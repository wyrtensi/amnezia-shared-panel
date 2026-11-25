package nft

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// CounterStats holds per-exit TX byte and packet counters read from nftables.
type CounterStats struct {
	Bytes   uint64
	Packets uint64
}

// Applier validates, atomically applies, tears down, and reads counters from nftables.
type Applier interface {
	Check(ruleset string) error
	Apply(ruleset string) error
	Teardown() error
	ReadExitCounters() (map[string]CounterStats, error)
}

// ExecApplier invokes the system `nft` binary atomically via stdin (`nft -f -`).
type ExecApplier struct{}

// NewExecApplier returns an ExecApplier using the host `nft` CLI.
func NewExecApplier() *ExecApplier {
	return &ExecApplier{}
}

func (e *ExecApplier) Check(ruleset string) error {
	cmd := exec.Command("nft", "--check", "-f", "-")
	cmd.Stdin = strings.NewReader(ruleset)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nft --check failed: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (e *ExecApplier) Apply(ruleset string) error {
	if err := e.Check(ruleset); err != nil {
		return err
	}

	// Idempotent atomic reset: ensure both tables exist before deleting them in the
	// same transaction as creating the replacement ruleset.
	var tx strings.Builder
	tx.WriteString("table ip amnezia_egress {}\n")
	tx.WriteString("delete table ip amnezia_egress\n")
	tx.WriteString("table ip6 amnezia_egress_v6 {}\n")
	tx.WriteString("delete table ip6 amnezia_egress_v6\n")
	tx.WriteString(ruleset)

	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = strings.NewReader(tx.String())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nft apply failed: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (e *ExecApplier) Teardown() error {
	script := "table ip amnezia_egress {}\ndelete table ip amnezia_egress\ntable ip6 amnezia_egress_v6 {}\ndelete table ip6 amnezia_egress_v6\n"
	cmd := exec.Command("nft", "-f", "-")
	cmd.Stdin = strings.NewReader(script)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nft teardown failed: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func (e *ExecApplier) ReadExitCounters() (map[string]CounterStats, error) {
	out, err := exec.Command("nft", "-j", "list", "chain", "ip", "amnezia_egress", "tx_accounting").Output()
	if err != nil {
		// When routed mode is off, table/chain doesn't exist — return empty counters.
		return map[string]CounterStats{}, nil
	}
	return ParseCountersJSON(out)
}

// ParseCountersJSON extracts per-exit-IP byte and packet counters from `nft -j list chain`.
func ParseCountersJSON(raw []byte) (map[string]CounterStats, error) {
	var doc struct {
		Nftables []struct {
			Rule *struct {
				Expr []json.RawMessage `json:"expr"`
			} `json:"rule"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("decode nft json: %w", err)
	}

	result := make(map[string]CounterStats)
	for _, entry := range doc.Nftables {
		if entry.Rule == nil {
			continue
		}
		var saddr string
		var stats *CounterStats
		for _, rawExpr := range entry.Rule.Expr {
			var probe map[string]json.RawMessage
			if err := json.Unmarshal(rawExpr, &probe); err != nil {
				continue
			}
			if mRaw, ok := probe["match"]; ok {
				var m struct {
					Left struct {
						Payload *struct {
							Protocol string `json:"protocol"`
							Field    string `json:"field"`
						} `json:"payload"`
					} `json:"left"`
					Right json.RawMessage `json:"right"`
				}
				if err := json.Unmarshal(mRaw, &m); err == nil &&
					m.Left.Payload != nil &&
					m.Left.Payload.Protocol == "ip" &&
					m.Left.Payload.Field == "saddr" {
					var ipStr string
					if err := json.Unmarshal(m.Right, &ipStr); err == nil {
						saddr = ipStr
					}
				}
			}
			if cRaw, ok := probe["counter"]; ok {
				var c struct {
					Packets uint64 `json:"packets"`
					Bytes   uint64 `json:"bytes"`
				}
				if err := json.Unmarshal(cRaw, &c); err == nil {
					stats = &CounterStats{Bytes: c.Bytes, Packets: c.Packets}
				}
			}
		}
		if saddr != "" && stats != nil {
			result[saddr] = *stats
		}
	}
	return result, nil
}
