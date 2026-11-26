package netdisc

import (
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"amnezia-egressd/internal/types"
)

// LinkInfo describes a host network interface obtained via netlink.
type LinkInfo struct {
	Index int
	Name  string
	Up    bool
}

// AddrInfo describes an IPv4 address bound to a LinkInfo.
type AddrInfo struct {
	LinkIndex int
	Prefix    netip.Prefix
}

// RouteInfo describes an IPv4 routing table entry obtained via netlink.
type RouteInfo struct {
	Table     int
	LinkIndex int
	Dst       *netip.Prefix // nil or 0.0.0.0/0 indicates a default route
	Gw        netip.Addr
	Priority  int
	Protocol  int
}

// RuleInfo describes an IPv4 policy routing rule obtained via netlink.
type RuleInfo struct {
	Priority int
	Table    int
	Src      *netip.Prefix
	Mark     uint32
}

// SnapshotClient reads read-only network state from the kernel (or a test double).
type SnapshotClient interface {
	Links() ([]LinkInfo, error)
	AddrsV4() ([]AddrInfo, error)
	RoutesV4() ([]RouteInfo, error)
	RulesV4() ([]RuleInfo, error)
	HasNftTable(tableName string) (bool, error)
}

// HostNetworkSnapshot holds discovered WAN IPv4 addresses, gateways, bridge state, and conflicts.
type HostNetworkSnapshot struct {
	BridgeName           string
	BridgePresent        bool
	BridgeLinkIndex      int
	Awg3ContainerIPv4    string
	MainGateway          netip.Addr
	MainGatewayIface     string
	MainGatewayLinkIndex int
	TunnelSubnetConflict bool
	EnvEgressMode        types.EgressMode
	NftTablePresent      bool
	IPv4s                []DiscoveredIPv4
}

// DiscoveredIPv4 enriches types.DetectedIPv4 with internal gateway selection fields.
type DiscoveredIPv4 struct {
	types.DetectedIPv4
	LinkIndex      int
	Prefix         netip.Prefix
	ResolvedGw     netip.Addr
	UsesCustomRule bool
}

