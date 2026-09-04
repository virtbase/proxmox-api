import { indexedPrefix, lastIndex } from "./index-bounds.js";
import type { PveCall, PveMethod, PveNode, PveSchema } from "./schema.js";
import { isOptional } from "./schema.js";

const METHOD_ORDER: PveMethod[] = ["GET", "POST", "PUT", "DELETE"];

export interface DocPage {
  /** Slug under `reference/endpoints/`, e.g. `nodes-qemu`. */
  slug: string;
  /** Human title, e.g. `nodes / qemu`. */
  title: string;
  markdown: string;
}

interface Operation {
  node: PveNode;
  call: PveCall;
  method: PveMethod;
}

/** Path segments that are not `{placeholders}`. */
function literalSegments(path: string): string[] {
  return path.split("/").filter((s) => s && !s.startsWith("{"));
}

/**
 * Which page an endpoint belongs on: the first two literal segments.
 *
 * `/nodes` alone would put all ~300 node endpoints on one page, so the second
 * segment splits them into `nodes/qemu`, `nodes/ceph` and so on.
 */
function groupKey(path: string): string {
  const segments = literalSegments(path);
  if (segments.length === 0) return "root";
  return segments.slice(0, 2).join("/");
}

/**
 * The expression a caller actually writes, mirroring how the proxy maps paths:
 * `/nodes/{node}/qemu/{vmid}/config` -> `proxmox.nodes.$(node).qemu.$(vmid).config`
 */
function callExpression(path: string, method: PveMethod): string {
  let expression = "proxmox";
  for (const segment of path.split("/").filter(Boolean)) {
    if (segment.startsWith("{")) {
      expression += `.$(${segment.slice(1, -1).replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())})`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      expression += `.${segment}`;
    } else {
      expression += `[${JSON.stringify(segment)}]`;
    }
  }
  return `${expression}.$${method.toLowerCase()}()`;
}

/**
 * Make PVE prose safe to drop into a VitePress page.
 *
 * VitePress compiles markdown as a Vue template, so the angle brackets that
 * fill Proxmox descriptions (`<vmid>`, `[file=]<volume>`) are read as HTML
 * tags and fail the build, and `{{ }}` would be interpolated. Newlines and
 * pipes additionally have to go so a table row stays one row.
 */
