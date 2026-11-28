#!/usr/bin/env bash
set -euo pipefail

config_file="${1:?usage: build-shims.sh <shim-override.env>}"
[ -f "$config_file" ] || { echo "missing config file: $config_file" >&2; exit 1; }

kv_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$config_file" | tail -n 1 | tr -d '\r'
}

mode="$(kv_value SHIM_OVERRIDE_MODE)"
if [ -n "${SHIM_OVERRIDE_MODE_ARG:-}" ]; then
  mode="${SHIM_OVERRIDE_MODE_ARG}"
fi
[ -n "$mode" ] || mode="upstream"

mkdir -p /out/shims
env_file="/out/shim-override.env"

case "$mode" in
  upstream)
    cat >"$env_file" <<'EOF'
# Upstream mode active: no custom containerd-shim binary is built or shipped.
# agent-update.sh removes any temporary amnezia-node-shim dpkg-divert override.
SHIM_MODE=upstream
EOF
    echo "shim-override: SHIM_OVERRIDE_MODE=upstream; skipping custom shim build"
    exit 0
    ;;
  override)
    ;;
  *)
    echo "unsupported SHIM_OVERRIDE_MODE=${mode} (expected override or upstream)" >&2
    exit 1
    ;;
esac

ttrpc_repo="$(kv_value SHIM_TTRPC_REPO)"
ttrpc_ref="$(kv_value SHIM_TTRPC_REF)"
ttrpc_commit="$(kv_value SHIM_TTRPC_COMMIT)"

[ -n "$ttrpc_repo" ] || { echo "SHIM_TTRPC_REPO is required when mode=override" >&2; exit 1; }
[ -n "$ttrpc_ref" ] || { echo "SHIM_TTRPC_REF is required when mode=override" >&2; exit 1; }
if ! printf '%s' "$ttrpc_commit" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "SHIM_TTRPC_COMMIT must be a 40-char hex SHA (got: ${ttrpc_commit:-<empty>})" >&2
  exit 1
fi

mkdir -p /src/ttrpc
git -C /src/ttrpc init -q
git -C /src/ttrpc remote add origin "$ttrpc_repo"
git -C /src/ttrpc fetch -q --depth 1 origin "$ttrpc_commit"
git -C /src/ttrpc checkout -q --detach FETCH_HEAD
checked_commit="$(git -C /src/ttrpc rev-parse HEAD)"
if [ "$checked_commit" != "$ttrpc_commit" ]; then
  echo "fetched commit ${checked_commit} does not match pinned ${ttrpc_commit}" >&2
  exit 1
fi

cat >"$env_file" <<EOF
# Temporary custom shim override built from forked wyrtensi/ttrpc (${ttrpc_ref}).
# Flip SHIM_OVERRIDE_MODE=upstream in infra/node/shim-override/shim-override.env to revert.
SHIM_MODE=override
SHIM_REF=${ttrpc_ref}
SHIM_TTRPC_REPO=${ttrpc_repo}
SHIM_TTRPC_COMMIT=${ttrpc_commit}
EOF

targets=(
  "1.7 v1.7.36 github.com/containerd/containerd/version"
  "2.2 v2.2.10 github.com/containerd/containerd/v2/version"
  "2.3 v2.3.7 github.com/containerd/containerd/v2/version"
  "2.4 v2.4.2 github.com/containerd/containerd/v2/version"
)

for entry in "${targets[@]}"; do
  read -r minor tag ver_pkg <<<"$entry"
  src_dir="/src/containerd-${minor}"
  out_bin="/out/shims/containerd-shim-runc-v2-${minor}"
  minor_key="${minor//./_}"

  echo "=== Building containerd-shim-runc-v2 ${minor} (${tag} + ${ttrpc_ref}) ==="
  git clone -q --depth 1 --branch "$tag" https://github.com/containerd/containerd.git "$src_dir"
  (
    cd "$src_dir"
    go mod edit -replace "github.com/containerd/ttrpc=/src/ttrpc"
    go get github.com/moby/locker@v1.0.1
    go list -mod=mod -m -f '{{.Path}} {{.Replace}}' github.com/containerd/ttrpc | grep -q '/src/ttrpc'
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
      -mod=mod \
      -trimpath \
      -ldflags="-s -w -X ${ver_pkg}.Version=${tag}+ttrpc241 -X ${ver_pkg}.Revision=${ttrpc_ref}" \
      -o "$out_bin" \
      ./cmd/containerd-shim-runc-v2
  )

  chmod 0755 "$out_bin"
  "$out_bin" -v
  go version -m "$out_bin" | grep -Eq '=>[[:space:]]+/src/ttrpc' || {
    echo "built binary ${out_bin} did not embed local /src/ttrpc replacement" >&2
    exit 1
  }
  sha="$(sha256sum "$out_bin" | awk '{print $1}')"
  printf 'SHIM_SHA256_%s=%s\n' "$minor_key" "$sha" >>"$env_file"
  rm -rf "$src_dir"
done
