package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"amnezia-egressd/internal/netdisc"
	"amnezia-egressd/internal/nft"
	"amnezia-egressd/internal/routing"
	"amnezia-egressd/internal/server"
	"amnezia-egressd/internal/store"
	"amnezia-egressd/internal/types"
)

// Version is stamped at build time via -ldflags="-X main.Version=...".
var Version = "1.2.0"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version":
			fmt.Println(Version)
			return
		case "teardown":
			os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
			runTeardown()
			return
		case "reconcile":
			os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
			runReconcile()
			return
		}
	}
	runDaemon()
}

type daemonFlags struct {
	socketPath string
	statePath  string
	bridgeName string
	nodeDir    string
	socketUID  int
}

func parseFlags() daemonFlags {
	var f daemonFlags
	flag.StringVar(&f.socketPath, "socket", "/run/amnezia-egress/egressd.sock", "Unix socket path")
	flag.StringVar(&f.statePath, "state", "/etc/amnezia-egress/state.json", "Persisted desired-state JSON path")
	flag.StringVar(&f.bridgeName, "bridge", "br-awg-egress", "Docker bridge interface for AWG3")
	flag.StringVar(&f.nodeDir, "node-dir", "/opt/amnezia-node", "Amnezia node directory containing .env and scripts/")
	flag.IntVar(&f.socketUID, "socket-uid", 10001, "Unix socket user owner for non-root node-agent access (-1 skips chown)")
	showVer := flag.Bool("version", false, "Print version and exit")
	flag.Parse()
	if *showVer {
		fmt.Println(Version)
		os.Exit(0)
	}
	return f
}

func newManager(f daemonFlags) *server.Manager {
	return server.NewManager(server.ManagerConfig{
		Version:    Version,
		BridgeName: f.bridgeName,
		NodeDir:    f.nodeDir,
		Store:      store.New(f.statePath),
		NetClient:  netdisc.NewLinuxClient(),
		NftApplier: nft.NewExecApplier(),
		RouteMgr:   routing.NewLinuxManager(),
	})
}

func runTeardown() {
	f := parseFlags()
	mgr := newManager(f)
	if err := mgr.Teardown(); err != nil {
		log.Fatalf("teardown error: %v", err)
	}
}

func runReconcile() {
	f := parseFlags()
	// Prefer talking to the running daemon over its Unix socket so state changes serialize properly.
	if f.socketPath != "" {
		if _, err := os.Stat(f.socketPath); err == nil {
			client := &http.Client{
				Timeout: 10 * time.Second,
				Transport: &http.Transport{
					DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
						return (&net.Dialer{}).DialContext(ctx, "unix", f.socketPath)
					},
				},
			}
			req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, "http://unix/v1/reconcile", nil)
			if resp, err := client.Do(req); err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return
				}
			}
		}
	}
	mgr := newManager(f)
	if _, err := mgr.Reconcile(); err != nil {
		log.Fatalf("reconcile error: %v", err)
	}
}

func runDaemon() {
	f := parseFlags()
	mgr := newManager(f)

	if _, err := mgr.Reconcile(); err != nil {
		log.Printf("initial reconcile warning: %v", err)
	}

	sockDir := filepath.Dir(f.socketPath)
	if err := os.MkdirAll(sockDir, 0o755); err != nil {
		log.Fatalf("create socket dir %s: %v", sockDir, err)
	}
	_ = os.Chmod(sockDir, 0o755)
	_ = os.Remove(f.socketPath)

	listener, err := net.Listen("unix", f.socketPath)
	if err != nil {
		log.Fatalf("listen unix socket %s: %v", f.socketPath, err)
	}
	// Socket owned by node-agent UID (10001:0) mode 0600 inside root-owned 0755 dir:
	// node-agent can connect, cannot unlink/replace files in sockDir, and root connects via CAP_DAC_OVERRIDE.
	if f.socketUID >= 0 {
		if err := os.Chown(f.socketPath, f.socketUID, 0); err != nil {
			log.Printf("chown unix socket uid=%d warning: %v", f.socketUID, err)
		}
	} else if envUID := strings.TrimSpace(os.Getenv("EGRESSD_SOCKET_UID")); envUID != "" {
		if uid, pErr := strconv.Atoi(envUID); pErr == nil && uid >= 0 {
			_ = os.Chown(f.socketPath, uid, 0)
		}
	}
	if err := os.Chmod(f.socketPath, 0o600); err != nil {
		log.Fatalf("chmod unix socket: %v", err)
	}

	httpServer := &http.Server{
		Handler:           server.Handler(mgr),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go watchHostNetworkChanges(ctx, func() {
		if _, err := mgr.Reconcile(); err != nil {
			log.Printf("netlink watcher reconcile warning: %v", err)
		}
	})

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		// Graceful shutdown: close socket & watchers while leaving active nftables & proto-99 routes intact (0ms drop).
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		_ = os.Remove(f.socketPath)
	case serveErr := <-errCh:
		if serveErr != nil {
			_ = os.Remove(f.socketPath)
			log.Fatalf("unix socket server error: %v", serveErr)
		}
	}
}

// Keep unused types import referenced cleanly if future subcommands inspect defaults.
var _ = types.DefaultDesiredState
