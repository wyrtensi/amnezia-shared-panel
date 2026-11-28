//go:build !linux

package verify

import "syscall"

func setSocketMark(_ syscall.RawConn, _ uint32) error {
	return nil
}
