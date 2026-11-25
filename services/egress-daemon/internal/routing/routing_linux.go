//go:build linux

package routing

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"amnezia-egressd/internal/nft"
	"amnezia-egressd/internal/types"
	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// LinuxManager manipulates host netlink rules/routes/conntrack and DOCKER-USER.
type LinuxManager struct{}

// NewLinuxManager constructs the real Linux routing Manager.
func NewLinuxManager() *LinuxManager {
	return &LinuxManager{}
}

func (m *LinuxManager) Sync(exits []nft.EvaluatedExit, bridgeName string) error {
	specs, err := DesiredRoutesFromExits(exits)
	if err != nil {
		return err
	}

	if err := m.ensureDockerUserRules(bridgeName); err != nil {
		return err
	}

	if err := setLooseRPFilter(bridgeName); err != nil {
		return err
	}

	wantTables := make(map[int]RouteSpec, len(specs))
	for _, s := range specs {
		wantTables[s.TableID] = s
		if s.IfaceName != "" {
			if err := setLooseRPFilter(s.IfaceName); err != nil {
				return err
			}
		}
		if err := ensureDefaultRoute(s); err != nil {
			return err
		}
	}

	// Clean stale proto 99 routes in our managed range [200..219] that are no longer needed.
	for t := types.MinRoutingTableID; t <= types.MaxRoutingTableID; t++ {
		if _, keep := wantTables[t]; keep {
			continue
		}
		_ = cleanupTableRoutes(t)
	}

	// Install local-subnet shield priority 19900 when custom tables are active, else remove it.
	if len(specs) > 0 {
		if err := setLooseRPFilter("all"); err != nil {
			return err
		}
		if err := ensureLocalShieldRule(); err != nil {
			return err
		}
	} else {
		_ = deleteManagedRulesInRange(types.RulePriorityLocalShield, types.RulePriorityLocalShield)
	}

	// Sync fwmark ip rules for priorities 19901..19920.
	if err := syncFwmarkRules(specs); err != nil {
		return err
	}

	return nil
}

func (m *LinuxManager) Teardown(bridgeName string) error {
	_ = deleteManagedRulesInRange(types.RulePriorityLocalShield, types.RulePriorityBase+(types.MaxRoutingTableID-types.MinRoutingTableID))
	for t := types.MinRoutingTableID; t <= types.MaxRoutingTableID; t++ {
		_ = cleanupTableRoutes(t)
	}
	_ = removeDockerUserRules(bridgeName)
	return nil
}

func (m *LinuxManager) FlushPeers(tunnelIPv4s []string) error {
	for _, raw := range tunnelIPv4s {
		ip := net.ParseIP(raw)
		if ip == nil || ip.To4() == nil {
			continue
		}
		ip4 := ip.To4()
		filter := &netlink.ConntrackFilter{}
		if err := filter.AddIP(netlink.ConntrackOrigSrcIP, ip4); err == nil {
			_, _ = netlink.ConntrackDeleteFilters(netlink.ConntrackTable, unix.AF_INET, filter)
		}
	}
	return nil
}

func setLooseRPFilter(iface string) error {
	if strings.ContainsAny(iface, "/.") && iface != "all" {
		// Prevent path traversal from weird names while preserving dotted VLAN names carefully:
		ifaceClean := filepath.Base(iface)
		if ifaceClean != iface {
			return fmt.Errorf("invalid interface name %q", iface)
		}
	}
	path := fmt.Sprintf("/proc/sys/net/ipv4/conf/%s/rp_filter", iface)
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	return os.WriteFile(path, []byte("2\n"), 0o644)
}

func ensureDefaultRoute(spec RouteSpec) error {
	route := &netlink.Route{
		LinkIndex: spec.LinkIndex,
		Dst: &net.IPNet{
			IP:   net.IPv4zero,
			Mask: net.CIDRMask(0, 32),
		},
		Gw:       net.IP(spec.Gateway.AsSlice()),
		Table:    spec.TableID,
		Protocol: types.RouteProtoEgressd,
		Flags:    int(netlink.FLAG_ONLINK),
	}
	if err := netlink.RouteReplace(route); err != nil {
		return fmt.Errorf("replace default route in table %d via %s onlink: %w", spec.TableID, spec.Gateway, err)
	}
	return nil
}

func cleanupTableRoutes(tableID int) error {
	routes, err := netlink.RouteListFiltered(netlink.FAMILY_V4, &netlink.Route{Table: tableID}, netlink.RT_FILTER_TABLE)
	if err != nil {
		return err
	}
	for i := range routes {
		if int(routes[i].Protocol) == types.RouteProtoEgressd {
			_ = netlink.RouteDel(&routes[i])
		}
	}
	return nil
}

