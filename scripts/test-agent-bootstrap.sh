#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALLER="$ROOT/apps/web/public/install-agent.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/relaydock-bootstrap-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

FAKE_BIN="$TEST_ROOT/bin"
FIXTURES="$TEST_ROOT/fixtures"
mkdir -p "$FAKE_BIN" "$FIXTURES"

checksum_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

cat >"$TEST_ROOT/fake-agent" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  version)
    echo "relaydock-agent ${TEST_AGENT_VERSION:-0.1.0}"
    ;;
  install)
    : >"$CALL_LOG"
    for argument in "$@"; do
      printf '%s\n' "$argument" >>"$CALL_LOG"
    done
    ;;
  *)
    exit 64
    ;;
esac
EOF
chmod 700 "$TEST_ROOT/fake-agent"

for artifact in \
  relaydock-agent-darwin-amd64.gz \
  relaydock-agent-darwin-arm64.gz \
  relaydock-agent-linux-amd64.gz \
  relaydock-agent-linux-arm64.gz
do
  gzip -n -9 -c "$TEST_ROOT/fake-agent" >"$FIXTURES/$artifact"
done

(
  cd "$FIXTURES"
  : >SHA256SUMS
  for artifact in \
    relaydock-agent-darwin-amd64.gz \
    relaydock-agent-darwin-arm64.gz \
    relaydock-agent-linux-amd64.gz \
    relaydock-agent-linux-arm64.gz
  do
    checksum_file "$artifact" >>SHA256SUMS
  done
)

cat >"$FAKE_BIN/curl" <<'EOF'
#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o)
      output=$2
      shift 2
      ;;
    --proto)
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url=$1
      shift
      ;;
  esac
done
[ -n "$output" ]
[ -n "$url" ]
printf '%s\n' "$url" >>"$CURL_LOG"
file=${url##*/}
cp "$FIXTURE_DIR/$file" "$output"
EOF

cat >"$FAKE_BIN/id" <<'EOF'
#!/bin/sh
set -eu
[ "${1:-}" = "-u" ]
echo "${TEST_ID_U:-501}"
EOF

cat >"$FAKE_BIN/uname" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  -s) echo "$TEST_UNAME_S" ;;
  -m) echo "$TEST_UNAME_M" ;;
  *) exit 64 ;;
esac
EOF
chmod 700 "$FAKE_BIN/curl" "$FAKE_BIN/id" "$FAKE_BIN/uname"

export FIXTURE_DIR="$FIXTURES"
export PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

fail() {
  echo "test-agent-bootstrap.sh: $*" >&2
  exit 1
}

assert_line() {
  expected=$1
  file=$2
  grep -F -x -- "$expected" "$file" >/dev/null || fail "missing line '$expected' in $file"
}

run_success_case() {
  os_name=$1
  machine=$2
  artifact=$3
  server=$4
  call_log="$TEST_ROOT/call-$os_name-$machine.log"
  curl_log="$TEST_ROOT/curl-$os_name-$machine.log"
  : >"$curl_log"
  export TEST_UNAME_S="$os_name" TEST_UNAME_M="$machine" CALL_LOG="$call_log" CURL_LOG="$curl_log"
  sh "$INSTALLER" --server "$server" --code ABCD-EFGH --name "Development laptop" >/dev/null
  assert_line install "$call_log"
  assert_line --server "$call_log"
  assert_line "$server" "$call_log"
  assert_line --code "$call_log"
  assert_line ABCD-EFGH "$call_log"
  assert_line --name "$call_log"
  assert_line "Development laptop" "$call_log"
  assert_line "${server%%/base}/downloads/agent/v0.1.0/$artifact" "$curl_log"
}

run_success_case Darwin x86_64 relaydock-agent-darwin-amd64.gz https://relay.example.com/base
run_success_case Darwin arm64 relaydock-agent-darwin-arm64.gz https://relay.example.com/base
run_success_case Linux x86_64 relaydock-agent-linux-amd64.gz https://relay.example.com/base
run_success_case Linux aarch64 relaydock-agent-linux-arm64.gz http://127.0.0.1:3000

export TEST_UNAME_S=Linux TEST_UNAME_M=x86_64 CALL_LOG="$TEST_ROOT/no-code.log" CURL_LOG="$TEST_ROOT/no-code-curl.log"
: >"$CURL_LOG"
sh "$INSTALLER" --server https://relay.example.com >/dev/null
if grep -F -x -- --code "$CALL_LOG" >/dev/null; then
  fail "installer forwarded an absent pairing code"
fi

export TEST_ID_U=0
if sh "$INSTALLER" --server https://relay.example.com --code ABCD-EFGH >/dev/null 2>&1; then
  fail "installer accepted root"
fi
unset TEST_ID_U

for insecure_server in \
  http://relay.example.com \
  http://localhost.evil.example \
  'https://relay.example.com?download=http://evil.example' \
  'https://user:password@relay.example.com'
do
  if sh "$INSTALLER" --server "$insecure_server" --code ABCD-EFGH >/dev/null 2>&1; then
    fail "installer accepted unsafe server URL $insecure_server"
  fi
done

export TEST_UNAME_M=i386
if sh "$INSTALLER" --server https://relay.example.com --code ABCD-EFGH >/dev/null 2>&1; then
  fail "installer accepted an unsupported architecture"
fi
export TEST_UNAME_M=x86_64

cp "$FIXTURES/relaydock-agent-linux-amd64.gz" "$TEST_ROOT/original.gz"
printf 'corrupt' >>"$FIXTURES/relaydock-agent-linux-amd64.gz"
if sh "$INSTALLER" --server https://relay.example.com --code ABCD-EFGH >/dev/null 2>&1; then
  fail "installer accepted a corrupt download"
fi
mv "$TEST_ROOT/original.gz" "$FIXTURES/relaydock-agent-linux-amd64.gz"

export TEST_AGENT_VERSION=9.9.9
gzip -n -9 -c "$TEST_ROOT/fake-agent" >"$FIXTURES/relaydock-agent-linux-amd64.gz"
(
  cd "$FIXTURES"
  checksum=$(checksum_file relaydock-agent-linux-amd64.gz)
  checksum=${checksum%% *}
  awk -v checksum="$checksum" '
    $2 == "relaydock-agent-linux-amd64.gz" { $1 = checksum }
    { print }
  ' SHA256SUMS >SHA256SUMS.next
  mv SHA256SUMS.next SHA256SUMS
)
if sh "$INSTALLER" --server https://relay.example.com --code ABCD-EFGH >/dev/null 2>&1; then
  fail "installer accepted an unexpected agent version"
fi

echo "Agent bootstrap tests passed."
