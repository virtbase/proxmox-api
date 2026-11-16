import { minorOf } from "./apt.js";
import { indexedPrefix, lastIndex } from "./index-bounds.js";
import {
  isSafeIdentifier,
  quoteProperty,
  toCamelCase,
  toPascalCase,
  toTypeName,
  UniqueNames,
} from "./naming.js";
import type { Operation } from "./operations.js";
import { METHOD_ORDER } from "./operations.js";
import type { PveNode, PveSchema } from "./schema.js";
import { isOptional, pathVariable } from "./schema.js";

/**
 * One level of indentation in the emitted code.
 */
const INDENT = "  ";
/**
 * The longest a union may be, written on one line and not counting what
 * precedes it, before it is broken into one member per line.
 */
const UNION_WRAP = 76;
/**
 * The largest number of members an enumeration may have and still be written
 * out where it is used.
 *
 * @remarks
 * Enumerations that share a property name but not their values (`type`,
 * `mode`, `state`, ...) have no single good name. Short ones are written out
 * where they are used; longer ones get a name qualified by where they occur.
 */
const INLINE_ENUM_MAX = 8;
/**
 * Matches a `typetext` that is left out of the documentation: `<string>`,
 * `<integer>` and friends repeat the type and say nothing.
 */
const TRIVIAL_TYPETEXT = /^<(string|integer|number|boolean)>( \(.*\))?$/;

/**
 * The identity of the schema a model is generated from.
 */
export interface ModelMeta {
  /**
   * The `pve-docs` version the schema was taken from.
   */
  version: string;
  /**
   * SHA-256 of the schema, in hexadecimal. Written into the model's header.
   */
  sha256: string;
}

/**
 * The result of {@link emitModel}.
 */
export interface EmitResult {
  /**
   * The complete source of the model file.
   */
  code: string;
  /**
   * Indexed prefixes emitted without a bound, sorted. Non-empty means Proxmox
   * has added an indexed property that `INDEX_BOUNDS` does not know about.
   */
  unboundedPrefixes: string[];
}

/**
 * The rendered pieces of one object type, before they are assembled into an
 * interface or a type literal.
 */
interface ObjectParts {
  /**
   * The lines of the body: every property with its doc comment, and the
   * index signatures.
   */
  members: string[];
  /**
   * The `Indexed<...>` types the object extends, one per bounded indexed
   * property.
   */
  heritage: string[];
}

/**
 * One value set of an enumeration and where it is used, as gathered while
 * names are resolved.
 */
interface EnumUse {
  /**
   * The values, in the order of the first use that was met.
   */
  values: string[];
  /**
   * The paths of the operations that use the value set under one property
   * name.
   */
  paths: Set<string>;
}

/**
 * Whether a type is rendered for a request parameter or for a response,
 * which decides how booleans are typed.
 */
type Position = "parameter" | "return";

/**
 * Returns the indentation for a nesting depth.
 */
function pad(depth: number): string {
  return INDENT.repeat(depth);
}

/**
 * Renders lines of text as a doc comment.
 *
 * @remarks
 * Any comment terminator in the text is written as `*\/`, so prose from the
 * schema cannot end the comment early. An empty line becomes a bare ` *`.
 *
 * @param lines - The content, one entry per comment line.
 * @param depth - Nesting depth the comment is indented to.
 * @returns The lines of the comment, or an empty array when there is no
 *   content.
 */
