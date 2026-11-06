#!/usr/bin/env bash
# Privacy-safe wasm build of the Bonfire contract.
#
#   ./build.sh           build, check, print the sha256 and write it to WASM_SHA256
#   ./build.sh --check   build, check, and compare the sha256 with WASM_SHA256 (exit 3 if it differs)
#
# Runs `cargo near build non-reproducible-wasm --locked` with `--remap-path-prefix` for the cargo home,
# the rustup home, the repository and the target directory, so panic messages in the wasm carry neutral
# paths (/cargo/registry/..., /bonfire/...) instead of machine-specific ones. cargo-near takes
# RUSTFLAGS only through `--env` and appends `--cfg near` itself, so RUSTFLAGS and
# CARGO_ENCODED_RUSTFLAGS are unset here (the latter would make cargo drop `--cfg near`).
#
# The build fails if `strings` finds /Users/, /home/ or the current user name in the wasm (exit 2),
# or if the wasm exports any method beyond the list below (exit 4): the ritual, NEP-141/145/148,
# the views and the one init. There is no owner, admin or upgrade method to find.
# Output: $CARGO_TARGET_DIR/near/bonfire.wasm (default target/near/bonfire.wasm).
# Needs: cargo-near 0.22, the toolchain pinned in rust-toolchain.toml, strings, python3,
# sha256sum or shasum.

set -euo pipefail

MODE=write
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  *) echo "usage: $0 [--check]" >&2; exit 64 ;;
esac

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
CARGO_HOME_DIR=${CARGO_HOME:-$HOME/.cargo}
RUSTUP_HOME_DIR=${RUSTUP_HOME:-$HOME/.rustup}
TARGET_DIR=${CARGO_TARGET_DIR:-$HERE/target}
mkdir -p "$TARGET_DIR"
TARGET_DIR=$(cd "$TARGET_DIR" && pwd)
OUT_DIR=$TARGET_DIR/near
WASM=$OUT_DIR/bonfire.wasm

for p in "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" "$REPO" "$TARGET_DIR"; do
  case "$p" in
    *" "*) echo "ERROR: path with a space ($p): RUSTFLAGS cannot carry it" >&2; exit 1 ;;
  esac
done

# rustc applies the last matching remapping, so the more specific prefixes come later
# (the target directory usually lies inside the repository).
FLAGS="-C link-arg=-s"
FLAGS="$FLAGS --remap-path-prefix=$REPO=/bonfire"
FLAGS="$FLAGS --remap-path-prefix=$TARGET_DIR=/target"
FLAGS="$FLAGS --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"
FLAGS="$FLAGS --remap-path-prefix=$CARGO_HOME_DIR=/cargo"

unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
cd "$HERE"
export CARGO_TARGET_DIR=$TARGET_DIR
cargo near build non-reproducible-wasm --locked --env "RUSTFLAGS=$FLAGS" --out-dir "$OUT_DIR" >&2

[ -f "$WASM" ] || { echo "ERROR: $WASM was not built" >&2; exit 1; }

# Privacy check: no machine-specific path or user name may remain in the wasm.
USER_NAME=${USER:-$(id -un)}
PATTERN='/Users/|/home/'
if [ -n "$USER_NAME" ]; then PATTERN="$PATTERN|$USER_NAME"; fi
LEAKS=$(strings -a "$WASM" | grep -E "$PATTERN" || true)
if [ -n "$LEAKS" ]; then
  echo "ERROR: the wasm contains machine-specific strings:" >&2
  printf '%s\n' "$LEAKS" | head -20 >&2
  exit 2
fi
echo "privacy check: no /Users/, /home/ or user name in $(basename "$WASM")" >&2

# Surface check: the wasm's function exports are exactly these methods (`__contract_abi` is the
# read-only ABI that cargo-near embeds).
EXPECTED="__contract_abi act audit claim_kindling collect config contract_source_metadata estimate \
ft_balance_of ft_metadata ft_resolve_transfer ft_total_supply ft_transfer ft_transfer_call history holder \
new night recent_throws records settle signing_text state storage_balance_bounds storage_balance_of \
storage_deposit storage_unregister storage_withdraw throw_wood"
python3 -I - "$WASM" "$EXPECTED" <<'PY' >&2
import sys

def leb(b, i):
    n = s = 0
    while True:
        x = b[i]; i += 1
        n |= (x & 0x7F) << s; s += 7
        if x < 0x80:
            return n, i

data = open(sys.argv[1], "rb").read()
assert data[:4] == b"\0asm", "not a wasm module"
i, found = 8, []
while i < len(data):
    sid = data[i]; size, i = leb(data, i + 1); end = i + size
    if sid == 7:
        count, i = leb(data, i)
        for _ in range(count):
            n, i = leb(data, i); name = data[i:i + n].decode(); i += n
            kind = data[i]; _, i = leb(data, i + 1)
            if kind == 0:
                found.append(name)
    i = end
expected = sorted(sys.argv[2].split())
if sorted(found) != expected:
    print("ERROR: the wasm exports differ from the expected surface", file=sys.stderr)
    print("  unexpected:", sorted(set(found) - set(expected)), file=sys.stderr)
    print("  missing:   ", sorted(set(expected) - set(found)), file=sys.stderr)
    sys.exit(4)
print("surface check: the wasm exports exactly the %d expected methods" % len(found), file=sys.stderr)
PY

if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$WASM" | awk '{print $1}')
else
  HASH=$(shasum -a 256 "$WASM" | awk '{print $1}')
fi
echo "sha256 $HASH  $(basename "$WASM") ($(wc -c <"$WASM" | tr -d ' ') bytes)" >&2

if [ "$MODE" = write ]; then
  printf '%s\n' "$HASH" >"$HERE/WASM_SHA256"
  echo "wrote WASM_SHA256" >&2
else
  EXPECTED=$(tr -d '[:space:]' <"$HERE/WASM_SHA256")
  if [ "$HASH" != "$EXPECTED" ]; then
    echo "MISMATCH: WASM_SHA256 says $EXPECTED" >&2
    exit 3
  fi
  echo "matches WASM_SHA256" >&2
fi
echo "$WASM"
