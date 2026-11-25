//go:build !linux

package main

import "context"

func watchHostNetworkChanges(_ context.Context, _ func()) {}
