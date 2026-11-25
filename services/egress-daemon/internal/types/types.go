package types

import (
	"fmt"
	"net/netip"
	"strings"
)

const (
	// TunnelCIDR is the fixed AWG 3.1 inner tunnel subnet managed by amnezia-awg3.
	TunnelCIDR = "10.90.0.0/22"

	// Awg3ListenPort is the UDP port used by amnezia-awg3.
	Awg3ListenPort = 51890

	// AmneziaDNSIP is the hardcoded AmneziaDNS address used by legacy/manual clients.
	AmneziaDNSIP = "172.29.172.254"

	// MinRoutingTableID and MaxRoutingTableID bound the custom policy routing tables
	// owned by amnezia-egressd (leaving OS table 100, main 254, local 255 untouched).
	MinRoutingTableID = 200
	MaxRoutingTableID = 219

	// FwmarkBase and FwmarkMask encode a 16-bit table slot without colliding with
	// arbitrary host fwmarks: 0x0000ae00 | (tableID - 200).
	FwmarkBase = 0x0000ae00
	FwmarkMask = 0x0000ff00

	// RulePriorityLocalShield is the high-priority local-subnet shield rule.
	RulePriorityLocalShield = 19900
	// RulePriorityBase is the starting priority for custom table fwmark rules.
	RulePriorityBase = 19901

	// RouteProtoEgressd identifies routes owned by amnezia-egressd (`proto 99`).
	RouteProtoEgressd = 99

	// MaxReportBytes bounds HostNetworkReport JSON so control-api/worker heaps stay small.
	MaxReportBytes = 4096
)

// EgressMode describes how amnezia-awg3 SNAT is performed on this node.
type EgressMode string

const (
	ModeMasquerade EgressMode = "masquerade"
	ModeRouted     EgressMode = "routed"
)

// EgressState summarizes live daemon + kernel rule health.
type EgressState string

const (
	StateMasqueradeReady EgressState = "masquerade_ready"
	StateRoutedActive    EgressState = "routed_active"
	StateConflict        EgressState = "conflict"
	StateDegraded        EgressState = "degraded"
)

// ExitHostState describes whether an Exit IP is usable on the host right now.
type ExitHostState string

const (
	ExitActive       ExitHostState = "active"
	ExitPending      ExitHostState = "pending"
	ExitMissingIP    ExitHostState = "missing_ip"
	ExitGatewayError ExitHostState = "gateway_error"
	ExitDisabled     ExitHostState = "disabled"
)

// DesiredExit defines one Exit IP configuration pushed by the panel/node-agent.
type DesiredExit struct {
	ID             string `json:"id"`
	IPv4           string `json:"ipv4"`
	InterfaceName  string `json:"interfaceName,omitempty"`
	GatewayIPv4    string `json:"gatewayIpv4,omitempty"`
	RoutingTableID int    `json:"routingTableId,omitempty"`
	DNSPrimary     string `json:"dnsPrimary"`
	DNSSecondary   string `json:"dnsSecondary,omitempty"`
	AmneziaDNSDNAT bool   `json:"amneziaDnsDnat"`
	EnforceDNSDNAT bool   `json:"enforceDnsDnat"`
	Enabled        bool   `json:"enabled"`
}

// DesiredPeer maps an inner AWG 3.1 tunnel IPv4 to an Exit IP and DNS policy.
type DesiredPeer struct {
	TunnelIPv4     string `json:"tunnelIpv4"`
	ExitIP         string `json:"exitIp"`
	DNSPrimary     string `json:"dnsPrimary,omitempty"`
	AmneziaDNSDNAT bool   `json:"amneziaDnsDnat"`
	EnforceDNSDNAT bool   `json:"enforceDnsDnat"`
	RoutingTableID int    `json:"routingTableId,omitempty"`
	Enabled        bool   `json:"enabled"`
}

// DesiredEntryMark tags inbound :51890/udp flows arriving on secondary Entry IPs
// so replies from br-awg-egress leave via that Entry IP's routing table.
type DesiredEntryMark struct {
	EntryIPv4      string `json:"entryIpv4"`
	RoutingTableID int    `json:"routingTableId"`
}

