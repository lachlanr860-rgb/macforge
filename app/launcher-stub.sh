#!/usr/bin/env bash
# Replace Skyrim Special Edition's launcher with a stub that starts the game.
#
# Steam's launch target for appid 489830 is SkyrimSELauncher.exe, and the game
# binary hands over to that launcher whenever it is present, so the only launch
# that reaches the game without the launcher UI is a stub in its place: Steam
# starts the stub, the stub starts SkyrimSE.exe as its child, and the game keeps
# the Steam launch context it requires.
#
#   bash app/launcher-stub.sh install   # put the stub in place (keeps the original)
#   bash app/launcher-stub.sh remove    # restore SkyrimSELauncher.exe
#   bash app/launcher-stub.sh build     # only compile the stub
#
# Building needs zig (brew install zig). Replacing these files may make Steam's
# "verify integrity of game files" restore the original launcher; re-run install
# afterwards.

set -euo pipefail

BOTTLE="${WHISKY_STUB_BOTTLE:-$HOME/Library/Containers/com.franke.Whisky/Bottles/E140608E-0BAE-4D4D-8865-B23FA4D407AD}"
GAME_DIR="$BOTTLE/drive_c/Program Files (x86)/Steam/steamapps/common/Skyrim Special Edition"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILT="$HERE/SkyrimSELauncher.exe"
LAUNCHER="$GAME_DIR/SkyrimSELauncher.exe"
ORIGINAL="$GAME_DIR/SkyrimSELauncher.exe.orig"

build() {
  command -v zig >/dev/null 2>&1 || { echo "zig is required: brew install zig" >&2; exit 1; }
  echo "==> compiling the launcher stub"
  # A console subsystem binary would flash a console window when Steam starts
  # it, so link as a GUI application explicitly.
  zig cc -target x86_64-windows-gnu -O2 -Wl,--subsystem,windows -o "$BUILT" "$HERE/launcher-stub.c"
  echo "==> built $BUILT"
}

install() {
  [ -f "$LAUNCHER" ] || { echo "no launcher at $LAUNCHER" >&2; exit 1; }
  [ -f "$BUILT" ] || build
  if [ -f "$ORIGINAL" ]; then
    echo "==> original already saved as SkyrimSELauncher.exe.orig"
  else
    mv "$LAUNCHER" "$ORIGINAL"
    echo "==> saved the original launcher as SkyrimSELauncher.exe.orig"
  fi
  cp "$BUILT" "$LAUNCHER"
  echo "==> installed the stub as SkyrimSELauncher.exe"
}

remove() {
  [ -f "$ORIGINAL" ] || { echo "nothing to restore" >&2; exit 1; }
  mv -f "$ORIGINAL" "$LAUNCHER"
  echo "==> restored the original launcher"
}

case "${1:-install}" in
  build) build ;;
  install) install ;;
  remove) remove ;;
  *) echo "usage: $0 [build|install|remove]" >&2; exit 2 ;;
esac