// Discover inspects the host network state without spawning Docker CLI processes.
func Discover(client SnapshotClient, bridgeName, nodeDir string) (HostNetworkSnapshot, error) {
	snap := HostNetworkSnapshot{
		BridgeName:    bridgeName,
		EnvEgressMode: types.ModeMasquerade,
	}
	if nodeDir != "" {
		envPath := filepath.Join(nodeDir, ".env")
		snap.EnvEgressMode = ReadEnvEgressMode(envPath)
		if rawIP := ReadEnvValue(envPath, "AWG3_EGRESS_IPV4"); rawIP != "" {
			if ip, parseErr := types.ParseIPv4(rawIP); parseErr == nil {
				snap.Awg3ContainerIPv4 = ip.String()
			}
		}
	}

	nftPresent, err := client.HasNftTable("amnezia_egress")
	if err == nil {
		snap.NftTablePresent = nftPresent
	}

	links, err := client.Links()
	if err != nil {
		return snap, fmt.Errorf("list links: %w", err)
	}
	addrs, err := client.AddrsV4()
	if err != nil {
		return snap, fmt.Errorf("list IPv4 addresses: %w", err)
	}
	routes, err := client.RoutesV4()
	if err != nil {
		return snap, fmt.Errorf("list IPv4 routes: %w", err)
	}
	rules, err := client.RulesV4()
	if err != nil {
		return snap, fmt.Errorf("list IPv4 rules: %w", err)
	}

	linkByIndex := make(map[int]LinkInfo, len(links))
	for _, l := range links {
		linkByIndex[l.Index] = l
		if l.Name == bridgeName {
			snap.BridgePresent = true
			snap.BridgeLinkIndex = l.Index
		}
	}
	if snap.Awg3ContainerIPv4 == "" && snap.BridgePresent {
		snap.Awg3ContainerIPv4 = deriveBridgeSiblingIPv4(addrs, snap.BridgeLinkIndex)
	}

	// Default gateways per routing table (lowest metric wins on multi-NIC / metric-100 hosts).
	defaultGwByTable := make(map[int]RouteInfo)
	tunnelPrefix := netip.MustParsePrefix(types.TunnelCIDR)
	for _, r := range routes {
		if r.Dst != nil && r.Dst.Bits() > 0 {
			// Detect non-bridge foreign routes overlapping 10.90.0.0/22 outside our own proto-99 tables.
			isOwnTable := r.Table >= types.MinRoutingTableID && r.Table <= types.MaxRoutingTableID
			isBridge := snap.BridgePresent && r.LinkIndex == snap.BridgeLinkIndex
			if !isOwnTable && !isBridge && r.Dst.Overlaps(tunnelPrefix) {
				snap.TunnelSubnetConflict = true
			}
			continue
		}
		if !r.Gw.IsValid() {
			continue
		}
		prev, exists := defaultGwByTable[r.Table]
		if !exists || r.Priority < prev.Priority {
			defaultGwByTable[r.Table] = r
		}
	}

	if mainRoute, ok := defaultGwByTable[254]; ok {
		snap.MainGateway = mainRoute.Gw
		snap.MainGatewayLinkIndex = mainRoute.LinkIndex
		if l, ok := linkByIndex[mainRoute.LinkIndex]; ok {
			snap.MainGatewayIface = l.Name
		}
	}

	// Find secondary OS source-routing rules (e.g. cloud table 100) outside main/local/default and 200..219.
	// Sort rules by priority ascending so first matching OS rule wins.
	sortedRules := append([]RuleInfo(nil), rules...)
	sort.Slice(sortedRules, func(i, j int) bool {
		return sortedRules[i].Priority < sortedRules[j].Priority
	})

	for _, a := range addrs {
		link, ok := linkByIndex[a.LinkIndex]
		if !ok || IsExcludedInterface(link.Name, bridgeName) {
			continue
		}
		ip := a.Prefix.Addr()
		if !ip.Is4() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || !ip.IsGlobalUnicast() {
			continue
		}

		item := DiscoveredIPv4{
			DetectedIPv4: types.DetectedIPv4{
				IPv4:          ip.String(),
				CIDR:          a.Prefix.String(),
				InterfaceName: link.Name,
			},
			LinkIndex: a.LinkIndex,
			Prefix:    a.Prefix,
		}

		// Match OS ip rule (from <ip> lookup <table>) excluding local/main/default and our 200..219 tables.
		for _, rule := range sortedRules {
			if rule.Table == 0 || rule.Table == 253 || rule.Table == 254 || rule.Table == 255 {
				continue
			}
			if rule.Table >= types.MinRoutingTableID && rule.Table <= types.MaxRoutingTableID {
				continue
			}
			if rule.Src != nil && rule.Src.Contains(ip) {
				if gwRoute, hasGw := defaultGwByTable[rule.Table]; hasGw {
					item.DetectedGatewayIPv4 = gwRoute.Gw.String()
					item.DetectedRuleTable = rule.Table
					item.ResolvedGw = gwRoute.Gw
					item.UsesCustomRule = true
					break
				}
			}
		}

		if !item.ResolvedGw.IsValid() {
			// Fall back to interface default gateway in main table if present, else global main gateway.
			if gw := bestDefaultForLink(routes, 254, a.LinkIndex); gw.IsValid() {
				item.ResolvedGw = gw
			} else if snap.MainGateway.IsValid() {
				item.ResolvedGw = snap.MainGateway
			}
		}

		snap.IPv4s = append(snap.IPv4s, item)
	}

	sort.Slice(snap.IPv4s, func(i, j int) bool {
		if snap.IPv4s[i].InterfaceName != snap.IPv4s[j].InterfaceName {
			return snap.IPv4s[i].InterfaceName < snap.IPv4s[j].InterfaceName
		}
		return snap.IPv4s[i].IPv4 < snap.IPv4s[j].IPv4
	})

	return snap, nil
}

