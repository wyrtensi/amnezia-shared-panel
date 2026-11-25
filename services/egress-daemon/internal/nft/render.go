package nft

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"

	"amnezia-egressd/internal/netdisc"
	"amnezia-egressd/internal/types"
)

// PlanResult holds the evaluated exit/peer mappings and rendered nftables ruleset.
type PlanResult struct {
	Ruleset        string
	EvaluatedExits []EvaluatedExit
	ActiveExits    []EvaluatedExit
	Warnings       []string
	Degraded       bool
}

// EvaluatedExit resolves a DesiredExit against the host's live network snapshot.
type EvaluatedExit struct {
	Desired           types.DesiredExit
	HostState         types.ExitHostState
	Detail            string
	ObservedCIDR      string
	InterfaceName     string
	LinkIndex         int
	ResolvedGateway   netip.Addr
	NeedsPolicyTable  bool
	RoutingTableID    int
	Fwmark            uint32
	Active            bool
}

// BuildPlan evaluates exits & peers against the live host snapshot and renders the nftables ruleset.
func BuildPlan(state types.DesiredState, snap netdisc.HostNetworkSnapshot, bridgeName string) PlanResult {
	if bridgeName == "" {
		bridgeName = "br-awg-egress"
	}

	discoveredByIP := make(map[string]netdisc.DiscoveredIPv4, len(snap.IPv4s))
	for _, d := range snap.IPv4s {
		discoveredByIP[d.IPv4] = d
	}

	usedTables := make(map[int]bool)
	for _, ex := range state.Exits {
		if ex.RoutingTableID >= types.MinRoutingTableID && ex.RoutingTableID <= types.MaxRoutingTableID {
			usedTables[ex.RoutingTableID] = true
		}
	}
	allocTable := func() (int, error) {
		for t := types.MinRoutingTableID; t <= types.MaxRoutingTableID; t++ {
			if !usedTables[t] {
				usedTables[t] = true
				return t, nil
			}
		}
		return 0, fmt.Errorf("exhausted custom routing tables [%d..%d]", types.MinRoutingTableID, types.MaxRoutingTableID)
	}

	evaluated := make([]EvaluatedExit, 0, len(state.Exits))
	activeExitByIP := make(map[string]EvaluatedExit, len(state.Exits))
	var activeExits []EvaluatedExit
	var warnings []string
	degraded := false

	for _, ex := range state.Exits {
		ev := EvaluatedExit{
			Desired:        ex,
			RoutingTableID: ex.RoutingTableID,
		}
		if !ex.Enabled {
			ev.HostState = types.ExitDisabled
			ev.Detail = "exit disabled"
			evaluated = append(evaluated, ev)
			continue
		}

		disc, present := discoveredByIP[ex.IPv4]
		if !present {
			ev.HostState = types.ExitMissingIP
			ev.Detail = fmt.Sprintf("IPv4 %s is not assigned on any host WAN interface", ex.IPv4)
			warnings = append(warnings, ev.Detail)
			degraded = true
			evaluated = append(evaluated, ev)
			continue
		}

		ev.ObservedCIDR = disc.CIDR
		ev.LinkIndex = disc.LinkIndex
		ev.InterfaceName = disc.InterfaceName
		if ex.InterfaceName != "" && ex.InterfaceName != disc.InterfaceName {
			ev.HostState = types.ExitGatewayError
			ev.Detail = fmt.Sprintf("IPv4 %s observed on %s, expected %s", ex.IPv4, disc.InterfaceName, ex.InterfaceName)
			warnings = append(warnings, ev.Detail)
			degraded = true
			evaluated = append(evaluated, ev)
			continue
		}

		if ex.GatewayIPv4 != "" {
			gw, err := types.ParseIPv4(ex.GatewayIPv4)
			if err != nil {
				ev.HostState = types.ExitGatewayError
				ev.Detail = err.Error()
				degraded = true
				evaluated = append(evaluated, ev)
				continue
			}
			ev.ResolvedGateway = gw
		} else if disc.ResolvedGw.IsValid() {
			ev.ResolvedGateway = disc.ResolvedGw
		}

		if !ev.ResolvedGateway.IsValid() {
			ev.HostState = types.ExitGatewayError
			ev.Detail = fmt.Sprintf("no IPv4 gateway detected for %s (%s)", ex.IPv4, disc.InterfaceName)
			warnings = append(warnings, ev.Detail)
			degraded = true
			evaluated = append(evaluated, ev)
			continue
		}

		needsTable := ex.GatewayIPv4 != "" ||
			disc.UsesCustomRule ||
			(snap.MainGateway.IsValid() && ev.ResolvedGateway != snap.MainGateway) ||
			(snap.MainGatewayIface != "" && ev.InterfaceName != snap.MainGatewayIface)

		if needsTable {
			if ev.RoutingTableID == 0 {
				tID, err := allocTable()
				if err != nil {
					ev.HostState = types.ExitGatewayError
					ev.Detail = err.Error()
					degraded = true
					evaluated = append(evaluated, ev)
					continue
				}
				ev.RoutingTableID = tID
			}
			ev.NeedsPolicyTable = true
			ev.Fwmark = types.FwmarkForTable(ev.RoutingTableID)
		}

		ev.HostState = types.ExitActive
		ev.Active = true
		evaluated = append(evaluated, ev)
		activeExits = append(activeExits, ev)
		activeExitByIP[ex.IPv4] = ev
	}

	var peerExitPairs []kvPair
	var peerDNSPairs []kvPair
	var peerForceDNSPairs []kvPair
	var peerFwmarkPairs []kvPair
	var allowedPeers []string

	peersSorted := append([]types.DesiredPeer(nil), state.Peers...)
	sort.Slice(peersSorted, func(i, j int) bool {
		return peersSorted[i].TunnelIPv4 < peersSorted[j].TunnelIPv4
	})

	for _, p := range peersSorted {
		if !p.Enabled {
			continue
		}
		ev, ok := activeExitByIP[p.ExitIP]
		if !ok || !ev.Active {
			// Fail-closed: peers bound to missing/disabled exits are excluded from
			// @allowed_active_peers so their traffic drops instead of hitting MASQUERADE.
			continue
		}

		allowedPeers = append(allowedPeers, p.TunnelIPv4)
		peerExitPairs = append(peerExitPairs, kvPair{k: p.TunnelIPv4, v: p.ExitIP})

		dnsPrimary := p.DNSPrimary
		if dnsPrimary == "" {
			dnsPrimary = ev.Desired.DNSPrimary
		}
		if dnsPrimary == "" {
			dnsPrimary = "1.1.1.1"
		}
		amneziaDNS := p.AmneziaDNSDNAT || ev.Desired.AmneziaDNSDNAT
		enforceDNS := p.EnforceDNSDNAT || ev.Desired.EnforceDNSDNAT
		if enforceDNS {
			peerForceDNSPairs = append(peerForceDNSPairs, kvPair{k: p.TunnelIPv4, v: dnsPrimary})
		} else if amneziaDNS {
			peerDNSPairs = append(peerDNSPairs, kvPair{k: p.TunnelIPv4, v: dnsPrimary})
		}

		var mark uint32
		if p.RoutingTableID != 0 {
			mark = types.FwmarkForTable(p.RoutingTableID)
		} else {
			mark = ev.Fwmark
		}
		if mark != 0 {
			peerFwmarkPairs = append(peerFwmarkPairs, kvPair{k: p.TunnelIPv4, v: fmt.Sprintf("0x%08x", mark)})
		}
	}

	// Build secondary Entry IP ct mark rules for strict-uRPF return symmetry.
	type entryMarkRule struct {
		ip   string
		mark uint32
	}
	var entryRules []entryMarkRule
	seenEntryRule := make(map[string]bool)
	for _, em := range state.EntryMarks {
		mark := types.FwmarkForTable(em.RoutingTableID)
		if mark == 0 || seenEntryRule[em.EntryIPv4] {
			continue
		}
		seenEntryRule[em.EntryIPv4] = true
		entryRules = append(entryRules, entryMarkRule{ip: em.EntryIPv4, mark: mark})
	}
	// Also protect any active Exit IP using a custom routing table in case it is dual-use as Entry IP.
	for _, ev := range activeExits {
		if ev.NeedsPolicyTable && ev.Fwmark != 0 && !seenEntryRule[ev.Desired.IPv4] {
			seenEntryRule[ev.Desired.IPv4] = true
			entryRules = append(entryRules, entryMarkRule{ip: ev.Desired.IPv4, mark: ev.Fwmark})
		}
	}
	sort.Slice(entryRules, func(i, j int) bool {
		return entryRules[i].ip < entryRules[j].ip
	})

	sort.Slice(activeExits, func(i, j int) bool {
		return activeExits[i].Desired.IPv4 < activeExits[j].Desired.IPv4
	})

	var b strings.Builder
	b.WriteString("table ip amnezia_egress {\n")
	writeMap(&b, "peer_exit_v4", "ipv4_addr : ipv4_addr", peerExitPairs)
	writeMap(&b, "peer_dns_v4", "ipv4_addr : ipv4_addr", peerDNSPairs)
	writeMap(&b, "peer_force_dns_v4", "ipv4_addr : ipv4_addr", peerForceDNSPairs)
	writeMap(&b, "peer_fwmark", "ipv4_addr : mark", peerFwmarkPairs)
	writeSet(&b, "allowed_active_peers", "ipv4_addr", allowedPeers)
	b.WriteString("\n")

	b.WriteString("  chain mangle_prerouting {\n")
	b.WriteString("    type filter hook prerouting priority -160; policy accept;\n")
	for _, er := range entryRules {
		fmt.Fprintf(
			&b,
			"    iifname != %q ip daddr %s udp dport %d ct mark set 0x%08x\n",
			bridgeName,
			er.ip,
			types.Awg3ListenPort,
			er.mark,
		)
	}
	fmt.Fprintf(
		&b,
		"    iifname %q udp sport %d ct mark & 0x%08x == 0x%08x meta mark set ct mark\n",
		bridgeName,
		types.Awg3ListenPort,
		types.FwmarkMask,
		types.FwmarkBase,
	)
	fmt.Fprintf(
		&b,
		"    iifname %q ip saddr %s meta mark set ip saddr map @peer_fwmark\n",
		bridgeName,
		types.TunnelCIDR,
	)
	b.WriteString("  }\n\n")

	b.WriteString("  chain prerouting {\n")
	b.WriteString("    type nat hook prerouting priority -110; policy accept;\n")
	fmt.Fprintf(
		&b,
		"    iifname %q ip saddr %s ip daddr %s meta l4proto { udp, tcp } th dport 53 dnat ip to ip saddr map @peer_dns_v4 : 53\n",
		bridgeName,
		types.TunnelCIDR,
		types.AmneziaDNSIP,
	)
	fmt.Fprintf(
		&b,
		"    iifname %q ip saddr %s meta l4proto { udp, tcp } th dport 53 dnat ip to ip saddr map @peer_force_dns_v4 : 53\n",
		bridgeName,
		types.TunnelCIDR,
	)
	b.WriteString("  }\n\n")

	b.WriteString("  chain forward {\n")
	b.WriteString("    type filter hook forward priority -10; policy accept;\n")
	if state.BlockSMTP {
		fmt.Fprintf(&b, "    iifname %q ip saddr %s tcp dport 25 counter drop\n", bridgeName, types.TunnelCIDR)
	}
	if state.IsolatePrivate {
		fmt.Fprintf(
			&b,
			"    iifname %q ip saddr %s ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8, 100.64.0.0/10 } counter drop\n",
			bridgeName,
			types.TunnelCIDR,
		)
	}
	fmt.Fprintf(&b, "    iifname %q ip saddr @allowed_active_peers accept\n", bridgeName)
	fmt.Fprintf(&b, "    iifname %q ip saddr %s counter drop\n", bridgeName, types.TunnelCIDR)
	b.WriteString("  }\n\n")

	b.WriteString("  chain postrouting {\n")
	b.WriteString("    type nat hook postrouting priority 90; policy accept;\n")
	fmt.Fprintf(
		&b,
		"    iifname %q ip saddr %s oifname != %q snat ip to ip saddr map @peer_exit_v4\n",
		bridgeName,
		types.TunnelCIDR,
		bridgeName,
	)
	b.WriteString("  }\n\n")

	b.WriteString("  chain tx_accounting {\n")
	b.WriteString("    type filter hook postrouting priority 120; policy accept;\n")
	for _, ev := range activeExits {
		fmt.Fprintf(&b, "    iifname %q ip saddr %s counter\n", bridgeName, ev.Desired.IPv4)
	}
	b.WriteString("  }\n")
	b.WriteString("}\n\n")

	b.WriteString("table ip6 amnezia_egress_v6 {\n")
	b.WriteString("  chain forward {\n")
	b.WriteString("    type filter hook forward priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    iifname %q counter reject with icmpv6 type admin-prohibited\n", bridgeName)
	b.WriteString("  }\n")
	b.WriteString("}\n")

	return PlanResult{
		Ruleset:        b.String(),
		EvaluatedExits: evaluated,
		ActiveExits:    activeExits,
		Warnings:       warnings,
		Degraded:       degraded,
	}
}

type kvPair struct {
	k string
	v string
}

func writeMap(b *strings.Builder, name, spec string, items []kvPair) {
	if len(items) == 0 {
		fmt.Fprintf(b, "  map %s { type %s; }\n", name, spec)
		return
	}
	fmt.Fprintf(b, "  map %s {\n    type %s;\n    elements = {\n", name, spec)
	for i, it := range items {
		comma := ","
		if i == len(items)-1 {
			comma = ""
		}
		fmt.Fprintf(b, "      %s : %s%s\n", it.k, it.v, comma)
	}
	b.WriteString("    }\n  }\n")
}

func writeSet(b *strings.Builder, name, typ string, items []string) {
	if len(items) == 0 {
		fmt.Fprintf(b, "  set %s { type %s; }\n", name, typ)
		return
	}
	fmt.Fprintf(b, "  set %s {\n    type %s;\n    elements = { %s }\n  }\n", name, typ, strings.Join(items, ", "))
}
