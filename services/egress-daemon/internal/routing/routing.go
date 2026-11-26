package routing

import (
	"fmt"
	"net/netip"

	"amnezia-egressd/internal/nft"
	"amnezia-egressd/internal/types"
)

// RouteSpec describes a desired default route inside one custom table [200..219].
type RouteSpec struct {
	TableID   int
	Fwmark    uint32
	Gateway   netip.Addr
	LinkIndex int
	IfaceName string
}

// SyncInput carries the evaluated exits, entry policy routes, bridge name, and
// AWG3 container IPv4 needed to synchronize Linux policy routing and return routes.
type SyncInput struct {
	ActiveExits       []nft.EvaluatedExit
	ExtraRoutes       []RouteSpec
	BridgeName        string
	Awg3ContainerIPv4 string
}

// Manager owns kernel policy routing (tables 200..219, rules 19900..19920),
// host tunnel return routes in main, rp_filter, DOCKER-USER return rules, and targeted conntrack flushing.
type Manager interface {
	Sync(input SyncInput) error
	Teardown(bridgeName string) error
	FlushPeers(tunnelIPv4s []string) error
}

// DesiredRoutesFromExits extracts deduplicated custom routing table specs.
func DesiredRoutesFromExits(exits []nft.EvaluatedExit) ([]RouteSpec, error) {
	return DesiredRoutesFromInput(SyncInput{ActiveExits: exits})
}

// DesiredRoutesFromInput combines evaluated exits and extra entry policy routes into deduplicated specs.
func DesiredRoutesFromInput(input SyncInput) ([]RouteSpec, error) {
	seen := make(map[int]bool)
	var specs []RouteSpec
	for _, ev := range input.ActiveExits {
		if !ev.Active || !ev.NeedsPolicyTable {
			continue
		}
		if ev.RoutingTableID < types.MinRoutingTableID || ev.RoutingTableID > types.MaxRoutingTableID {
			return nil, fmt.Errorf("exit %s routingTableId %d out of range", ev.Desired.IPv4, ev.RoutingTableID)
		}
		if seen[ev.RoutingTableID] {
			continue
		}
		seen[ev.RoutingTableID] = true
		specs = append(specs, RouteSpec{
			TableID:   ev.RoutingTableID,
			Fwmark:    ev.Fwmark,
			Gateway:   ev.ResolvedGateway,
			LinkIndex: ev.LinkIndex,
			IfaceName: ev.InterfaceName,
		})
	}
	for _, extra := range input.ExtraRoutes {
		if extra.TableID < types.MinRoutingTableID || extra.TableID > types.MaxRoutingTableID {
			return nil, fmt.Errorf("extra route routingTableId %d out of range", extra.TableID)
		}
		if seen[extra.TableID] {
			continue
		}
		if extra.Fwmark == 0 {
			extra.Fwmark = types.FwmarkForTable(extra.TableID)
		}
		seen[extra.TableID] = true
		specs = append(specs, extra)
	}
	return specs, nil
}
