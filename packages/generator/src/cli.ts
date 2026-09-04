import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { emitModel } from "./emit.js";
import { docsSidebar, emitDocs } from "./emit-docs.js";
import { DEFAULT_SCHEMA_URL, loadSchema } from "./load-schema.js";

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_OUT = resolve(packageRoot, "../api/src/model.ts");
const DEFAULT_CACHE = resolve(packageRoot, ".cache/apidoc.js");
const DEFAULT_DOCS = resolve(packageRoot, "../../docs/reference/endpoints");

const USAGE = `Regenerate the Proxmox VE API model.

Usage: bun src/cli.ts [options]

  --url <url>      schema bundle to download (default: the PVE API viewer)
  --input <file>   read a bundle from disk instead of fetching
  --out <file>     where to write the model (default: packages/api/src/model.ts)
  --docs <dir>     where to write the endpoint reference
  --no-docs        only write the model
  --cache <file>   where to keep the downloaded bundle
  --offline        use the cached bundle, never the network
  --check          exit 1 if the output would change; write nothing
  -h, --help       show this message
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      input: { type: "string" },
      out: { type: "string" },
      docs: { type: "string" },
      "no-docs": { type: "boolean", default: false },
      cache: { type: "string" },
      offline: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const out = resolve(values.out ?? DEFAULT_OUT);
  const docsDir = values["no-docs"]
    ? undefined
    : resolve(values.docs ?? DEFAULT_DOCS);
  const cachePath = resolve(values.cache ?? DEFAULT_CACHE);

  console.log(
    values.input
      ? `Reading schema from ${values.input}`
      : values.offline
        ? `Reading cached schema from ${cachePath}`
        : `Fetching schema from ${values.url ?? DEFAULT_SCHEMA_URL}`,
  );

  const schema = await loadSchema({
    url: values.url,
    input: values.input,
    cachePath,
    offline: values.offline,
  });
  console.log(`Schema sha256 ${schema.sha256}`);

  const { code: model, unboundedPrefixes } = emitModel(schema.nodes, {
    source: schema.source,
    sha256: schema.sha256,
  });

  if (unboundedPrefixes.length > 0) {
    // Not fatal - the generated keys stay usable - but the slot count is a
    // guess until someone adds it to INDEX_BOUNDS.
    console.warn(
      `Warning: no index bound known for ${unboundedPrefixes.join(", ")}; ` +
        "emitted as unbounded keys. Add them to src/index-bounds.ts.",
    );
  }

  const pages = docsDir ? emitDocs(schema.nodes) : [];

  if (values.check) {
    const stale: string[] = [];
    const current = await Bun.file(out)
      .text()
      .catch(() => "");
    if (current !== model) stale.push(out);
    for (const page of pages) {
      const path = resolve(docsDir as string, `${page.slug}.md`);
      const existing = await Bun.file(path)
        .text()
        .catch(() => "");
      if (existing !== page.markdown) stale.push(path);
    }
    if (stale.length === 0) {
      console.log("Generated output is up to date.");
      return 0;
    }
    console.error(
      `Out of date; run \`bun run codegen\`:\n  ${stale.slice(0, 10).join("\n  ")}` +
        (stale.length > 10 ? `\n  ...and ${stale.length - 10} more` : ""),
    );
    return 1;
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, model, "utf8");
  console.log(`Wrote ${out} (${model.split("\n").length} lines).`);

  if (docsDir) {
    // Cleared first so a group that disappears upstream does not leave a
    // stale page behind.
    await rm(docsDir, { recursive: true, force: true });
    await mkdir(docsDir, { recursive: true });
    for (const page of pages) {
      await writeFile(
        resolve(docsDir, `${page.slug}.md`),
        page.markdown,
        "utf8",
      );
    }
    await writeFile(
      resolve(docsDir, "sidebar.json"),
      `${JSON.stringify(docsSidebar(pages), null, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote ${pages.length} endpoint pages to ${docsDir}.`);
  }
  return 0;
}

process.exitCode = await main();