function docBlock(lines: string[], depth: number): string[] {
  if (lines.length === 0) return [];
  const p = pad(depth);
  const safe = lines.map((line) => line.replace(/\*\//g, "*\\/"));
  return [
    `${p}/**`,
    ...safe.map((line) => `${p} * ${line}`.trimEnd()),
    `${p} */`,
  ];
}

/**
 * Splits prose into its lines, trimmed, dropping the empty ones.
 */
function splitLines(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Joins type expressions into a union.
 *
 * @param members - The member types. Duplicates are dropped, keeping the
 *   first occurrence.
 * @param depth - Nesting depth of the line the union is written on. Members
 *   of a broken union are indented one level deeper.
 * @returns The only member when there is just one. Otherwise the members
 *   joined by ` | ` on one line, or, when that exceeds {@link UNION_WRAP}
 *   characters or a member spans lines, a line break followed by one
 *   `| member` line each.
 *
 * @example
 * ```ts
 * union(['"kvm"', '"tcg"', '"kvm"'], 1); // '"kvm" | "tcg"'
 * ```
 */
function union(members: string[], depth: number): string {
  const unique = [...new Set(members)];
  if (unique.length === 1) return unique[0] as string;
  const flat = unique.join(" | ");
  if (flat.length <= UNION_WRAP && !flat.includes("\n")) return flat;
  const p = pad(depth + 1);
  return `\n${unique.map((member) => `${p}| ${member}`).join("\n")}`;
}

/**
 * Prepares a rendered type to follow `=`: a one-line type gets a leading
 * space, a broken union already starts with its own line break.
 */
function assign(rendered: string): string {
  return rendered.startsWith("\n") ? rendered : ` ${rendered}`;
}

/**
 * Returns a key that identifies a set of enum values whatever their order.
 */
function enumKey(values: string[]): string {
  return JSON.stringify([...values].sort());
}

/**
 * Derives the base type name of an enumeration from the name of the property
 * it belongs to.
 *
 * @remarks
 * `file-type` and `file_type` are the same name once it is a type.
 *
 * @param hint - The property name, or whatever else stands in for one.
 * @returns The PascalCase name, or `Enum` when the hint yields no usable
 *   type name.
 *
 * @example
 * ```ts
 * enumBase("file-type"); // "FileType"
 * enumBase("file_type"); // "FileType"
 * ```
 */
function enumBase(hint: string): string {
  return toTypeName(hint, "Enum") || "Enum";
}

/**
 * Returns the path segments that are not `{placeholders}`.
 */
function literalSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment && !pathVariable(segment));
}

/**
 * Returns the leading literal segments that all paths have in common.
 *
 * @remarks
 * Placeholders are removed before the paths are compared.
 *
 * @example
 * ```ts
 * commonPrefix(["/nodes/{node}/qemu/{vmid}/config", "/nodes/{node}/lxc"]);
 * // ["nodes"]
 * ```
 */
function commonPrefix(paths: string[]): string[] {
  const [first = [], ...rest] = paths.map(literalSegments);
  let length = first.length;
  for (const other of rest) {
    let shared = 0;
    while (shared < length && first[shared] === other[shared]) shared++;
    length = shared;
  }
  return first.slice(0, length);
}

/**
 * Renders the permissions of a call as a phrase for its doc comment.
 *
 * @remarks
 * The schema stores the check as a nested array, such as
 * `["perm", "/vms/{vmid}", ["VM.Audit"]]`, optionally wrapped in `and` or
 * `or`, which is unreadable in an editor tooltip.
 *
 * @param permissions - The `permissions` value of the call, in whatever
 *   shape the schema gives it.
 * @returns The schema's own description on one line when there is one;
 *   otherwise the rendered check; otherwise a phrase for the user classes
 *   `all` and `world`. `undefined` when none of these is present.
 */
function describePermissions(permissions: unknown): string | undefined {
  if (!permissions || typeof permissions !== "object") return undefined;
  const { description, check, user } = permissions as {
    description?: string;
    check?: unknown;
    user?: string;
  };
  if (description) return splitLines(description).join(" ");
  if (Array.isArray(check)) return describeCheck(check);
  if (user === "all") return "any authenticated user";
  if (user === "world") return "no authentication required";
  return undefined;
}

/**
 * Renders one permission check, recursing into `and` and `or`.
 *
 * @remarks
 * A `perm` check lists its privileges and the path they are needed on. The
 * privileges are joined by `or` when the check carries the `any` option and
 * by commas otherwise. The parts of an `and` or `or` are joined by that
 * word, and a part that itself contains ` and ` or ` or ` is put in round
 * brackets. Any other check is returned as its JSON text.
 *
 * @example
 * ```ts
 * describeCheck(["perm", "/vms/{vmid}", ["VM.Audit"]]);
 * // "VM.Audit on /vms/{vmid}"
 * ```
 */
function describeCheck(check: unknown[]): string {
  const [kind, ...rest] = check;
  if (kind === "and" || kind === "or") {
    return rest
      .map((part) => (Array.isArray(part) ? describeCheck(part) : String(part)))
      .map((part) =>
        part.includes(" and ") || part.includes(" or ") ? `(${part})` : part,
      )
      .join(` ${kind} `);
  }
  if (kind === "perm" && Array.isArray(rest[1])) {
    const any = rest.includes("any");
    return `${rest[1].join(any ? " or " : ", ")} on ${String(rest[0])}`;
  }
  return JSON.stringify(check);
}

/**
 * A single-use renderer that turns one schema into the `Proxmox` namespace
 * of the model file.
 *
 * @remarks
 * An instance is good for a single {@link ModelEmitter.build} call. The
 * `Api` interface is written while the tree is walked; every named type met
 * on the way is registered as a declaration and written out afterwards in
 * name order, so its place in the file does not depend on where it is first
 * used.
 */
class ModelEmitter {
  /**
   * The type names in use inside the namespace.
   */
  private readonly names: UniqueNames;
  /**
   * The operations by their `id`, such as `GET /nodes/{node}/qemu`.
   */
  private readonly operationsById: Map<string, Operation>;
  /**
   * Base name and value set of an enumeration, mapped to the alias to use,
   * or to `undefined` to write the values inline.
   */
  private readonly enumNames = new Map<string, string | undefined>();
  /**
   * The aliases already declared for PVE formats and for the slots of
   * indexed properties, by a key that identifies the format or slot.
   */
  private readonly aliasByKey = new Map<string, string>();
  /**
   * The rendered lines of every named type besides `Api`, by name.
   */
  private readonly declarations = new Map<string, string[]>();
  /**
   * The last indices in use, each of which needs an `Index<n>` type.
   */
  private readonly indexBounds = new Set<number>();
  /**
   * The lines of the `Api` interface.
   */
  private readonly api: string[] = [];
  /**
   * Whether the types being rendered belong to a request or a response.
   */
  private position: Position = "parameter";
  /**
   * The indexed prefixes met so far that have no known bound.
   */
  readonly unboundedPrefixes = new Set<string>();

  /**
   * Prepares the emitter and settles every enumeration's name.
   *
   * @remarks
   * Reserves `Api`, `Proxmox`, the helper types `Indexed` and `NoParams`,
   * and the names of every operation's response and parameter interfaces,
   * so no alias can take them. Then claims the enumeration names.
   *
   * @param nodes - The root nodes of the API tree.
   * @param operations - The operations collected from the same tree.
   * @param meta - The schema's version and hash, for the file header.
   */
  constructor(
    private readonly nodes: PveNode[],
    private readonly operations: Operation[],
    private readonly meta: ModelMeta,
  ) {
    this.operationsById = new Map(operations.map((op) => [op.id, op]));
    this.names = new UniqueNames([
      "Api",
      "Proxmox",
      "Indexed",
      "NoParams",
      ...operations.flatMap((op) => [op.name, `${op.name}Params`]),
    ]);
    this.resolveEnumNames();
  }

  /**
   * Renders the complete model file.
   *
   * @remarks
   * Walks the tree to write the `Api` interface, which registers the
   * declarations and index bounds as it goes. Call it once per instance; a
   * second call would append the `Api` interface again.
   *
   * @returns The source of the file: a header naming the schema, the import
   *   of `RequestOptions`, and the `Proxmox` namespace holding the helper
   *   types, the declarations sorted by name, and the `Api` interface.
   */
  build(): string {
    this.api.push(`${pad(1)}export interface Api {`);
    for (const node of this.nodes) this.emitNode(node, 2);
    this.api.push(`${pad(1)}}`);

    const declarations = [...this.declarations.keys()]
      .sort()
      .flatMap((name) => this.declarations.get(name) as string[]);

    return [
      "// Generated by @virtbase/proxmox-api-generator. Do not edit.",
      `// Source: pve-docs ${this.meta.version} (Proxmox VE ${minorOf(this.meta.version)})`,
      `// SHA-256: ${this.meta.sha256}`,
      `// Covers ${this.operations.length} operations.`,
      "",
      'import type { RequestOptions } from "./proxy.js";',
      "",
      "export namespace Proxmox {",
      ...this.helperTypes(),
      ...declarations,
      ...this.api,
      "}",
      "",
    ].join("\n");
  }

  /**
   * Renders the types the model relies on that do not come from the schema.
   *
   * @remarks
   * These are `Indexed`, `NoParams` and one `Index<n>` union of `0` to `n`
   * for every bound in use, in ascending order and wrapped at 16 members a
   * row. Reads the registered bounds, so the tree has to be walked first.
   */
  private helperTypes(): string[] {
    const p = pad(1);
    const lines = [
      ...docBlock(
        [
          "The keys `<Prefix>0`, `<Prefix>1`, ... of one of PVE's indexed properties,",
          "such as `net[n]` or `scsi[n]`, up to the last index the API accepts.",
        ],
        1,
      ),
      `${p}export type Indexed<Prefix extends string, Index extends number, Value> = {`,
      `${pad(2)}[Key in \`\${Prefix}\${Index}\`]?: Value;`,
      `${p}};`,
      ...docBlock(
        ["Placeholder for an operation that takes no parameters."],
        1,
      ),
      `${p}export type NoParams = Record<string, never> | null;`,
    ];
    for (const bound of [...this.indexBounds].sort((a, b) => a - b)) {
      const members = Array.from(
        { length: bound + 1 },
        (_, index) => `${index}`,
      );
      const rows: string[] = [];
      for (let start = 0; start < members.length; start += 16) {
        rows.push(members.slice(start, start + 16).join(" | "));
      }
      lines.push(
        rows.length === 1
          ? `${p}export type Index${bound} = ${rows[0]};`
          : `${p}export type Index${bound} =\n${rows.map((row) => `${pad(2)}| ${row}`).join("\n")};`,
      );
    }
    return lines;
  }

  /**
   * Registers a named type for the namespace, replacing any declaration
   * already registered under the same name.
   *
   * @param name - The type name, which also decides the output position.
   * @param lines - The rendered declaration, doc comment included.
   */
  private declare(name: string, lines: string[]): void {
    this.declarations.set(name, lines);
  }

  /**
   * Appends one node of the tree, with everything below it, to the `Api`
   * interface.
   *
   * @remarks
   * A literal segment becomes a property, quoted where necessary. A
   * placeholder becomes a `$(...)` method that takes the value and returns
   * the subtree; its argument is the variable in camelCase, or `value` when
   * that is not an identifier. Inside come the node's operations in
   * {@link METHOD_ORDER}, then its children in schema order.
   *
   * @param depth - Nesting depth of the node's own line.
   */
  private emitNode(node: PveNode, depth: number): void {
    const p = pad(depth);
    const variable = pathVariable(node.text);
    if (variable) {
      const camel = toCamelCase(variable);
      const argument = isSafeIdentifier(camel) ? camel : "value";
      this.api.push(
        `${p}$(${argument}: ${this.pathVariableType(node, variable)}): {`,
      );
    } else {
      this.api.push(`${p}${quoteProperty(node.text)}: {`);
    }

    for (const method of METHOD_ORDER) {
      const operation = this.operationsById.get(`${method} ${node.path}`);
      if (operation) this.emitOperation(operation, depth + 1);
    }
    for (const child of node.children ?? []) this.emitNode(child, depth + 1);
    this.api.push(`${p}};`);
  }

  /**
   * Decides the argument type of a placeholder's `$()` method.
   *
   * @remarks
   * `{vmid}` is an integer and `{node}` a string. The answer is taken from
   * the parameter declarations of the calls instead of a list of special
   * cases. Only the calls on the placeholder's own node are consulted, so a
   * placeholder without calls of its own is typed `string`.
   *
   * @param node - The placeholder's node.
   * @param variable - The placeholder's name, without braces.
   * @returns `number` when a call on the node declares the variable as an
   *   integer or number, `string` otherwise.
   */
  private pathVariableType(node: PveNode, variable: string): string {
    for (const method of METHOD_ORDER) {
      const declared = node.info?.[method]?.parameters?.properties?.[variable];
      if (declared?.type === "integer" || declared?.type === "number") {
        return "number";
      }
    }
    return "string";
  }

  /**
   * Appends the method of one operation, with its doc comment, to the `Api`
   * interface.
   *
   * @remarks
   * The comment holds the call's description, its method and path, the
   * permissions it needs when they can be rendered, and a note when the
   * call does not accept API tokens. The method is named after the HTTP
   * method (`$get`, `$post`, ...) and takes the parameters and optional
   * request options. Registers the operation's parameter and response
   * interfaces as a side effect.
   *
   * @param depth - Nesting depth of the method's line.
   */
  private emitOperation(operation: Operation, depth: number): void {
    const { call, method, path } = operation;
    const doc: string[] = [];
    if (call.description) doc.push(...splitLines(call.description));
    doc.push("", `\`${method} ${path}\``);
    const permissions = describePermissions(call.permissions);
    if (permissions) doc.push("", `Permissions: ${permissions}`);
    if (Number(call.allowtoken ?? 1) === 0) {
      doc.push("", "Not callable with an API token.");
    }
    this.api.push(...docBlock(doc, depth));

    const parameter = this.parameterSignature(operation);
    const returns = this.returnType(operation);
    this.api.push(
      `${pad(depth)}$${method.toLowerCase()}(${parameter}, options?: RequestOptions): Promise<${returns}>;`,
    );
  }

  /**
   * Renders the `param` argument of an operation's method and declares the
   * interface it refers to.
   *
   * @remarks
   * Path placeholders are left out, since the caller supplies them through
   * `$()`. Switches the emitter to the parameter position and registers the
   * `<name>Params` interface when there are parameters to describe.
   *
   * @returns `param?: NoParams` when nothing is left after the placeholders,
   *   or `param?: Record<string, any>` when the call then still allows
   *   additional properties. Otherwise `param: <name>Params`, marked
   *   optional when every parameter is.
   */
  private parameterSignature(operation: Operation): string {
    const { call } = operation;
    const entries = Object.entries(call.parameters?.properties ?? {}).filter(
      ([name]) => !operation.pathVariables.includes(name),
    );
    const additional = call.parameters?.additionalProperties;
    if (entries.length === 0) {
      return additional && additional !== "0"
        ? "param?: Record<string, any>"
        : "param?: NoParams";
    }

    this.position = "parameter";
    const name = `${operation.name}Params`;
    const parts = this.objectParts(Object.fromEntries(entries), additional, 1);
    this.declare(name, [
      ...docBlock([`Parameters of \`${operation.id}\`.`], 1),
      ...this.interfaceDeclaration(name, parts),
    ]);
    const allOptional = entries.every(([, schema]) => isOptional(schema));
    return `param${allOptional ? "?" : ""}: ${name}`;
  }

  /**
   * Renders the type an operation's method resolves to and declares the
   * interface it refers to.
   *
   * @remarks
   * An object, or an array of objects, is declared as an interface named
   * after the operation; for an array the interface describes one item. An
   * object without any known shape is `Record<string, any>` and declares
   * nothing. Everything else is rendered in place, with the handler name as
   * the hint for enumerations. For an array, the `additionalProperties` of
   * the array schema applies when the items carry none. Switches the emitter
   * to the return position unless the call returns nothing.
   *
   * @returns The type expression, `null` when the call returns nothing.
   */
  private returnType(operation: Operation): string {
    const { call } = operation;
    const returns = call.returns;
    if (!returns || returns.type === "null") return "null";

    this.position = "return";
    const isList = returns.type === "array";
    const target = isList ? (returns.items ?? {}) : returns;
    const structured =
      target.type === "object" || (!target.type && target.properties);
    if (!structured) return this.typeExpr(returns, 1, call.name);

    const parts = this.objectParts(
      target.properties ?? {},
      target.additionalProperties ?? returns.additionalProperties,
      1,
    );
    if (parts.members.length === 0 && parts.heritage.length === 0) {
      return isList ? "Record<string, any>[]" : "Record<string, any>";
    }
    this.declare(operation.name, [
      ...docBlock(
        [
          `${isList ? "One item returned" : "Returned"} by \`${operation.id}\`.`,
        ],
        1,
      ),
      ...this.interfaceDeclaration(operation.name, parts),
    ]);
    return isList ? `${operation.name}[]` : operation.name;
  }

  /**
   * Renders an exported interface at namespace level from rendered parts.
   *
   * @remarks
   * Heritage goes into an `extends` clause on a line of its own, one type
   * per line. An interface without members is closed on its opening line.
   *
   * @param parts - The members and heritage, rendered for depth `1`.
   * @returns The lines of the declaration, without a doc comment.
   */
  private interfaceDeclaration(name: string, parts: ObjectParts): string[] {
    const open =
      parts.heritage.length > 0
        ? [
            `${pad(1)}export interface ${name}`,
            `${pad(2)}extends ${parts.heritage.join(`,\n${pad(3)}`)} {`,
          ]
        : [`${pad(1)}export interface ${name} {`];
    if (parts.members.length === 0) {
      open[open.length - 1] += "}";
      return open;
    }
    return [...open, ...parts.members, `${pad(1)}}`];
  }

  /**
   * Renders the TypeScript type of one schema node.
   *
   * @remarks
   * A `oneOf` wins over everything else and becomes the union of its
   * variants. Otherwise the `type` decides: a boolean is `boolean` as a
   * parameter and `boolean | 0 | 1` in a response, integers and numbers are
   * `number`, and a string is its enumeration, the alias of its named
   * format, or `string`. A node without a type is rendered from its `enum`,
   * `properties` or `items`, whichever is found first, and is `any` when it
   * has none. Rendering may register declarations and claim names.
   *
   * @param depth - Nesting depth of the line the type is written on, which
   *   sets the indentation of anything that spans lines.
   * @param hint - The property name the node belongs to, used to name the
   *   enumerations found in it.
   * @returns The type expression. A broken union starts with a line break.
   */
  private typeExpr(schema: PveSchema, depth: number, hint: string): string {
    if (schema.oneOf?.length) {
      return union(
        schema.oneOf.map((variant) => this.typeExpr(variant, depth, hint)),
        depth,
      );
    }

    switch (schema.type) {
      case "boolean":
        // Perl handlers answer 1/0, the newer Rust-backed ones true/false.
        return this.position === "return" ? "boolean | 0 | 1" : "boolean";
      case "integer":
      case "number":
        return "number";
      case "null":
        return "null";
      case "any":
        return "any";
      case "array":
        return this.arrayExpr(schema, depth, hint);
      case "object":
        return this.inlineObject(schema, depth);
      case "string":
        if (schema.enum) return this.enumExpr(schema.enum, hint, depth);
        if (typeof schema.format === "string") {
          return this.formatAlias(schema.format);
        }
        return "string";
      default:
        if (schema.enum) return this.enumExpr(schema.enum, hint, depth);
        if (schema.properties) return this.inlineObject(schema, depth);
        if (schema.items) return this.arrayExpr(schema, depth, hint);
        return "any";
    }
  }

  /**
   * Renders the type of an array schema.
   *
   * @returns `T[]` for a plain element type, `Array<T>` when the element
   *   type contains a `|` or spans lines, and `any[]` when the schema does
   *   not describe its items.
   */
  private arrayExpr(schema: PveSchema, depth: number, hint: string): string {
    if (!schema.items) return "any[]";
    const element = this.typeExpr(schema.items, depth, hint);
    return element.includes("|") || element.includes("\n")
      ? `Array<${element}>`
      : `${element}[]`;
  }

  /**
   * Renders an object schema as a type written in place.
   *
   * @param depth - Nesting depth of the line the type starts on.
   * @returns A type literal, intersected with an `Indexed<...>` type for
   *   every bounded indexed property, or `Record<string, any>` when the
   *   schema describes neither properties nor additional ones.
   */
  private inlineObject(schema: PveSchema, depth: number): string {
    const parts = this.objectParts(
      schema.properties ?? {},
      schema.additionalProperties,
      depth,
    );
    if (parts.members.length === 0 && parts.heritage.length === 0) {
      return "Record<string, any>";
    }
    const body =
      parts.members.length > 0
        ? ["{", ...parts.members, `${pad(depth)}}`].join("\n")
        : undefined;
    return [...parts.heritage, ...(body ? [body] : [])].join(" & ");
  }

  /**
   * Renders the properties of an object, in schema order.
   *
   * @remarks
   * An ordinary property becomes a member with a doc comment and a `?` when
   * it is optional. An indexed property with a known bound becomes an
   * `Indexed<...>` heritage entry and registers the bound. One without a
   * bound becomes a template-literal index signature and is recorded in
   * {@link ModelEmitter.unboundedPrefixes}. An index signature for
   * additional properties comes last.
   *
   * @param additional - The object's `additionalProperties`. A schema types
   *   the extra values, a set flag allows `any`, and anything else adds no
   *   index signature.
   * @param depth - Nesting depth of the object's opening line. Members are
   *   indented one level deeper.
   * @returns The rendered members and heritage.
   */
  private objectParts(
    properties: Record<string, PveSchema>,
    additional: PveSchema["additionalProperties"],
    depth: number,
  ): ObjectParts {
    const members: string[] = [];
    const heritage: string[] = [];
    const inner = depth + 1;
    const p = pad(inner);

    for (const [name, schema] of Object.entries(properties)) {
      const prefix = indexedPrefix(name);
      if (prefix) {
        const bound = lastIndex(prefix);
        if (bound === undefined) {
          this.unboundedPrefixes.add(prefix);
          members.push(
            ...docBlock(this.describe(schema, name), inner),
            `${p}[key: \`${prefix}\${number}\`]: ${this.typeExpr(schema, inner, prefix)};`,
          );
        } else {
          this.indexBounds.add(bound);
          heritage.push(
            `Indexed<"${prefix}", Index${bound}, ${this.slotType(prefix, schema, inner)}>`,
          );
        }
        continue;
      }
      members.push(...docBlock(this.describe(schema, name), inner));
      const optional = isOptional(schema) ? "?" : "";
      members.push(
        `${p}${quoteProperty(name)}${optional}: ${this.typeExpr(schema, inner, name)};`,
      );
    }

    if (additional && typeof additional === "object") {
      members.push(
        `${p}[key: string]: ${this.typeExpr(additional, inner, "value")};`,
      );
    } else if (additional === 1 || additional === "1") {
      members.push(`${p}[key: string]: any;`);
    }
    return { members, heritage };
  }

  /**
   * Renders the value type of one indexed property.
   *
   * @remarks
   * A bare primitive is wrapped in a named alias so the description is
   * written once instead of on every slot. The alias is named after the
   * prefix, `<Prefix>Slot` when that name is taken, and is declared the
   * first time the prefix is met with that primitive; later uses share it
   * and its description. Any other slot type, such as the alias of a named
   * format, is used as it is, and the property's own description is then
   * not emitted.
   *
   * @param prefix - The property's prefix, such as `net`.
   * @param schema - The schema of one slot.
   * @param depth - Nesting depth of the line the type is written on.
   * @returns The alias for a `string`, `number` or boolean slot, and the
   *   rendered type as it is for anything else.
   */
  private slotType(prefix: string, schema: PveSchema, depth: number): string {
    const rendered = this.typeExpr(schema, depth, prefix);
    if (
      !["string", "number", "boolean", "boolean | 0 | 1"].includes(rendered)
    ) {
      return rendered;
    }
    const key = `slot:${prefix}:${rendered}`;
    const existing = this.aliasByKey.get(key);
    if (existing) return existing;

    const base = toPascalCase(prefix) || "Slot";
    const name = this.names.claim(base, `${base}Slot`);
    this.aliasByKey.set(key, name);
    this.declare(name, [
      ...docBlock(this.describe(schema, `${prefix}[n]`), 1),
      `${pad(1)}export type ${name} = ${rendered};`,
    ]);
    return name;
  }

  /**
   * Collects the doc comment of a property from its schema.
   *
   * @remarks
   * The prose comes first, taken from `verbose_description` when there is
   * one and from `description` otherwise, followed by a note on indexed
   * properties. The constraints follow as tags, in a fixed order:
   * `@pattern`, `@minimum`, `@maximum`, `@minLength`, `@maxLength`,
   * `@default`, `@format`, `@propertyString` with the packed fields,
   * `@typetext` unless it only repeats the type, `@requires`, and
   * `@discriminatedBy` with the property that selects a `oneOf` variant.
   *
   * @param name - The property's name as the schema spells it, `[n]`
   *   included.
   * @returns The lines of the comment, without comment markers. Empty when
   *   the schema has nothing to say.
   */
  private describe(schema: PveSchema, name: string): string[] {
    const doc: string[] = [];
    const prose = schema.verbose_description ?? schema.description;
    if (prose) doc.push(...splitLines(prose));
    const prefix = indexedPrefix(name);
    if (prefix)
      doc.push(`Indexed property: \`${prefix}0\`, \`${prefix}1\`, ...`);

    for (const key of [
      "pattern",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "default",
    ] as const) {
      const value = schema[key];
      if (value === undefined) continue;
      doc.push(
        `@${key} ${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
    }
    if (typeof schema.format === "string") doc.push(`@format ${schema.format}`);
    if (typeof schema.format === "object") {
      const fields = Object.entries(schema.format)
        .map(([field, spec]) => `${field}=<${spec.type ?? "string"}>`)
        .join(", ");
      doc.push(`@propertyString ${fields}`);
    }
    if (schema.typetext && !TRIVIAL_TYPETEXT.test(schema.typetext)) {
      doc.push(`@typetext ${schema.typetext}`);
    }
    if (schema.requires) doc.push(`@requires ${schema.requires}`);
    if (schema["type-property"]) {
      // TypeScript cannot make one property's type depend on a sibling, so
      // the union is widened and the rule recorded here instead.
      const variants = (schema.oneOf ?? [])
        .map((variant) => (variant["instance-types"] ?? []).join("|"))
        .filter(Boolean)
        .join(", ");
      doc.push(
        `@discriminatedBy ${schema["type-property"]}${variants ? ` (${variants})` : ""}`,
      );
    }
    return doc;
  }

  /**
   * Returns the string alias that stands for a named PVE format, declaring
   * it on first use.
   *
   * @remarks
   * The alias keeps the format visible in editor hints. It is named after
   * the format (`pve-vmid` gives `PveVmid`), or `<Name>Format` when that
   * name is taken.
   *
   * @param format - The format name from the schema.
   * @returns The alias name, or `string` when the format name cannot be
   *   turned into a type name.
   */
  private formatAlias(format: string): string {
    const key = `format:${format}`;
    const existing = this.aliasByKey.get(key);
    if (existing) return existing;

    const candidate = toTypeName(format, "");
    if (!candidate) return "string";

    const name = this.names.claim(candidate, `${candidate}Format`);
    this.aliasByKey.set(key, name);
    this.declare(name, [
      ...docBlock([`PVE format \`${format}\`.`], 1),
      `${pad(1)}export type ${name} = string;`,
    ]);
    return name;
  }

  /**
   * Renders an enumeration as the alias chosen for it or as a union of
   * string literals.
   *
   * @remarks
   * The choice was made by {@link ModelEmitter.resolveEnumNames}. An alias
   * is declared on first use, with the values in the order of that use and
   * without a doc comment.
   *
   * @param hint - The property name the enumeration belongs to.
   * @param depth - Nesting depth of the line the type is written on.
   * @returns The alias name, or the union when the enumeration is written
   *   inline.
   */
  private enumExpr(values: string[], hint: string, depth: number): string {
    const name = this.enumNames.get(`${enumBase(hint)}\0${enumKey(values)}`);
    const members = values.map((value) => JSON.stringify(value));
    if (!name) return union(members, depth);
    if (!this.declarations.has(name)) {
      this.declare(name, [
        `${pad(1)}export type ${name} =${assign(union(members, 1))};`,
      ]);
    }
    return name;
  }

  /**
   * Decides every enumeration's name before anything is emitted, from where
   * it is used and not from the order it is met in.
   *
   * @remarks
   * Enumerations are grouped by the base name their property gives them. A
   * base name with a single value set keeps the plain name. Where several
   * value sets share a base name, a set of up to {@link INLINE_ENUM_MAX}
   * values is written inline, and a longer one is qualified by the literal
   * path segments common to every operation that uses it, or by those of
   * the first such path in sorted order when they share none.
   *
   * Names are claimed in sorted order, so the outcome is the same however
   * the tree is traversed. A name that is already taken gets the suffix
   * `Enum` and, if that is taken as well, a counter. Fills
   * {@link ModelEmitter.enumNames} and claims the names.
   */
  private resolveEnumNames(): void {
    const uses = new Map<string, Map<string, EnumUse>>();
    /**
     * Records the enumerations in a schema node and everything nested in
     * it as used by the operation at `path`.
     */
    const record = (schema: PveSchema, hint: string, path: string): void => {
      if (schema.enum) {
        const base = enumBase(hint);
        const sets = uses.get(base) ?? new Map<string, EnumUse>();
        uses.set(base, sets);
        const key = enumKey(schema.enum);
        const use = sets.get(key) ?? { values: schema.enum, paths: new Set() };
        sets.set(key, use);
        use.paths.add(path);
      }
      for (const variant of schema.oneOf ?? []) record(variant, hint, path);
      if (schema.items) record(schema.items, hint, path);
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        record(property, indexedPrefix(name) ?? name, path);
      }
      if (typeof schema.additionalProperties === "object") {
        record(schema.additionalProperties, "value", path);
      }
    };
    /**
     * Records the enumerations in the properties of an object schema,
     * skipping the object node itself.
     */
    const recordObject = (schema: PveSchema | undefined, path: string) => {
      for (const [name, property] of Object.entries(schema?.properties ?? {})) {
        record(property, indexedPrefix(name) ?? name, path);
      }
      if (typeof schema?.additionalProperties === "object") {
        record(schema.additionalProperties, "value", path);
      }
    };

    for (const { call, path } of this.operations) {
      recordObject(call.parameters, path);
      const returns = call.returns;
      if (!returns) continue;
      const target = returns.type === "array" ? (returns.items ?? {}) : returns;
      if (target.type === "object" || (!target.type && target.properties)) {
        recordObject(target, path);
      } else {
        record(returns, call.name, path);
      }
    }

    const wanted: Array<{ key: string; name: string }> = [];
    for (const [base, sets] of uses) {
      for (const [valueKey, use] of sets) {
        const key = `${base}\0${valueKey}`;
        if (sets.size === 1) {
          wanted.push({ key, name: base });
        } else if (use.values.length > INLINE_ENUM_MAX) {
          const paths = [...use.paths].sort();
          const prefix = commonPrefix(paths);
          const owner =
            prefix.length > 0 ? prefix : literalSegments(paths[0] ?? "");
          wanted.push({ key, name: toPascalCase(owner.join(" ")) + base });
        } else {
          this.enumNames.set(key, undefined);
        }
      }
    }
    wanted.sort(
      (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
    );
    for (const { key, name } of wanted) {
      this.enumNames.set(key, this.names.claim(name, `${name}Enum`));
    }
  }
}

