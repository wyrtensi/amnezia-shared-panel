#!/usr/bin/env bash
# Two-container test of the reachability probe.
#
# A server container runs the node's real awg3 entrypoint; the probe runs from
# its built image with the same hardening as infra/probe/compose.yaml and is
# driven only through its API. The test passes when both targets get a
# handshake and an egress IP equal to the server's, and the probe's main
# routing table and the host's routes and rules are the same before and after.
#
# Usage: infra/probe/tests/two-container.sh
#   PROBE_IMAGE=<ref>      test this image instead of building one
#   RP2C_NET_PREFIX=10.231 first two octets of the two private /24 networks
#   RP2C_NET_THIRD=21      third octet of the first network (the second is +1)
#   RP2C_SAVE_RESULT=<file> keep a copy of the final GET /runs/latest body
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
AWG_IMG=amneziavpn/amneziawg-go@sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72
NODE_IMG=node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

ID="rp2c-$$"
PREFIX="${RP2C_NET_PREFIX:-10.231}"
THIRD="${RP2C_NET_THIRD:-21}"
WAN="$PREFIX.$THIRD"          # where the probe reaches the server's UDP
INET="$PREFIX.$((THIRD + 1))" # the server's "internet" side, with the echo
SRV_WAN="$WAN.10"
SRV_INET="$INET.10"
PROBE_WAN="$WAN.20"
PROBE_INET="$INET.20"
ECHO="$INET.50"
WORK="$(mktemp -d)"
BUILT_IMAGE=""

cleanup() {
  # Only what this run created, by its unique names.
  docker rm -f "$ID-srv" "$ID-echo" "$ID-probe" >/dev/null 2>&1 || true
  docker network rm "$ID-wan" "$ID-inet" >/dev/null 2>&1 || true
  if [ -n "$BUILT_IMAGE" ]; then docker image rm "$BUILT_IMAGE" >/dev/null 2>&1 || true; fi
  rm -r -f "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if docker inspect "$ID-probe" >/dev/null 2>&1; then
    echo "--- probe logs ---" >&2
    docker logs --tail 40 "$ID-probe" >&2 || true
  fi
  exit 1
}
pass() { echo "ok: $*"; }

for img in "$AWG_IMG" "$NODE_IMG"; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null
done
if [ -z "${PROBE_IMAGE:-}" ]; then
  BUILT_IMAGE="$ID-image:test"
  docker build -q -t "$BUILT_IMAGE" "$REPO/services/reachability-probe" >/dev/null
  PROBE_IMAGE="$BUILT_IMAGE"
fi

docker network create --subnet "$WAN.0/24" "$ID-wan" >/dev/null
docker network create --subnet "$INET.0/24" "$ID-inet" >/dev/null

# Echo of the caller's address: what an egress URL answers.
docker run -d --name "$ID-echo" --network "$ID-inet" --ip "$ECHO" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true "$NODE_IMG" \
  node -e 'require("http").createServer((q,r)=>r.end(q.socket.remoteAddress.replace("::ffff:",""))).listen(8080)' \
  >/dev/null

# Server: the node's real awg3 entrypoint.
docker run -d --name "$ID-srv" --network "$ID-wan" --ip "$SRV_WAN" \
  --cap-drop ALL --cap-add NET_ADMIN --device /dev/net/tun \
  --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -v "$REPO/infra/node/scripts/awg3-entrypoint.sh:/usr/local/libexec/awg3-entrypoint.sh:ro" \
  -v "$REPO/infra/node/scripts/awg3-geometry.sh:/usr/local/libexec/awg3-geometry.sh:ro" \
  --tmpfs /opt/amnezia/awg:mode=0700 \
  --entrypoint /bin/sh "$AWG_IMG" /usr/local/libexec/awg3-entrypoint.sh >/dev/null
docker network connect --ip "$SRV_INET" "$ID-inet" "$ID-srv"
up=0
for _ in $(seq 1 60); do
  if docker exec "$ID-srv" awg show awg0 >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] || fail "server awg0 did not come up"
