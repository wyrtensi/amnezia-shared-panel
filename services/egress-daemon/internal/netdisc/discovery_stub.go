//go:build !linux

package netdisc

import "fmt"

type LinuxNetlinkClient struct{}

func NewLinuxClient() *LinuxNetlinkClient {
	return &LinuxNetlinkClient{}
}

func (c *LinuxNetlinkClient) Links() ([]LinkInfo, error) {
	return nil, fmt.Errorf("netlink discovery requires Linux")
}

func (c *LinuxNetlinkClient) AddrsV4() ([]AddrInfo, error) {
	return nil, fmt.Errorf("netlink discovery requires Linux")
}

func (c *LinuxNetlinkClient) RoutesV4() ([]RouteInfo, error) {
	return nil, fmt.Errorf("netlink discovery requires Linux")
}

func (c *LinuxNetlinkClient) RulesV4() ([]RuleInfo, error) {
	return nil, fmt.Errorf("netlink discovery requires Linux")
}

func (c *LinuxNetlinkClient) HasNftTable(_ string) (bool, error) {
	return false, fmt.Errorf("nftables requires Linux")
}
