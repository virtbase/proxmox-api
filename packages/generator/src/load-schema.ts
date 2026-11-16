import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AptPackage, AptSource } from "./apt.js";
import { downloadApidoc } from "./apt.js";
import type { PveNode } from "./schema.js";

/**
 * Absolute path of the generator package, the directory that holds the lock
 * file, the download cache and the history.
 */
export const GENERATOR_ROOT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

/**
 * Default location of the lock file.
 */
const LOCK_PATH = join(GENERATOR_ROOT, "schema.lock.json");

/**
 * The committed, gzip-compressed copy of the pinned schema, which generating
 * reads instead of the network.
 */
const SCHEMA_PATH = join(GENERATOR_ROOT, "schema.json.gz");

/**
 * Directory in which downloaded API viewer bundles are kept between runs. It
 * is ignored by Git.
 */
const CACHE_DIR = join(GENERATOR_ROOT, ".cache");

/**
 * The exact upstream artefact the committed output was generated from, as
 * stored in `schema.lock.json`.
 *
 * @remarks
 * Proxmox publishes no versioned schema; the only versioned copy is the
 * `apidoc.js` inside each `pve-docs` package, so that package is what is
 * pinned.
 */
export interface SchemaLock extends AptSource {
  /**
   * The pinned `pve-docs` version, for example `9.2.14`.
   */
  version: string;
  /**
   * Path of the pinned `.deb`, relative to the base URL of the apt
   * repository.
   */
  filename: string;
  /**
   * SHA-256 of the `.deb`, as listed in the apt index. A download of the
   * package must match it.
   */
  debSha256: string;
  /**
   * SHA-256 of the `apiSchema` literal inside `apidoc.js`, not of the whole
   * file: the viewer code that surrounds the literal changes between releases
   * without the API changing.
   */
  schemaSha256: string;
}

/**
 * A parsed API schema together with where it came from; the input of every
 * emitter.
 */
export interface LoadedSchema {
  /**
   * Top-level nodes of the API tree.
   */
  nodes: PveNode[];
  /**
   * The `apiSchema` array literal the nodes were parsed from.
   */
  literal: string;
  /**
   * The `pve-docs` version the schema was taken from, or the label passed to
   * {@link loadFile}.
   */
  version: string;
  /**
   * SHA-256 of the `apiSchema` literal, in lowercase hex.
   */
  sha256: string;
  /**
   * Upload date of the package (`YYYY-MM-DD`). Known when the package was
   * downloaded during this run, or when an earlier download stored the date
   * next to the cached bundle. Never set by {@link loadCommitted} or
   * {@link loadFile}.
   */
  released?: string;
}

/**
 * Reads the lock file.
 *
 * @param path - File to read. Defaults to `schema.lock.json` in the generator
 *   package.
 * @returns The parsed lock. Its content is not validated.
 * @throws An {@link Error} if the file cannot be read.
 * @throws A {@link SyntaxError} if the file is not valid JSON.
 */
export async function readLock(path = LOCK_PATH): Promise<SchemaLock> {
  return JSON.parse(await readFile(path, "utf8")) as SchemaLock;
}

/**
 * Writes the lock file as indented JSON with a trailing newline, replacing
 * its previous content.
 *
 * @param lock - The lock to store.
 * @param path - File to write. Defaults to `schema.lock.json` in the
 *   generator package.
 * @throws An {@link Error} if the file cannot be written.
 */
