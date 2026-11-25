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

// Manager owns kernel policy routing (tables 200..219, rules 19900..19920),
// rp_filter, DOCKER-USER return rules, and targeted conntrack flushing.
type Manager interface {
	Sync(exits []nft.EvaluatedExit, bridgeName string) error
	Teardown(bridgeName string) error
	FlushPeers(tunnelIPv4s []string) error
}

// DesiredRoutesFromExits extracts deduplicated custom routing table specs.
func DesiredRoutesFromExits(exits []nft.EvaluatedExit) ([]RouteSpec, error) {
	seen := make(map[int]bool)
	var specs []RouteSpec
	for _, ev := range exits {
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
	return specs, nil
}
