#!/bin/bash
# Builds "MacForge.app": a native WebKit window plus the Node server, the built
# site and a Node runtime inside Contents/Resources, with a proper Dock icon.
#   bash app/build.sh             build in the project root
#   bash app/build.sh --install   build, then install into /Applications
#   bash app/build.sh --dmg       build, then write dist/MacForge-<version>.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

APP="MacForge.app"
OLD_APP="Whisky Games.app"
SOURCE_ICON="app/icon.png"
ICNS="app/AppIcon.icns"
ICONSET="app/AppIcon.iconset"
NODE_VERSION="${MACFORGE_NODE_VERSION:-v26.13.1}"
NODE_TARBALL="app/vendor/node-$NODE_VERSION-darwin-arm64.tar.gz"

INSTALL=0
DMG=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --dmg) DMG=1 ;;
    *)
      echo "usage: bash app/build.sh [--install] [--dmg]" >&2
      exit 2
      ;;
  esac
done

if [ -f "$SOURCE_ICON" ]; then
  echo "==> building the icon"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  while read -r pixels name; do
    sips -z "$pixels" "$pixels" "$SOURCE_ICON" --out "$ICONSET/$name.png" >/dev/null
  done <<'SIZES'
16 icon_16x16
32 icon_16x16@2x
32 icon_32x32
64 icon_32x32@2x
128 icon_128x128
256 icon_128x128@2x
256 icon_256x256
512 icon_256x256@2x
512 icon_512x512
1024 icon_512x512@2x
SIZES
  iconutil -c icns "$ICONSET" -o "$ICNS"
fi

echo "==> building the site"
npm run build

echo "==> compiling the shell"
mkdir -p build
swiftc -O app/main.swift -o build/MacForge -framework AppKit -framework WebKit

echo "==> bundling Node $NODE_VERSION"
mkdir -p app/vendor
if [ ! -f "$NODE_TARBALL" ]; then
  curl -fL --retry 3 --progress-bar \
    -o "$NODE_TARBALL.part" \
    "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz"
  mv "$NODE_TARBALL.part" "$NODE_TARBALL"
fi

EXPECTED=$(curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" \
  | awk -v file="node-$NODE_VERSION-darwin-arm64.tar.gz" '$2 == file { print $1 }')
ACTUAL=$(shasum -a 256 "$NODE_TARBALL" | awk '{ print $1 }')
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Node tarball checksum mismatch for $NODE_TARBALL" >&2
  exit 1
fi

rm -rf build/node
mkdir -p build/node
tar -xzf "$NODE_TARBALL" -C build/node --strip-components=1 \
  "node-$NODE_VERSION-darwin-arm64/bin/node"
test -x build/node/bin/node

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp build/MacForge "$APP/Contents/MacOS/MacForge"
cp app/Info.plist "$APP/Contents/Info.plist"
cp -R server "$APP/Contents/Resources/server"
cp -R dist "$APP/Contents/Resources/dist"
cp -R build/node "$APP/Contents/Resources/node"
if [ -f "$ICNS" ]; then cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"; fi
chmod +x "$APP/Contents/MacOS/MacForge" "$APP/Contents/Resources/node/bin/node"

codesign --force --sign - "$APP/Contents/Resources/node/bin/node" >/dev/null 2>&1 || true
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

if [ "$DMG" = 1 ]; then
  VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" app/Info.plist)
  echo "==> building the disk image"
  mkdir -p dist
  STAGE="build/dmg"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/.background"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  if [ -f app/dmg-background.png ]; then
    cp app/dmg-background.png "$STAGE/.background/background.png"
  fi

  # Finder only stores icon positions and the background in .DS_Store, which is
  # written while the image is mounted read/write. The final image is a
  # compressed copy of that laid-out volume.
  RW="build/MacForge-rw.dmg"
  MOUNT="/Volumes/MacForge"
  OUT="dist/MacForge-$VERSION.dmg"
  rm -f "$RW" "$OUT"

  cleanup_dmg() {
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  }
  trap cleanup_dmg EXIT

  if [ -d /Volumes/MacForge ]; then
    hdiutil detach -force /Volumes/MacForge >/dev/null 2>&1 || {
      echo "Eject the mounted MacForge volume before building the disk image." >&2
      exit 1
    }
  fi

  hdiutil create -volname "MacForge" -srcfolder "$STAGE" -ov -format UDRW -fs HFS+ "$RW" >/dev/null
  hdiutil attach "$RW" -nobrowse -readwrite >/dev/null
  if [ ! -d "$MOUNT" ]; then
    echo "Could not mount the disk image at $MOUNT." >&2
    exit 1
  fi

  osascript <<'APPLESCRIPT'
    tell application "Finder"
      set deskBounds to bounds of window of desktop
      tell disk "MacForge"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false

        set winWidth to 700
        set winHeight to 460
        set leftPos to round (((item 3 of deskBounds) - winWidth) / 2)
        set topPos to round (((item 4 of deskBounds) - winHeight) / 2)
        set the bounds of container window to {leftPos, topPos, leftPos + winWidth, topPos + winHeight}

        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to 128
        set text size of opts to 13
        set color of opts to {65535, 65535, 65535}
        set background picture of opts to file ".background:background.png"

        set position of item "MacForge.app" of container window to {180, 216}
        set position of item "Applications" of container window to {520, 216}
        update without registering applications
        delay 1
        close
      end tell
      set selection to {}
    end tell
APPLESCRIPT

  if [ -f "$ICNS" ]; then
    cp "$ICNS" "$MOUNT/.VolumeIcon.icns"
    SetFile -a C "$MOUNT" >/dev/null 2>&1 || true
    echo "==> volume icon added"
  fi

  sync
  sleep 1
  hdiutil detach "$MOUNT" >/dev/null
  hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null
  rm -f "$RW"
  trap - EXIT
  codesign --force --sign - "$OUT" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
  echo "==> disk image: $OUT ($(du -h "$OUT" | cut -f1))"
fi

if [ "$INSTALL" = 1 ]; then
  echo "==> installing to /Applications"
  rm -rf "/Applications/$APP"
  cp -R "$APP" /Applications/
  # The pre-rebrand bundle, so two copies of the app do not list the same games.
  rm -rf "/Applications/$OLD_APP"
  # Nudge Launch Services so Launchpad and Spotlight pick it up immediately.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "/Applications/$APP" >/dev/null 2>&1 || true
  rm -rf "$APP"
  echo "==> installed: /Applications/$APP"
else
  echo "==> done: $APP"
fi
