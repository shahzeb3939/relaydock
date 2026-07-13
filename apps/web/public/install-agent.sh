#!/bin/sh

set -eu

AGENT_VERSION=0.1.0
SERVER=
PAIRING_CODE=
DEVICE_NAME=

usage() {
  cat <<'EOF'
Install and pair the RelayDock agent as a background user service.

Usage:
  install-agent.sh --server URL [--code CODE] [--name NAME]

Pass --code to pair or re-pair this device: if a credential already exists it
is replaced (the previous one is backed up alongside it) so a device that was
removed from the server can be added again. Re-running without --code preserves
the existing device identity and only refreshes the binary and background
service.

The installer records the PATH of the shell you run it from so the background
agent can find the same tools you use in a terminal (claude, node, git, ...),
even though it runs as a launchd/systemd service with a minimal PATH.
EOF
}

fail() {
  echo "install-agent.sh: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server)
      [ "$#" -ge 2 ] || fail "--server requires a value"
      SERVER=$2
      shift 2
      ;;
    --code)
      [ "$#" -ge 2 ] || fail "--code requires a value"
      PAIRING_CODE=$2
      shift 2
      ;;
    --name)
      [ "$#" -ge 2 ] || fail "--name requires a value"
      DEVICE_NAME=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$SERVER" ] || fail "--server is required"

case "$SERVER" in
  *'?'*|*'#'*) fail "server URL must not contain a query or fragment" ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  fail "do not run as root; RelayDock must run as your normal user account"
fi

case "$SERVER" in
  https://*)
    SCHEME=https
    AUTHORITY_AND_PATH=${SERVER#https://}
    ;;
  http://localhost|http://localhost/*|http://localhost:*|\
  http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*|\
  http://\[::1\]|http://\[::1\]/*|http://\[::1\]:*)
    SCHEME=http
    AUTHORITY_AND_PATH=${SERVER#http://}
    ;;
  http://*)
    fail "HTTP is allowed only for localhost or a loopback address; use HTTPS"
    ;;
  *)
    fail "server URL must begin with https://"
    ;;
esac

AUTHORITY=${AUTHORITY_AND_PATH%%/*}
[ -n "$AUTHORITY" ] || fail "server URL must contain a host"
case "$AUTHORITY" in
  *'@'*|*'?'*|*'#'*)
    fail "server URL must not contain credentials, a query, or a fragment"
    ;;
esac
DOWNLOAD_ORIGIN="$SCHEME://$AUTHORITY"

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v gzip >/dev/null 2>&1 || fail "gzip is required"

OS_NAME=$(uname -s)
MACHINE=$(uname -m)
case "$OS_NAME" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "unsupported operating system: $OS_NAME (macOS and Linux are supported)" ;;
esac
case "$MACHINE" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "unsupported CPU architecture: $MACHINE (amd64 and arm64 are supported)" ;;
esac

ARTIFACT="relaydock-agent-$OS-$ARCH.gz"
RELEASE_URL="$DOWNLOAD_ORIGIN/downloads/agent/v$AGENT_VERSION"
umask 077
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/relaydock-agent-install.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
CHECKSUMS="$TEMP_DIR/SHA256SUMS"
ARCHIVE="$TEMP_DIR/$ARTIFACT"
BINARY="$TEMP_DIR/relaydock-agent"

download() {
  url=$1
  destination=$2
  if [ "$SCHEME" = https ]; then
    curl --fail --silent --show-error --location \
      --proto '=https' --tlsv1.2 \
      --output "$destination" "$url"
  else
    curl --fail --silent --show-error --location \
      --output "$destination" "$url"
  fi
}

echo "Downloading RelayDock agent v$AGENT_VERSION for $OS/$ARCH..."
download "$RELEASE_URL/SHA256SUMS" "$CHECKSUMS"
download "$RELEASE_URL/$ARTIFACT" "$ARCHIVE"

EXPECTED_CHECKSUM=
while read -r checksum filename; do
  filename=${filename#\*}
  if [ "$filename" = "$ARTIFACT" ]; then
    EXPECTED_CHECKSUM=$checksum
    break
  fi
done <"$CHECKSUMS"

case "$EXPECTED_CHECKSUM" in
  ''|*[!0-9A-Fa-f]*) fail "release checksum is missing or invalid for $ARTIFACT" ;;
esac
[ "${#EXPECTED_CHECKSUM}" -eq 64 ] || fail "release checksum is invalid for $ARTIFACT"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(sha256sum "$ARCHIVE")
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(shasum -a 256 "$ARCHIVE")
else
  fail "sha256sum or shasum is required to verify the download"
fi
ACTUAL_CHECKSUM=${ACTUAL_CHECKSUM%% *}
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "download checksum verification failed"

gzip -dc "$ARCHIVE" >"$BINARY"
chmod 700 "$BINARY"
VERSION_OUTPUT=$("$BINARY" version) || fail "downloaded agent could not run on this computer"
[ "$VERSION_OUTPUT" = "relaydock-agent $AGENT_VERSION" ] || \
  fail "downloaded agent reported an unexpected version: $VERSION_OUTPUT"

set -- install --server "$SERVER"
if [ -n "$PAIRING_CODE" ]; then
  set -- "$@" --code "$PAIRING_CODE"
fi
if [ -n "$DEVICE_NAME" ]; then
  set -- "$@" --name "$DEVICE_NAME"
fi

"$BINARY" "$@"