function escapeCell(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{\{/g, "&#123;&#123;")
    .replace(/\|/g, "\\|")
    .trim();
}

/** Enum values shown inline before the list is summarised instead. */
const MAX_ENUM_SHOWN = 8;

/** A compact type label for the parameter table. */
function typeLabel(schema: PveSchema): string {
  if (schema.enum) {
    // Some enums run to 500+ values (every `mp<n>`/`unused<n>` slot, timezone
    // lists). Spelled out, one of those fills a table cell with 10 kB of
    // noise, so long ones are summarised.
    const shown = schema.enum
      .slice(0, MAX_ENUM_SHOWN)
      .map((v) => `\`${v}\``)
      .join(" \\| ");
    const hidden = schema.enum.length - MAX_ENUM_SHOWN;
    return hidden > 0 ? `${shown} \\| … (${hidden} more)` : shown;
  }
  if (schema.type === "array") {
    return `${typeLabel(schema.items ?? {})}[]`;
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  return schema.type ?? "any";
}

function constraints(schema: PveSchema): string {
  const parts: string[] = [];
  if (typeof schema.format === "string")
    parts.push(`format \`${schema.format}\``);
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.maxLength !== undefined) parts.push(`≤ ${schema.maxLength} chars`);
  if (schema.default !== undefined) {
    parts.push(`default \`${JSON.stringify(schema.default)}\``);
  }
  return parts.join(", ");
}

function parameterTable(call: PveCall): string[] {
  const properties = call.parameters?.properties ?? {};
  const rows: string[] = [];

  for (const [rawName, schema] of Object.entries(properties)) {
    const prefix = indexedPrefix(rawName);
    const bound = prefix ? lastIndex(prefix) : undefined;
    const name =
      prefix && bound !== undefined
        ? `\`${prefix}0\`…\`${prefix}${bound}\``
        : `\`${rawName}\``;
    const detail = [escapeCell(schema.description ?? ""), constraints(schema)]
      .filter(Boolean)
      .join(" — ");
    rows.push(
      `| ${name} | ${typeLabel(schema)} | ${isOptional(schema) ? "" : "yes"} | ${detail} |`,
    );
  }

  if (rows.length === 0) return [];
  return [
    "",
    "| Parameter | Type | Required | Notes |",
    "| --- | --- | --- | --- |",
    ...rows,
  ];
}

function returnsLine(call: PveCall): string {
  const returns = call.returns;
  if (!returns || returns.type === "null") return "Returns nothing.";
  if (returns.type === "array") {
    return `Returns an array of \`${returns.items?.type ?? "any"}\`.`;
  }
  return `Returns \`${returns.type ?? "any"}\`.`;
}

function renderOperation(operation: Operation): string[] {
  const { node, call, method } = operation;
  const lines = [
    "",
    `### \`${method} ${node.path}\``,
    "",
    "```ts",
    callExpression(node.path, method),
    "```",
    "",
  ];
  if (call.description) lines.push(escapeCell(call.description), "");
  lines.push(returnsLine(call));
  if (call.allowtoken === 0) {
    lines.push("", "::: warning", "Not callable with an API token.", ":::");
  }
  lines.push(...parameterTable(call));
  return lines;
}

/** Collect every operation in the tree, depth first. */
function collect(nodes: PveNode[], out: Operation[] = []): Operation[] {
  for (const node of nodes) {
    for (const method of METHOD_ORDER) {
      const call = node.info?.[method];
      if (call) out.push({ node, call, method });
    }
    collect(node.children ?? [], out);
  }
  return out;
}

/** Build one markdown page per endpoint group, plus an index page. */
export function emitDocs(nodes: PveNode[]): DocPage[] {
  const groups = new Map<string, Operation[]>();
  for (const operation of collect(nodes)) {
    const key = groupKey(operation.node.path);
    const bucket = groups.get(key);
    if (bucket) bucket.push(operation);
    else groups.set(key, [operation]);
  }

  const keys = [...groups.keys()].sort();
  const pages: DocPage[] = keys.map((key) => {
    const operations = groups.get(key) as Operation[];
    operations.sort(
      (a, b) =>
        a.node.path.localeCompare(b.node.path) ||
        METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    );
    const title = key.replace(/\//g, " / ");
    return {
      slug: key.replace(/\//g, "-"),
      title,
      markdown: [
        "---",
        `title: ${title}`,
        "editLink: false",
        "---",
        "",
        `# ${title}`,
        "",
        `<!-- Generated by @virtbase/proxmox-api-generator. Do not edit. -->`,
        "",
        `${operations.length} operation${operations.length === 1 ? "" : "s"}.`,
        ...operations.flatMap(renderOperation),
        "",
      ].join("\n"),
    };
  });

  const total = [...groups.values()].reduce((sum, ops) => sum + ops.length, 0);
  pages.unshift({
    slug: "index",
    title: "Endpoints",
    markdown: [
      "---",
      "title: Endpoints",
      "editLink: false",
      "---",
      "",
      "# Endpoints",
      "",
      "<!-- Generated by @virtbase/proxmox-api-generator. Do not edit. -->",
      "",
      `Every one of the ${total} operations the Proxmox VE API exposes, grouped`,
      "by path, with the call expression for each.",
      "",
      "| Group | Operations |",
      "| --- | --- |",
      ...keys.map((key) => {
        const count = (groups.get(key) as Operation[]).length;
        return `| [${key.replace(/\//g, " / ")}](./${key.replace(/\//g, "-")}) | ${count} |`;
      }),
      "",
    ].join("\n"),
  });

  return pages;
}

/** Sidebar entries for the generated pages, for the VitePress config. */
export function docsSidebar(
  pages: DocPage[],
): Array<{ text: string; link: string }> {
  return pages.map((page) => ({
    text: page.title,
    link: `/reference/endpoints/${page.slug === "index" ? "" : page.slug}`,
  }));
}
