package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"amnezia-egressd/internal/netdisc"
	"amnezia-egressd/internal/nft"
	"amnezia-egressd/internal/routing"
	"amnezia-egressd/internal/store"
	"amnezia-egressd/internal/types"
	"amnezia-egressd/internal/verify"
)

// SwitchRunner executes the host script that atomically flips masquerade <-> routed.
type SwitchRunner interface {
	SwitchMode(ctx context.Context, mode types.EgressMode) error
}

// ScriptSwitchRunner runs <nodeDir>/scripts/switch-egress-mode.sh.
type ScriptSwitchRunner struct {
	NodeDir string
}

func (r ScriptSwitchRunner) SwitchMode(ctx context.Context, mode types.EgressMode) error {
	script := filepath.Join(r.NodeDir, "scripts", "switch-egress-mode.sh")
	cmd := exec.CommandContext(ctx, "/bin/sh", script, string(mode))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("switch-egress-mode.sh %s failed: %w (%s)", mode, err, types.ClipDetail(string(out), 280))
	}
	return nil
}

// Manager coordinates persisted state, kernel netfilter/routing reconciliation,
// host network reporting, peer updates, and switch-mode serialization.
type Manager struct {
	version    string
	bridgeName string
	nodeDir    string
	store      *store.Store
	netClient  netdisc.SnapshotClient
	nftApplier nft.Applier
	routeMgr   routing.Manager
	switcher   SwitchRunner
	verifyExit func(ctx context.Context, req types.VerifyExitRequest) types.VerifyExitResponse
	httpCheck  func(ctx context.Context, req types.HttpCheckRequest) types.HttpCheckResponse
	now        func() time.Time

	stateMu  sync.Mutex
	switchMu sync.Mutex
}

// ManagerConfig configures a Manager.
type ManagerConfig struct {
	Version    string
	BridgeName string
	NodeDir    string
	Store      *store.Store
	NetClient  netdisc.SnapshotClient
	NftApplier nft.Applier
	RouteMgr   routing.Manager
	Switcher   SwitchRunner
}

// NewManager constructs a ready-to-use Manager.
func NewManager(cfg ManagerConfig) *Manager {
	bridgeName := cfg.BridgeName
	if bridgeName == "" {
		bridgeName = "br-awg-egress"
	}
	switcher := cfg.Switcher
	if switcher == nil {
		switcher = ScriptSwitchRunner{NodeDir: cfg.NodeDir}
	}
	return &Manager{
		version:    cfg.Version,
		bridgeName: bridgeName,
		nodeDir:    cfg.NodeDir,
		store:      cfg.Store,
		netClient:  cfg.NetClient,
		nftApplier: cfg.NftApplier,
		routeMgr:   cfg.RouteMgr,
		switcher:   switcher,
		verifyExit: verify.VerifyExit,
		httpCheck:  verify.RunHttpCheck,
		now:        time.Now,
	}
}

// GetState returns the persisted DesiredState.
func (m *Manager) GetState() (types.DesiredState, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	return m.store.Load()
}

// Report returns the bounded (< 4 KiB) HostNetworkReport.
func (m *Manager) Report() (types.HostNetworkReport, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	state, err := m.store.Load()
	if err != nil {
		return types.HostNetworkReport{}, err
	}
	return m.buildReportLocked(state)
}

// Reconcile reloads DesiredState from disk and reapplies kernel rules if host is in routed mode.
func (m *Manager) Reconcile() (types.ApplyStateResponse, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	state, err := m.store.Load()
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	return m.applyLocked(state, false, nil)
}

// ApplyState validates, persists, and (if host is in routed mode) atomically applies DesiredState.
// It NEVER alters masquerade <-> routed mode.
func (m *Manager) ApplyState(newState types.DesiredState) (types.ApplyStateResponse, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	if err := types.NormalizeAndValidateDesiredState(&newState); err != nil {
		return types.ApplyStateResponse{}, err
	}
	prev, err := m.store.Load()
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	changedPeers := diffChangedPeerIPs(prev.Peers, newState.Peers)
	return m.applyLocked(newState, true, changedPeers)
}

