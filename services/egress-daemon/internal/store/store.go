package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"amnezia-egressd/internal/types"
)

const maxStateFileBytes = 4 * 1024 * 1024

// Store manages atomic persistence of DesiredState on the host filesystem.
type Store struct {
	path string
}

// New creates a Store backed by path (e.g. /etc/amnezia-egress/state.json).
func New(path string) *Store {
	return &Store{path: path}
}

// Path returns the configured state file path.
func (s *Store) Path() string {
	return s.path
}

// Load reads and validates DesiredState from disk, returning DefaultDesiredState when absent.
func (s *Store) Load() (types.DesiredState, error) {
	if s.path == "" {
		return types.DefaultDesiredState(), nil
	}
	info, err := os.Lstat(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return types.DefaultDesiredState(), nil
		}
		return types.DesiredState{}, fmt.Errorf("stat state file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return types.DesiredState{}, fmt.Errorf("state file must not be a symlink: %s", s.path)
	}
	if !info.Mode().IsRegular() {
		return types.DesiredState{}, fmt.Errorf("state path must be a regular file: %s", s.path)
	}
	if info.Size() > maxStateFileBytes {
		return types.DesiredState{}, fmt.Errorf("state file exceeds %d bytes", maxStateFileBytes)
	}

	raw, err := os.ReadFile(s.path)
	if err != nil {
		return types.DesiredState{}, fmt.Errorf("read state file: %w", err)
	}
	var state types.DesiredState
	if err := json.Unmarshal(raw, &state); err != nil {
		return types.DesiredState{}, fmt.Errorf("parse state JSON: %w", err)
	}
	if err := types.NormalizeAndValidateDesiredState(&state); err != nil {
		return types.DesiredState{}, fmt.Errorf("validate state JSON: %w", err)
	}
	return state, nil
}

// Save atomically persists DesiredState with 0600 file permissions (0700 parent dir).
func (s *Store) Save(state types.DesiredState) error {
	if s.path == "" {
		return nil
	}
	if err := types.NormalizeAndValidateDesiredState(&state); err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	if info, err := os.Lstat(s.path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to write through symlink state file: %s", s.path)
	}

	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state JSON: %w", err)
	}
	encoded = append(encoded, '\n')

	tmp, err := os.CreateTemp(dir, ".state-*.json.tmp")
	if err != nil {
		return fmt.Errorf("create temp state file: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod temp state file: %w", err)
	}
	if _, err := tmp.Write(encoded); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp state file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync temp state file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp state file: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return fmt.Errorf("rename state file: %w", err)
	}
	cleanup = false
	return nil
}
