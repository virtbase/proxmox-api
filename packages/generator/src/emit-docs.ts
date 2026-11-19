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
 * Decides which group an endpoint belongs to: its first two literal segments.
 *
 * @remarks
 * `/nodes` alone would put all ~300 node endpoints on one page, so the second
 * segment splits them into `nodes/qemu`, `nodes/ceph` and so on. Large
 * groups are split further by {@link pageKeys}.
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
 * The number of operations above which a group is split into sub-pages.
 */
const SPLIT_ABOVE = 50;

/**
 * The number of operations a third path segment needs within a split group
 * to get a page of its own.
 */
const MIN_SUB_PAGE = 10;

/**
 * Assigns every operation to the page it is listed on.
 *
 * @remarks
 * Operations are grouped by {@link groupKey}. A group of more than
 * {@link SPLIT_ABOVE} operations is split by its third literal segment, but
 * only segments with at least {@link MIN_SUB_PAGE} operations move to a page
 * of their own, such as `nodes/qemu/agent`. The rest stay on the group's
 * page, so the split never produces a page with a handful of entries.
 *
 * @param operations - Every operation of the API tree.
 * @returns The operations of each page, keyed by page key.
 */
function pageKeys(operations: Operation[]): Map<string, Operation[]> {
  const groups = new Map<string, Operation[]>();
  for (const operation of operations) {
    const key = groupKey(operation.node.path);
    const bucket = groups.get(key);
    if (bucket) bucket.push(operation);
    else groups.set(key, [operation]);
  }

  const pages = new Map<string, Operation[]>();
  for (const [key, members] of groups) {
    if (members.length <= SPLIT_ABOVE) {
      pages.set(key, members);
      continue;
    }
    const bySegment = new Map<string, Operation[]>();
    for (const operation of members) {
      const third = literalSegments(operation.node.path)[2];
      const subKey = third === undefined ? key : `${key}/${third}`;
      const bucket = bySegment.get(subKey);
      if (bucket) bucket.push(operation);
      else bySegment.set(subKey, [operation]);
    }
    const rest: Operation[] = [];
    for (const [subKey, subMembers] of bySegment) {
      if (subKey !== key && subMembers.length >= MIN_SUB_PAGE) {
        pages.set(subKey, subMembers);
      } else {
        rest.push(...subMembers);
      }
    }
    pages.set(key, rest);
  }
  return pages;
}

/**
 * Returns the file name of a page.
 *
 * @param key - The page key, e.g. `nodes/qemu/agent`.
 * @returns The key with every `/` replaced by `-`, e.g. `nodes-qemu-agent`.
 */
