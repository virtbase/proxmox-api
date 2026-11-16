import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AptPackage } from "./apt.js";
import { compareDebianVersions, listVersions, suiteExists } from "./apt.js";
import { diffOperations } from "./diff.js";
import { emitModel, emitSchemaInfo, exportedTypeNames } from "./emit.js";
import {
  changelogSidebar,
  emitChangelog,
  summarize,
} from "./emit-changelog.js";
import type { DocPage } from "./emit-docs.js";
import { docsSidebar, emitDocs } from "./emit-docs.js";
import type { HistoryEntry } from "./history.js";
import { readHistory, writeHistoryEntry } from "./history.js";
import type { LoadedSchema, SchemaLock } from "./load-schema.js";
import {
  GENERATOR_ROOT,
  loadFile,
  loadLocked,
  loadVersion,
  readLock,
  writeLock,
} from "./load-schema.js";
import { collectOperations } from "./operations.js";

/**
 * Absolute path of the repository root.
 */
const REPO_ROOT = resolve(GENERATOR_ROOT, "../..");

/**
 * File the generated API model is written to.
 */
const MODEL = join(REPO_ROOT, "packages/api/src/model.ts");

/**
 * File the generated schema version constants are written to.
 */
const SCHEMA_INFO = join(REPO_ROOT, "packages/api/src/schema-info.ts");

/**
 * Directory of the generated endpoint reference. Everything in it is replaced
 * on each run.
 */
const ENDPOINT_DOCS = join(REPO_ROOT, "docs/reference/endpoints");

/**
 * Directory of the generated API changelog. Everything in it is replaced on
 * each run.
 */
const CHANGELOG_DOCS = join(REPO_ROOT, "docs/reference/api-changelog");

/**
 * The Debian codenames that follow each suite this repository may track,
 * oldest first.
 *
 * @remarks
 * A Proxmox VE major is built on a new Debian release and so appears in a new
 * apt suite. `update` probes these successors to notice one. A tracked suite
 * that is not a key here has no successors to probe.
 */
const LATER_SUITES: Record<string, string[]> = {
  bookworm: ["trixie", "forky", "duke"],
  trixie: ["forky", "duke"],
  forky: ["duke"],
};

/**
 * Help text, printed for `--help` and after an unknown command.
 */
const USAGE = `Generate the Proxmox VE API model, endpoint reference and API changelog.

Usage: bun src/cli.ts [command] [options]

Commands:
  generate            regenerate from the version pinned in schema.lock.json (default)
  update              move the lock to the newest pve-docs release, record what
                      changed in history/, then regenerate
  backfill <v...>     record history for specific pve-docs versions, oldest first

Options:
  --check             exit 1 if generated output is stale; write nothing
  --offline           never download; fail if the pinned schema is not cached
  --input <file>      generate every output from an apidoc.js on disk instead of
                      the locked version, for experiments; do not commit it
  --to <version>      with update: move to this version instead of the newest
  --summary <file>    with update: write a plain-text change summary here
  -h, --help          show this message
`;

/**
 * Writes one line to standard output.
 */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Maps generated documentation pages to the files they are written to.
 *
 * @param directory - Absolute path of the directory the pages belong in.
 * @param pages - The pages; each becomes `<slug>.md`.
 * @param sidebar - Sidebar definition, stored as indented JSON in
 *   `sidebar.json` in the same directory.
 * @returns The content of each file, keyed by absolute path.
 */
function pagesToFiles(
  directory: string,
  pages: DocPage[],
  sidebar: unknown,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const page of pages) {
    files.set(join(directory, `${page.slug}.md`), page.markdown);
  }
  files.set(
    join(directory, "sidebar.json"),
    `${JSON.stringify(sidebar, null, 2)}\n`,
  );
  return files;
}

/**
 * Renders everything the generator produces, without touching the disk.
 *
 * @param schema - Source of the model, the schema constants and the endpoint
 *   reference.
 * @param history - Stored history entries, the source of the API changelog.
 * @returns `files`, the content of every generated file keyed by absolute
 *   path, and `unbounded`, the prefixes of indexed properties for which no
 *   slot count is known.
 */
