package server

import (
	"encoding/json"
	"fmt"
	"net/http"

	"amnezia-egressd/internal/types"
)

const maxRequestBodyBytes = 4 * 1024 * 1024

// Handler returns the HTTP handler exposed over the Unix domain socket.
func Handler(m *Manager) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": m.version})
	})

	mux.HandleFunc("GET /v1/report", func(w http.ResponseWriter, _ *http.Request) {
		report, err := m.Report()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, report)
	})

	mux.HandleFunc("GET /v1/state", func(w http.ResponseWriter, _ *http.Request) {
		state, err := m.GetState()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})

	mux.HandleFunc("PUT /v1/state", func(w http.ResponseWriter, r *http.Request) {
		var body types.DesiredState
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res, err := m.ApplyState(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /v1/reconcile", func(w http.ResponseWriter, _ *http.Request) {
		res, err := m.Reconcile()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /v1/teardown", func(w http.ResponseWriter, _ *http.Request) {
		if err := m.Teardown(); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("POST /v1/peers/upsert", func(w http.ResponseWriter, r *http.Request) {
		var body types.UpsertPeerRequest
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res, err := m.UpsertPeer(body.Peer)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /v1/peers/remove", func(w http.ResponseWriter, r *http.Request) {
		var body types.RemovePeerRequest
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res, err := m.RemovePeer(body.TunnelIPv4)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("POST /v1/verify-exit", func(w http.ResponseWriter, r *http.Request) {
		var body types.VerifyExitRequest
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, m.VerifyExit(r.Context(), body))
	})

	mux.HandleFunc("POST /v1/checks/http", func(w http.ResponseWriter, r *http.Request) {
		var body types.HttpCheckRequest
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, m.RunHttpCheck(r.Context(), body))
	})

	mux.HandleFunc("POST /v1/switch-mode", func(w http.ResponseWriter, r *http.Request) {
		var body types.SwitchModeRequest
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		res, err := m.SwitchMode(r.Context(), body.Mode)
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		status := http.StatusOK
		if !res.OK {
			status = http.StatusConflict
		}
		writeJSON(w, status, res)
	})

	return mux
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{
		"ok":    false,
		"error": types.ClipDetail(err.Error(), 300),
	})
}
