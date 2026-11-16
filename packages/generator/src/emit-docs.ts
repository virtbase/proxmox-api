import { minorOf } from "./apt.js";
import { indexedPrefix, lastIndex } from "./index-bounds.js";
import { METHOD_ORDER } from "./operations.js";
import type { PveCall, PveMethod, PveNode, PveSchema } from "./schema.js";
import { isOptional } from "./schema.js";

/**
 * One generated Markdown page of the documentation site.
 *
 * @remarks
 * Used for the endpoint reference and for the API changelog alike. The
 * caller decides which directory the page is written to.
 */
export interface DocPage {
  /**
   * File name without the extension, e.g. `nodes-qemu` for a page under
   * `reference/endpoints/`. The overview page of a section is `index`.
   */
  slug: string;
  /**
   * Human title, e.g. `nodes / qemu`. Also the text of the sidebar entry.
   */
  title: string;
  /**
   * The complete page source, frontmatter included, ending in a newline.
   */
  markdown: string;
}

/**
 * One call of the API tree, paired with the node it belongs to.
 */
interface Operation {
  node: PveNode;
  call: PveCall;
  method: PveMethod;
}

/**
 * Returns the path segments that are not `{placeholders}`.
 */
function literalSegments(path: string): string[] {
  return path.split("/").filter((s) => s && !s.startsWith("{"));
}

/**
 * Decides which page an endpoint belongs on: the first two literal segments.
 *
 * @remarks
 * `/nodes` alone would put all ~300 node endpoints on one page, so the second
 * segment splits them into `nodes/qemu`, `nodes/ceph` and so on.
 *
 * @param path - Full path of the endpoint, with placeholders.
 * @returns The group key: one or two literal segments joined by `/`, or
 *   `root` for a path without literal segments.
 *
 * @example
 * ```ts
 * groupKey("/nodes/{node}/qemu/{vmid}/config"); // "nodes/qemu"
 * groupKey("/version"); // "version"
 * ```
 */
function groupKey(path: string): string {
  const segments = literalSegments(path);
  if (segments.length === 0) return "root";
  return segments.slice(0, 2).join("/");
}

/**
 * Renders the expression a caller actually writes for an operation,
 * mirroring how the proxy maps paths.
 *
 * @remarks
 * A placeholder becomes `.$(name)` with the name in camelCase. A literal
 * segment becomes a property access, in bracket notation when it is not an
 * identifier. The call itself is written without arguments.
 *
 * @param path - Full path of the endpoint, with placeholders.
 * @param method - The HTTP method, which names the final call.
 * @returns The expression, starting at a client called `proxmox`.
 *
 * @example
 * ```ts
 * callExpression("/nodes/{node}/qemu/{vmid}/config", "GET");
 * // "proxmox.nodes.$(node).qemu.$(vmid).config.$get()"
 * ```
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
 * Makes PVE prose safe to drop into a VitePress page or table cell.
 *
 * @remarks
 * VitePress compiles Markdown as a Vue template, so the angle brackets that
 * fill Proxmox descriptions (`<vmid>`, `[file=]<volume>`) are read as HTML
 * tags and fail the build, and `{{ }}` would be interpolated. Newlines and
 * pipes additionally have to go so a table row stays one row.
 *
 * @param text - Prose taken from the schema.
 * @returns The text on one line, trimmed, with `&`, `<`, `>` and `{{` as
 *   HTML entities and every `|` escaped with a backslash.
 *
 * @example
 * ```ts
 * escapeCell("Use <vmid>\nor a|b"); // "Use &lt;vmid&gt; or a\\|b"
 * ```
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

/**
 * The number of enum values shown in a type label before the remainder is
 * summarised as a count.
 */
const MAX_ENUM_SHOWN = 8;

/**
 * Renders a compact type label for the parameter table.
 *
 * @remarks
 * An enumeration lists its first {@link MAX_ENUM_SHOWN} values, separated by
 * escaped pipes, and counts the rest. An array is the label of its items
 * followed by `[]`. Integers and numbers are both `number`. Anything else is
 * the schema's own type name, or `any` when it has none.
 *
 * @example
 * ```ts
 * typeLabel({ type: "string", enum: ["kvm", "tcg"] }); // "`kvm` \\| `tcg`"
 * typeLabel({ type: "array", items: { type: "integer" } }); // "number[]"
 * ```
 */