function render(
  schema: LoadedSchema,
  history: HistoryEntry[],
): { files: Map<string, string>; unbounded: string[] } {
  const operations = collectOperations(schema.nodes);
  const meta = { version: schema.version, sha256: schema.sha256 };
  const model = emitModel(schema.nodes, operations, meta);
  const endpointPages = emitDocs(schema.nodes, schema.version);
  const changelogPages = emitChangelog(history);

  return {
    unbounded: model.unboundedPrefixes,
    files: new Map([
      [MODEL, model.code],
      [SCHEMA_INFO, emitSchemaInfo(meta, operations.length)],
      ...pagesToFiles(ENDPOINT_DOCS, endpointPages, docsSidebar(endpointPages)),
      ...pagesToFiles(
        CHANGELOG_DOCS,
        changelogPages,
        changelogSidebar(changelogPages),
      ),
    ]),
  };
}

/**
 * Reads a text file.
 *
 * @returns The content, or `undefined` when the file does not exist.
 */
async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}

/**
 * Finds the generated files on disk that differ from the rendered output.
 *
 * @param files - The rendered content, keyed by absolute path.
 * @returns The paths that are missing or hold different content, followed by
 *   the files in the two generated documentation directories that are no
 *   longer rendered at all.
 */
async function staleFiles(files: Map<string, string>): Promise<string[]> {
  const stale: string[] = [];
  for (const [path, content] of files) {
    if ((await readText(path)) !== content) stale.push(path);
  }
  for (const directory of [ENDPOINT_DOCS, CHANGELOG_DOCS]) {
    const present = await readdir(directory).catch(() => [] as string[]);
    for (const name of present) {
      if (!files.has(join(directory, name))) stale.push(join(directory, name));
    }
  }
  return stale;
}

/**
 * Writes the rendered output to disk.
 *
 * @remarks
 * Both generated documentation directories are deleted first, so any file in
 * them that is not rendered, hand-written ones included, is lost. Missing
 * parent directories are created.
 *
 * @param files - The rendered content, keyed by absolute path.
 * @throws An {@link Error} if a directory cannot be removed or created, or a
 *   file cannot be written.
 */
