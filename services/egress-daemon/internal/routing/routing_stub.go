//go:build !linux

package routing

import (
	"fmt"

	"amnezia-egressd/internal/nft"
)

type LinuxManager struct{}

func NewLinuxManager() *LinuxManager {
	return &LinuxManager{}
}

func (m *LinuxManager) Sync(_ []nft.EvaluatedExit, _ string) error {
	return fmt.Errorf("policy routing requires Linux")
}

func (m *LinuxManager) Teardown(_ string) error {
	return fmt.Errorf("policy routing teardown requires Linux")
}

func (m *LinuxManager) FlushPeers(_ []string) error {
	return nil
}