/**
 * Renders the typed API model from a schema.
 *
 * @remarks
 * The output is deterministic: the same tree, operations and metadata give
 * byte-identical code.
 *
 * @param nodes - The root nodes of the API tree.
 * @param operations - The operations of the same tree, as returned by
 *   `collectOperations`. Their names become the interface names.
 * @param meta - The schema's version and hash, written into the header.
 * @returns The source of the model file and the indexed prefixes that had to
 *   be emitted without a bound.
 */
export function emitModel(
  nodes: PveNode[],
  operations: Operation[],
  meta: ModelMeta,
): EmitResult {
  const emitter = new ModelEmitter(nodes, operations, meta);
  const code = emitter.build();
  return { code, unboundedPrefixes: [...emitter.unboundedPrefixes].sort() };
}

/**
 * Renders the module of runtime constants that tell a consumer what the
 * model was built from.
 *
 * @param meta - The schema's version. The Proxmox VE release is derived from
 *   it; the hash is not used.
 * @param operations - The number of operations the model covers.
 * @returns The source of the file, which exports `PVE_VERSION`,
 *   `PVE_SCHEMA_VERSION` and `PVE_OPERATION_COUNT`.
 */
export function emitSchemaInfo(meta: ModelMeta, operations: number): string {
  /**
   * Renders one exported constant with a one-line doc comment and a blank
   * line after it.
   */
  const constant = (doc: string, name: string, value: string | number) => [
    "/**",
    ` * ${doc}`,
    " */",
    `export const ${name} = ${JSON.stringify(value)};`,
    "",
  ];
  return [
    "// Generated by @virtbase/proxmox-api-generator. Do not edit.",
    "",
    ...constant(
      "The Proxmox VE release the bundled API model describes, e.g. `9.2`.",
      "PVE_VERSION",
      minorOf(meta.version),
    ),
    ...constant(
      "The exact `pve-docs` package version the API schema was taken from.",
      "PVE_SCHEMA_VERSION",
      meta.version,
    ),
    ...constant(
      "Number of operations the model covers.",
      "PVE_OPERATION_COUNT",
      operations,
    ),
  ].join("\n");
}

/**
 * Extracts the names a generated model exports from the `Proxmox` namespace.
 *
 * @remarks
 * Relies on the layout {@link emitModel} produces: every type or interface
 * exported at namespace level starts a line indented by exactly two spaces.
 *
 * @param code - The source of a model file.
 * @returns The names of the exported types and interfaces.
 */
export function exportedTypeNames(code: string): Set<string> {
  const names = code.matchAll(/^ {2}export (?:type|interface) (\w+)/gm);
  return new Set([...names].map((match) => match[1] as string));
}
