#!/bin/sh
set -eu

STATE_DIR=/opt/amnezia/awg
CONFIG_FILE="$STATE_DIR/awg0.conf"
PRIVATE_KEY_FILE="$STATE_DIR/wireguard_server_private_key.key"
PUBLIC_KEY_FILE="$STATE_DIR/wireguard_server_public_key.key"
PSK_FILE="$STATE_DIR/wireguard_psk.key"
CLIENTS_FILE="$STATE_DIR/clientsTable"
INIT_MARKER="$STATE_DIR/.initializing"
RUNTIME_CONFIG_FILE=/tmp/awg0.runtime.conf
GEOMETRY_SCRIPT=/usr/local/libexec/awg3-geometry.sh
# The tunnel MTU the client will use; S4 comes out of the same budget, so the
# generator needs it. Matches AppContract.AmneziaWG3.DEFAULTS.MTU.
TUNNEL_MTU="${AWG3_TUNNEL_MTU:-1376}"

umask 077
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if [ -f "$INIT_MARKER" ]; then
  rm -f \
    "$CONFIG_FILE" \
    "$PRIVATE_KEY_FILE" \
    "$PUBLIC_KEY_FILE" \
    "$PSK_FILE" \
    "$CLIENTS_FILE" \
    "$STATE_DIR"/.init.*
fi

config_exists=0
key_files=0
[ -f "$CONFIG_FILE" ] && config_exists=1
for key_file in "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE" "$PSK_FILE"; do
  [ -f "$key_file" ] && key_files=$((key_files + 1))
done

if [ "$config_exists" -ne 0 ] && [ "$key_files" -ne 3 ]; then
  echo "Refusing to start: AWG3 config exists but key material is incomplete" >&2
  exit 1
fi

if [ "$config_exists" -eq 0 ] && { [ "$key_files" -ne 0 ] || [ -e "$CLIENTS_FILE" ]; }; then
  echo "Refusing to start: AWG3 state exists but config is missing" >&2
  exit 1
fi

if [ "$config_exists" -ne 0 ] && [ ! -f "$CLIENTS_FILE" ]; then
  echo "Refusing to start: AWG3 config exists but clientsTable is missing" >&2
  exit 1
fi

if [ "$config_exists" -eq 0 ]; then
  : >"$INIT_MARKER"
  private_key="$(awg genkey)"
  public_key="$(printf '%s' "$private_key" | awg pubkey)"
  preshared_key="$(awg genpsk)"
  # AmneziaWG 3.1 header protection key (32-byte base64, same generator as PSK)
  header_protection_key="$(awg genpsk)"
  # Obfuscation geometry, drawn once for THIS node. Previously these were
  # constants identical on every node we deploy, so a classifier that learned
  # one node had learned the fleet. The generator enforces the protocol's own
  # rules (S >= 12 with header protection, headers distinct and clear of the
  # WireGuard message types) and the one rule nothing enforces: Jmin < Jmax,
  # where an inversion is a multi-gigabyte allocation per handshake.
  geometry="$(sh "$GEOMETRY_SCRIPT" "$TUNNEL_MTU")"

  if [ "$h1" = "$h2" ] || [ "$h1" = "$h3" ] || [ "$h1" = "$h4" ] || \
     [ "$h2" = "$h3" ] || [ "$h2" = "$h4" ] || [ "$h3" = "$h4" ]; then
    echo "Refusing to start: generated AWG3 headers are not unique" >&2
    exit 1
  fi

  temporary_private="$STATE_DIR/.init.$$.private"
  temporary_public="$STATE_DIR/.init.$$.public"
  temporary_psk="$STATE_DIR/.init.$$.psk"
  temporary_config="$STATE_DIR/.init.$$.conf"
  temporary_clients="$STATE_DIR/.init.$$.clients"

  printf '%s\n' "$private_key" >"$temporary_private"
  printf '%s\n' "$public_key" >"$temporary_public"
  printf '%s\n' "$preshared_key" >"$temporary_psk"

  cat >"$temporary_config" <<EOF