async function writeFiles(files: Map<string, string>): Promise<void> {
  // Cleared first so a page for a group that disappeared does not linger.
  for (const directory of [ENDPOINT_DOCS, CHANGELOG_DOCS]) {
    await rm(directory, { recursive: true, force: true });
  }
  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

/**
 * Runs the `generate` command: renders the output for a schema, then writes
 * it or compares it with what is on disk.
 *
 * @remarks
 * The API changelog is rendered from the entries stored in `history/`,
 * whichever schema is passed. A warning is printed to standard error for
 * every indexed property without a known slot count; it does not affect the
 * exit code.
 *
 * @param schema - The schema to generate from.
 * @param options - How to treat the rendered output.
 * @param options.check - When `true`, nothing is written: the output is
 *   compared with the files on disk and up to ten stale paths are printed to
 *   standard error.
 * @returns The process exit code: `0` after writing or when everything is up
 *   to date, `1` when `options.check` found stale output.
 * @throws An {@link Error} if a history file cannot be read or parsed, or if
 *   the output cannot be written.
 */
async function generate(
  schema: LoadedSchema,
  options: { check: boolean },
): Promise<number> {
  const { files, unbounded } = render(schema, await readHistory());
  if (unbounded.length > 0) {
    console.warn(
      `Warning: no index bound known for ${unbounded.join(", ")}; ` +
        "emitted as unbounded keys. Add them to src/index-bounds.ts.",
    );
  }

  if (options.check) {
    const stale = await staleFiles(files);
    if (stale.length === 0) {
      log(`Generated output is up to date with pve-docs ${schema.version}.`);
      return 0;
    }
    const shown = stale.slice(0, 10).map((path) => relative(REPO_ROOT, path));
    console.error(
      `Out of date; run \`bun run codegen\`:\n  ${shown.join("\n  ")}` +
        (stale.length > 10 ? `\n  ...and ${stale.length - 10} more` : ""),
    );
    return 1;
  }

  await writeFiles(files);
  log(`Generated ${files.size} files from pve-docs ${schema.version}.`);
  return 0;
}

/**
 * Lists every type name the generated model exports for a schema.
 *
 * @remarks
 * The model is emitted in memory and the names are collected from its code.
 */
function exportedTypes(schema: LoadedSchema): Set<string> {
  const { code } = emitModel(schema.nodes, collectOperations(schema.nodes), {
    version: schema.version,
    sha256: schema.sha256,
  });
  return exportedTypeNames(code);
}

/**
 * Builds the history entry for a schema version by comparing it with its
 * predecessor.
 *
 * @remarks
 * Besides the operations, the type names exported by the two generated models
 * are compared. A name that disappeared is listed under `removedTypes` and
 * raises the level to `major`, whatever the operation diff says.
 *
 * @param schema - The version the entry describes.
 * @param previous - The version before it. When omitted, the entry is a
 *   baseline: it lists no changes and its level is `none`.
 * @returns The entry; nothing is written to disk.
 */
function entryFor(
  schema: LoadedSchema,
  previous: LoadedSchema | undefined,
): HistoryEntry {
  const operations = collectOperations(schema.nodes);
  const diff = previous
    ? diffOperations(collectOperations(previous.nodes), operations)
    : diffOperations(operations, operations);
  const current = exportedTypes(schema);
  const removedTypes = previous
    ? [...exportedTypes(previous)].filter((name) => !current.has(name)).sort()
    : [];
  return {
    version: schema.version,
    previous: previous?.version,
    released: schema.released,
    schemaSha256: schema.sha256,
    operations: operations.length,
    ...diff,
    level: removedTypes.length > 0 ? "major" : diff.level,
    removedTypes,
  };
}

/**
 * Publishes step outputs to GitHub Actions.
 *
 * @remarks
 * Appends one `key=value` line per entry to the file named by the
 * `GITHUB_OUTPUT` environment variable. Does nothing when the variable is
 * unset, as it is outside GitHub Actions.
 *
 * @param values - Output names and their values, which must not contain line
 *   breaks.
 */
async function setOutput(values: Record<string, string>): Promise<void> {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await appendFile(file, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Prints a notice when a later Debian suite already carries a release of the
 * tracked package, which signals a new Proxmox VE major.
 *
 * @remarks
 * The successors listed in {@link LATER_SUITES} are probed in order with
 * requests to `download.proxmox.com`. Probing stops at the first suite that
 * exists, whether or not it holds a release yet. A request that fails counts
 * as nothing found, so this never rejects. In GitHub Actions the notice is
 * printed as a `::warning::` workflow command.
 *
 * @param lock - The current lock, which names the tracked suite, component
 *   and package.
 */
async function warnAboutNewerSuite(lock: SchemaLock): Promise<void> {
  for (const suite of LATER_SUITES[lock.suite] ?? []) {
    if (!(await suiteExists({ ...lock, suite }).catch(() => false))) continue;
    const released = await listVersions({ ...lock, suite }).catch(() => []);
    if (released.length === 0) continue;
    const message = `Proxmox VE ${released.at(-1)?.version} is available in the "${suite}" suite; this repository still tracks "${lock.suite}". Moving is a deliberate, breaking step: edit suite in schema.lock.json.`;
    log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : message);
    return;
  }
}

/**
 * Runs the `update` command: moves the lock to another `pve-docs` version if
 * that version ships a different schema, records the difference and
 * regenerates.
 *
 * @remarks
 * The package index of the tracked suite is read from
 * `download.proxmox.com`, and the target is its newest release or
 * `options.to`. Nothing changes when the target is the locked version or
 * ships a schema with the locked hash: most `pve-docs` releases only touch
 * the prose, and skipping them keeps the lock on the first version that
 * shipped a schema.
 *
 * Otherwise `history/<version>.json` is written, `schema.lock.json` is
 * rewritten with the target's version, file name and hashes, the change
 * summary is printed and all output is regenerated. The previous schema is
 * taken from the cache or downloaded again for the comparison.
 *
 * When `GITHUB_OUTPUT` is set, the step outputs `updated` (`true` or
 * `false`) and `version` (the locked version after the run) are written,
 * plus `previous` and `level` when the lock moved.
 *
 * @param options - The values of the command's flags.
 * @param options.to - Version to move to instead of the newest. It must be a
 *   release listed in the tracked suite and may be older than the locked one.
 * @param options.summary - File that also receives the plain-text change
 *   summary. It is written only when the lock moves.
 * @returns The process exit code: `0` when the lock moved or there was
 *   nothing to update, `1` when the suite lists no release or not the one
 *   asked for.
 * @throws An {@link Error} if the lock file cannot be read, or the index or a
 *   package cannot be downloaded.
 * @throws An {@link Error} if a downloaded package does not match the hash in
 *   the index, or the previous schema does not match the hash in the lock.
 * @throws An {@link Error} if the history entry, the lock, the summary or the
 *   generated output cannot be written.
 */
async function update(options: {
  to?: string;
  summary?: string;
}): Promise<number> {
  const lock = await readLock();
  const available = await listVersions(lock);
  const target = options.to
    ? available.find((entry) => entry.version === options.to)
    : available.at(-1);
  if (!target) {
    console.error(
      options.to
        ? `pve-docs ${options.to} is not in the ${lock.suite} suite.`
        : `No pve-docs release found in the ${lock.suite} suite.`,
    );
    return 1;
  }
  await warnAboutNewerSuite(lock);

  if (compareDebianVersions(target.version, lock.version) === 0) {
    log(`Already on pve-docs ${lock.version}; nothing to update.`);
    await setOutput({ updated: "false", version: lock.version });
    return 0;
  }

  const next = await loadVersion(target);
  if (next.sha256 === lock.schemaSha256) {
    // Most pve-docs releases only touch the prose. The lock stays on the
    // first version that shipped a schema, so no release is cut for nothing.
    log(
      `pve-docs ${target.version} ships the same schema as ${lock.version}; nothing to update.`,
    );
    await setOutput({ updated: "false", version: lock.version });
    return 0;
  }

  log(`Updating pve-docs ${lock.version} -> ${target.version}`);
  const previous = await loadLocked(lock);
  const entry = entryFor(next, previous);
  await writeHistoryEntry(entry);
  await writeLock({
    ...lock,
    version: target.version,
    filename: target.filename,
    debSha256: target.sha256,
    schemaSha256: next.sha256,
  });

  const summary = summarize(entry);
  log(summary);
  if (options.summary) await writeFile(options.summary, `${summary}\n`, "utf8");
  await setOutput({
    updated: "true",
    version: target.version,
    previous: lock.version,
    level: entry.level,
  });
  return generate(next, { check: false });
}

/**
 * Runs the `backfill` command: records history entries for the given
 * `pve-docs` versions without moving the lock or regenerating anything.
 *
 * @remarks
 * The versions are looked up in the package indexes of the `bookworm` suite
 * and of the tracked one, read from `download.proxmox.com`. Each schema comes
 * from the cache or is downloaded and verified against the index. A version
 * is compared with the one given before it, and the first becomes a baseline
 * without changes. The order is not checked, and an existing history file
 * for a version is overwritten.
 *
 * @param versions - The versions to record, oldest first.
 * @returns The process exit code: `0` when every entry was written, `1` as
 *   soon as a version is found in neither suite. The entries of the versions
 *   before it have been written by then.
 * @throws An {@link Error} if the lock file cannot be read, or an index or a
 *   package cannot be downloaded or verified.
 * @throws An {@link Error} if a history entry cannot be written.
 */
async function backfill(versions: string[]): Promise<number> {
  const lock = await readLock();
  const suites = new Set(["bookworm", lock.suite]);
  const available: AptPackage[] = [];
  for (const suite of suites) {
    available.push(...(await listVersions({ ...lock, suite })));
  }

  let previous: LoadedSchema | undefined;
  for (const version of versions) {
    const target = available.find((entry) => entry.version === version);
    if (!target) {
      console.error(
        `pve-docs ${version} not found in ${[...suites].join(", ")}.`,
      );
      return 1;
    }
    const schema = await loadVersion(target);
    const entry = entryFor(schema, previous);
    await writeHistoryEntry(entry);
    log(`${version}: ${entry.operations} operations, ${entry.level}`);
    previous = schema;
  }
  return 0;
}

/**
 * Parses the command line and runs the selected command.
 *
 * @remarks
 * `generate` is the default command and `--help` takes precedence over any
 * command. With `--input`, `generate` reads the given file under the version
 * label `custom` and bypasses the lock, the cache and the hash checks, so
 * `--offline` has no effect; every output is still rendered, not the model
 * alone. Flags that do not belong to the selected command are ignored.
 *
 * @returns The process exit code: `0` on success and after printing the
 *   help, `1` when a command reports stale output or a missing version, `2`
 *   for an unknown command.
 * @throws A {@link TypeError} if an unknown flag is passed or a flag that
 *   takes a value has none.
 * @throws An {@link Error} if the selected command fails for any other
 *   reason; the process then ends with a non-zero exit code.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      input: { type: "string" },
      to: { type: "string" },
      summary: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "generate", ...rest] = positionals;

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "generate": {
      const schema = values.input
        ? await loadFile(resolve(values.input), "custom")
        : await loadLocked(await readLock(), { offline: values.offline });
      return generate(schema, { check: values.check });
    }
    case "update":
      return update({ to: values.to, summary: values.summary });
    case "backfill":
      return backfill(rest);
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main();
