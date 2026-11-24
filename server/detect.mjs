import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Game detection for Whisky bottles.
 *
 * Two sources, both read off the bottle's own Steam install:
 *   1. appmanifest_<appid>.acf  — everything Steam installed itself
 *   2. userdata/<id>/config/shortcuts.vdf — "Add a Non-Steam Game" entries,
 *      whose artwork (if the user set any) lives in config/grid/
 */

const CONTAINERS = ["com.franke.Whisky", "com.isaacmarovitz.Whisky"];

const STEAM_DIRS = ["drive_c/Program Files (x86)/Steam", "drive_c/Program Files/Steam"];

// Whisky's bottles, then the prefixes this app builds with its own runtime.
// The old folder name stays listed so a bottle left behind by a pre-rebrand
// build is still found instead of silently disappearing from the rail.
const STEAM_ROOTS = CONTAINERS.map((id) =>
  path.join(homedir(), "Library", "Containers", id, "Bottles"),
).concat([
  path.join(homedir(), "Library", "Application Support", "MacForge", "Bottles"),
  path.join(homedir(), "Library", "Application Support", "Whisky Games", "Bottles"),
]);

// Steam tools, not games: Common Redistributables lands in every prefix the
// moment a game installs, so it would otherwise show up as a "game".
const SKIP_APPIDS = new Set(["228980"]);
const SKIP_NAMES = /^(steamworks|proton|steam linux runtime|steamvr|steam client)/i;

const CDN = "https://cdn.akamai.steamstatic.com/steam/apps";

export const WHISKY_CLI = "/Applications/Whisky.app/Contents/Resources/WhiskyCmd";

// Wide art first, then the 460×215 grid capsule, then the portrait poster.
const GRID_SUFFIXES = ["_hero.png", "_hero.jpg", ".png", ".jpg", ".jpeg", "p.png", "p.jpg"];

function steamDirIn(bottleDir) {
  for (const rel of STEAM_DIRS) {
    const dir = path.join(bottleDir, rel);
    if (existsSync(path.join(dir, "appcache"))) return dir;
  }
  return null;
}

// Steam caches library artwork per app: a folder exists for every app the
// client has shown in the library. The files inside vary by title and age, so
// art is only decoration here — never a reason to drop an owned app.
const ART_PREFERENCE = [
  "library_600x900.jpg",
  "library_hero.jpg",
  "header.jpg",
  "library_600x900.png",
  "library_hero.png",
  "logo.png",
];

const ART_FILE = /\.(jpe?g|png)$/i;

/**
 * Every appid Steam has cached library art for, with the art file to serve.
 * This cache is the client's own offline record of the account's library, so it
 * is what the owned-games list is built from; entries without art are skipped
 * because they are leftover ids rather than library entries.
 */
export function readOwnedLibrary(bottleDir) {
  const owned = new Map();
  const steam = steamDirIn(bottleDir);
  if (!steam) return owned;

  const cache = path.join(steam, "appcache", "librarycache");
  if (!existsSync(cache)) return owned;

  let entries;
  try {
    entries = readdirSync(cache, { withFileTypes: true });
  } catch {
    return owned;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    if (SKIP_APPIDS.has(entry.name)) continue;

    const dir = path.join(cache, entry.name);
    let files = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }

    const preferred = ART_PREFERENCE.find((name) => files.includes(name));
    const art = preferred ?? files.find((name) => ART_FILE.test(name)) ?? null;

    owned.set(entry.name, { appid: entry.name, art: art ? path.join(dir, art) : null });
  }

  return owned;
}

export function listBottles() {
  const found = [];
  for (const root of STEAM_ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(path.join(root, entry.name));
    }
  }
  return found;
}

function readBottleMeta(dir) {
  const meta = {
    name: path.basename(dir),
    windowsVersion: null,
    backend: null,
    compatibilityMode: false,
    detectedLauncher: null,
    enhancedSync: null,
  };

  const plist = path.join(dir, "Metadata.plist");
  if (!existsSync(plist)) return meta;

  try {
    const json = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
    meta.name = json?.info?.name || meta.name;
    meta.windowsVersion = json?.wineConfig?.windowsVersion ?? null;
    meta.backend = json?.graphicsConfig?.backend ?? null;
    meta.compatibilityMode = json?.launcherConfig?.compatibilityMode === true;
    meta.detectedLauncher = json?.launcherConfig?.detectedLauncher ?? null;
    const sync = json?.wineConfig?.enhancedSync;
    meta.enhancedSync = sync && typeof sync === "object" ? Object.keys(sync)[0] ?? null : null;
  } catch {
    // A bottle with unreadable metadata still gets scanned for games.
  }

  return meta;
}

