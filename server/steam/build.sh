#!/bin/bash
# Rebuilds the steamwebhelper shim that server/steam.mjs installs into a bottle.
#   bash server/steam/build.sh
# Needs either zig (no install) or Homebrew's mingw-w64.
set -euo pipefail
cd "$(dirname "$0")"

SRC=steamwebhelper-wrapper.c
OUT=steamwebhelper.exe

if command -v zig >/dev/null 2>&1; then
  # WinMain entry, GUI subsystem so Steam's launch does not flash a console.
  zig cc -target x86_64-windows-gnu -O2 -DUNICODE -D_UNICODE \
    -Wl,--subsystem,windows -o "$OUT" "$SRC" -lshell32
elif command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  x86_64-w64-mingw32-gcc -O2 -municode -DUNICODE -D_UNICODE -static \
    -o "$OUT" "$SRC" -lshell32 -mwindows
else
  echo "needs zig or mingw-w64: brew install mingw-w64" >&2
  exit 1
fi

rm -f steamwebhelper.pdb
file "$OUT"
