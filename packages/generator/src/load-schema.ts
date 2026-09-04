/*
 *   Copyright (c) 2026 Janic Bellmann
 *
 *   This program is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU General Public License for more details.
 *
 *   You should have received a copy of the GNU General Public License
 *   along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { PveNode } from "./schema.js";

/**
 * The API viewer bundles the schema and its ExtJS front-end into one file, as
 * `const apiSchema = [...]` followed by the viewer code. There is no
 * machine-readable endpoint - this is the document Proxmox publishes.
 */
export const DEFAULT_SCHEMA_URL =
  "https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js";

export interface LoadedSchema {
  nodes: PveNode[];
  /**
   * What the schema *is*, for the generated header - the upstream URL, or a
   * bare filename for `--input`.
   *
   * Deliberately not the path it was read from: the cache is a transport
   * detail, and an absolute local path would both vary between machines and
   * publish someone's home directory inside the package.
   */
  source: string;
  /** SHA-256 of the raw document, so a regeneration is traceable to an input. */
  sha256: string;
}

/**
 * Slice the `apiSchema` array literal out of the viewer bundle.
 *
 * The array is followed by ~20 kB of application code, so the end has to be
 * found by balancing brackets. Strings are tracked because descriptions
 * contain both braces and escaped quotes.
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

/** Parse a viewer bundle into API nodes. */
export function parseSchema(source: string): PveNode[] {
  const nodes = JSON.parse(extractSchemaLiteral(source)) as PveNode[];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("parsed schema is empty");
  }
  return nodes;
}

export interface LoadOptions {
  /** Read this file instead of going to the network. */
  input?: string;
  url?: string;
  /** Where to keep the downloaded bundle so reruns work offline. */
  cachePath?: string;
  /** Use the cache even when it exists only as a stale copy. */
  offline?: boolean;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Resolve the schema from an explicit file, the cache, or the network - in
 * that order - and hash whatever was used.
 */
export async function loadSchema(
  options: LoadOptions = {},
): Promise<LoadedSchema> {
  const url = options.url ?? DEFAULT_SCHEMA_URL;

  if (options.input) {
    const raw = await readFile(options.input, "utf8");
    return finish(raw, basename(options.input));
  }

  if (options.offline) {
    if (!options.cachePath) {
      throw new Error("--offline needs a cache to read from");
    }
    const cached = await readIfPresent(options.cachePath);
    if (cached === undefined) {
      throw new Error(
        `--offline but no cached schema at ${options.cachePath}; run once without it`,
      );
    }
    // The cache is a copy of `url`, so that is what the output records.
    return finish(cached, url);
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "proxmox-api codegen" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  const raw = await response.text();
  // Parse before caching, so a captive portal or an error page is never
  // written over a good copy.
  const loaded = finish(raw, url);
  if (options.cachePath) {
    await mkdir(dirname(options.cachePath), { recursive: true });
    await writeFile(options.cachePath, raw, "utf8");
  }
  return loaded;
}

function finish(raw: string, source: string): LoadedSchema {
  return {
    nodes: parseSchema(raw),
    source,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}
