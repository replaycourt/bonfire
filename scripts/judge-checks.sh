#!/usr/bin/env bash
# The read-only checks from JUDGE.md, each printed as PASS or FAIL.
#
#   scripts/judge-checks.sh [--rpc <url>]
#
# Needs bash, curl and python3 (python3 only decodes the RPC's JSON). Works on macOS and Linux and
# sends no transaction: every call is a `query` (a view) on the public NEAR testnet RPC. Exit code:
# the number of checks that failed (0 when all pass).

set -u

RPC=${RPC:-https://test.rpc.fastnear.com}
if [ "${1:-}" = "--rpc" ] && [ -n "${2:-}" ]; then RPC=$2; fi
CONTRACT=bonfire-coin.testnet
GAS_ACCOUNT=bonfire-gas.testnet
ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXPECTED_HASH=$(tr -d '[:space:]' <"$ROOT/contract/WASM_SHA256")
EMPTY_ARGS=e30= # base64 of {}

FAILED=0
TOTAL=0
FALLBACK_RPC=${FALLBACK_RPC:-https://near-testnet.drpc.org}
# --fail keeps an HTTP error page (FastNEAR answers 429 to a quick burst of calls) out of the output,
# so a retry cannot append a second answer to the first; when the RPC keeps refusing, the fallback
# answers instead. An empty output becomes "error: no answer from the RPC" in check().
query() { # $1: JSON params of a `query` call
  local body="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"
  curl -sf --max-time 20 --retry 3 --retry-delay 2 "$RPC" -H 'Content-Type: application/json' -d "$body" ||
    curl -sf --max-time 20 --retry 2 --retry-delay 2 "$FALLBACK_RPC" -H 'Content-Type: application/json' -d "$body"
}
view() { # $1: method, $2: base64 of the JSON args, $3: optional block height (default: final)
  local at='"finality":"final"'
  if [ -n "${3:-}" ]; then at="\"block_id\":$3"; fi
  query "{\"request_type\":\"call_function\",$at,\"account_id\":\"$CONTRACT\",\"method_name\":\"$1\",\"args_base64\":\"$2\"}"
}
# Reads the RPC answer on stdin and runs the python code in $1 on it, with `r` the result object,
# `v` a view's decoded JSON and ROOT the repository root; the code sets `out`, which is printed.
# Any error prints "error: ...".
check() {
  python3 -I -c '
import json, sys, collections, re, urllib.parse
ROOT = sys.argv[2]
try:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("no answer from the RPC")
    ans = json.loads(raw)
    if "result" not in ans:
        raise ValueError("RPC error: %s" % json.dumps(ans.get("error"))[:200])
    r = ans["result"]
    if "error" in r:
        raise ValueError("RPC error: %s" % r["error"][:200])
    v = json.loads(bytes(r["result"]).decode()) if "result" in r else None
    out = None
    exec(sys.argv[1])
    print(out)
except Exception as e:
    print("error: %s" % (e,))
' "$1" "$ROOT"
}
report() { # $1: name, $2: what was seen, $3: what passes
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected: %s\n      got:      %s\n' "$1" "$3" "$2"
    FAILED=$((FAILED + 1))
  fi
}

echo "Bonfire: read-only checks of $CONTRACT against $RPC"

# 1. The contract account has no access keys: nobody can redeploy it, change a rule or act as it.
got=$(query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" \
  | check 'out = "%d access keys" % len(r["keys"])')
report "1. $CONTRACT has no access keys" "$got" "0 access keys"

# 2. The deployed code is the wasm this repository records: the chain's code hash (base58 of the
#    wasm's sha256) equals contract/WASM_SHA256. That this hash is the build of the source is shown
#    by a rebuild (contract/build.sh --check, contract/compare-wasm.py), not by this check.
got=$(query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | check '
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in r["code_hash"]:
    n = n * 58 + B58.index(c)
out = n.to_bytes(32, "big").hex()')
report "2. code hash on chain = contract/WASM_SHA256" "$got" "$EXPECTED_HASH"

# 3. No EMBER appears or vanishes: supply = balances + pile + hearth + owed, and
#    supply = genesis + minted - burned.
got=$(view audit "$EMPTY_ARGS" | check '
s, b, p, h, o = (int(v[k]) for k in ("supply", "balances", "pile", "hearth", "owed"))
g, m, x = (int(v[k]) for k in ("genesis", "minted", "burned"))
ok = v["balanced"] and v["ledger"] and s == b + p + h + o and s == g + m - x
out = "balanced and ledger true, sums agree" if ok else "balanced=%s ledger=%s supply=%d" % (v["balanced"], v["ledger"], s)')
report "3. audit(): balanced and ledger hold" "$got" "balanced and ledger true, sums agree"

# 4. Every launch parameter is the testnet block of sim/params.json, with the two changes documented
#    in docs/testnet-launch.md, and the founders are the five demo bots labelled in web/js/config.js.
got=$(view config "$EMPTY_ARGS" | check '
p = json.load(open(ROOT + "/sim/params.json", encoding="utf-8"))["testnet"]["config"]
p = dict(p, kindling_per_night=4, hearth_genesis=str(3000000 * 10**18))
c = v["config"]
diff = sorted(k for k in set(p) | set(c) if p.get(k) != c.get(k))
cfg_js = open(ROOT + "/web/js/config.js", encoding="utf-8").read()
final = cfg_js[cfg_js.index("final:"):cfg_js.index("stage:")]
bots = set(re.findall(r"[0-9a-f]{64}", final[final.index("bots:"):]))
founders = {f["account_id"]: int(f["amount"]) // 10**18 for f in v["founders"]}
amounts = sorted(founders.values())
if diff:
    out = "differs: %s" % ", ".join(diff)
elif set(founders) != bots or amounts != [5000, 10000, 15000, 30000, 40000]:
    out = "founders are not the five labelled bots"
else:
    out = "%d fields as documented; founders: 5 demo bots" % len(c)')
report "4. config() = sim/params.json testnet block + 2 documented changes" "$got" "24 fields as documented; founders: 5 demo bots"

# 5. The public relay keys that pay players' gas can only call act, collect and settle; the gas
#    account's one full-access key is not in the repository.
got=$(query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$GAS_ACCOUNT\"}" | check '
def kind(p):
    if p == "FullAccess":
        return "full access"
    f = p["FunctionCall"]
    return f["receiver_id"] + " " + ",".join(sorted(f["method_names"]))
kinds = collections.Counter(kind(k["access_key"]["permission"]) for k in r["keys"])
relay = kinds.pop("bonfire-coin.testnet act,collect,settle", 0)
kinds.pop("bonfire-stage.testnet act,collect,settle", 0)
full = kinds.pop("full access", 0)
out = ("unexpected keys: %s" % dict(kinds)) if kinds else "%s relay keys for %s (act, collect, settle only), %d full access" % ("some" if relay else "no", "bonfire-coin.testnet", full)')
report "5. relay keys only call act, collect, settle" "$got" "some relay keys for bonfire-coin.testnet (act, collect, settle only), 1 full access"

# 6. The coin's face is drawn by the contract from its state: the word on ft_metadata().icon is the
#    last settled night's outcome (LIT ×streak, SMOKED or COLD; printed with an x). Both views read
#    the same block.
height=$(query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" \
  | check 'out = r["block_height"]')
want=""
case "$height" in
  '' | *[!0-9]*) got="error: no block height ($height)" ;;
  *)
    want=$(view state "$EMPTY_ARGS" "$height" | check '
last = v["last"]
out = ("LIT x%d" % v["streak"]) if last and last["outcome"] == "LIT" else (last["outcome"] if last else "FIRST NIGHT")')
    got=$(view ft_metadata "$EMPTY_ARGS" "$height" | check '
icon = v["icon"]
assert icon.startswith("data:image/svg+xml,"), "not an SVG data URL"
svg = urllib.parse.unquote(icon[len("data:image/svg+xml,"):])
assert svg.startswith("<svg") and svg.endswith("</svg>"), "not an SVG"
out = re.search(r"<text[^>]*>([^<]*)</text>", svg).group(1).replace("\u00d7", "x")')
    case "$got$want" in
      *error:*) got="icon: $got; state(): $want" ;;
      *) if [ "$got" = "$want" ]; then got="icon word matches state()"; else got="icon says '$got', state() says '$want'"; fi ;;
    esac
    ;;
esac
report "6. ft_metadata().icon shows the last night's outcome${want:+ ($want)}" "$got" "icon word matches state()"

if [ "$FAILED" -eq 0 ]; then echo "All $TOTAL checks passed."; else echo "$FAILED of $TOTAL checks failed."; fi
exit "$FAILED"
