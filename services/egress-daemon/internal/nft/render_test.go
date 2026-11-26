package nft

import (
	"net/netip"
	"strings"
	"testing"

	"amnezia-egressd/internal/netdisc"
	"amnezia-egressd/internal/types"
)

func TestBuildPlanEmptySetsAndIPv6RejectSyntax(t *testing.T) {
	snap := netdisc.HostNetworkSnapshot{
		BridgeName:    "br-awg-egress",
		BridgePresent: true,
		MainGateway:   netip.MustParseAddr("198.51.100.1"),
	}
	plan := BuildPlan(types.DefaultDesiredState(), snap, "br-awg-egress")

	if strings.Contains(plan.Ruleset, "icmpx") {
		t.Fatal("ruleset must NOT use icmpx inside table ip6")
	}
	if !strings.Contains(plan.Ruleset, "reject with icmpv6 type admin-prohibited") {
		t.Fatal("ruleset must use icmpv6 type admin-prohibited in table ip6")
	}
	if !strings.Contains(plan.Ruleset, "ip saddr @allowed_active_peers accept") {
		t.Fatal("ruleset must use positive allow rule for kernel 5.15 empty-set safety")
	}
	if !strings.Contains(plan.Ruleset, "map peer_exit_v4 { type ipv4_addr : ipv4_addr; }") {
		t.Fatal("empty map syntax missing")
	}
}

func TestBuildPlanMultiExitFailClosedAndSecondaryEntryMark(t *testing.T) {
	snap := netdisc.HostNetworkSnapshot{
		BridgeName:       "br-awg-egress",
		BridgePresent:    true,
		MainGateway:      netip.MustParseAddr("198.51.100.1"),
		MainGatewayIface: "ens3",
		IPv4s: []netdisc.DiscoveredIPv4{
			{
				DetectedIPv4: types.DetectedIPv4{
					IPv4:          "198.51.100.10",
					CIDR:          "198.51.100.10/24",
					InterfaceName: "ens3",
				},
				LinkIndex:  2,
				Prefix:     netip.MustParsePrefix("198.51.100.10/24"),
				ResolvedGw: netip.MustParseAddr("198.51.100.1"),
			},
			{
				DetectedIPv4: types.DetectedIPv4{
					IPv4:                "203.0.113.20",
					CIDR:                "203.0.113.20/24",
					InterfaceName:       "ens3",
					DetectedGatewayIPv4: "203.0.113.1",
					DetectedRuleTable:   100,
				},
				LinkIndex:      2,
				Prefix:         netip.MustParsePrefix("203.0.113.20/24"),
				ResolvedGw:     netip.MustParseAddr("203.0.113.1"),
				UsesCustomRule: true,
			},
		},
	}

	state := types.DesiredState{
		SchemaVersion:  1,
		BlockSMTP:      true,
		IsolatePrivate: true,
		Exits: []types.DesiredExit{
			{
				ID:             "e1",
				IPv4:           "198.51.100.10",
				DNSPrimary:     "1.1.1.1",
				AmneziaDNSDNAT: true,
				Enabled:        true,
			},
			{
				ID:             "e2",
				IPv4:           "203.0.113.20",
				RoutingTableID: 201,
				DNSPrimary:     "9.9.9.9",
				AmneziaDNSDNAT: true,
				EnforceDNSDNAT: true,
				Enabled:        true,
			},
			{
				ID:         "e3-missing",
				IPv4:       "192.0.2.99",
				DNSPrimary: "8.8.8.8",
				Enabled:    true,
			},
		},
		Peers: []types.DesiredPeer{
			{TunnelIPv4: "10.90.0.2", ExitIP: "198.51.100.10", AmneziaDNSDNAT: true, Enabled: true},
			{TunnelIPv4: "10.90.0.3", ExitIP: "203.0.113.20", Enabled: true},
			// Assigned to missing IP — must be excluded from allowed_active_peers (fail-closed)
			{TunnelIPv4: "10.90.0.4", ExitIP: "192.0.2.99", Enabled: true},
			// Disabled peer — must be excluded
			{TunnelIPv4: "10.90.0.5", ExitIP: "198.51.100.10", Enabled: false},
		},
	}

	plan := BuildPlan(state, snap, "br-awg-egress")
	if !plan.Degraded {
		t.Fatal("expected plan to be marked Degraded because 192.0.2.99 is missing on host")
	}
	if len(plan.ActiveExits) != 2 {
		t.Fatalf("expected 2 active exits, got %d", len(plan.ActiveExits))
	}

	for _, mustContain := range []string{
		"10.90.0.2 : 198.51.100.10",
		"10.90.0.3 : 203.0.113.20",
		"10.90.0.2 : 1.1.1.1",
		"10.90.0.3 : 9.9.9.9",
		"10.90.0.3 : 0x0000ae01",
		"elements = { 10.90.0.2, 10.90.0.3 }",
		`iifname != "br-awg-egress" ip daddr 203.0.113.20 udp dport 51890 ct mark set 0x0000ae01`,
		`iifname "br-awg-egress" ip saddr 10.90.0.0/22 tcp dport 25 counter drop`,
		`iifname "br-awg-egress" ip saddr 10.90.0.0/22 ip daddr { 10.0.0.0/8,`,
	} {
		if !strings.Contains(plan.Ruleset, mustContain) {
			t.Fatalf("expected ruleset to contain %q\nRuleset:\n%s", mustContain, plan.Ruleset)
		}
	}

	if strings.Contains(plan.Ruleset, "10.90.0.4") || strings.Contains(plan.Ruleset, "10.90.0.5") {
		t.Fatalf("missing-exit or disabled peer leaked into ruleset:\n%s", plan.Ruleset)
	}
	if strings.Contains(plan.Ruleset, ": 53") {
		t.Fatalf("redundant ': 53' suffix must not appear in DNS DNAT map expressions:\n%s", plan.Ruleset)
	}
}

