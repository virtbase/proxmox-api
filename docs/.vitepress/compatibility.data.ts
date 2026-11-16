import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * One row of the compatibility table: a release of the package and the schema
 * it was generated from.
 */
export interface Release {
  /**
   * Version of `@virtbase/proxmox-api`.
   */
  version: string;
  /**
   * The `pve-docs` version its API model was generated from.
   */
  schema: string;
}

/**
 * Absolute path of the repository root.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Path of the generator's lock file, relative to the repository root.
 */
const LOCK = "packages/generator/schema.lock.json";

/**
 * The `pve-docs` version behind each release that was cut before the schema
 * version was pinned in the repository, keyed by package version.
 */
const BEFORE_LOCK: Record<string, string> = {
  "2.0.0": "9.2.4",
  "3.0.0": "9.2.5",
};

/**
 * Runs `git` in the repository root and captures what it prints.
 *
 * @param args - Arguments passed to `git` as they are, without a shell.
 * @returns The standard output, or `undefined` when `git` cannot be started
 *   or exits with a non-zero status. Its error output is discarded.
 */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * Reads the pinned `pve-docs` version from the lock file as committed at a
 * Git revision.
 *
 * @param ref - Tag, branch or commit to read the lock file from.
 * @returns The version, or `undefined` when the revision has no lock file or
 *   `git` fails.
 * @throws A {@link SyntaxError} if the lock file at `ref` is not valid JSON.
 */
function schemaAt(ref: string): string | undefined {
  const lock = git("show", `${ref}:${LOCK}`);
  return lock ? (JSON.parse(lock) as { version: string }).version : undefined;
}

/**
 * Orders releases newest first. Version components are compared as numbers,
 * so `10.0.0` sorts above `9.0.0`.
 */
function byVersionDescending(a: Release, b: Release): number {
  return b.version.localeCompare(a.version, undefined, { numeric: true });
}

/**
 * VitePress data loader behind the compatibility table in the guide.
 *
 * @remarks
 * `watch` names the lock file, so the development server reloads the table
 * when the pinned schema changes.
 */
export default {
  watch: [`../../${LOCK}`],
  /**
   * Collects which schema each release shipped.
   *
   * @remarks
   * Every tag of the form `x.y.z` is a release, and its schema is read from
   * the lock file at that tag by running `git`. Releases from before the lock
   * file existed come from {@link BEFORE_LOCK}. The package version in the
   * working tree is added with the current lock unless it is already known:
   * on the commit that cuts a release the tag does not exist yet, and a
   * shallow clone has no tags at all.
   *
   * @returns The releases, newest first.
   * @throws An {@link Error} if `packages/api/package.json` or the lock file
   *   cannot be read.
   * @throws A {@link SyntaxError} if either file, or the lock file at a tag,
   *   is not valid JSON.
   */
  load(): Release[] {
    const releases = new Map<string, string>(Object.entries(BEFORE_LOCK));
    const tags = (git("tag", "--list") ?? "")
      .split("\n")
      .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag));
    for (const tag of tags) {
      const schema = schemaAt(tag);
      if (schema) releases.set(tag, schema);
    }

    const read = (path: string) =>
      JSON.parse(readFileSync(`${ROOT}/${path}`, "utf8")) as {
        version: string;
      };
    const head = read("packages/api/package.json").version;
    if (!releases.has(head)) releases.set(head, read(LOCK).version);

    return [...releases]
      .map(([version, schema]) => ({ version, schema }))
      .sort(byVersionDescending);
  },
};
