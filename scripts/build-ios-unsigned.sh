#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: build-ios-unsigned.sh VERSION}"
ROOT="$(pwd)"
LOG="$ROOT/ios-build-session.log"
ADDR_FILE="$(node -p "require('os').tmpdir() + '/' + require('./src-tauri/tauri.conf.json').identifier + '-server-addr'")"
mkdir -p artifacts
rm -f "$ADDR_FILE"

# Tauri 2.10.1 has no ios --no-sign flag. Keep its release options server
# alive for the generated Xcode 'Build Rust Code' phase instead.
pnpm tauri ios build --open --ci --features custom-protocol >"$LOG" 2>&1 &
SESSION_PID=$!
cleanup() {
  kill "$SESSION_PID" 2>/dev/null || true
  cat "$LOG"
}
trap cleanup EXIT
for ((attempt = 0; attempt < 180; attempt++)); do
  if ! kill -0 "$SESSION_PID" 2>/dev/null; then
    echo 'Tauri build session exited before becoming ready' >&2
    exit 1
  fi
  if [[ -s "$ADDR_FILE" ]]; then
    break
  fi
  sleep 1
done
if [[ ! -s "$ADDR_FILE" ]]; then
  echo 'Timed out waiting for the Tauri build options server' >&2
  exit 1
fi

# Tauri generates lowercase debug/release configurations. Using Release
# silently selected debug in the original workflow.
XCODE_TOOLCHAIN="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain"
test -d "$XCODE_TOOLCHAIN/usr/lib/swift/iphoneos"
xcodebuild build \
  -toolchain com.apple.dt.toolchain.XcodeDefault \
  -project src-tauri/gen/apple/huangguo-client.xcodeproj \
  -scheme huangguo-client_iOS \
  -configuration release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/build_output" \
  TOOLCHAIN_DIR="$XCODE_TOOLCHAIN" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

APP="$ROOT/build_output/Build/Products/release-iphoneos/HGhub.app"
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")
test -s "$APP/$EXECUTABLE"
file "$APP/$EXECUTABLE" | grep 'Mach-O.*arm64'
# Avoid grep -q with pipefail: early pipe closure can hide a match.
strings "$APP/$EXECUTABLE" > "$ROOT/ios-binary-strings.txt"
if grep -F 'localhost:1420' "$ROOT/ios-binary-strings.txt"; then
  echo 'Refusing to package a development build' >&2
  exit 1
fi

PACKAGE_DIR=$(mktemp -d)
mkdir -p "$PACKAGE_DIR/Payload"
cp -R "$APP" "$PACKAGE_DIR/Payload/"
IPA="$ROOT/artifacts/HGhub_${VERSION}_ios.ipa"
(cd "$PACKAGE_DIR" && zip -qr "$IPA" Payload)
unzip -tq "$IPA"
ls -lh "$IPA"