function pageSlug(key: string): string {
  return key.replace(/\//g, "-");
}

/**
 * Returns the title of a page.
 *
 * @param key - The page key, e.g. `nodes/qemu/agent`.
 * @returns The key with spaces around every `/`, e.g. `nodes / qemu / agent`.
 */
function pageTitle(key: string): string {
  return key.replace(/\//g, " / ");
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
 * The number of parameters up to which a call's parameters are shown in one
 * table. Above it, the optional ones are folded away.
 */
const MAX_UNFOLDED_PARAMETERS = 8;

/**
 * Renders one row of a parameter table.
 *
 * @remarks
 * An indexed parameter with a known bound is shown as its range of keys,
 * such as `scsi0`…`scsi30`; without one it keeps its schema name. The notes
 * column joins the escaped description and the constraints.
 *
 * @param rawName - The parameter's name in the schema.
 * @param schema - The parameter's schema.
 * @returns The Markdown table row.
 */
function parameterRow(rawName: string, schema: PveSchema): string {
  const prefix = indexedPrefix(rawName);
  const bound = prefix ? lastIndex(prefix) : undefined;
  const name =
    prefix && bound !== undefined
      ? `\`${prefix}0\`…\`${prefix}${bound}\``
      : `\`${rawName}\``;
  const detail = [escapeCell(schema.description ?? ""), constraints(schema)]
    .filter(Boolean)
    .join(" — ");
  return `| ${name} | ${typeLabel(schema)} | ${isOptional(schema) ? "" : "yes"} | ${detail} |`;
}

/**
 * Renders the parameters of a call as tables, in schema order.
 *
 * @remarks
 * Path placeholders are parameters in the schema and are listed like any
 * other. Up to {@link MAX_UNFOLDED_PARAMETERS} parameters share one table.
 * Beyond that, the required ones stay visible and the optional ones move
 * into a collapsed `details` block, which keeps calls such as creating a VM,
 * with over a hundred options, from burying the rest of the page.
 *
 * @returns The Markdown lines, starting with a blank line, or an empty array
 *   when the call takes no parameters.
 */
function parameterTable(call: PveCall): string[] {
  const entries = Object.entries(call.parameters?.properties ?? {});
  if (entries.length === 0) return [];
  const header = [
    "| Parameter | Type | Required | Notes |",
    "| --- | --- | --- | --- |",
  ];
  if (entries.length <= MAX_UNFOLDED_PARAMETERS) {
    return ["", ...header, ...entries.map(([n, s]) => parameterRow(n, s))];
  }
  const required = entries.filter(([, s]) => !isOptional(s));
  const optional = entries.filter(([, s]) => isOptional(s));
  const lines: string[] = [];
  if (required.length > 0) {
    lines.push("", ...header, ...required.map(([n, s]) => parameterRow(n, s)));
  }
  lines.push(
    "",
    `::: details ${optional.length} optional parameters`,
    "",
    ...header,
    ...optional.map(([n, s]) => parameterRow(n, s)),
    "",
    ":::",
  );
  return lines;
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
 * Base URL of the API viewer Proxmox publishes; an endpoint's path is
 * appended as the fragment.
 */
const API_VIEWER = "https://pve.proxmox.com/pve-docs/api-viewer/index.html#";

/**
 * Renders the link to an endpoint in Proxmox's API viewer.
 *
 * @remarks
 * Written as HTML rather than a Markdown link: markdown-it percent-encodes
 * link targets, turning `{node}` into `%7Bnode%7D`, and the viewer looks the
 * fragment up verbatim, so an encoded link opens the viewer with nothing
 * selected. Browsers leave braces in a fragment as they are.
 *
 * @param path - Full path of the endpoint, with placeholders.
 * @returns A paragraph holding the link, which opens in a new tab.
 */
function apiViewerLink(path: string): string {
  return `<p class="api-viewer-link"><a href="${API_VIEWER}${path}" target="_blank" rel="noreferrer">Open in the Proxmox API viewer</a></p>`;
}

/**
 * Renders the section of one operation.
 *
 * @remarks
 * The section consists of a `###` heading with a method badge and the path,
 * the call expression in a code block, the escaped description, the return
 * sentence, a warning when the call does not accept API tokens, the
 * parameter tables and a link to the endpoint in Proxmox's API viewer. The
 * badge is a plain `span` so the heading's anchor stays the slug of
 * `METHOD /path`, as it was before the badge existed.
 *
 * @returns The Markdown lines, starting with a blank line.
 */
function renderOperation(operation: Operation): string[] {
  const { node, call, method } = operation;
  const lines = [
    "",
    `### <span class="method-badge" data-method="${method}">${method}</span> \`${node.path}\``,
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
  lines.push(...parameterTable(call), "", apiViewerLink(node.path));
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
 * Endpoints are assigned to pages by {@link pageKeys}. On a page,
 * operations are ordered by path and then by {@link METHOD_ORDER}, and a
 * group that was split links its sub-pages. The index page states the total
 * number of operations and the schema version, and links every page with its
 * operation count.
 *
 * @param nodes - The root nodes of the API tree.
 * @param version - The `pve-docs` version the schema was taken from, quoted
 *   on the index page together with the Proxmox VE release derived from it.
 * @returns The index page (slug `index`) first, then the group pages sorted
 *   by page key, so a sub-page follows its group. A page's slug is its key
 *   with `/` replaced by `-`.
 */
export function emitDocs(nodes: PveNode[], version: string): DocPage[] {
  const pages = pageKeys(collect(nodes));
  const keys = [...pages.keys()].sort();

  const docs: DocPage[] = keys.map((key) => {
    const operations = pages.get(key) as Operation[];
    operations.sort(
      (a, b) =>
        a.node.path.localeCompare(b.node.path) ||
        METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method),
    );
    const title = pageTitle(key);
    const subPages = keys.filter(
      (other) => other.startsWith(`${key}/`) && groupKey(other) === key,
    );
    const lines = [
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
    ];
    if (subPages.length > 0) {
      const links = subPages.map(
        (sub) =>
          `[${sub.slice(key.length + 1)}](./${pageSlug(sub)}) (${(pages.get(sub) as Operation[]).length})`,
      );
      lines.push(
        "",
        `Further operations are on their own pages: ${links.join(", ")}.`,
      );
    }
    lines.push(...operations.flatMap(renderOperation), "");
    return { slug: pageSlug(key), title, markdown: lines.join("\n") };
  });

  const total = [...pages.values()].reduce((sum, ops) => sum + ops.length, 0);
  docs.unshift({
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
        const count = (pages.get(key) as Operation[]).length;
        return `| [${pageTitle(key)}](./${pageSlug(key)}) | ${count} |`;
      }),
      "",
    ].join("\n"),
  });

  return docs;
}

/**
 * One entry of the endpoint sidebar, in the shape VitePress expects.
 */
export interface SidebarEntry {
  text: string;
  /**
   * The page the entry opens. Absent on a heading whose path has no page of
   * its own.
   */
  link?: string;
  /**
   * Set on every entry with children, so the tree starts folded; VitePress
   * still unfolds the branch that holds the current page.
   */
  collapsed?: boolean;
  items?: SidebarEntry[];
}

/**
 * Builds the sidebar for the endpoint pages, for the VitePress config.
 *
 * @remarks
 * Pages are nested by the segments of their title, so `nodes / qemu / agent`
 * is listed as `agent` below `qemu` below `nodes`, each entry linking its
 * own page. Everything sits in one `Endpoints` section that opens with a
 * link to the index page.
 *
 * @param pages - The pages returned by {@link emitDocs}, index page first
 *   and the rest sorted, so a parent is placed before its children.
 * @returns A single section holding the overview link and the tree.
 */
export function docsSidebar(pages: DocPage[]): SidebarEntry[] {
  const overview: SidebarEntry = {
    text: "Overview",
    link: "/reference/endpoints/",
  };
  const roots: SidebarEntry[] = [];
  for (const page of pages) {
    if (page.slug === "index") continue;
    let siblings = roots;
    let entry: SidebarEntry | undefined;
    for (const segment of page.title.split(" / ")) {
      entry = siblings.find((candidate) => candidate.text === segment);
      if (!entry) {
        entry = { text: segment };
        siblings.push(entry);
      }
      entry.items ??= [];
      siblings = entry.items;
    }
    if (entry) entry.link = `/reference/endpoints/${page.slug}`;
  }
  return [{ text: "Endpoints", items: [overview, ...roots.map(prune)] }];
}

/**
 * Drops the empty child lists {@link docsSidebar} creates while building the
 * tree, and folds every entry that keeps children.
 *
 * @param entry - The entry to tidy, together with its descendants.
 * @returns A copy without empty `items`, with `collapsed` set where there
 *   are children.
 */
function prune(entry: SidebarEntry): SidebarEntry {
  const items = (entry.items ?? []).map(prune);
  if (items.length === 0) {
    return entry.link ? { text: entry.text, link: entry.link } : entry;
  }
  return { ...entry, collapsed: true, items };
}
