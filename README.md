# MacForge

A macOS game launcher for Windows games on Apple silicon. It is a small AppKit
window around a WebKit view, with a local Node server and a Vite-built console
behind it. Games live in Wine bottles that MacForge manages itself: it finds the
Steam install inside a bottle, launches games on its own Wine layer, and drives
Steam's silent install/uninstall from the page — no Steam window, no CrossOver,
no Whisky install required. A one-time **Set up Steam** button builds a bottle,
installs Steam and opens it for sign-in.

```
index.html, src/        the console (home rail, owned library, bottle tools)
server/                 local HTTP server and game/runtime logic
app/                    the native shell, icon and bundling script
scripts/fetch-runtime   installs the Wine tree MacForge runs games with
```

## Download

The built `.dmg` is attached to the latest GitHub release. It is ad-hoc signed,
so the first launch needs right-click → Open on a Mac that has never run it.

## Requirements

- macOS 13 or newer on Apple silicon.
- No Node or Wine install: the app carries its own Node runtime and downloads
  its Wine tree on first launch.
- No existing Steam bottle: the in-app **Set up Steam** button creates one,
  installs Steam and opens it once for sign-in.
- `ffmpeg` for hover trailer clips (`brew install ffmpeg`); everything else works
  without it. Development also needs Node.js.

## Run it

```sh
npm install
npm run dev            # Vite at http://localhost:5173, API mounted on the same port
```

To run the way the app does — the built site plus the API from one loopback
server:

```sh
npm run build
PORT=5210 node server/server.mjs
```

The app itself starts that server on a random free port and loads it in the
window.

## Build the app

```sh
bash app/build.sh             # MacForge.app in the project root
bash app/build.sh --install   # also copies it to /Applications
bash app/build.sh --dmg       # also writes dist/MacForge-<version>.dmg
```

The script rebuilds `AppIcon.icns` from `app/icon.png` with `sips`, builds the
site, compiles `app/main.swift` with `swiftc`, downloads and checksums the
official Node runtime, and assembles the bundle with the server, `dist/` and
`node/` inside `Contents/Resources`. Installing replaces the previous bundle of
the same name and removes the pre-rebrand `Whisky Games.app`, so two copies
cannot list the same library.

## Where things live

| Path | What |
| --- | --- |
| `~/Library/Application Support/MacForge/Bottles` | bottles this app created or moved here |
| `~/Library/Application Support/MacForge/runtime` | the Wine tree it launches with |
| `~/Library/Application Support/MacForge/payloads` | adopted or downloaded DXVK/redist payloads |
| `~/Library/Application Support/MacForge/crashes` | crash reports for unexpected game exits (newest 25 kept) |
| `~/Library/Caches/MacForge/clips` | cached store-trailer clips for hover previews |
| `~/Library/Caches/MacForge/appinfo.json` | Steam app-name cache |

Bottles made by Whisky are still read from its containers. The console offers to
move them into MacForge's own folder with a same-volume rename (not a copy),
verifies that every installed game is still readable, and rolls back if not.

## Wine runtime

On a machine with no Wine, the app downloads its own tree (about 1.3 GB, Wine
11.19 with MoltenVK, DXVK and DXMT) on first launch and shows the progress in
the library. It falls back to a shared Whisky runtime if one already exists.
The same installer is available from a terminal for pre-seeding or offline use:

```sh
node scripts/fetch-runtime.mjs --list   # show what would be installed
node scripts/fetch-runtime.mjs          # download, verify and install
```

Downloads are checked against the SHA-256 GitHub publishes for the asset. A new
or freshly moved bottle is then prepared with the DLL payloads and the VC++
2015–2022 runtimes a game expects: DXVK 2.7.1 (`d3d8`, `d3d9`, `d3d10core`,
`d3d11`, `dxgi` for x64 and x32) plus the matching native overrides in the
bottle's registry.

## How it works

- **Detection** reads `appmanifest_<appid>.acf` for installed Steam games and
  `shortcuts.vdf` for non-Steam entries, skipping tools such as the Common
  Redistributables. It also reads Steam's library-art cache, which is how the
  owned-library list can be shown before a game is installed.
- **Launching** goes through the runtime's own `wine64` and `wine64 start /unix`.
  Steam launches wait for the client to actually be ready (up to 300 seconds)
  before asking it to start a game. DLL overrides live in the prefix registry,
  not in `WINEDLLOVERRIDES`.
- **Installing and removing** are Steam's own silent commands, polled for
  progress and speed, with pause/resume/cancel from the game's row. Nothing is
  typed into a Steam window.
- **Terms and first runs** are not automated: a game that opens its own EULA,
  terms or sign-in screen gets a hint that a first run may need one, and later
  launches go straight in. MacForge never accepts an agreement on your behalf.
- **Crash reports** watch a game's install folder for the length of a session and
  record an unexpected exit with recent log lines; asking a game to stop does
  not produce a report.
- **Server scope** is loopback only. Mutating requests additionally require a
  same-origin `Origin`, so another page cannot drive the app.

## API

All endpoints are under `/api/` on the local server; GET unless noted.

| Endpoint | Purpose |
| --- | --- |
| `/api/games` | installed games across every readable bottle |
| `/api/library` | the owned Steam library, with install state |
| `/api/install`, `/api/uninstall`, `/api/download`, `/api/update`, `/api/verify` (POST) | Steam operations |
| `/api/launch` (POST), `/api/status`, `/api/quit` (POST) | run and stop games |
| `/api/runtime` | which Wine is in use, and from where |
| `/api/runtime/install` (POST) | downloads the app's own Wine runtime; GET follows the job |
| `/api/runtime/check` (POST) | launches a program through the runtime, then checks the DXVK payload |
| `/api/setup/steam` (POST) | creates a bottle, installs Steam and opens it for sign-in |
| `/api/steam/open` (POST) | reopens an installed Steam for sign-in |
| `/api/bottles`, `/api/bottles/migrate` (POST) | bottles still outside MacForge's folder, and moving them |
| `/api/bottle` (POST), `/api/bottle/prepare` (POST) | create a prepared bottle, or repair one |
| `/api/payloads`, `/api/preflight` | payload state and setup problems |
| `/api/crashes`, `/api/crash` | crash reports |

Mutations need a same-origin `Origin` header, for example:

```sh
curl -X POST -H 'Origin: http://127.0.0.1:5210' \
  http://127.0.0.1:5210/api/runtime/check
```

`/api/runtime/check` reports `healthy: true` only when Wine, `wineserver`,
MoltenVK, the bottle's DXVK, a prefix round-trip **and** the complete DXVK
payload all pass.

## Static build

`npm run build` writes `dist/`. `deploy.json` and `worker/index.js` can serve
those assets as a static site, but the API and game launching only exist in the
local server — a static copy is the console without a backend.