// UpsertPeer updates or appends one peer in DesiredState and syncs kernel rules when active.
func (m *Manager) UpsertPeer(peer types.DesiredPeer) (types.ApplyStateResponse, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	state, err := m.store.Load()
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	if err := types.NormalizeAndValidateDesiredState(&types.DesiredState{
		SchemaVersion: 1,
		Peers:         []types.DesiredPeer{peer},
	}); err != nil {
		return types.ApplyStateResponse{}, err
	}
	peerAddr, _ := types.ParseIPv4(peer.TunnelIPv4)
	peer.TunnelIPv4 = peerAddr.String()

	prevPeers := append([]types.DesiredPeer(nil), state.Peers...)
	replaced := false
	for i := range state.Peers {
		if state.Peers[i].TunnelIPv4 == peer.TunnelIPv4 {
			state.Peers[i] = peer
			replaced = true
			break
		}
	}
	if !replaced {
		state.Peers = append(state.Peers, peer)
	}
	if err := types.NormalizeAndValidateDesiredState(&state); err != nil {
		return types.ApplyStateResponse{}, err
	}
	return m.applyLocked(state, true, diffChangedPeerIPs(prevPeers, state.Peers))
}

// RemovePeer deletes one peer from DesiredState, syncs kernel rules, and flushes its conntrack entries.
func (m *Manager) RemovePeer(tunnelIPv4 string) (types.ApplyStateResponse, error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()

	addr, err := types.ParseIPv4(tunnelIPv4)
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	target := addr.String()

	state, err := m.store.Load()
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	filtered := make([]types.DesiredPeer, 0, len(state.Peers))
	removed := false
	for _, p := range state.Peers {
		if p.TunnelIPv4 == target {
			removed = true
			continue
		}
		filtered = append(filtered, p)
	}
	if !removed {
		report, repErr := m.buildReportLocked(state)
		if repErr != nil {
			return types.ApplyStateResponse{}, repErr
		}
		return types.ApplyStateResponse{OK: true, Report: &report}, nil
	}
	state.Peers = filtered
	return m.applyLocked(state, true, []string{target})
}

// SwitchMode serializes mode transition via switchMu WITHOUT holding stateMu, preventing
// re-entrant deadlocks if switch-egress-mode.sh calls POST /v1/reconcile on this socket.
func (m *Manager) SwitchMode(ctx context.Context, mode types.EgressMode) (types.SwitchModeResponse, error) {
	if mode != types.ModeMasquerade && mode != types.ModeRouted {
		return types.SwitchModeResponse{}, fmt.Errorf("invalid egress mode %q", mode)
	}

	m.switchMu.Lock()
	defer m.switchMu.Unlock()

	if err := m.switcher.SwitchMode(ctx, mode); err != nil {
		return types.SwitchModeResponse{OK: false, Error: err.Error()}, nil
	}
	report, err := m.Report()
	if err != nil {
		return types.SwitchModeResponse{OK: false, Error: err.Error()}, nil
	}
	return types.SwitchModeResponse{OK: true, Report: &report}, nil
}

