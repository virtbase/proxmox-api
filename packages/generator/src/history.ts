import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareDebianVersions, minorOf } from "./apt.js";
import type { SchemaDiff } from "./diff.js";
import { GENERATOR_ROOT } from "./load-schema.js";

/**
 * Default directory of the stored history entries, `history` in the generator
 * package.
 */
const HISTORY_DIR = join(GENERATOR_ROOT, "history");

/**
 * One tracked schema version and how it differs from the one before it,
 * stored as `history/<version>.json`.
 *
 * @remarks
 * These files are the source of the API changelog. Each is written once, when
 * the lock moves to that version, and never regenerated: the upstream
 * packages it was computed from may not stay downloadable for ever.
 */
export interface HistoryEntry extends SchemaDiff {
  /**
   * The `pve-docs` version this entry describes.
   */
  version: string;
  /**
   * The version this one was compared with; absent on the first entry.
   */
  previous?: string;
  /**
   * Date the `pve-docs` package was published (`YYYY-MM-DD`); absent when it
   * was not known at the time the entry was written.
   */
  released?: string;
  /**
   * SHA-256 of the `apiSchema` literal this version ships.
   */
  schemaSha256: string;
  /**
   * Number of operations in this version of the schema.
   */
  operations: number;
  /**
   * Exported type names that existed in the previous model and no longer do.
   * A rename looks the same as a removal to anyone importing the type, so any
   * entry here makes the update breaking.
   */
  removedTypes?: string[];
}

/**
 * Reads every stored history entry.
 *
 * @param directory - Directory holding the `<version>.json` files. Defaults
 *   to `history` in the generator package.
 * @returns The entries, oldest version first; empty when the directory cannot
 *   be read. Files that do not end in `.json` are ignored, and the entries
 *   are not validated.
 * @throws An {@link Error} if one of the files cannot be read.
 * @throws A {@link SyntaxError} if one of the files is not valid JSON.
 */
export async function readHistory(
  directory = HISTORY_DIR,
): Promise<HistoryEntry[]> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(
        async (file) =>
          JSON.parse(
            await readFile(join(directory, file), "utf8"),
          ) as HistoryEntry,
      ),
  );
  return entries.sort((a, b) => compareDebianVersions(a.version, b.version));
}

/**
 * Stores a history entry as `<version>.json`, written as indented JSON with a
 * trailing newline.
 *
 * @remarks
 * The directory is created when it is missing. A file that already exists
 * for the same version is overwritten.
 *
 * @param entry - The entry to store; its `version` names the file.
 * @param directory - Directory to write to. Defaults to `history` in the
 *   generator package.
 * @throws An {@link Error} if the directory cannot be created or the file
 *   cannot be written.
 */
export async function writeHistoryEntry(
  entry: HistoryEntry,
  directory = HISTORY_DIR,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${entry.version}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Groups history entries by Proxmox VE minor release.
 *
 * @param entries - Entries in any order; the array is left as it is.
 * @returns One group per release such as `9.2`, newest release first, each
 *   holding its entries newest version first.
 */
export function groupByMinor(
  entries: HistoryEntry[],
): Array<{ minor: string; entries: HistoryEntry[] }> {
  const groups = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const minor = minorOf(entry.version);
    const group = groups.get(minor) ?? [];
    groups.set(minor, group);
    group.push(entry);
  }
  return [...groups]
    .map(([minor, group]) => ({
      minor,
      entries: group.sort((a, b) =>
        compareDebianVersions(b.version, a.version),
      ),
    }))
    .sort((a, b) => compareDebianVersions(b.minor, a.minor));
}
