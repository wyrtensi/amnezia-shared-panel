//go:build linux

package main

import "syscall"

func setUmask(mask int) int {
	return syscall.Umask(mask)
}
