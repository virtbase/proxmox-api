import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { emitModel } from "./emit.js";
import { DEFAULT_SCHEMA_URL, loadSchema } from "./load-schema.js";

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_OUT = resolve(packageRoot, "../api/src/model.ts");
const DEFAULT_CACHE = resolve(packageRoot, ".cache/apidoc.js");

const USAGE = `Regenerate the Proxmox VE API model.

Usage: bun src/cli.ts [options]

  --url <url>      schema bundle to download (default: the PVE API viewer)
  --input <file>   read a bundle from disk instead of fetching
  --out <file>     where to write the model (default: packages/api/src/model.ts)
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

  const model = emitModel(schema.nodes, {
    source: schema.source,
    sha256: schema.sha256,
  });

  if (values.check) {
    const current = await Bun.file(out)
      .text()
      .catch(() => "");
    if (current === model) {
      console.log(`${out} is up to date.`);
      return 0;
    }
    console.error(`${out} is out of date; run \`bun run codegen\`.`);
    return 1;
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, model, "utf8");
  console.log(`Wrote ${out} (${model.split("\n").length} lines).`);
  return 0;
}

process.exitCode = await main();