func ensureLocalShieldRule() error {
	rules, err := netlink.RuleList(netlink.FAMILY_V4)
	if err != nil {
		return err
	}
	for _, r := range rules {
		if r.Priority == types.RulePriorityLocalShield &&
			r.Table == 254 &&
			uint32(r.Mark) == types.FwmarkBase &&
			r.Mask != nil && *r.Mask == types.FwmarkMask &&
			r.SuppressPrefixlen == 0 {
			return nil
		}
	}
	_ = deleteManagedRulesInRange(types.RulePriorityLocalShield, types.RulePriorityLocalShield)

	rule := netlink.NewRule()
	rule.Priority = types.RulePriorityLocalShield
	rule.Table = 254
	rule.Mark = types.FwmarkBase
	mask := uint32(types.FwmarkMask)
	rule.Mask = &mask
	rule.SuppressPrefixlen = 0
	if err := netlink.RuleAdd(rule); err != nil {
		return fmt.Errorf("add local shield rule: %w", err)
	}
	return nil
}

func syncFwmarkRules(specs []RouteSpec) error {
	minPrio := types.RulePriorityBase
	maxPrio := types.RulePriorityBase + (types.MaxRoutingTableID - types.MinRoutingTableID)

	wantByPrio := make(map[int]RouteSpec, len(specs))
	for _, s := range specs {
		prio := types.RulePriorityBase + (s.TableID - types.MinRoutingTableID)
		wantByPrio[prio] = s
	}

	existing, err := netlink.RuleList(netlink.FAMILY_V4)
	if err != nil {
		return err
	}
	present := make(map[int]bool)
	for i := range existing {
		r := &existing[i]
		if r.Priority < minPrio || r.Priority > maxPrio {
			continue
		}
		s, want := wantByPrio[r.Priority]
		if want && r.Table == s.TableID && uint32(r.Mark) == s.Fwmark &&
			r.Mask != nil && *r.Mask == 0xffffffff {
			present[r.Priority] = true
			continue
		}
		_ = netlink.RuleDel(r)
	}

	for prio, s := range wantByPrio {
		if present[prio] {
			continue
		}
		rule := netlink.NewRule()
		rule.Priority = prio
		rule.Table = s.TableID
		rule.Mark = s.Fwmark
		fullMask := uint32(0xffffffff)
		rule.Mask = &fullMask
		if err := netlink.RuleAdd(rule); err != nil {
			return fmt.Errorf("add fwmark rule prio %d table %d: %w", prio, s.TableID, err)
		}
	}
	return nil
}

func deleteManagedRulesInRange(minPrio, maxPrio int) error {
	rules, err := netlink.RuleList(netlink.FAMILY_V4)
	if err != nil {
		return err
	}
	for i := range rules {
		if rules[i].Priority >= minPrio && rules[i].Priority <= maxPrio {
			_ = netlink.RuleDel(&rules[i])
		}
	}
	return nil
}

func (m *LinuxManager) ensureDockerUserRules(bridgeName string) error {
	if _, err := exec.LookPath("iptables"); err != nil {
		return nil
	}
	// Only add into DOCKER-USER if Docker created the chain.
	if err := exec.Command("iptables", "-S", "DOCKER-USER").Run(); err != nil {
		return nil
	}

	inArgs := []string{"-i", bridgeName, "-m", "comment", "--comment", "amnezia-egress-in", "-j", "RETURN"}
	outArgs := []string{"-o", bridgeName, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-m", "comment", "--comment", "amnezia-egress-out", "-j", "RETURN"}

	for _, args := range [][]string{outArgs, inArgs} {
		check := append([]string{"-C", "DOCKER-USER"}, args...)
		if exec.Command("iptables", check...).Run() != nil {
			insert := append([]string{"-I", "DOCKER-USER", "1"}, args...)
			if out, err := exec.Command("iptables", insert...).CombinedOutput(); err != nil {
				return fmt.Errorf("insert DOCKER-USER rule: %w (%s)", err, strings.TrimSpace(string(out)))
			}
		}
	}
	return nil
}

func removeDockerUserRules(bridgeName string) error {
	if _, err := exec.LookPath("iptables"); err != nil {
		return nil
	}
	for _, args := range [][]string{
		{"-D", "DOCKER-USER", "-i", bridgeName, "-m", "comment", "--comment", "amnezia-egress-in", "-j", "RETURN"},
		{"-D", "DOCKER-USER", "-o", bridgeName, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-m", "comment", "--comment", "amnezia-egress-out", "-j", "RETURN"},
	} {
		_ = exec.Command("iptables", args...).Run()
	}
	return nil
}