// DesiredState is the persisted target configuration under /etc/amnezia-egress/state.json.
// Applying DesiredState NEVER switches masquerade <-> routed mode; mode transitions happen
// strictly via switch-egress-mode.sh / POST /v1/switch-mode.
type DesiredState struct {
	SchemaVersion  int                `json:"schemaVersion"`
	BlockSMTP      bool               `json:"blockSmtp"`
	IsolatePrivate bool               `json:"isolatePrivate"`
	Exits          []DesiredExit      `json:"exits"`
	Peers          []DesiredPeer      `json:"peers"`
	EntryMarks     []DesiredEntryMark `json:"entryMarks,omitempty"`
}

// DefaultDesiredState returns the safe empty configuration before exits/peers are provisioned.
func DefaultDesiredState() DesiredState {
	return DesiredState{
		SchemaVersion:  1,
		BlockSMTP:      true,
		IsolatePrivate: true,
		Exits:          []DesiredExit{},
		Peers:          []DesiredPeer{},
		EntryMarks:     []DesiredEntryMark{},
	}
}

// DetectedIPv4 captures one global IPv4 address observed on a host WAN interface.
type DetectedIPv4 struct {
	IPv4                string `json:"ipv4"`
	CIDR                string `json:"cidr"`
	InterfaceName       string `json:"interfaceName"`
	DetectedGatewayIPv4 string `json:"detectedGatewayIpv4,omitempty"`
	DetectedRuleTable   int    `json:"detectedRuleTable,omitempty"`
}

// ExitStatus reports live kernel state and counters for one DesiredExit.
type ExitStatus struct {
	IPv4                string        `json:"ipv4"`
	HostState           ExitHostState `json:"hostState"`
	Detail              string        `json:"detail,omitempty"`
	ObservedSubnetCIDR  string        `json:"observedSubnetCidr,omitempty"`
	DetectedGatewayIPv4 string        `json:"detectedGatewayIpv4,omitempty"`
	TxBytes             uint64        `json:"txBytes"`
	TxPackets           uint64        `json:"txPackets"`
}

// HostNetworkReport is the compact (< 4 KiB) status snapshot served on GET /v1/report.
type HostNetworkReport struct {
	DaemonVersion        string         `json:"daemonVersion"`
	ObservedMode         EgressMode     `json:"observedMode"`
	EgressState          EgressState    `json:"egressState"`
	Detail               string         `json:"detail,omitempty"`
	BridgeName           string         `json:"bridgeName"`
	BridgePresent        bool           `json:"bridgePresent"`
	Awg3ContainerIPv4    string         `json:"awg3ContainerIpv4,omitempty"`
	TunnelSubnetConflict bool           `json:"tunnelSubnetConflict"`
	IPv4Addresses        []DetectedIPv4 `json:"ipv4Addresses"`
	Exits                []ExitStatus   `json:"exits"`
	ObservedAt           string         `json:"observedAt"`
}

// ApplyStateResponse is returned by PUT /v1/state.
type ApplyStateResponse struct {
	OK       bool               `json:"ok"`
	Warnings []string           `json:"warnings,omitempty"`
	Report   *HostNetworkReport `json:"report"`
}

// UpsertPeerRequest is accepted by POST /v1/peers/upsert.
type UpsertPeerRequest struct {
	Peer DesiredPeer `json:"peer"`
}

// RemovePeerRequest is accepted by POST /v1/peers/remove.
type RemovePeerRequest struct {
	TunnelIPv4 string `json:"tunnelIpv4"`
}

// VerifyExitRequest triggers source-bound HTTP + DNS verification from EgressIPv4.
type VerifyExitRequest struct {
	EgressIPv4 string `json:"egressIpv4"`
	ProbeURL   string `json:"probeUrl"`
	DNSServer  string `json:"dnsServer,omitempty"`
	DNSDomain  string `json:"dnsDomain,omitempty"`
	TimeoutMs  int    `json:"timeoutMs,omitempty"`
}

