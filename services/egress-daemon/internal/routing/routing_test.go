package routing

import (
	"net/netip"
	"testing"

	"amnezia-egressd/internal/nft"
	"amnezia-egressd/internal/types"
)

func TestDesiredRoutesFromExitsDeduplicatesAndFilters(t *testing.T) {
	exits := []nft.EvaluatedExit{
		{
			Desired:          types.DesiredExit{IPv4: "198.51.100.10"},
			Active:           true,
			NeedsPolicyTable: false,
		},
		{
			Desired:          types.DesiredExit{IPv4: "203.0.113.20"},
			Active:           true,
			NeedsPolicyTable: true,
			RoutingTableID:   201,
			Fwmark:           types.FwmarkForTable(201),
			ResolvedGateway:  netip.MustParseAddr("203.0.113.1"),
			InterfaceName:    "ens3",
			LinkIndex:        2,
		},
		{
			Desired:          types.DesiredExit{IPv4: "192.0.2.30"},
			Active:           false,
			NeedsPolicyTable: true,
			RoutingTableID:   202,
		},
	}

	got, err := DesiredRoutesFromExits(exits)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].TableID != 201 || got[0].Fwmark != 0x0000ae01 {
		t.Fatalf("unexpected specs: %+v", got)
	}

	merged, err := DesiredRoutesFromInput(SyncInput{
		ActiveExits: exits,
		ExtraRoutes: []RouteSpec{
			{TableID: 201, Gateway: netip.MustParseAddr("203.0.113.1"), LinkIndex: 2, IfaceName: "ens3"},
			{TableID: 203, Gateway: netip.MustParseAddr("198.51.100.1"), LinkIndex: 3, IfaceName: "ens4"},
		},
		BridgeName:        "br-awg-egress",
		Awg3ContainerIPv4: "172.30.90.2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != 2 || merged[1].TableID != 203 || merged[1].Fwmark != types.FwmarkForTable(203) {
		t.Fatalf("unexpected merged specs: %+v", merged)
	}
}
