//go:build linux

package netdisc

import (
	"fmt"
	"net/netip"
	"os/exec"
	"strings"

	"github.com/vishvananda/netlink"
)

// LinuxNetlinkClient implements SnapshotClient against the live Linux kernel via netlink.
type LinuxNetlinkClient struct{}

// NewLinuxClient returns the real Linux netlink SnapshotClient.
func NewLinuxClient() *LinuxNetlinkClient {
	return &LinuxNetlinkClient{}
}

func (c *LinuxNetlinkClient) Links() ([]LinkInfo, error) {
	links, err := netlink.LinkList()
	if err != nil {
		return nil, err
	}
	out := make([]LinkInfo, 0, len(links))
	for _, l := range links {
		attrs := l.Attrs()
		if attrs == nil {
			continue
		}
		out = append(out, LinkInfo{
			Index: attrs.Index,
			Name:  attrs.Name,
			Up:    attrs.Flags&1 != 0,
		})
	}
	return out, nil
}

func (c *LinuxNetlinkClient) AddrsV4() ([]AddrInfo, error) {
	addrs, err := netlink.AddrList(nil, netlink.FAMILY_V4)
	if err != nil {
		return nil, err
	}
	out := make([]AddrInfo, 0, len(addrs))
	for _, a := range addrs {
		if a.IPNet == nil {
			continue
		}
		ip4 := a.IPNet.IP.To4()
		if ip4 == nil {
			continue
		}
		ones, _ := a.IPNet.Mask.Size()
		addr, ok := netip.AddrFromSlice(ip4)
		if !ok {
			continue
		}
		out = append(out, AddrInfo{
			LinkIndex: a.LinkIndex,
			Prefix:    netip.PrefixFrom(addr, ones),
		})
	}
	return out, nil
}

func (c *LinuxNetlinkClient) RoutesV4() ([]RouteInfo, error) {
	filter := &netlink.Route{Table: 0}
	routes, err := netlink.RouteListFiltered(netlink.FAMILY_V4, filter, netlink.RT_FILTER_TABLE)
	if err != nil {
		return nil, err
	}
	out := make([]RouteInfo, 0, len(routes))
	for _, r := range routes {
		ri := RouteInfo{
			Table:     r.Table,
			LinkIndex: r.LinkIndex,
			Priority:  r.Priority,
			Protocol:  int(r.Protocol),
		}
		if r.Dst != nil && r.Dst.IP != nil {
			if ip4 := r.Dst.IP.To4(); ip4 != nil {
				if addr, ok := netip.AddrFromSlice(ip4); ok {
					ones, _ := r.Dst.Mask.Size()
					p := netip.PrefixFrom(addr, ones)
					ri.Dst = &p
				}
			}
		}
		if r.Gw != nil {
			if gw4 := r.Gw.To4(); gw4 != nil {
				if gwAddr, ok := netip.AddrFromSlice(gw4); ok {
					ri.Gw = gwAddr
				}
			}
		}
		out = append(out, ri)
	}
	return out, nil
}

func (c *LinuxNetlinkClient) RulesV4() ([]RuleInfo, error) {
	rules, err := netlink.RuleList(netlink.FAMILY_V4)
	if err != nil {
		return nil, err
	}
	out := make([]RuleInfo, 0, len(rules))
	for _, r := range rules {
		ri := RuleInfo{
			Priority: r.Priority,
			Table:    r.Table,
			Mark:     uint32(r.Mark),
		}
		if r.Src != nil && r.Src.IP != nil {
			if ip4 := r.Src.IP.To4(); ip4 != nil {
				if addr, ok := netip.AddrFromSlice(ip4); ok {
					ones, _ := r.Src.Mask.Size()
					p := netip.PrefixFrom(addr, ones)
					ri.Src = &p
				}
			}
		}
		out = append(out, ri)
	}
	return out, nil
}

func (c *LinuxNetlinkClient) HasNftTable(tableName string) (bool, error) {
	if _, err := exec.LookPath("nft"); err != nil {
		return false, fmt.Errorf("nft binary unavailable: %w", err)
	}
	out, err := exec.Command("nft", "list", "tables", "ip").Output()
	if err != nil {
		return false, err
	}
	target := "table ip " + tableName
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == target {
			return true, nil
		}
	}
	return false, nil
}
