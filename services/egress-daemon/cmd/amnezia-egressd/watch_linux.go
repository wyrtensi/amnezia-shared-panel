//go:build linux

package main

import (
	"context"
	"log"
	"time"

	"github.com/vishvananda/netlink"
)

func watchHostNetworkChanges(ctx context.Context, onChange func()) {
	periodic := time.NewTicker(5 * time.Minute)
	defer periodic.Stop()

	for ctx.Err() == nil {
		watchOnce(ctx, periodic.C, onChange)
		if ctx.Err() != nil {
			return
		}
		log.Printf("netlink watcher stream closed; reconnecting in 2s")
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func watchOnce(ctx context.Context, periodicC <-chan time.Time, onChange func()) {
	addrCh := make(chan netlink.AddrUpdate, 32)
	linkCh := make(chan netlink.LinkUpdate, 32)
	routeCh := make(chan netlink.RouteUpdate, 32)
	doneCh := make(chan struct{})
	defer close(doneCh)

	if err := netlink.AddrSubscribe(addrCh, doneCh); err != nil {
		log.Printf("netlink AddrSubscribe failed: %v", err)
		addrCh = nil
	}
	if err := netlink.LinkSubscribe(linkCh, doneCh); err != nil {
		log.Printf("netlink LinkSubscribe failed: %v", err)
		linkCh = nil
	}
	if err := netlink.RouteSubscribe(routeCh, doneCh); err != nil {
		log.Printf("netlink RouteSubscribe failed: %v", err)
		routeCh = nil
	}

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
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()

	for {
		if addrCh == nil && linkCh == nil && routeCh == nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case _, ok := <-addrCh:
			if !ok {
				return
			}
			resetTimer()
		case _, ok := <-linkCh:
			if !ok {
				return
			}
			resetTimer()
		case _, ok := <-routeCh:
			if !ok {
				return
			}
			resetTimer()
		case <-periodicC:
			onChange()
		case <-timerCh:
			timerCh = nil
			onChange()
		}
	}
}