/** Map a Windows library path from libraryfolders.vdf onto the host. */
function wineToHost(value, bottleDir) {
  if (typeof value !== "string" || !value) return null;
  const win = value.match(/^([A-Za-z]):\\(.*)$/);
  if (win) {
    const drive = win[1].toLowerCase();
    const rest = win[2].split("\\").filter(Boolean).join("/");
    return drive === "z" ? `/${rest}` : path.join(bottleDir, `drive_${drive}`, rest);
  }
  return value.startsWith("/") ? value : null;
}

/* ---------------- installed Steam apps ---------------- */

function parseAcf(file) {
  const raw = readFileSync(file, "utf8");
  const get = (key) => {
    const match = raw.match(new RegExp(`"${key}"\\s+"([^"]*)"`));
    return match ? match[1] : null;
  };
  return {
    appid: get("appid"),
    name: get("name"),
    installdir: get("installdir"),
    buildid: get("buildid"),
    state: Number(get("StateFlags") ?? 0),
    sizeOnDisk: Number(get("SizeOnDisk") ?? 0),
    lastPlayed: Number(get("LastPlayed") ?? 0),
    lastUpdated: Number(get("LastUpdated") ?? 0),
    // Live download counters: Steam rewrites these as bytes land.
    download: Number(get("BytesDownloaded") ?? 0),
    downloadTotal: Number(get("BytesToDownload") ?? 0),
    staged: Number(get("BytesStaged") ?? 0),
    stageTotal: Number(get("BytesToStage") ?? 0),
    updateResult: Number(get("UpdateResult") ?? 0),
  };
}

function steamLibraries(steamapps, bottleDir) {
  const libraries = [steamapps];
  const vdf = path.join(steamapps, "libraryfolders.vdf");
  if (!existsSync(vdf)) return libraries;

  for (const match of readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) {
    const host = wineToHost(match[1], bottleDir);
    if (!host) continue;
    const candidate = path.join(host, "steamapps");
    if (existsSync(candidate) && !libraries.includes(candidate)) libraries.push(candidate);
  }
  return libraries;
}

/**
 * Every AppState manifest in a bottle, keyed by appid. A manifest that is not
 * fully installed is a download in flight, and its byte counters are the only
 * honest progress Steam exposes without its window.
 */
export function readManifests(bottleDir) {
  const found = new Map();

  const read = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (!/^appmanifest_\d+\.acf$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const app = parseAcf(file);
        if (!app.appid) continue;
        found.set(app.appid, { ...app, file, library: dir });
      } catch {
        // A manifest Steam is mid-write on is skipped until the next read.
      }
    }
  };

  for (const relative of STEAM_DIRS) {
    const steamapps = path.join(bottleDir, relative, "steamapps");
    if (!existsSync(steamapps)) continue;

    for (const library of steamLibraries(steamapps, bottleDir)) {
      if (!existsSync(library)) continue;
      read(library);

      // Older clients stage the manifest inside downloading/<appid>/ instead.
      let staged = [];
      try {
        staged = readdirSync(path.join(library, "downloading"), { withFileTypes: true });
      } catch {
        staged = [];
      }
      for (const entry of staged) {
        if (entry.isDirectory()) read(path.join(library, "downloading", entry.name));
      }
    }
  }

  return found;
}

/** Turn a host path inside drive_c back into the C:\ path Wine expects. */
function hostToWine(file, bottleDir) {
  const driveC = path.join(bottleDir, "drive_c");
  if (!file.startsWith(driveC)) return null;
  return `C:\\${path.relative(driveC, file).split(path.sep).join("\\")}`;
}

const NOT_THE_GAME = /(launcher|setup|unins|crash|config|helper|touchup|vcredist|dxsetup|installer|redist)/i;

/**
 * Steam's own `-applaunch` silently does nothing when a silent Steam instance
 * is already running in the bottle, so find the game's own executable and fall
 * back to it. The largest remaining .exe is the game binary in practice.
 */
