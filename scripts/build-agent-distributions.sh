#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
AGENT_DIR="$ROOT/apps/agent"
PUBLIC_DIR="$ROOT/apps/web/public/downloads/agent"
VERSION=${1:-0.1.0}
GO_TOOLCHAIN=${GO_TOOLCHAIN:-go1.23.0}

case "$VERSION" in
  ''|*[!0-9A-Za-z.-]*)
    echo "Invalid agent version: $VERSION" >&2
    exit 1
    ;;
esac

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required to build agent distributions." >&2
  exit 1
fi
if ! command -v gzip >/dev/null 2>&1; then
  echo "gzip is required to package agent distributions." >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/relaydock-agent-build.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

OUTPUT_DIR="$PUBLIC_DIR/v$VERSION"
STAGING_DIR="$TEMP_DIR/distribution"
mkdir -p "$STAGING_DIR"

build_target() {
  os=$1
  arch=$2
  artifact="relaydock-agent-$os-$arch.gz"
  binary="$TEMP_DIR/relaydock-agent-$os-$arch"

  echo "Building $os/$arch with $GO_TOOLCHAIN"
  (
    cd "$AGENT_DIR"
    CGO_ENABLED=0 \
      GOOS="$os" \
      GOARCH="$arch" \
      GOTOOLCHAIN="$GO_TOOLCHAIN" \
      go build \
        -trimpath \
        -buildvcs=false \
        -ldflags="-s -w -X main.agentVersion=$VERSION" \
        -o "$binary" \
        .
  )
  gzip -n -9 -c "$binary" >"$STAGING_DIR/$artifact"
}

# Keep this order stable: SHA256SUMS is committed and checked in CI.
build_target darwin amd64
build_target darwin arm64
build_target linux amd64
build_target linux arm64

(
  cd "$STAGING_DIR"
  : >SHA256SUMS
  for artifact in \
    relaydock-agent-darwin-amd64.gz \
    relaydock-agent-darwin-arm64.gz \
    relaydock-agent-linux-amd64.gz \
    relaydock-agent-linux-arm64.gz
  do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$artifact" >>SHA256SUMS
    else
      shasum -a 256 "$artifact" >>SHA256SUMS
    fi
  done
)

NATIVE_OS=$(GOTOOLCHAIN="$GO_TOOLCHAIN" go env GOOS)
NATIVE_ARCH=$(GOTOOLCHAIN="$GO_TOOLCHAIN" go env GOARCH)
NATIVE_BINARY="$TEMP_DIR/relaydock-agent-$NATIVE_OS-$NATIVE_ARCH"
if [ -x "$NATIVE_BINARY" ]; then
  VERSION_OUTPUT=$("$NATIVE_BINARY" version)
  [ "$VERSION_OUTPUT" = "relaydock-agent $VERSION" ] || {
    echo "Native build reported '$VERSION_OUTPUT', expected 'relaydock-agent $VERSION'." >&2
    exit 1
  }
fi

mkdir -p "$PUBLIC_DIR"
rm -rf "$OUTPUT_DIR"
mv "$STAGING_DIR" "$OUTPUT_DIR"

echo "Agent distributions written to $OUTPUT_DIR"