// Teardown removes only amnezia-egressd nftables tables, proto-99 routes, ip rules, and DOCKER-USER hooks.
func (m *Manager) Teardown() error {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	var errs []string
	if err := m.nftApplier.Teardown(); err != nil {
		errs = append(errs, err.Error())
	}
	if err := m.routeMgr.Teardown(m.bridgeName); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// VerifyExit performs source-bound HTTP + DNS verification for an Exit IP.
func (m *Manager) VerifyExit(ctx context.Context, req types.VerifyExitRequest) types.VerifyExitResponse {
	if req.Fwmark == 0 {
		req.Fwmark = m.resolveExitFwmark(req.EgressIPv4)
	}
	return m.verifyExit(ctx, req)
}

// RunHttpCheck performs a source-bound HTTP request for node-agent service checks.
func (m *Manager) RunHttpCheck(ctx context.Context, req types.HttpCheckRequest) types.HttpCheckResponse {
	if req.Fwmark == 0 {
		req.Fwmark = m.resolveExitFwmark(req.EgressIPv4)
	}
	return m.httpCheck(ctx, req)
}

func (m *Manager) resolveExitFwmark(egressIPv4 string) uint32 {
	addr, err := types.ParseIPv4(egressIPv4)
	if err != nil {
		return 0
	}
	target := addr.String()

	m.stateMu.Lock()
	state, loadErr := m.store.Load()
	m.stateMu.Unlock()
	if loadErr != nil {
		return 0
	}
	snap, discErr := netdisc.Discover(m.netClient, m.bridgeName, m.nodeDir)
	if discErr != nil {
		return 0
	}
	plan := nft.BuildPlan(state, snap, m.bridgeName)
	for _, ev := range plan.EvaluatedExits {
		if ev.Desired.IPv4 == target && ev.NeedsPolicyTable && ev.Fwmark != 0 {
			return ev.Fwmark
		}
	}
	return 0
}

func (m *Manager) applyLocked(state types.DesiredState, persist bool, flushPeers []string) (types.ApplyStateResponse, error) {
	snap, err := netdisc.Discover(m.netClient, m.bridgeName, m.nodeDir)
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	plan := nft.BuildPlan(state, snap, m.bridgeName)

	if persist {
		// Validate nft syntax before persisting whenever nft exists on the host.
		if _, err := exec.LookPath("nft"); err == nil {
			if err := m.nftApplier.Check(plan.Ruleset); err != nil {
				return types.ApplyStateResponse{}, err
			}
		}
		if err := m.store.Save(state); err != nil {
			return types.ApplyStateResponse{}, err
		}
	}

	if snap.EnvEgressMode == types.ModeRouted {
		extraRoutes := make([]routing.RouteSpec, 0, len(plan.EntryRoutes))
		for _, er := range plan.EntryRoutes {
			extraRoutes = append(extraRoutes, routing.RouteSpec{
				TableID:   er.TableID,
				Fwmark:    er.Fwmark,
				Gateway:   er.ResolvedGateway,
				LinkIndex: er.LinkIndex,
				IfaceName: er.InterfaceName,
			})
		}
		if err := m.routeMgr.Sync(routing.SyncInput{
			ActiveExits:       plan.ActiveExits,
			ExtraRoutes:       extraRoutes,
			BridgeName:        m.bridgeName,
			Awg3ContainerIPv4: snap.Awg3ContainerIPv4,
		}); err != nil {
			return types.ApplyStateResponse{}, err
		}
		if err := m.nftApplier.Apply(plan.Ruleset); err != nil {
			return types.ApplyStateResponse{}, err
		}
		if len(flushPeers) > 0 {
			_ = m.routeMgr.FlushPeers(flushPeers)
		}
	}

	report, err := m.buildReportLocked(state)
	if err != nil {
		return types.ApplyStateResponse{}, err
	}
	return types.ApplyStateResponse{
		OK:       true,
		Warnings: plan.Warnings,
		Report:   &report,
	}, nil
}

func (m *Manager) buildReportLocked(state types.DesiredState) (types.HostNetworkReport, error) {
	snap, err := netdisc.Discover(m.netClient, m.bridgeName, m.nodeDir)
	if err != nil {
		return types.HostNetworkReport{}, err
	}
	plan := nft.BuildPlan(state, snap, m.bridgeName)
	counters, _ := m.nftApplier.ReadExitCounters()

	ipAddresses := make([]types.DetectedIPv4, 0, len(snap.IPv4s))
	for _, d := range snap.IPv4s {
		ipAddresses = append(ipAddresses, d.DetectedIPv4)
	}

	exits := make([]types.ExitStatus, 0, len(plan.EvaluatedExits))
	for _, ev := range plan.EvaluatedExits {
		c := counters[ev.Desired.IPv4]
		gw := ""
		if ev.ResolvedGateway.IsValid() {
			gw = ev.ResolvedGateway.String()
		}
		exits = append(exits, types.ExitStatus{
			IPv4:                ev.Desired.IPv4,
			HostState:           ev.HostState,
			Detail:              types.ClipDetail(ev.Detail, 180),
			ObservedSubnetCIDR:  ev.ObservedCIDR,
			DetectedGatewayIPv4: gw,
			TxBytes:             c.Bytes,
			TxPackets:           c.Packets,
		})
	}

	observedMode := snap.EnvEgressMode
	var egressState types.EgressState
	var detail string

	if observedMode == types.ModeRouted {
		switch {
		case snap.TunnelSubnetConflict:
			egressState = types.StateConflict
			detail = "foreign route overlaps 10.90.0.0/22"
		case !snap.BridgePresent:
			egressState = types.StateDegraded
			detail = fmt.Sprintf("bridge interface %s not present", m.bridgeName)
		case !snap.NftTablePresent:
			egressState = types.StateDegraded
			detail = "nftables table ip amnezia_egress not loaded"
		case plan.Degraded:
			egressState = types.StateDegraded
			detail = strings.Join(plan.Warnings, "; ")
		default:
			egressState = types.StateRoutedActive
		}
	} else {
		switch {
		case snap.TunnelSubnetConflict:
			egressState = types.StateConflict
			detail = "foreign route overlaps 10.90.0.0/22"
		case snap.NftTablePresent:
			egressState = types.StateConflict
			detail = "amnezia_egress nftables active while node is configured for masquerade"
		case plan.Degraded:
			egressState = types.StateDegraded
			detail = strings.Join(plan.Warnings, "; ")
		default:
			egressState = types.StateMasqueradeReady
		}
	}

	report := types.HostNetworkReport{
		DaemonVersion:        m.version,
		ObservedMode:         observedMode,
		EgressState:          egressState,
		Detail:               types.ClipDetail(detail, 260),
		BridgeName:           m.bridgeName,
		BridgePresent:        snap.BridgePresent,
		Awg3ContainerIPv4:    snap.Awg3ContainerIPv4,
		TunnelSubnetConflict: snap.TunnelSubnetConflict,
		IPv4Addresses:        ipAddresses,
		Exits:                exits,
		ObservedAt:           m.now().UTC().Format(time.RFC3339),
	}

	compactReportToBudget(&report, types.MaxReportBytes)
	return report, nil
}

func compactReportToBudget(report *types.HostNetworkReport, budget int) {
	if encoded, err := json.Marshal(report); err == nil && len(encoded) <= budget {
		return
	}
	report.Detail = types.ClipDetail(report.Detail, 120)
	for i := range report.Exits {
		report.Exits[i].Detail = types.ClipDetail(report.Exits[i].Detail, 80)
	}
	for len(report.IPv4Addresses) > 1 {
		encoded, err := json.Marshal(report)
		if err == nil && len(encoded) <= budget {
			return
		}
		report.IPv4Addresses = report.IPv4Addresses[:len(report.IPv4Addresses)-1]
	}
}

func diffChangedPeerIPs(prev, next []types.DesiredPeer) []string {
	prevByIP := make(map[string]types.DesiredPeer, len(prev))
	for _, p := range prev {
		prevByIP[p.TunnelIPv4] = p
	}
	nextByIP := make(map[string]types.DesiredPeer, len(next))
	for _, p := range next {
		nextByIP[p.TunnelIPv4] = p
	}

	changedSet := make(map[string]bool)
	for ip, oldP := range prevByIP {
		newP, exists := nextByIP[ip]
		if !exists || newP != oldP {
			changedSet[ip] = true
		}
	}
	for ip, newP := range nextByIP {
		if oldP, exists := prevByIP[ip]; exists && oldP != newP {
			changedSet[ip] = true
		}
	}

	out := make([]string, 0, len(changedSet))
	for ip := range changedSet {
		out = append(out, ip)
	}
	return out
}