func TestBuildPlanEntryMarksReservationAndPeerOptOut(t *testing.T) {
	snap := netdisc.HostNetworkSnapshot{
		BridgeName:       "br-awg-egress",
		BridgePresent:    true,
		MainGateway:      netip.MustParseAddr("198.51.100.1"),
		MainGatewayIface: "ens3",
		IPv4s: []netdisc.DiscoveredIPv4{
			{
				DetectedIPv4: types.DetectedIPv4{
					IPv4:          "198.51.100.10",
					CIDR:          "198.51.100.10/24",
					InterfaceName: "ens3",
				},
				LinkIndex:  2,
				Prefix:     netip.MustParsePrefix("198.51.100.10/24"),
				ResolvedGw: netip.MustParseAddr("198.51.100.1"),
			},
			{
				DetectedIPv4: types.DetectedIPv4{
					IPv4:                "203.0.113.20",
					CIDR:                "203.0.113.20/24",
					InterfaceName:       "ens4",
					DetectedGatewayIPv4: "203.0.113.1",
					DetectedRuleTable:   100,
				},
				LinkIndex:      3,
				Prefix:         netip.MustParsePrefix("203.0.113.20/24"),
				ResolvedGw:     netip.MustParseAddr("203.0.113.1"),
				UsesCustomRule: true,
			},
			{
				DetectedIPv4: types.DetectedIPv4{
					IPv4:                "198.51.100.20",
					CIDR:                "198.51.100.20/24",
					InterfaceName:       "ens5",
					DetectedGatewayIPv4: "198.51.100.254",
					DetectedRuleTable:   101,
				},
				LinkIndex:      4,
				Prefix:         netip.MustParsePrefix("198.51.100.20/24"),
				ResolvedGw:     netip.MustParseAddr("198.51.100.254"),
				UsesCustomRule: true,
			},
		},
	}

	state := types.DesiredState{
		SchemaVersion:  1,
		BlockSMTP:      true,
		IsolatePrivate: true,
		Exits: []types.DesiredExit{
			{
				ID:             "e-main",
				IPv4:           "198.51.100.10",
				DNSPrimary:     "1.1.1.1",
				AmneziaDNSDNAT: true,
				EnforceDNSDNAT: true,
				Enabled:        true,
			},
			{
				ID:         "e-secondary-auto-table",
				IPv4:       "203.0.113.20",
				DNSPrimary: "9.9.9.9",
				Enabled:    true,
			},
		},
		EntryMarks: []types.DesiredEntryMark{
			// Reserve 200 for entry-only asymmetric IP so e-secondary-auto-table skips 200 and gets 201.
			{EntryIPv4: "198.51.100.20", RoutingTableID: 200},
		},
		Peers: []types.DesiredPeer{
			// Main-table exit with stale p.RoutingTableID must NOT emit @peer_fwmark;
			// explicit DNSPrimary with false flags allows per-peer opt-out.
			{
				TunnelIPv4:     "10.90.0.2",
				ExitIP:         "198.51.100.10",
				DNSPrimary:     "1.1.1.1",
				AmneziaDNSDNAT: false,
				EnforceDNSDNAT: false,
				RoutingTableID: 205,
				Enabled:        true,
			},
		},
	}

	plan := BuildPlan(state, snap, "br-awg-egress")
	if len(plan.EntryRoutes) != 1 || plan.EntryRoutes[0].TableID != 200 || plan.EntryRoutes[0].EntryIPv4 != "198.51.100.20" {
		t.Fatalf("expected EntryRoutes=[{198.51.100.20 table 200}], got %+v", plan.EntryRoutes)
	}
	if len(plan.ActiveExits) != 2 {
		t.Fatalf("expected 2 active exits, got %d", len(plan.ActiveExits))
	}
	for _, ev := range plan.ActiveExits {
		if ev.Desired.IPv4 == "203.0.113.20" && ev.RoutingTableID != 201 {
			t.Fatalf("expected e-secondary-auto-table to skip reserved 200 and allocate 201, got %d", ev.RoutingTableID)
		}
	}
	if strings.Contains(plan.Ruleset, "10.90.0.2 : 0x") {
		t.Fatalf("peer on main-table exit must not receive fwmark even if RoutingTableID is non-zero:\n%s", plan.Ruleset)
	}
	if strings.Contains(plan.Ruleset, "10.90.0.2 : 1.1.1.1") {
		t.Fatalf("peer with explicit DNSPrimary and false DNAT flags must opt out:\n%s", plan.Ruleset)
	}
	if !strings.Contains(plan.Ruleset, `ip daddr 198.51.100.20 udp dport 51890 ct mark set 0x0000ae00`) {
		t.Fatalf("expected entry mark ct rule for 198.51.100.20:\n%s", plan.Ruleset)
	}
}

func TestParseCountersJSON(t *testing.T) {
	sample := []byte(`{
	  "nftables": [
	    {"metainfo": {"version": "1.0.9"}},
	    {"rule": {"expr": [
	      {"match": {"left": {"meta": {"key": "iifname"}}, "right": "br-awg-egress"}},
	      {"match": {"left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": "198.51.100.10"}},
	      {"counter": {"packets": 42, "bytes": 4096}}
	    ]}}
	  ]
	}`)
	got, err := ParseCountersJSON(sample)
	if err != nil {
		t.Fatal(err)
	}
	if c := got["198.51.100.10"]; c.Packets != 42 || c.Bytes != 4096 {
		t.Fatalf("unexpected parsed counter: %+v", c)
	}
}
