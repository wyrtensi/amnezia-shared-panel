//go:build linux

package main

import (
	"context"
	"time"

	"github.com/vishvananda/netlink"
)

func watchHostNetworkChanges(ctx context.Context, onChange func()) {
	addrCh := make(chan netlink.AddrUpdate, 16)
	linkCh := make(chan netlink.LinkUpdate, 16)
	doneCh := make(chan struct{})
	defer close(doneCh)

	if err := netlink.AddrSubscribe(addrCh, doneCh); err != nil {
		return
	}
	_ = netlink.LinkSubscribe(linkCh, doneCh)

	var timer *time.Timer
	var timerCh <-chan time.Time
	resetTimer := func() {
		if timer == nil {
			timer = time.NewTimer(1 * time.Second)
			timerCh = timer.C
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(1 * time.Second)
	}

	for {
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case _, ok := <-addrCh:
			if !ok {
				return
			}
			resetTimer()
		case <-linkCh:
			resetTimer()
		case <-timerCh:
			timerCh = nil
			onChange()
		}
	}
}