function pickGameExe(installDir) {
  let entries = [];
  try {
    entries = readdirSync(installDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.exe$/i.test(entry.name)) continue;
    if (NOT_THE_GAME.test(entry.name)) continue;
    try {
      const { size } = statSync(path.join(installDir, entry.name));
      if (!best || size > best.size) best = { name: entry.name, size };
    } catch {
      // unreadable entry: ignore
    }
  }

  return best ? path.join(installDir, best.name) : null;
}

function readSteamApps(bottleDir, bottleName) {
  const games = [];
  const seen = new Set();

  for (const relative of STEAM_DIRS) {
    const steamapps = path.join(bottleDir, relative, "steamapps");
    if (!existsSync(steamapps)) continue;

    for (const library of steamLibraries(steamapps, bottleDir)) {
      if (!existsSync(library)) continue;

      let files = [];
      try {
        files = readdirSync(library).filter((name) => /^appmanifest_\d+\.acf$/.test(name));
      } catch {
        continue;
      }

      for (const file of files) {
        let app;
        try {
          app = parseAcf(path.join(library, file));
        } catch {
          continue;
        }
        if (!app.appid || !app.name) continue;
        if (SKIP_APPIDS.has(app.appid)) continue;
        if (SKIP_NAMES.test(app.name)) continue;
        if ((app.state & 4) === 0) continue; // not fully installed
        if (seen.has(app.appid)) continue;

        seen.add(app.appid);
        const exeFile = app.installdir
          ? pickGameExe(path.join(library, "common", app.installdir))
          : null;
        const exe = exeFile ? hostToWine(exeFile, bottleDir) : null;

        games.push({
          appid: app.appid,
          name: app.name,
          kind: "steam",
          bottle: bottleName,
          installdir: app.installdir,
          sizeOnDisk: app.sizeOnDisk,
          lastPlayed: app.lastPlayed,
          exe,
          icon: `${CDN}/${app.appid}/header.jpg`,
          // A capability flag, not a shell command: Steam games launch by appid
          // through this app's own Wine layer, with or without a known exe.
          launch: Boolean(exe || app.appid),
        });
      }
    }
  }

  return games;
}

/* ---------------- Add a Non-Steam Game ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(text) {
  const bytes = Buffer.from(text, "utf8");
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Steam identifies a shortcut by CRC32 of its exe path plus its display name,
 * with the high bit set. Implementations disagree on casing, so generate the
 * plausible variants and use them to look for artwork on disk.
 */
export function shortcutIdCandidates(exe, name) {
  const ids = new Set();
  const paths = exe ? [exe, exe.toLowerCase(), exe.replace(/\\/g, "/")] : [""];
  const names = [name, (name || "").toLowerCase()];
  for (const raw of paths) {
    for (const label of names) ids.add(((crc32(raw + label) | 0x80000000) >>> 0).toString());
  }
  return [...ids];
}

/** Valve's binary KeyValues, as written by shortcuts.vdf. */
function readBinaryVdf(buffer) {
  let offset = 0;

  const readString = () => {
    const start = offset;
    while (offset < buffer.length && buffer[offset] !== 0) offset += 1;
    const value = buffer.toString("utf8", start, offset);
    offset += 1;
    return value;
  };

  const readObject = () => {
    const object = {};
    while (offset < buffer.length) {
      const type = buffer[offset];
      offset += 1;
      if (type === 0x08) return object;

      const key = readString();
      if (type === 0x00) object[key] = readObject();
      else if (type === 0x01) object[key] = readString();
      else if (type === 0x02) {
        object[key] = buffer.readInt32LE(offset);
        offset += 4;
      } else if (type === 0x07) {
        object[key] = Number(buffer.readBigUInt64LE(offset));
        offset += 8;
      } else return object; // unknown type: stop rather than misread
    }
    return object;
  };

  if (buffer[offset] !== 0x00) return null;
  offset += 1;
  const rootKey = readString();
  const root = readObject();
  return { rootKey, root };
}