func bestDefaultForLink(routes []RouteInfo, table, linkIndex int) netip.Addr {
	var bestPriority int
	var bestGw netip.Addr
	for _, r := range routes {
		if r.Table != table || r.LinkIndex != linkIndex {
			continue
		}
		if r.Dst != nil && r.Dst.Bits() > 0 {
			continue
		}
		if !r.Gw.IsValid() {
			continue
		}
		if !bestGw.IsValid() || r.Priority < bestPriority {
			bestGw = r.Gw
			bestPriority = r.Priority
		}
	}
	return bestGw
}

// IsExcludedInterface skips loopback, container bridges, veth pairs, and VPN tunnel interfaces
// (such as host awg0, dormant amn0, or our br-awg-egress) so they never appear as WAN Exit IPs.
func IsExcludedInterface(name, bridgeName string) bool {
	if name == "" || name == "lo" || name == bridgeName {
		return true
	}
	for _, prefix := range []string{"docker", "br-", "veth", "awg", "amn", "wg", "tun", "tap", "virbr", "cni"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func deriveBridgeSiblingIPv4(addrs []AddrInfo, bridgeLinkIndex int) string {
	for _, a := range addrs {
		if a.LinkIndex != bridgeLinkIndex || !a.Prefix.Addr().Is4() {
			continue
		}
		if a.Prefix.Bits() <= 30 {
			candidate := a.Prefix.Masked().Addr().Next().Next()
			if candidate.Is4() && a.Prefix.Contains(candidate) && candidate != a.Prefix.Addr() {
				return candidate.String()
			}
		}
		break
	}
	return "172.30.90.2"
}

// ReadEnvValue reads one key from a .env file safely without executing shell syntax.
func ReadEnvValue(envPath, key string) string {
	if envPath == "" || key == "" {
		return ""
	}
	raw, err := os.ReadFile(envPath)
	if err != nil {
		return ""
	}
	prefix := key + "="
	val := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, prefix) {
			v := strings.TrimSpace(strings.TrimPrefix(line, prefix))
			val = strings.Trim(v, `"'`)
		}
	}
	return val
}

// ReadEnvEgressMode resolves AWG3 egress mode, preferring state/amnezia-awg3/egress-mode
// and falling back to AWG3_EGRESS_MODE in node .env without executing shell syntax.
func ReadEnvEgressMode(envPath string) types.EgressMode {
	if envPath == "" {
		return types.ModeMasquerade
	}
	nodeDir := filepath.Dir(envPath)
	if info, err := os.Stat(envPath); err == nil && info.IsDir() {
		nodeDir = envPath
		envPath = filepath.Join(nodeDir, ".env")
	}
	stateModePath := filepath.Join(nodeDir, "state", "amnezia-awg3", "egress-mode")
	if raw, err := os.ReadFile(stateModePath); err == nil {
		switch strings.TrimSpace(string(raw)) {
		case string(types.ModeRouted):
			return types.ModeRouted
		case string(types.ModeMasquerade):
			return types.ModeMasquerade
		}
	}
	switch ReadEnvValue(envPath, "AWG3_EGRESS_MODE") {
	case string(types.ModeRouted):
		return types.ModeRouted
	default:
		return types.ModeMasquerade
	}
}

// ShareSubnetOrSlash24 reports whether two IPv4 interface prefixes overlap or sit in the same /24.
// Helps surface same-subnet warning metadata accurately across /23, /24, and /32 hosts.
func ShareSubnetOrSlash24(a, b netip.Prefix) bool {
	if a.Overlaps(b) {
		return true
	}
	a24 := netip.PrefixFrom(a.Addr(), 24).Masked()
	b24 := netip.PrefixFrom(b.Addr(), 24).Masked()
	return a24 == b24
}
