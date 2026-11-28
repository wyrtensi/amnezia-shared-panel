//go:build linux

package verify

import (
	"syscall"

	"golang.org/x/sys/unix"
)

func setSocketMark(rawConn syscall.RawConn, fwmark uint32) error {
	if fwmark == 0 {
		return nil
	}
	var setErr error
	if err := rawConn.Control(func(fd uintptr) {
		setErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_MARK, int(fwmark))
	}); err != nil {
		return err
	}
	return setErr
}