export async function writeLock(
  lock: SchemaLock,
  path = LOCK_PATH,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

/**
 * Slices the `apiSchema` array literal out of the API viewer bundle.
 *
 * @remarks
 * The array is followed by the viewer's own code, so its end is found by
 * balancing brackets and braces, skipping over double-quoted strings because
 * descriptions contain both braces and escaped quotes. The literal is not
 * parsed here.
 *
 * @param source - Content of `apidoc.js`.
 * @returns The text from the first `[` after the first mention of
 *   `apiSchema` up to and including its matching `]`.
 * @throws An {@link Error} if `source` does not mention `apiSchema`.
 * @throws An {@link Error} if no `[` follows `apiSchema`.
 * @throws An {@link Error} if the array is never closed.
 *
 * @example
 * ```ts
 * const bundle = 'const apiSchema = [{"path":"/version"}];\nExt.onReady();';
 * extractSchemaLiteral(bundle); // '[{"path":"/version"}]'
 * ```
 */
export function extractSchemaLiteral(source: string): string {
  const marker = source.indexOf("apiSchema");
  if (marker === -1) {
    throw new Error(
      "no `apiSchema` declaration found - the API viewer bundle changed shape",
    );
  }
  const start = source.indexOf("[", marker);
  if (start === -1) {
    throw new Error("`apiSchema` is not followed by an array literal");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (inString) {
      if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth++;
    } else if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("`apiSchema` array literal is not terminated");
}

/**
 * Parses the API tree embedded in the API viewer bundle.
 *
 * @param source - Content of `apidoc.js`.
 * @returns The top-level nodes of the API tree.
 * @throws An {@link Error} if the `apiSchema` literal cannot be located; see
 *   {@link extractSchemaLiteral}.
 * @throws A {@link SyntaxError} if the literal is not valid JSON.
 * @throws An {@link Error} if the literal is not a non-empty array.
 */
export function parseSchema(source: string): PveNode[] {
  return parseLiteral(extractSchemaLiteral(source));
}

/**
 * Parses an `apiSchema` literal as JSON.
 *
 * @remarks
 * Only the outermost shape is checked; the nodes themselves are trusted to
 * follow the schema types.
 *
 * @param literal - The array literal, as returned by
 *   {@link extractSchemaLiteral}.
 * @returns The top-level nodes of the API tree.
 * @throws A {@link SyntaxError} if the literal is not valid JSON.
 * @throws An {@link Error} if the literal is not a non-empty array.
 */
function parseLiteral(literal: string): PveNode[] {
  const nodes = JSON.parse(literal) as PveNode[];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("parsed schema is empty");
  }
  return nodes;
}

/**
 * Returns the SHA-256 of a string's UTF-8 encoding in lowercase hex.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Returns where the API viewer bundle of one `pve-docs` version is cached:
 * `.cache/pve-docs_<version>.apidoc.js` in the generator package.
 */
function cachePath(version: string): string {
  return join(CACHE_DIR, `pve-docs_${version}.apidoc.js`);
}

/**
 * Reads a UTF-8 text file without failing.
 *
 * @returns The content, or `undefined` when the file does not exist or cannot
 *   be read for any other reason.
 */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Loads the schema of one `pve-docs` version, from the download cache or the
 * network.
 *
 * @remarks
 * A bundle cached as `.cache/pve-docs_<version>.apidoc.js` is used as it is.
 * Otherwise the package is downloaded from `download.proxmox.com` by
 * {@link downloadApidoc}, which verifies the `.deb` against `entry.sha256`.
 * A downloaded bundle is cached only after its schema has been extracted, so
 * a bad download is never served again from disk. Its upload date is kept in
 * a `.released` file beside it.
 *
 * @param entry - The package to load. Its `filename` and `sha256` are used
 *   only when the package has to be downloaded.
 * @returns The parsed schema, its literal and hash and, when known, the
 *   upload date of the package.
 * @throws An {@link Error} if the download, its verification or the
 *   extraction fails; see {@link downloadApidoc}.
 * @throws An {@link Error} if the cache cannot be written.
 * @throws An {@link Error} if the bundle holds no `apiSchema` array literal;
 *   see {@link extractSchemaLiteral}.
 * @throws A {@link SyntaxError} if the literal is not valid JSON.
 * @throws An {@link Error} if the literal is an empty array.
 */
export async function loadVersion(entry: AptPackage): Promise<LoadedSchema> {
  const path = cachePath(entry.version);
  let apidoc = await readIfPresent(path);
  let released: string | undefined;
  let downloaded = false;

  if (apidoc === undefined) {
    ({ apidoc, released } = await downloadApidoc(entry));
    downloaded = true;
  } else {
    released = (await readIfPresent(`${path}.released`))?.trim();
  }

  const literal = extractSchemaLiteral(apidoc);
  const nodes = parseLiteral(literal);
  if (downloaded) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, apidoc, "utf8");
    if (released) await writeFile(`${path}.released`, released, "utf8");
  }
  return {
    nodes,
    literal,
    version: entry.version,
    sha256: sha256(literal),
    released,
  };
}

/**
 * Loads the schema committed to the repository and verifies that it is the
 * one the lock file pins.
 *
 * @remarks
 * Nothing is downloaded. The committed copy exists so that generating, and
 * checking that generated output is current, never depends on Proxmox's
 * servers being reachable.
 *
 * @param lock - The lock naming the version and the hash the schema must
 *   have.
 * @param path - File to read. Defaults to `schema.json.gz` in the generator
 *   package.
 * @returns The parsed schema, its literal and its hash. The upload date is
 *   never set.
 * @throws An {@link Error} if the file cannot be read or is not gzip data.
 * @throws An {@link Error} if the hash of the schema differs from
 *   `lock.schemaSha256`, which means the file and the lock were not updated
 *   together.
 * @throws A {@link SyntaxError} if the schema is not valid JSON.
 * @throws An {@link Error} if the schema is an empty array.
 */
export async function loadCommitted(
  lock: SchemaLock,
  path = SCHEMA_PATH,
): Promise<LoadedSchema> {
  const literal = gunzipSync(await readFile(path)).toString("utf8");
  const hash = sha256(literal);
  if (hash !== lock.schemaSha256) {
    throw new Error(
      `${path}: schema sha256 ${hash} does not match the locked ${lock.schemaSha256}. ` +
        "Run `bun run codegen:update` to bring both in step.",
    );
  }
  return {
    nodes: parseLiteral(literal),
    literal,
    version: lock.version,
    sha256: hash,
  };
}

/**
 * Writes a schema as the committed copy that {@link loadCommitted} reads.
 *
 * @remarks
 * The literal is stored gzip-compressed, without a timestamp, so the same
 * schema always produces the same bytes.
 *
 * @param literal - The `apiSchema` array literal to store.
 * @param path - File to write. Defaults to `schema.json.gz` in the generator
 *   package.
 * @throws An {@link Error} if the file cannot be written.
 */
export async function writeCommitted(
  literal: string,
  path = SCHEMA_PATH,
): Promise<void> {
  await writeFile(path, gzipSync(literal, { level: 9 }));
}

/**
 * Loads a bundle from disk, for experiments against a hand-picked file.
 *
 * @remarks
 * Nothing is downloaded, cached or verified against the lock.
 *
 * @param path - Path of an `apidoc.js`.
 * @param version - Label recorded as the schema's version; the command line
 *   passes `custom`.
 * @returns The parsed schema, its literal and its hash. The upload date is
 *   never set.
 * @throws An {@link Error} if the file cannot be read.
 * @throws An {@link Error} if the file holds no `apiSchema` array literal;
 *   see {@link extractSchemaLiteral}.
 * @throws A {@link SyntaxError} if the literal is not valid JSON.
 * @throws An {@link Error} if the literal is an empty array.
 */
export async function loadFile(
  path: string,
  version: string,
): Promise<LoadedSchema> {
  const literal = extractSchemaLiteral(await readFile(path, "utf8"));
  return {
    nodes: parseLiteral(literal),
    literal,
    version,
    sha256: sha256(literal),
  };
}