function typeLabel(schema: PveSchema): string {
  if (schema.enum) {
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

/**
 * Summarises the constraints of a parameter for the notes column.
 *
 * @returns The named format, minimum, maximum, maximum length and default
 *   that are present, in that order and separated by commas, or an empty
 *   string when there are none.
 *
 * @example
 * ```ts
 * constraints({ minimum: 1, maximum: 8, default: 1 });
 * // "min 1, max 8, default `1`"
 * ```
 */
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

/**
 * Renders the parameter table of a call, one row per parameter in schema
 * order.
 *
 * @remarks
 * Path placeholders are parameters in the schema and are listed like any
 * other. An indexed parameter with a known bound is shown as its range of
 * keys, such as `scsi0`…`scsi30`; without one it keeps its schema name. The
 * notes column joins the escaped description and the constraints.
 *
 * @returns The Markdown lines, starting with a blank line, or an empty array
 *   when the call takes no parameters.
 */
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

/**
 * Renders the sentence that states what a call returns.
 *
 * @returns `Returns nothing.` for a missing or `null` return schema.
 *   Otherwise the sentence names the top-level type, and for an array the
 *   type of its items, with `any` standing in for a missing type.
 */
function returnsLine(call: PveCall): string {
  const returns = call.returns;
  if (!returns || returns.type === "null") return "Returns nothing.";
  if (returns.type === "array") {
    return `Returns an array of \`${returns.items?.type ?? "any"}\`.`;
  }
  return `Returns \`${returns.type ?? "any"}\`.`;
}

/**
 * Renders the section of one operation.
 *
 * @remarks
 * The section consists of a `###` heading with method and path, the call
 * expression in a code block, the escaped description, the return sentence,
 * a warning when the call does not accept API tokens, and the parameter
 * table.
 *
 * @returns The Markdown lines, starting with a blank line.
 */
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
  if (Number(call.allowtoken ?? 1) === 0) {
    lines.push("", "::: warning", "Not callable with an API token.", ":::");
  }
  lines.push(...parameterTable(call));
  return lines;
}

/**
 * Collects every operation in the tree, depth first.
 *
 * @param nodes - The nodes to walk. A node's own calls come before those of
 *   its children, in {@link METHOD_ORDER}.
 * @param out - The array the operations are appended to. Defaults to a new,
 *   empty one.
 * @returns The `out` array.
 */
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

/**
 * Builds the endpoint reference: one Markdown page per endpoint group, plus
 * an index page.
 *
 * @remarks
 * Endpoints are grouped by their first two literal path segments, see
 * {@link groupKey}. On a page, operations are ordered by path and then by
 * {@link METHOD_ORDER}. The index page states the total number of
 * operations and the schema version, and links every group with its
 * operation count.
 *
 * @param nodes - The root nodes of the API tree.
 * @param version - The `pve-docs` version the schema was taken from, quoted
 *   on the index page together with the Proxmox VE release derived from it.
 * @returns The index page (slug `index`) first, then the group pages sorted
 *   by group key. A group page's slug is its key with `/` replaced by `-`.
 */
export function emitDocs(nodes: PveNode[], version: string): DocPage[] {
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
      `Every one of the ${total} operations in the Proxmox VE ${minorOf(version)} API (schema`,
      `\`pve-docs ${version}\`), grouped by path, with the call expression for each.`,
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

/**
 * Builds the sidebar entries for the endpoint pages, for the VitePress
 * config.
 *
 * @param pages - The pages returned by {@link emitDocs}.
 * @returns One entry per page, in the given order. The index page links to
 *   `/reference/endpoints/`, every other page to its slug below that.
 */
export function docsSidebar(
  pages: DocPage[],
): Array<{ text: string; link: string }> {
  return pages.map((page) => ({
    text: page.title,
    link: `/reference/endpoints/${page.slug === "index" ? "" : page.slug}`,
  }));
}