# The entrypoint masquerades out of eth0; here the internet side is eth1.
docker exec "$ID-srv" iptables -t nat -A POSTROUTING -s 10.90.0.0/22 -o eth1 -j MASQUERADE

# One client peer on the server.
CPRIV="$(docker exec "$ID-srv" awg genkey)"
CPUB="$(printf '%s' "$CPRIV" | docker exec -i "$ID-srv" awg pubkey)"
SPUB="$(docker exec "$ID-srv" cat /opt/amnezia/awg/wireguard_server_public_key.key)"
PSK="$(docker exec "$ID-srv" cat /opt/amnezia/awg/wireguard_psk.key)"
docker exec "$ID-srv" awg set awg0 peer "$CPUB" preshared-key /opt/amnezia/awg/wireguard_psk.key \
  allowed-ips 10.90.0.2/32

# Client conf as the node-agent issues it (wg-quick keys, the server's AWG
# parameters, a 3.1 keepalive range), except for a split-tunnel
# AllowedIPs that does NOT cover the echo, so the egress check only passes
# when the probe widens it to the full tunnel.
PARAMS="$(docker exec "$ID-srv" sed -n '/^\[Interface\]/,/^\[/p' /opt/amnezia/awg/awg0.conf |
  grep -Ev '^\[|^(PrivateKey|Address|ListenPort|PostUp|PostDown)[[:space:]]*=' | grep -v '^$')"
umask 077
cat >"$WORK/client.conf" <<EOF
[Interface]
Address = 10.90.0.2/32
DNS = 1.1.1.1
MTU = 1280
PrivateKey = $CPRIV
$PARAMS

[Peer]
PublicKey = $SPUB
PresharedKey = $PSK
AllowedIPs = 192.0.2.0/24
Endpoint = $SRV_WAN:51890
PersistentKeepalive = 25-35
EOF

API_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$API_KEY" >"$WORK/probe-api-key"
# The probe's root has no CAP_DAC_OVERRIDE, so a 0600 file owned by this uid
# would be unreadable to it. Test-only key in a private temp dir.
chmod 0644 "$WORK/probe-api-key"
printf 'x-api-key: %s\n' "$API_KEY" >"$WORK/auth-header"

# The probe, hardened exactly like infra/probe/compose.yaml.
docker run -d --name "$ID-probe" --init --network "$ID-wan" --ip "$PROBE_WAN" \
  --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun \
  --read-only --tmpfs /tmp:mode=0700 --tmpfs /var/run/amneziawg:mode=0700 \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 256m \
  -e NODE_OPTIONS=--max-old-space-size=128 -e PROBE_LISTEN=0.0.0.0:4002 \
  -e PROBE_API_KEY_FILE=/run/secrets/probe_api_key \
  -v "$WORK/probe-api-key:/run/secrets/probe_api_key:ro" \
  -p 127.0.0.1::4002 "$PROBE_IMAGE" >/dev/null
docker network connect --ip "$PROBE_INET" "$ID-inet" "$ID-probe"
PORT="$(docker port "$ID-probe" 4002/tcp | head -n 1 | sed 's/.*://')"
BASE="http://127.0.0.1:$PORT"

healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 0.5
done
[ "$healthy" = 1 ] || fail "probe /healthz did not answer"
pass "probe is up on loopback port $PORT"

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/runs/latest")"
[ "$code" = 401 ] || fail "GET /runs/latest without a key answered $code, want 401"
pass "API refuses a request without the key"

# Baselines, taken after every network and container exists: creating docker
# networks changes the host's routes by itself.
probe_main_before="$(docker exec "$ID-probe" ip route show table main)"
probe_rules_before="$(docker exec "$ID-probe" ip rule)"
host_before="$(ip route; ip rule)"

