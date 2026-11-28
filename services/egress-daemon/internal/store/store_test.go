package store

import (
	"os"
	"path/filepath"
	"testing"

	"amnezia-egressd/internal/types"
)

func TestStoreLoadAbsentReturnsDefault(t *testing.T) {
	dir := t.TempDir()
	s := New(filepath.Join(dir, "state.json"))
	got, err := s.Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.SchemaVersion != 1 || !got.BlockSMTP || !got.IsolatePrivate {
		t.Fatalf("unexpected default state: %+v", got)
	}
	if len(got.Exits) != 0 || len(got.Peers) != 0 {
		t.Fatalf("expected empty exits/peers, got %+v", got)
	}
}

func TestStoreSaveAndLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "state.json")
	s := New(path)

	want := types.DesiredState{
		SchemaVersion:  1,
		BlockSMTP:      true,
		IsolatePrivate: false,
		Exits: []types.DesiredExit{
			{
				ID:             "exit-1",
				IPv4:           "198.51.100.10",
				RoutingTableID: 201,
				DNSPrimary:     "9.9.9.9",
				AmneziaDNSDNAT: true,
				Enabled:        true,
			},
		},
		Peers: []types.DesiredPeer{
			{
				TunnelIPv4:     "10.90.0.2",
				ExitIP:         "198.51.100.10",
				DNSPrimary:     "9.9.9.9",
				AmneziaDNSDNAT: true,
				RoutingTableID: 201,
				Enabled:        true,
			},
		},
	}

	if err := s.Save(want); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 perms, got %o", info.Mode().Perm())
	}

	got, err := s.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}
	if len(got.Exits) != 1 || got.Exits[0].IPv4 != "198.51.100.10" {
		t.Fatalf("unexpected loaded exits: %+v", got.Exits)
	}
	if len(got.Peers) != 1 || got.Peers[0].TunnelIPv4 != "10.90.0.2" {
		t.Fatalf("unexpected loaded peers: %+v", got.Peers)
	}
}

func TestStoreRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "state.json")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unsupported in this environment: %v", err)
	}
	s := New(link)
	if _, err := s.Load(); err == nil {
		t.Fatal("expected Load to reject symlink")
	}
	if err := s.Save(types.DefaultDesiredState()); err == nil {
		t.Fatal("expected Save to reject symlink")
	}
}
