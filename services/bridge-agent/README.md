# bridge-agent

Loopback-only management API of an AWG 3.1 node bridge. It reads the local
frps (pinned frp **v0.72.0**) dashboard API and reports a small, filtered,
versioned status to the panel. It is not a proxy for frps: only the fields
below leave the host.

Test fixtures in `test/fixtures/` are **real responses captured from the
frps v0.72.0 binary** (`/api/serverinfo`, `/api/proxy/udp`, `/api/proxy/tcp`);
the zod models in `src/frps.ts` follow `server/http/model/types.go` and
`server/api_router.go` at tag `v0.72.0` (`ServerInfoResp`, `GetProxyInfoResp`,
`ProxyStatsInfo`, `UDPOutConf`). An offline proxy has `"conf": null`, so no
`remotePort`. Re-capture the fixtures when the pinned frp release changes.

## API (`apiVersion` 1, spec: `openapi/bridge-agent.v1.yaml`)

All JSON. `Authorization: Bearer <token>` is required except for `/healthz`;
missing or wrong token is `401 {"error":{"code":"UNAUTHORIZED"}}` (checked
before routing, constant-time compare).

- `GET /healthz` returns `{ "ok": true }`. No auth, no upstream call.
- `GET /v1/identity` returns `{ bridgeId, agentVersion, apiVersion: 1, capabilities }`:
  `["status.v1"]`, plus `"update.v1"` when updates are configured (below).
- `GET /v1/status` returns
  `{ bridgeId, agentVersion, apiVersion, observedAt, frps: { reachable, version }, applied: { controlTcpPort, udpPortStart, udpPortEnd }, proxies: [{ proxyId, remotePort, online, registrationMarker }], errors: [{ code, message }] }`.
  - Always `200` while the agent runs. When frps is down the agent still answers,
    with `frps.reachable=false`.
  - `frps.reachable` is true only when both frps reads succeeded; otherwise
    `proxies` is `[]` and proves nothing about any registration (treat as unknown).
  - `proxyId` is the frp proxy name (`awg-route-<route uuid>`); only UDP proxies.
    `remotePort` is `null` for an offline proxy (frps drops its config).
  - `registrationMarker` = first 32 hex chars of `sha256(clientID + "\n" + lastStartTime)`;
    stable per registration, changes on re-registration, raw clientID never exposed.
    `null` when frps reports no clientID or start time. Caveat: frps formats
    `lastStartTime` as `MM-DD HH:MM:SS` (no year, second resolution), so two
    registrations of the same client within one second share a marker.
  - `errors` (max 8): `code` in `FRPS_UNREACHABLE`, `FRPS_AUTH_FAILED`, `FRPS_TIMEOUT`,
    `FRPS_HTTP_ERROR`, `FRPS_MALFORMED_RESPONSE` (also an oversized body); `message`
    is a fixed short string and never contains upstream text or credentials.
- `POST /v1/update` (only with `update.v1`) records one update intent for the host's
  systemd updater (`infra/bridge/bridge-agent-update.sh`); the agent never touches
  Docker. Body `{ operationId (lowercase uuid), imageRepository, imageDigest
  (sha256:<64 hex>), notAfter (ISO UTC) }`, at most 4 KiB. It writes
  `<spool>/requests/<operationId>.json` (temp file + rename) and answers
  `{ operationId, state, updatedAt, errorCode? }`:
  - `202` new intent, `state: "queued"`; an intent that arrives at or after
    `notAfter` is recorded too and answered `state: "expired"` (never started).
  - `200` replay of a known operation with the same intent: its current state,
    nothing rewritten.
  - `400 INVALID_REQUEST` (malformed body or fields), `422 REPOSITORY_NOT_APPROVED`
    (not `BRIDGE_AGENT_IMAGE_REPOSITORY`), `409 OPERATION_CONFLICT` (same id, other
    intent), `409 UPDATE_IN_PROGRESS` (another operation is queued or running),
    `500 INTERNAL_ERROR` (the spool cannot be written or a record cannot be read).
  - A `notAfter` more than 180 s ahead of or 60 s behind local time logs one line
    (clock skew or late delivery).
- `GET /v1/update?operationId=<uuid>` returns the same status body: the host's
  result file (`<spool>/results/<id>.json`) verbatim when there is one, else the
  pending request (`queued`, or `expired` once `notAfter` passed). `404
  {"error":{"code":"UNKNOWN_OPERATION"}}` only when there is no record at all;
  `400 INVALID_REQUEST` for a bad id; an unreadable or invalid record is `500`.
  States: `queued, picked_up, staging, replacing, health_check, succeeded,
  rolled_back, rollback_failed, failed, expired` (the panel's
  `BRIDGE_AGENT_UPDATE_AGENT_STATES`; a test pins them). Records live on the host,
  so a replaced or rolled-back agent keeps answering for them.
- Other paths: `404 NOT_FOUND`; wrong method on a known path: `405 METHOD_NOT_ALLOWED`.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_ID` | required | lowercase UUID assigned at enrollment (same as `/etc/amnezia-bridge/frp/bridge-id`) |
| `BRIDGE_AGENT_API_TOKEN_FILE` | required | file with the management bearer token (>= 32 chars, mode 0600); distinct from the frp token and the dashboard credential |
| `BRIDGE_AGENT_LISTEN` | `127.0.0.1:7600` | `host:port`; the host must be a loopback IP literal, otherwise startup fails |
| `BRIDGE_FRPS_URL` | `http://127.0.0.1:7500` | frps dashboard; http, loopback only |
| `BRIDGE_FRPS_DASHBOARD_ENV_FILE` | `/etc/amnezia-bridge/frp/dashboard.env` | `FRPS_DASHBOARD_USER` / `FRPS_DASHBOARD_PASSWORD` written by `install-frps.sh` (mode 0600). The compose service that runs this image is `infra/bridge/compose.yaml`, started by `infra/bridge/install-bridge.sh` |
| `BRIDGE_APPLIED_CONTROL_PORT`, `BRIDGE_APPLIED_UDP_START`, `BRIDGE_APPLIED_UDP_END` | required | what the installer applied (reported as-is, not read from frps) |
| `BRIDGE_AGENT_IMAGE_REPOSITORY` | empty | approved bridge-agent repository; empty turns updates off (no `update.v1`, no `/v1/update`) |
| `BRIDGE_UPDATE_SPOOL_DIR` | `/var/lib/amnezia-bridge/update` | absolute; with updates on, `requests/` must be writable and `results/` readable, else startup fails |
| `BRIDGE_FRPS_TIMEOUT_MS` | `3000` | per-request upstream timeout |
| `BRIDGE_FRPS_MAX_BYTES` | `1048576` | upstream response size cap |

Startup fails with a secret-free message on any missing or invalid setting, or
if the token or credentials file is readable by group or others. The service
reads `package.json` next to `dist/` for `agentVersion`, so ship it in the image.

## Development

```sh
npm ci
npm test        # typecheck + vitest
npm run build
```

## Image and release

`Dockerfile` builds the image (`docker build services/bridge-agent`): multi-stage,
digest-pinned bases, `dist/` plus `package.json` (the agent reads its version from
it), non-root by default, label `io.amnezia.bridge-agent.api-version` equal to
`BRIDGE_API_VERSION`, healthcheck on the unauthenticated `GET /healthz`. The host
runs it through `infra/bridge/compose.yaml` as uid 0 with every capability
dropped. The version is this package's `version`; a release is the tag
`bridge-agent-vX.Y.Z` (equal to it), built and pushed to GHCR by
`.github/workflows/release-bridge-agent.yml`. See `infra/bridge/README.md`.
