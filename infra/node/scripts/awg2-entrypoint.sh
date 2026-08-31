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
  echo "Refusing to start: AWG2 config exists but key material is incomplete" >&2
  exit 1
fi

if [ "$config_exists" -eq 0 ] && { [ "$key_files" -ne 0 ] || [ -e "$CLIENTS_FILE" ]; }; then
  echo "Refusing to start: AWG2 state exists but config is missing" >&2
  exit 1
fi

if [ "$config_exists" -ne 0 ] && [ ! -f "$CLIENTS_FILE" ]; then
  echo "Refusing to start: AWG2 config exists but clientsTable is missing" >&2
  exit 1
fi

random_header() {
  while :; do
    value="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
    case "$value" in
      ''|0|1|2|3|4) ;;
      *) printf '%s\n' "$value"; return 0 ;;
    esac
  done
}

if [ "$config_exists" -eq 0 ]; then
  : >"$INIT_MARKER"
  private_key="$(awg genkey)"
  public_key="$(printf '%s' "$private_key" | awg pubkey)"
  preshared_key="$(awg genpsk)"
  h1="$(random_header)"
  h2="$(random_header)"
  h3="$(random_header)"
  h4="$(random_header)"

  if [ "$h1" = "$h2" ] || [ "$h1" = "$h3" ] || [ "$h1" = "$h4" ] || \
     [ "$h2" = "$h3" ] || [ "$h2" = "$h4" ] || [ "$h3" = "$h4" ]; then
    echo "Refusing to start: generated AWG2 headers are not unique" >&2
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
Address = 10.89.0.1/22
ListenPort = 51889
Jc = 4
Jmin = 40
Jmax = 70
S1 = 15
S2 = 20
S3 = 20
S4 = 23
H1 = $h1
H2 = $h2
H3 = $h3
H4 = $h4
I1 = <r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s 10.89.0.0/22 -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s 10.89.0.0/22 -o eth0 -j MASQUERADE
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

  unset private_key public_key preshared_key h1 h2 h3 h4
  unset temporary_private temporary_public temporary_psk temporary_config temporary_clients
fi

chmod 600 "$CONFIG_FILE" "$PRIVATE_KEY_FILE" "$PUBLIC_KEY_FILE" "$PSK_FILE" "$CLIENTS_FILE"

stored_private="$(cat "$PRIVATE_KEY_FILE")"
stored_public="$(cat "$PUBLIC_KEY_FILE")"
stored_psk="$(cat "$PSK_FILE")"
config_private="$(sed -n 's/^[[:space:]]*PrivateKey[[:space:]]*=[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"
derived_public="$(printf '%s' "$stored_private" | awg pubkey)"
[ "$config_private" = "$stored_private" ] || {
  echo "Refusing to start: AWG2 config private key does not match persisted key material" >&2
  exit 1
}
[ "$derived_public" = "$stored_public" ] || {
  echo "Refusing to start: AWG2 public key does not match the persisted private key" >&2
  exit 1
}
printf '%s' "$stored_psk" | awg pubkey >/dev/null
grep -Eq '^Address[[:space:]]*=[[:space:]]*10\.89\.0\.1/22[[:space:]]*$' "$CONFIG_FILE" || {
  echo "Refusing to start: AWG2 config must use 10.89.0.1/22" >&2
  exit 1
}
grep -Eq '^ListenPort[[:space:]]*=[[:space:]]*51889[[:space:]]*$' "$CONFIG_FILE" || {
  echo "Refusing to start: AWG2 config must use UDP 51889" >&2
  exit 1
}
unset stored_private stored_public stored_psk config_private derived_public

cleanup_interface() {
  iptables -D FORWARD -i awg0 -j ACCEPT >/dev/null 2>&1 || true
  iptables -D FORWARD -o awg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT >/dev/null 2>&1 || true
  iptables -t nat -D POSTROUTING -s 10.89.0.0/22 -o eth0 -j MASQUERADE >/dev/null 2>&1 || true
  ip link delete dev awg0 >/dev/null 2>&1 || true
  rm -f \
    "$RUNTIME_CONFIG_FILE" \
    /var/run/amneziawg/awg0.sock \
    /var/run/wireguard/awg0.sock
}

trap cleanup_interface EXIT
cleanup_interface

# The pinned AWG2 tools are intentionally isolated from a potentially newer host kernel module.
amneziawg-go awg0
awg-quick strip "$CONFIG_FILE" >"$RUNTIME_CONFIG_FILE"
chmod 600 "$RUNTIME_CONFIG_FILE"
awg setconf awg0 "$RUNTIME_CONFIG_FILE"
rm -f "$RUNTIME_CONFIG_FILE"
ip -4 address add 10.89.0.1/22 dev awg0
ip link set mtu 1420 up dev awg0
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A FORWARD -o awg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.89.0.0/22 -o eth0 -j MASQUERADE

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