jq -n --rawfile conf "$WORK/client.conf" \
  --arg control "http://$ECHO:8080/" --arg egress "http://$ECHO:8080/" --arg expected "$SRV_INET" '{
    runId: "6f1c2a9e-0b7d-4c55-9a3e-2d8f4b1e7a60",
    control: { url: $control },
    egress: { url: $egress },
    targets: [
      { targetId: "node-a", protocol: "amneziawg3", config: $conf, expectedEgressIp: $expected },
      { targetId: "node-b", protocol: "amneziawg3", config: $conf, expectedEgressIp: $expected },
      { targetId: "node-c", protocol: "amneziawg3", config: "[Interface]\nPrivateKey = x\n" }
    ]
  }' >"$WORK/run.json"

code="$(curl -s -o "$WORK/post.json" -w '%{http_code}' -H @"$WORK/auth-header" \
  -H 'content-type: application/json' --data-binary @"$WORK/run.json" "$BASE/runs")"
[ "$code" = 202 ] || fail "POST /runs answered $code, want 202"
pass "run accepted"

finished=0
for _ in $(seq 1 180); do
  curl -fsS -H @"$WORK/auth-header" "$BASE/runs/latest" >"$WORK/latest.json"
  if [ "$(jq -r '.finishedAt != null' "$WORK/latest.json")" = true ]; then finished=1; break; fi
  sleep 0.5
done
[ "$finished" = 1 ] || fail "run did not finish in 90s"
if [ -n "${RP2C_SAVE_RESULT:-}" ]; then cp "$WORK/latest.json" "$RP2C_SAVE_RESULT"; fi

echo "--- run result ---"
jq -c '{control: .control.ok, results: [.results[] | {targetId, status, detail, egressIp,
  ping: .levels.ping.ok, tcp: .levels.tcp.ok, handshake: .levels.handshake.ok, http: .levels.http.ok}]}' \
  "$WORK/latest.json"

[ "$(jq -r '.control.ok' "$WORK/latest.json")" = true ] || fail "control did not pass"
for i in 0 1; do
  got="$(jq -r --argjson i "$i" --arg ip "$SRV_INET" \
    '.results[$i] | (.status == "done" and .levels.handshake.ok == true and .levels.http.ok == true and .egressIp == $ip)' \
    "$WORK/latest.json")"
  [ "$got" = true ] || fail "target $i: want handshake.ok && http.ok with egress $SRV_INET"
done
pass "both targets: handshake.ok && http.ok, egress $SRV_INET (the server's side)"
[ "$(jq -r '.results[2].status' "$WORK/latest.json")" = error ] || fail "bad config is not an error"
pass "a bad config is reported as error"

for secret in "$CPRIV" "$PSK"; do
  if grep -qF -- "$secret" "$WORK/latest.json" "$WORK/post.json"; then fail "a response carries config content"; fi
  if docker logs "$ID-probe" 2>&1 | grep -qF -- "$secret"; then fail "the probe log carries config content"; fi
done
pass "no config content in responses or logs"

[ "$probe_main_before" = "$(docker exec "$ID-probe" ip route show table main)" ] ||
  fail "probe main routing table changed"
pass "probe main routing table unchanged"
[ "$probe_rules_before" = "$(docker exec "$ID-probe" ip rule)" ] || fail "probe rules not restored"
if docker exec "$ID-probe" ip link show awgp0 >/dev/null 2>&1; then fail "awgp0 left behind"; fi
[ -z "$(docker exec "$ID-probe" ip route show table 200)" ] || fail "table 200 not flushed"
[ -z "$(docker exec "$ID-probe" ls -A /tmp)" ] || fail "config files left in /tmp"
pass "tunnel torn down: no rule, no table 200 routes, no link, no files"
zombies="$(docker exec "$ID-probe" sh -c 'cat /proc/[0-9]*/stat 2>/dev/null' | awk '$3 == "Z"' | wc -l)"
[ "$zombies" -eq 0 ] || fail "$zombies zombie processes in the probe"
pass "no zombie processes"
[ "$host_before" = "$(ip route; ip rule)" ] || fail "host routes or rules changed"
pass "host routes and rules unchanged"

echo "two-container test: PASS"
