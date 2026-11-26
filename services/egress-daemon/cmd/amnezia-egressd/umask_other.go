//go:build !linux

package main

func setUmask(_ int) int {
	return 0
}
