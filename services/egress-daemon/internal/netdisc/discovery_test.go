package netdisc

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"amnezia-egressd/internal/types"
)

type fakeClient struct {
	links      []LinkInfo
	addrs      []AddrInfo
	routes     []RouteInfo
	rules      []RuleInfo
	nftPresent bool
}

func (f *fakeClient) Links() ([]LinkInfo, error)     { return f.links, nil }
func (f *fakeClient) AddrsV4() ([]AddrInfo, error)   { return f.addrs, nil }
func (f *fakeClient) RoutesV4() ([]RouteInfo, error) { return f.routes, nil }
func (f *fakeClient) RulesV4() ([]RuleInfo, error)   { return f.rules, nil }
func (f *fakeClient) HasNftTable(_ string) (bool, error) {
	return f.nftPresent, nil
}

func TestDiscoverMultiGatewayAndExcludedInterfaces(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("AWG3_EGRESS_MODE=routed\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	p24 := netip.MustParsePrefix("198.51.100.10/24")
	p23 := netip.MustParsePrefix("203.0.113.20/23")
	p32 := netip.MustParsePrefix("192.0.2.50/32")
	ruleSrc := netip.MustParsePrefix("203.0.113.20/32")
	awgPeer := netip.MustParsePrefix("10.88.0.1/24")
	dormant := netip.MustParsePrefix("172.29.172.1/24")

	client := &fakeClient{
		nftPresent: true,
		links: []LinkInfo{
			{Index: 1, Name: "lo", Up: true},
			{Index: 2, Name: "enp1s0", Up: true},
			{Index: 3, Name: "ens3", Up: true},
			{Index: 4, Name: "br-awg-egress", Up: true},
			{Index: 5, Name: "awg0", Up: true},
			{Index: 6, Name: "amn0", Up: true},
		},
		addrs: []AddrInfo{
			{LinkIndex: 1, Prefix: netip.MustParsePrefix("127.0.0.1/8")},
			{LinkIndex: 2, Prefix: p24},
			{LinkIndex: 2, Prefix: p32},
			{LinkIndex: 3, Prefix: p23},
			{LinkIndex: 4, Prefix: netip.MustParsePrefix("172.18.0.1/16")},
			{LinkIndex: 5, Prefix: awgPeer},
			{LinkIndex: 6, Prefix: dormant},
		},
		routes: []RouteInfo{
			// Main table default with metric 100
			{Table: 254, LinkIndex: 2, Gw: netip.MustParseAddr("198.51.100.1"), Priority: 100},
			// Cloud secondary table 100 default
			{Table: 100, LinkIndex: 3, Gw: netip.MustParseAddr("203.0.112.1"), Priority: 100},
			// Our own proto 99 table 201 must not affect discovery or conflict flags
			{Table: 201, LinkIndex: 3, Gw: netip.MustParseAddr("203.0.112.1"), Protocol: 99},
		},
		rules: []RuleInfo{
			{Priority: 1000, Table: 100, Src: &ruleSrc},
		},
	}

	snap, err := Discover(client, "br-awg-egress", dir)
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	if !snap.BridgePresent || snap.BridgeLinkIndex != 4 {
		t.Fatalf("expected br-awg-egress index 4, got %+v", snap)
	}
	if snap.Awg3ContainerIPv4 != "172.18.0.2" {
		t.Fatalf("expected derived Awg3ContainerIPv4=172.18.0.2, got %q", snap.Awg3ContainerIPv4)
	}
	if snap.TunnelSubnetConflict {
		t.Fatal("expected no tunnel subnet conflict")
	}
	if snap.EnvEgressMode != types.ModeRouted || !snap.NftTablePresent {
		t.Fatalf("expected routed + nftPresent, got mode=%s nft=%v", snap.EnvEgressMode, snap.NftTablePresent)
	}
	if len(snap.IPv4s) != 3 {
		t.Fatalf("expected 3 WAN IPv4s, got %d (%+v)", len(snap.IPv4s), snap.IPv4s)
	}

	byIP := map[string]DiscoveredIPv4{}
	for _, d := range snap.IPv4s {
		byIP[d.IPv4] = d
	}
	if got := byIP["203.0.113.20"]; got.DetectedGatewayIPv4 != "203.0.112.1" || got.DetectedRuleTable != 100 || !got.UsesCustomRule {
		t.Fatalf("expected table 100 gateway auto-detection for 203.0.113.20, got %+v", got)
	}
	if got := byIP["192.0.2.50"]; got.ResolvedGw.String() != "198.51.100.1" {
		t.Fatalf("expected fallback main gateway for /32 IP, got %+v", got)
	}
}

func TestDiscoverDetectsForeignTunnelSubnetConflict(t *testing.T) {
	foreign := netip.MustParsePrefix("10.90.0.0/24")
	client := &fakeClient{
		links: []LinkInfo{
			{Index: 2, Name: "eth0", Up: true},
			{Index: 3, Name: "br-awg-egress", Up: true},
			{Index: 4, Name: "tun9", Up: true},
		},
		routes: []RouteInfo{
			{Table: 254, LinkIndex: 4, Dst: &foreign},
		},
	}

	snap, err := Discover(client, "br-awg-egress", "")
	if err != nil {
		t.Fatal(err)
	}
	if !snap.TunnelSubnetConflict {
		t.Fatal("expected 10.90.0.0/24 on tun9 to trigger TunnelSubnetConflict")
	}
}

func TestReadEnvEgressModePrefersPersistedStateAndAwg3EnvOverride(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("AWG3_EGRESS_MODE=masquerade\nAWG3_EGRESS_IPV4=172.30.90.5\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ReadEnvEgressMode(envPath); got != types.ModeMasquerade {
		t.Fatalf("expected masquerade from .env, got %s", got)
	}
	stateDir := filepath.Join(dir, "state", "amnezia-awg3")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "egress-mode"), []byte("routed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := ReadEnvEgressMode(envPath); got != types.ModeRouted {
		t.Fatalf("expected persisted egress-mode=routed to override .env, got %s", got)
	}

	client := &fakeClient{
		links: []LinkInfo{{Index: 4, Name: "br-awg-egress", Up: true}},
		addrs: []AddrInfo{{LinkIndex: 4, Prefix: netip.MustParsePrefix("172.30.90.1/29")}},
	}
	snap, err := Discover(client, "br-awg-egress", dir)
	if err != nil {
		t.Fatal(err)
	}
	if snap.EnvEgressMode != types.ModeRouted {
		t.Fatalf("expected routed mode, got %s", snap.EnvEgressMode)
	}
	if snap.Awg3ContainerIPv4 != "172.30.90.5" {
		t.Fatalf("expected AWG3_EGRESS_IPV4 override 172.30.90.5, got %q", snap.Awg3ContainerIPv4)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "container-ipv4"), []byte("172.30.90.4\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	snap2, err := Discover(client, "br-awg-egress", dir)
	if err != nil {
		t.Fatal(err)
	}
	if snap2.Awg3ContainerIPv4 != "172.30.90.4" {
		t.Fatalf("expected live state/amnezia-awg3/container-ipv4 to override .env, got %q", snap2.Awg3ContainerIPv4)
	}
}

func TestDiscoverFiltersNonPublicHostIPsAndKeepsSecondaryNICSeparate(t *testing.T) {
	gwMain := netip.MustParseAddr("198.51.100.1")
	client := &fakeClient{
		links: []LinkInfo{
			{Index: 2, Name: "ens3", Up: true},
			{Index: 3, Name: "ens4", Up: true},
		},
		addrs: []AddrInfo{
			{LinkIndex: 2, Prefix: netip.MustParsePrefix("198.51.100.10/24")},
			{LinkIndex: 3, Prefix: netip.MustParsePrefix("203.0.113.50/24")},
			{LinkIndex: 3, Prefix: netip.MustParsePrefix("10.0.0.5/24")},
			{LinkIndex: 3, Prefix: netip.MustParsePrefix("172.16.5.5/24")},
			{LinkIndex: 3, Prefix: netip.MustParsePrefix("192.168.1.5/24")},
			{LinkIndex: 3, Prefix: netip.MustParsePrefix("100.64.0.5/24")},
		},
		routes: []RouteInfo{
			{Table: 254, LinkIndex: 2, Gw: gwMain},
		},
	}

	snap, err := Discover(client, "br-awg-egress", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.IPv4s) != 2 {
		t.Fatalf("expected only 2 public IPs after filtering RFC1918/CGNAT, got %+v", snap.IPv4s)
	}
	for _, item := range snap.IPv4s {
		if item.IPv4 == "203.0.113.50" && item.ResolvedGw.IsValid() {
			t.Fatalf("secondary NIC ens4 must NOT inherit ens3 main gateway, got %s", item.ResolvedGw)
		}
	}
}