// VerifyExitResponse reports both source-bound HTTP egress IP confirmation and DNS resolution.
type VerifyExitResponse struct {
	OK            bool   `json:"ok"`
	EgressIPv4    string `json:"egressIpv4"`
	ObservedIP    string `json:"observedIp,omitempty"`
	IPMatch       bool   `json:"ipMatch"`
	HTTPLatencyMs int64  `json:"httpLatencyMs"`
	HTTPError     string `json:"httpError,omitempty"`
	DNSOK         bool   `json:"dnsOk"`
	DNSServer     string `json:"dnsServer,omitempty"`
	DNSLatencyMs  int64  `json:"dnsLatencyMs"`
	DNSError      string `json:"dnsError,omitempty"`
}

// HttpCheckRequest runs a source-bound HTTP check (matching node-agent's assertions model).
type HttpCheckRequest struct {
	EgressIPv4      string            `json:"egressIpv4"`
	URL             string            `json:"url"`
	Method          string            `json:"method,omitempty"`
	Headers         map[string]string `json:"headers,omitempty"`
	FollowRedirects *bool             `json:"followRedirects,omitempty"`
	TimeoutMs       int               `json:"timeoutMs,omitempty"`
}

// HttpCheckResponse mirrors the bounded response data needed by node-agent assertions.
type HttpCheckResponse struct {
	Status    int               `json:"status"`
	FinalURL  string            `json:"finalUrl,omitempty"`
	Body      string            `json:"body,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	LatencyMs int64             `json:"latencyMs"`
	Error     string            `json:"error,omitempty"`
}

// SwitchModeRequest is accepted by POST /v1/switch-mode.
type SwitchModeRequest struct {
	Mode EgressMode `json:"mode"`
}

// SwitchModeResponse is returned by POST /v1/switch-mode.
type SwitchModeResponse struct {
	OK     bool               `json:"ok"`
	Report *HostNetworkReport `json:"report,omitempty"`
	Error  string             `json:"error,omitempty"`
}

// NormalizeAndValidateDesiredState sanitizes defaults and rejects invalid IPs, tables, or duplicates.
func NormalizeAndValidateDesiredState(in *DesiredState) error {
	if in == nil {
		return fmt.Errorf("desired state is required")
	}
	if in.SchemaVersion == 0 {
		in.SchemaVersion = 1
	}
	if in.SchemaVersion != 1 {
		return fmt.Errorf("unsupported schemaVersion %d", in.SchemaVersion)
	}

	tunnelPrefix := netip.MustParsePrefix(TunnelCIDR)
	seenExitIPs := make(map[string]struct{}, len(in.Exits))
	seenTables := make(map[int]struct{}, len(in.Exits))

	for i := range in.Exits {
		ex := &in.Exits[i]
		addr, err := ParseIPv4(ex.IPv4)
		if err != nil {
			return fmt.Errorf("exits[%d].ipv4: %w", i, err)
		}
		ex.IPv4 = addr.String()
		if _, dup := seenExitIPs[ex.IPv4]; dup {
			return fmt.Errorf("duplicate exit ipv4 %s", ex.IPv4)
		}
		seenExitIPs[ex.IPv4] = struct{}{}

		if ex.GatewayIPv4 != "" {
			gw, err := ParseIPv4(ex.GatewayIPv4)
			if err != nil {
				return fmt.Errorf("exits[%d].gatewayIpv4: %w", i, err)
			}
			ex.GatewayIPv4 = gw.String()
		}

		if ex.RoutingTableID != 0 {
			if ex.RoutingTableID < MinRoutingTableID || ex.RoutingTableID > MaxRoutingTableID {
				return fmt.Errorf("exits[%d].routingTableId %d out of range [%d..%d]", i, ex.RoutingTableID, MinRoutingTableID, MaxRoutingTableID)
			}
			if _, dup := seenTables[ex.RoutingTableID]; dup {
				return fmt.Errorf("duplicate routingTableId %d", ex.RoutingTableID)
			}
			seenTables[ex.RoutingTableID] = struct{}{}
		}

		if strings.TrimSpace(ex.DNSPrimary) == "" {
			ex.DNSPrimary = "1.1.1.1"
		}
		dns1, err := ParseIPv4(ex.DNSPrimary)
		if err != nil {
			return fmt.Errorf("exits[%d].dnsPrimary: %w", i, err)
		}
		ex.DNSPrimary = dns1.String()

		if strings.TrimSpace(ex.DNSSecondary) != "" {
			dns2, err := ParseIPv4(ex.DNSSecondary)
			if err != nil {
				return fmt.Errorf("exits[%d].dnsSecondary: %w", i, err)
			}
			ex.DNSSecondary = dns2.String()
		}
	}

	seenPeers := make(map[string]struct{}, len(in.Peers))
	for i := range in.Peers {
		p := &in.Peers[i]
		peerAddr, err := ParseIPv4(p.TunnelIPv4)
		if err != nil {
			return fmt.Errorf("peers[%d].tunnelIpv4: %w", i, err)
		}
		if !tunnelPrefix.Contains(peerAddr) {
			return fmt.Errorf("peers[%d].tunnelIpv4 %s is outside %s", i, peerAddr, TunnelCIDR)
		}
		p.TunnelIPv4 = peerAddr.String()
		if _, dup := seenPeers[p.TunnelIPv4]; dup {
			return fmt.Errorf("duplicate peer tunnelIpv4 %s", p.TunnelIPv4)
		}
		seenPeers[p.TunnelIPv4] = struct{}{}

		exitAddr, err := ParseIPv4(p.ExitIP)
		if err != nil {
			return fmt.Errorf("peers[%d].exitIp: %w", i, err)
		}
		p.ExitIP = exitAddr.String()

		if strings.TrimSpace(p.DNSPrimary) != "" {
			dns1, err := ParseIPv4(p.DNSPrimary)
			if err != nil {
				return fmt.Errorf("peers[%d].dnsPrimary: %w", i, err)
			}
			p.DNSPrimary = dns1.String()
		}
		if p.RoutingTableID != 0 && (p.RoutingTableID < MinRoutingTableID || p.RoutingTableID > MaxRoutingTableID) {
			return fmt.Errorf("peers[%d].routingTableId %d out of range [%d..%d]", i, p.RoutingTableID, MinRoutingTableID, MaxRoutingTableID)
		}
	}

	seenEntries := make(map[string]struct{}, len(in.EntryMarks))
	for i := range in.EntryMarks {
		em := &in.EntryMarks[i]
		entryAddr, err := ParseIPv4(em.EntryIPv4)
		if err != nil {
			return fmt.Errorf("entryMarks[%d].entryIpv4: %w", i, err)
		}
		em.EntryIPv4 = entryAddr.String()
		if _, dup := seenEntries[em.EntryIPv4]; dup {
			return fmt.Errorf("duplicate entryMark %s", em.EntryIPv4)
		}
		seenEntries[em.EntryIPv4] = struct{}{}
		if em.RoutingTableID < MinRoutingTableID || em.RoutingTableID > MaxRoutingTableID {
			return fmt.Errorf("entryMarks[%d].routingTableId %d out of range [%d..%d]", i, em.RoutingTableID, MinRoutingTableID, MaxRoutingTableID)
		}
	}

	return nil
}

// ParseIPv4 parses a strict dotted-quad IPv4 literal (rejecting IPv6-mapped IPv4).
func ParseIPv4(raw string) (netip.Addr, error) {
	addr, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil || !addr.Is4() {
		return netip.Addr{}, fmt.Errorf("invalid IPv4 literal %q", raw)
	}
	return addr, nil
}

// FwmarkForTable returns the 32-bit mark paired with a [200..219] routing table.
func FwmarkForTable(tableID int) uint32 {
	if tableID < MinRoutingTableID || tableID > MaxRoutingTableID {
		return 0
	}
	return uint32(FwmarkBase | (tableID - MinRoutingTableID))
}

// ClipDetail truncates status detail strings to keep reports compact.
func ClipDetail(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " "))
	if len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}
