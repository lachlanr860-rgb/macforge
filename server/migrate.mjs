import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { listBottles, readManifests } from "./detect.mjs";
import { OWN_BOTTLES } from "./runtime.mjs";

/**
 * Moving the games off Whisky for good.
 *
 * A bottle is a folder; nothing about it refers to the folder it sits in.
 * Steam's library paths are C:\ paths inside the prefix, and the only absolute
 * paths are the ones this app builds from the folder, so relocating the whole
 * folder is enough. Both locations are on the same volume, so this is a rename
 * rather than a 8 GB copy, and it is verified before the move is kept.
 */

export function migrationPlan() {
  const own = path.resolve(OWN_BOTTLES);
  const bottles = [];

  for (const dir of listBottles()) {
    const resolved = path.resolve(dir);
    if (resolved === own || resolved.startsWith(`${own}${path.sep}`)) continue;
    if (!existsSync(path.join(dir, "drive_c"))) continue;

    const id = path.basename(dir);
    const target = path.join(OWN_BOTTLES, id);
    bottles.push({
      id,
      dir,
      target,
      games: readManifests(dir).size,
      conflict: existsSync(target),
    });
  }

  return {
    target: OWN_BOTTLES,
    bottles,
    pending: bottles.filter((bottle) => !bottle.conflict).length,
  };
}

/**
 * Rename each bottle, then check that the same number of installed games is
 * readable from the new place. A mismatch is put back where it was: the source
 * folder stays intact until the move has been proven.
 */
export function migrateBottles() {
  const plan = migrationPlan();
  const results = [];

  for (const bottle of plan.bottles) {
    if (bottle.conflict) {
      results.push({ ...bottle, ok: false, error: "a bottle with that name is already here" });
      continue;
    }

    const before = bottle.games;
    const games = [...readManifests(bottle.dir).keys()];

    try {
      mkdirSync(OWN_BOTTLES, { recursive: true });
      renameSync(bottle.dir, bottle.target);

      const after = readManifests(bottle.target);
      const sameGames = games.every((appid) => after.has(appid));
      const healthy = existsSync(path.join(bottle.target, "drive_c")) && sameGames;

      if (!healthy) {
        renameSync(bottle.target, bottle.dir);
        results.push({
          ...bottle,
          ok: false,
          error: `check failed after the move (${before} games before, ${after.size} after) — put back`,
        });
        continue;
      }

      results.push({ ...bottle, ok: true, games: after.size });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // The rename never happened, so the bottle is still where it was. If it
      // half-happened, put it back before reporting the failure.
      if (!existsSync(bottle.dir) && existsSync(bottle.target)) {
        try {
          renameSync(bottle.target, bottle.dir);
        } catch {
          // Both paths existing is reported below as a failure either way.
        }
      }

      results.push({
        ...bottle,
        ok: false,
        error: /EXDEV/.test(message)
          ? "the two folders are on different volumes, so this would need a copy"
          : message,
      });
    }
  }

  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    moved: results.filter((result) => result.ok).length,
    results,
    remaining: migrationPlan().bottles.length,
  };
}