[Interface]
PrivateKey = $private_key
Address = 10.90.0.1/22
ListenPort = 51890
$geometry
HeaderProtectionKey = $header_protection_key
RandomTrailers = on
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE
EOF

  printf '[]\n' >"$temporary_clients"
  chmod 600 \
    "$temporary_private" \
    "$temporary_public" \
    "$temporary_psk" \
    "$temporary_config" \
    "$temporary_clients"
  mv "$temporary_private" "$PRIVATE_KEY_FILE"
  mv "$temporary_public" "$PUBLIC_KEY_FILE"
  mv "$temporary_psk" "$PSK_FILE"
  mv "$temporary_config" "$CONFIG_FILE"
  mv "$temporary_clients" "$CLIENTS_FILE"
  rm -f "$INIT_MARKER"

  unset private_key public_key preshared_key header_protection_key h1 h2 h3 h4
  unset temporary_private temporary_public temporary_psk temporary_config temporary_clients
fi

chmod 600 "$CONFIG_FILE" "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE" "$PSK_FILE" "$CLIENTS_FILE"

stored_private="$(cat "$PRIVATE_KEY_FILE")"
stored_public="$(cat "$PUBLIC_KEY_FILE")"
stored_psk="$(cat "$PSK_FILE")"
config_private="$(sed -n 's/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"
derived_public="$(printf '%s' "$stored_private" | awg pubkey)"
[ "$config_private" = "$stored_private" ] || {
  echo "Refusing to start: AWG3 config private key does not match persisted key material" >&2
  exit 1
}
[ "$derived_public" = "$stored_public" ] || {
  echo "Refusing to start: AWG3 public key does not match the persisted private key" >&2
  exit 1
}
printf '%s' "$stored_psk" | awg pubkey >/dev/null
grep -Eq '^Address[[:space:]]*=[[:space:]]*10\.90\.0\.1/22[[:space:]]*$' "$CONFIG_FILE" || {
  echo "Refusing to start: AWG3 config must use 10.90.0.1/22" >&2
  exit 1
}
grep -Eq '^ListenPort[[:space:]]*=[[:space:]]*51890[[:space:]]*$' "$CONFIG_FILE" || {
  echo "Refusing to start: AWG3 config must use UDP 51890" >&2
  exit 1
}
grep -Eq '^HeaderProtectionKey[[:space:]]*=[[:space:]]*.+$' "$CONFIG_FILE" || {
  echo "Refusing to start: AWG3 config must define HeaderProtectionKey" >&2
  exit 1
}
unset stored_private stored_public stored_psk config_private derived_public

cleanup_interface() {
  iptables -D FORWARD -i awg0 -j ACCEPT >/dev/null 2>&1 || true
  iptables -D FORWARD -o awg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT >/dev/null 2>&1 || true
  iptables -t nat -D POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE >/dev/null 2>&1 || true
  ip link delete dev awg0 >/dev/null 2>&1 || true
  rm -f \
    "$RUNTIME_CONFIG_FILE" \
    /var/run/amneziawg/awg0.sock \
    /var/run/wireguard/awg0.sock
}

trap cleanup_interface EXIT
cleanup_interface

# The pinned AWG 3.1 userspace daemon runs in its own container, isolated from the host kernel module.
amneziawg-go awg0
awg-quick strip "$CONFIG_FILE" >"$RUNTIME_CONFIG_FILE"
chmod 600 "$RUNTIME_CONFIG_FILE"
awg setconf awg0 "$RUNTIME_CONFIG_FILE"
rm -f "$RUNTIME_CONFIG_FILE"
ip -4 address add 10.90.0.1/22 dev awg0
ip link set mtu 1420 up dev awg0
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A FORWARD -o awg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.90.0.0/22 -o eth0 -j MASQUERADE

stopping=0
stop_service() {
  stopping=1
}
trap stop_service INT TERM

while [ "$stopping" -eq 0 ]; do
  sleep 5 &
  wait "$!" || true
done

trap - INT TERM
