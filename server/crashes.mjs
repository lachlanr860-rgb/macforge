import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { APP_SUPPORT } from "./runtime.mjs";

/**
 * When a Windows game dies inside Wine there is no crash dialog and no exit
 * code the app can see: the window vanishes and the process is gone. What Wine
 * did say is in the Steam log, so each session records the log lines written
 * since it started, the signatures worth reading, and how long the game ran.
 *
 * A report is only written when the game stopped without being asked to, so
 * quitting normally does not fill this folder.
 */

export const CRASH_DIR = path.join(APP_SUPPORT, "crashes");
const KEEP = 25;

const SIGNATURE =
  /unhandled exception|page fault|access violation|err:seh|winedbg|err:module|err:virtual|c0000005|c0000409|failed to load|device lost/i;

/** The text appended to a log since a recorded byte offset, last lines first-class. */
export function logSince(file, offset, maxLines = 160) {
  if (!file || !existsSync(file)) return [];

  let bytes;
  try {
    const size = statSync(file).size;
    if (size <= offset) return [];
    const start = Math.max(0, offset);
    const length = Math.min(size - start, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    bytes = buffer;
  } catch {
    return [];
  }

  return bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-maxLines);
}

/** The lines in a tail that name a failure, so a report reads without the noise. */
export function signalsIn(lines) {
  return lines.filter((line) => SIGNATURE.test(line)).slice(-12);
}

function prune() {
  let names = [];
  try {
    names = readdirSync(CRASH_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= KEEP) return;

  const byAge = names
    .map((name) => {
      try {
        return { name, at: statSync(path.join(CRASH_DIR, name)).mtimeMs };
      } catch {
        return { name, at: 0 };
      }
    })
    .sort((a, b) => b.at - a.at);

  for (const entry of byAge.slice(KEEP)) {
    try {
      rmSync(path.join(CRASH_DIR, entry.name), { force: true });
    } catch {
      // A report that will not delete is not worth failing a session over.
    }
  }
}

export function recordCrash(entry) {
  mkdirSync(CRASH_DIR, { recursive: true });

  const at = new Date(entry.endedAt ?? Date.now());
  const id = `${at.toISOString().replace(/[:.]/g, "-")}-${entry.appid ?? "app"}`;
  const report = {
    id,
    appid: entry.appid ?? null,
    name: entry.name ?? null,
    bottle: entry.bottle ?? null,
    exe: entry.exe ?? null,
    startedAt: entry.startedAt ?? null,
    endedAt: entry.endedAt ?? Date.now(),
    seconds: entry.seconds ?? null,
    unexpected: entry.unexpected !== false,
    // A game that dies within a minute saying nothing is usually sitting on a
    // first-run terms or sign-in screen rather than genuinely crashing.
    firstRun: (entry.signals ?? []).length === 0 && (entry.seconds ?? 999) < 90,
    signals: entry.signals ?? [],
    logTail: entry.logTail ?? [],
    file: path.join(CRASH_DIR, `${id}.json`),
  };

  try {
    writeFileSync(report.file, JSON.stringify(report, null, 2));
    prune();
  } catch {
    return null;
  }

  return report;
}

function readReport(file) {
  try {
    return JSON.parse(readFileSync(path.join(CRASH_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

export function listCrashes(limit = 20) {
  let names = [];
  try {
    names = readdirSync(CRASH_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  return names
    .map(readReport)
    .filter(Boolean)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, limit);
}

export function readCrash(id) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(id ?? "")) return null;
  return readReport(`${id}.json`);
}
