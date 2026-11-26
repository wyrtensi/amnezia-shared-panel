package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"amnezia-egressd/internal/netdisc"
	"amnezia-egressd/internal/nft"
	"amnezia-egressd/internal/routing"
	"amnezia-egressd/internal/store"
	"amnezia-egressd/internal/types"
)

type stubNetClient struct {
	nftPresent bool
}

func (s *stubNetClient) Links() ([]netdisc.LinkInfo, error) {
	return []netdisc.LinkInfo{
		{Index: 2, Name: "ens3", Up: true},
		{Index: 3, Name: "br-awg-egress", Up: true},
	}, nil
}

func (s *stubNetClient) AddrsV4() ([]netdisc.AddrInfo, error) {
	return []netdisc.AddrInfo{
		{LinkIndex: 2, Prefix: netip.MustParsePrefix("198.51.100.10/24")},
		{LinkIndex: 2, Prefix: netip.MustParsePrefix("203.0.113.20/24")},
	}, nil
}

func (s *stubNetClient) RoutesV4() ([]netdisc.RouteInfo, error) {
	return []netdisc.RouteInfo{
		{Table: 254, LinkIndex: 2, Gw: netip.MustParseAddr("198.51.100.1")},
	}, nil
}

func (s *stubNetClient) RulesV4() ([]netdisc.RuleInfo, error) { return nil, nil }
func (s *stubNetClient) HasNftTable(_ string) (bool, error)  { return s.nftPresent, nil }

type stubApplier struct {
	mu       sync.Mutex
	checks   int
	applies  int
	teardown int
	lastRule string
	counters map[string]nft.CounterStats
	netStub  *stubNetClient
}

func (a *stubApplier) Check(ruleset string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.checks++
	a.lastRule = ruleset
	return nil
}

func (a *stubApplier) Apply(ruleset string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.applies++
	a.lastRule = ruleset
	a.netStub.nftPresent = true
	return nil
}

func (a *stubApplier) Teardown() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.teardown++
	a.netStub.nftPresent = false
	return nil
}

func (a *stubApplier) ReadExitCounters() (map[string]nft.CounterStats, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.counters, nil
}

type stubRouteMgr struct {
	mu         sync.Mutex
	syncs      int
	lastInput  routing.SyncInput
	flushed    []string
}

func (r *stubRouteMgr) Sync(input routing.SyncInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.syncs++
	r.lastInput = input
	return nil
}

func (r *stubRouteMgr) Teardown(_ string) error { return nil }
func (r *stubRouteMgr) FlushPeers(peers []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.flushed = append(r.flushed, peers...)
	return nil
}

type stubSwitcher struct {
	nodeDir string
	mgr     *Manager
}

func (s *stubSwitcher) SwitchMode(_ context.Context, mode types.EgressMode) error {
	// Simulate switch-egress-mode.sh updating .env and calling Reconcile() back into Manager!
	// This directly tests there is no mutex deadlock during switch-mode.
	if err := os.WriteFile(filepath.Join(s.nodeDir, ".env"), []byte("AWG3_EGRESS_MODE="+string(mode)+"\n"), 0o600); err != nil {
		return err
	}
	if mode == types.ModeRouted {
		_, err := s.mgr.Reconcile()
		return err
	}
	return s.mgr.Teardown()
}

var _ routing.Manager = (*stubRouteMgr)(nil)

func TestPutStateInMasqueradeStagesWithoutApplying(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("AWG3_EGRESS_MODE=masquerade\n"), 0o600)

	netStub := &stubNetClient{}
	applier := &stubApplier{netStub: netStub}
	routeMgr := &stubRouteMgr{}

	mgr := NewManager(ManagerConfig{
		Version:    "1.2.0-test",
		BridgeName: "br-awg-egress",
		NodeDir:    dir,
		Store:      store.New(filepath.Join(dir, "state.json")),
		NetClient:  netStub,
		NftApplier: applier,
		RouteMgr:   routeMgr,
	})

	h := Handler(mgr)

	payload := types.DesiredState{
		SchemaVersion:  1,
		BlockSMTP:      true,
		IsolatePrivate: true,
		Exits: []types.DesiredExit{
			{ID: "e1", IPv4: "198.51.100.10", DNSPrimary: "1.1.1.1", AmneziaDNSDNAT: true, Enabled: true},
		},
		Peers: []types.DesiredPeer{
			{TunnelIPv4: "10.90.0.2", ExitIP: "198.51.100.10", AmneziaDNSDNAT: true, Enabled: true},
		},
	}
	raw, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPut, "/v1/state", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if applier.applies != 0 {
		t.Fatalf("PUT /v1/state must NEVER activate routed nftables while .env says masquerade")
	}

	var applyResp types.ApplyStateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &applyResp); err != nil {
		t.Fatal(err)
	}
	if applyResp.Report.ObservedMode != types.ModeMasquerade || applyResp.Report.EgressState != types.StateMasqueradeReady {
		t.Fatalf("unexpected report: %+v", applyResp.Report)
	}
}