function findGridArt(gridDir, ids) {
  if (!gridDir || !existsSync(gridDir)) return null;
  for (const id of ids) {
    for (const suffix of GRID_SUFFIXES) {
      const name = `${id}${suffix}`;
      try {
        if (statSync(path.join(gridDir, name)).isFile()) return name;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export function readShortcuts(steamDir, bottleName, bottleId) {
  const userdata = path.join(steamDir, "userdata");
  if (!existsSync(userdata)) return [];

  const games = [];

  for (const account of readdirSync(userdata, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;

    const configDir = path.join(userdata, account.name, "config");
    const shortcutsFile = path.join(configDir, "shortcuts.vdf");
    if (!existsSync(shortcutsFile)) continue;

    let parsed;
    try {
      parsed = readBinaryVdf(readFileSync(shortcutsFile));
    } catch {
      continue;
    }

    // Valve writes the map directly under the "shortcuts" root key; tolerate
    // files that nest it under a root object instead.
    if (!parsed) continue;
    const shortcuts = parsed.rootKey === "shortcuts" ? parsed.root : parsed.root?.shortcuts;
    if (!shortcuts || typeof shortcuts !== "object") continue;

    for (const entry of Object.values(shortcuts)) {
      if (!entry || typeof entry !== "object") continue;
      if (Number(entry.IsHidden ?? 0) === 1) continue;

      const exe = typeof entry.Exe === "string" ? entry.Exe : null;
      const name = entry.AppName || (exe ? path.win32.basename(exe) : null);
      if (!name) continue;

      const ids = shortcutIdCandidates(exe, name);
      const art = findGridArt(path.join(configDir, "grid"), ids);

      games.push({
        appid: ids[0],
        name,
        kind: "shortcut",
        bottle: bottleName,
        exe,
        sizeOnDisk: 0,
        lastPlayed: Number(entry.LastPlayTime ?? 0),
        icon: art ? `/api/grid?b=${encodeURIComponent(bottleId)}&f=${encodeURIComponent(art)}` : null,
        launch: Boolean(exe),
      });
    }
  }

  return games;
}

/* ---------------- scan ---------------- */

function readBottleGames(bottleDir, bottleId, bottleName) {
  const games = [];
  const seen = new Set();

  for (const relative of STEAM_DIRS) {
    const steamDir = path.join(bottleDir, relative);
    if (!existsSync(steamDir)) continue;

    for (const game of readShortcuts(steamDir, bottleName, bottleId)) {
      const key = game.exe ? game.exe.toLowerCase() : game.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      games.push(game);
    }
  }

  games.push(...readSteamApps(bottleDir, bottleName));
  return games;
}

export function detect() {
  const bottles = [];
  const games = [];
  const seen = new Set();

  for (const dir of listBottles()) {
    const bottleId = path.basename(dir);
    const meta = readBottleMeta(dir);
    const found = readBottleGames(dir, bottleId, meta.name);

    bottles.push({
      id: bottleId,
      name: meta.name,
      windowsVersion: meta.windowsVersion,
      backend: meta.backend,
      compatibilityMode: meta.compatibilityMode,
      detectedLauncher: meta.detectedLauncher,
      enhancedSync: meta.enhancedSync,
      gameCount: found.length,
    });

    for (const game of found) {
      const key =
        game.kind === "steam" ? `s:${game.appid}` : `x:${game.exe ?? game.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      games.push(game);
    }
  }

  games.sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name));

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    platform: process.platform,
    counts: {
      bottles: bottles.length,
      games: games.length,
      shortcuts: games.filter((game) => game.kind === "shortcut").length,
    },
    games,
    bottles,
  };
}

/* ---------------- artwork ---------------- */

export function resolveGridArt(bottleId, filename) {
  if (!/^[0-9]{1,12}(_[a-z]+)?p?\.(png|jpe?g)$/i.test(filename)) return null;

  for (const dir of listBottles()) {
    if (path.basename(dir) !== bottleId) continue;

    for (const relative of STEAM_DIRS) {
      const userdata = path.join(dir, relative, "userdata");
      if (!existsSync(userdata)) continue;

      for (const account of readdirSync(userdata, { withFileTypes: true })) {
        if (!account.isDirectory()) continue;
        const gridDir = path.join(userdata, account.name, "config", "grid");
        const file = path.join(gridDir, filename);
        if (!existsSync(file)) continue;
        // Belt and braces: the regex already forbids separators.
        if (!path.resolve(file).startsWith(`${path.resolve(gridDir)}${path.sep}`)) continue;
        return file;
      }
    }
  }

  return null;
}