func TestSwitchModeDoesNotDeadlockOnReconcileCallbackAndUpsertsFlushConntrack(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("AWG3_EGRESS_MODE=masquerade\n"), 0o600)

	netStub := &stubNetClient{}
	applier := &stubApplier{
		netStub: netStub,
		counters: map[string]nft.CounterStats{
			"198.51.100.10": {Bytes: 2048, Packets: 16},
		},
	}
	routeMgr := &stubRouteMgr{}

	sw := &stubSwitcher{nodeDir: dir}
	mgr := NewManager(ManagerConfig{
		Version:    "1.2.0-test",
		BridgeName: "br-awg-egress",
		NodeDir:    dir,
		Store:      store.New(filepath.Join(dir, "state.json")),
		NetClient:  netStub,
		NftApplier: applier,
		RouteMgr:   routeMgr,
		Switcher:   sw,
	})
	sw.mgr = mgr

	// Pre-warm state
	_, err := mgr.ApplyState(types.DesiredState{
		SchemaVersion: 1,
		Exits: []types.DesiredExit{
			{ID: "e1", IPv4: "198.51.100.10", DNSPrimary: "1.1.1.1", Enabled: true},
			{ID: "e2", IPv4: "203.0.113.20", DNSPrimary: "9.9.9.9", Enabled: true},
		},
		Peers: []types.DesiredPeer{
			{TunnelIPv4: "10.90.0.2", ExitIP: "198.51.100.10", Enabled: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	h := Handler(mgr)

	// Switch to routed -> triggers callback to mgr.Reconcile()
	req := httptest.NewRequest(http.MethodPost, "/v1/switch-mode", bytes.NewReader([]byte(`{"mode":"routed"}`)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch-mode failed: %d %s", rec.Code, rec.Body.String())
	}
	var swResp types.SwitchModeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &swResp); err != nil {
		t.Fatal(err)
	}
	if !swResp.OK || swResp.Report.EgressState != types.StateRoutedActive {
		t.Fatalf("expected routed_active, got %+v", swResp)
	}
	if swResp.Report.Exits[0].TxBytes != 2048 {
		t.Fatalf("expected TxBytes=2048, got %+v", swResp.Report.Exits[0])
	}

	// Reassign peer to second exit -> triggers conntrack flush on 10.90.0.2
	upsertReq := httptest.NewRequest(http.MethodPost, "/v1/peers/upsert", bytes.NewReader([]byte(`{"peer":{"tunnelIpv4":"10.90.0.2","exitIp":"203.0.113.20","enabled":true}}`)))
	upsertRec := httptest.NewRecorder()
	h.ServeHTTP(upsertRec, upsertReq)
	if upsertRec.Code != http.StatusOK {
		t.Fatalf("upsert failed: %d %s", upsertRec.Code, upsertRec.Body.String())
	}
	if len(routeMgr.flushed) != 1 || routeMgr.flushed[0] != "10.90.0.2" {
		t.Fatalf("expected conntrack flush on 10.90.0.2, got %+v", routeMgr.flushed)
	}
}

func TestReportStaysUnderCompactBudget(t *testing.T) {
	dir := t.TempDir()
	report := types.HostNetworkReport{
		DaemonVersion: "1.2.0",
		ObservedMode:  types.ModeRouted,
		EgressState:   types.StateRoutedActive,
		BridgeName:    "br-awg-egress",
		BridgePresent: true,
		ObservedAt:    "2026-11-25T10:00:00Z",
	}
	for i := 0; i < 60; i++ {
		report.IPv4Addresses = append(report.IPv4Addresses, types.DetectedIPv4{
			IPv4:          "198.51.100.1",
			CIDR:          "198.51.100.1/24",
			InterfaceName: "eth0",
		})
	}
	compactReportToBudget(&report, types.MaxReportBytes)
	raw, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	_ = dir
	if len(raw) > types.MaxReportBytes {
		t.Fatalf("expected compacted report <= %d bytes, got %d", types.MaxReportBytes, len(raw))
	}
}

func TestVerifyExitAndHttpCheckResolveExitFwmark(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("AWG3_EGRESS_MODE=routed\nAWG3_EGRESS_IPV4=172.30.90.2\n"), 0o600)

	netStub := &stubNetClient{nftPresent: true}
	applier := &stubApplier{netStub: netStub}
	routeMgr := &stubRouteMgr{}

	mgr := NewManager(ManagerConfig{
		Version:    "1.2.0-test",
		BridgeName: "br-awg-egress",
		NodeDir:    dir,
		Store:      store.New(filepath.Join(dir, "state.json")),
		NetClient:  netStub,
		NftApplier: applier,
		RouteMgr:   routeMgr,
	})

	_, err := mgr.ApplyState(types.DesiredState{
		SchemaVersion: 1,
		Exits: []types.DesiredExit{
			{
				ID:             "e2",
				IPv4:           "203.0.113.20",
				GatewayIPv4:    "203.0.113.1",
				RoutingTableID: 201,
				DNSPrimary:     "1.1.1.1",
				Enabled:        true,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if routeMgr.lastInput.Awg3ContainerIPv4 != "172.30.90.2" {
		t.Fatalf("expected SyncInput.Awg3ContainerIPv4=172.30.90.2, got %q", routeMgr.lastInput.Awg3ContainerIPv4)
	}

	var gotVerifyMark uint32
	mgr.verifyExit = func(_ context.Context, req types.VerifyExitRequest) types.VerifyExitResponse {
		gotVerifyMark = req.Fwmark
		return types.VerifyExitResponse{OK: true, EgressIPv4: req.EgressIPv4}
	}
	var gotHTTPMark uint32
	mgr.httpCheck = func(_ context.Context, req types.HttpCheckRequest) types.HttpCheckResponse {
		gotHTTPMark = req.Fwmark
		return types.HttpCheckResponse{Status: 200}
	}

	mgr.VerifyExit(context.Background(), types.VerifyExitRequest{
		EgressIPv4: "203.0.113.20",
		ProbeURL:   "https://example.com",
	})
	mgr.RunHttpCheck(context.Background(), types.HttpCheckRequest{
		EgressIPv4: "203.0.113.20",
		URL:        "https://example.com",
	})

	wantMark := types.FwmarkForTable(201)
	if gotVerifyMark != wantMark || gotHTTPMark != wantMark {
		t.Fatalf("expected resolved fwmark 0x%x for both verify (0x%x) and httpCheck (0x%x)", wantMark, gotVerifyMark, gotHTTPMark)
	}
}
