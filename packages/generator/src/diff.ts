import type { Operation } from "./operations.js";
import type { PveCall, PveSchema } from "./schema.js";
import { isOptional } from "./schema.js";

/**
 * How far a schema update moves the package version.
 *
 * @remarks
 * `major` is reserved for changes that stop existing callers compiling or
 * working - the cases Proxmox itself calls breaking: an endpoint or parameter
 * removed, a parameter newly required, a return value changing type. `minor`
 * covers additions and every other change of shape, `patch` a change of
 * wording or metadata only, and `none` an identical schema.
 */
export type ChangeLevel = "major" | "minor" | "patch" | "none";

/**
 * One difference found in an operation that exists in both versions.
 */
interface ChangeDetail {
  /**
   * The difference as a Markdown phrase, for example
   * ``parameter `ostype` removed``.
   */
  text: string;
  /**
   * Whether this difference can break an existing caller.
   */
  breaking: boolean;
}

/**
 * What happened to one operation between two schema versions; one line of
 * the API changelog.
 */
export interface OperationChange {
  /**
   * Identity of the operation, for example `GET /nodes/{node}/qemu`.
   */
  operation: string;
  /**
   * Whether the operation is new, gone, or present in both versions with a
   * different shape.
   */
  change: "added" | "removed" | "changed";
  /**
   * `true` for a removed operation and for a changed one with at least one
   * breaking detail; always `false` for an added one.
   */
  breaking: boolean;
  /**
   * The individual differences. Present only when `change` is `changed`.
   */
  details?: ChangeDetail[];
}

/**
 * The outcome of comparing two versions of the API schema: the differences
 * and the release level they call for.
 */
export interface SchemaDiff {
  /**
   * `major` if any change is breaking, otherwise `minor` if there is any
   * change, otherwise `patch` if only documentation changed, otherwise
   * `none`.
   */
  level: ChangeLevel;
  /**
   * Counts of operations, by what happened to them.
   */
  summary: {
    added: number;
    removed: number;
    changed: number;
    /**
     * Operations that were removed or changed in a breaking way.
     */
    breaking: number;
    /**
     * Operations whose wording changed but whose shape did not.
     */
    documentation: number;
  };
  /**
   * The added, removed and changed operations, sorted by path and then by
   * method. Operations that only changed their documentation are not listed.
   */
  changes: OperationChange[];
}

/**
 * The comparable essence of one parameter or returned value, as collected by
 * {@link flatten}.
 */
interface Field {
  /**
   * Coarse type, as computed by {@link baseKind}.
   */
  kind: string;
  optional: boolean;
  /**
   * The allowed values of an enumeration, sorted; absent for anything else.
   */
  values?: string[];
}

/**
 * Reduces a schema node to the coarse type that is compared between
 * versions.
 *
 * @remarks
 * `integer` and `number` both count as `number`, an enumeration counts as
 * `string` and a `oneOf` as `union`. A node without a `type` is classified by
 * its `properties` or `items`, and is `any` when it has neither.
 */
function baseKind(schema: PveSchema): string {
  if (schema.oneOf) return "union";
  if (schema.enum) return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type) return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "any";
}

/**
 * Flattens a schema into a map from path to field, so that two versions can
 * be compared key by key.
 *
 * @remarks
 * Nested properties are joined with dots, array elements live under `[]` and
 * the schema of unlisted keys under `*`, which gives keys such as `[].status`
 * and `options.*`. The root schema itself gets no entry. The variants of a
 * `oneOf` are merged into the property that holds them; where two variants
 * define the same nested key, the later one wins.
 *
 * @param schema - The node to flatten; `undefined` adds nothing.
 * @param prefix - Path of `schema` itself, empty for the root.
 * @param out - The map to add to.
 * @param isVariant - Set while descending into a `oneOf` variant, which
 *   shares the path of its parent.
 * @returns `out`, for chaining.
 */
function flatten(
  schema: PveSchema | undefined,
  prefix: string,
  out: Map<string, Field>,
  isVariant = false,
): Map<string, Field> {
  if (!schema) return out;
  const kind = baseKind(schema);
  // A variant only contributes what is nested inside it; the property's own
  // entry was written by the `oneOf` that holds it.
  if (prefix && !isVariant) {
    out.set(prefix, {
      kind,
      optional: isOptional(schema),
      values: schema.enum ? [...schema.enum].sort() : undefined,
    });
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    flatten(property, prefix ? `${prefix}.${name}` : name, out);
  }
  for (const variant of schema.oneOf ?? []) {
    flatten(variant, prefix, out, true);
  }
  if (schema.items) flatten(schema.items, `${prefix}[]`, out);
  if (typeof schema.additionalProperties === "object") {
    flatten(schema.additionalProperties, `${prefix}.*`, out);
  }
  return out;
}

/**
 * Flattens the parameters of a call; see {@link flatten} for the keys.
 */
function parameters(call: PveCall): Map<string, Field> {
  return flatten(call.parameters, "", new Map());
}

/**
 * Flattens the return schema of a call.
 *
 * @returns The fields of the returned value, plus a `(value)` entry for the
 *   type of the value itself. Empty when the call declares no return schema.
 */
function returns(call: PveCall): Map<string, Field> {
  const out = new Map<string, Field>();
  const schema = call.returns;
  if (!schema) return out;
  out.set("(value)", { kind: baseKind(schema), optional: false });
  return flatten(schema, "", out);
}

/**
 * Returns the values of `a` that `b` does not contain, in the order of `a`.
 * A missing list counts as empty.
 */
function difference(a: string[] = [], b: string[] = []): string[] {
  const other = new Set(b);
  return a.filter((value) => !other.has(value));
}

/**
 * Formats values as a comma-separated list of Markdown code spans.
 */
function list(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

/**
 * Lists how the parameters of one operation differ between two versions.
 *
 * @remarks
 * Breaking: a parameter removed, one changing its type, one newly restricted
 * to an enumeration, an enumeration losing values, a required top-level
 * parameter added, a top-level parameter becoming required, and unlisted
 * parameters no longer being accepted.
 *
 * Not breaking: an optional or nested parameter added, an enumeration gaining
 * values, and a top-level parameter becoming optional. The requiredness of
 * nested fields is not compared at all.
 *
 * @param before - The call in the older version.
 * @param after - The call in the newer version.
 * @returns One detail per difference; empty when the parameters have the
 *   same shape.
 */
function compareParameters(before: PveCall, after: PveCall): ChangeDetail[] {
  const details: ChangeDetail[] = [];
  const old = parameters(before);
  const current = parameters(after);

  for (const [name, field] of current) {
    const previous = old.get(name);
    // Requiredness only means something for a top-level parameter; inside a
    // nested value or an array element the flag is not a contract.
    const topLevel = !/[.[]/.test(name);
    if (!previous) {
      const required = topLevel && !field.optional;
      details.push({
        text: `parameter \`${name}\` added${required ? " (required)" : ""}`,
        breaking: required,
      });
      continue;
    }
    if (previous.kind !== field.kind) {
      details.push({
        text: `parameter \`${name}\` changed from ${previous.kind} to ${field.kind}`,
        breaking: true,
      });
    } else if (field.values && !previous.values) {
      details.push({
        text: `parameter \`${name}\` is now restricted to ${list(field.values)}`,
        breaking: true,
      });
    } else if (field.values) {
      const gained = difference(field.values, previous.values);
      const lost = difference(previous.values, field.values);
      if (gained.length > 0) {
        details.push({
          text: `parameter \`${name}\` accepts ${list(gained)}`,
          breaking: false,
        });
      }
      if (lost.length > 0) {
        details.push({
          text: `parameter \`${name}\` no longer accepts ${list(lost)}`,
          breaking: true,
        });
      }
    }
    if (!topLevel) continue;
    if (previous.optional && !field.optional) {
      details.push({
        text: `parameter \`${name}\` is now required`,
        breaking: true,
      });
    } else if (!previous.optional && field.optional) {
      details.push({
        text: `parameter \`${name}\` is now optional`,
        breaking: false,
      });
    }
  }
  for (const name of old.keys()) {
    if (!current.has(name)) {
      details.push({ text: `parameter \`${name}\` removed`, breaking: true });
    }
  }
  const open = (call: PveCall) => {
    const extra = call.parameters?.additionalProperties;
    return extra !== undefined && extra !== 0 && extra !== "0";
  };
  if (open(before) && !open(after)) {
    details.push({
      text: "unlisted parameters are no longer accepted",
      breaking: true,
    });
  }
  return details;
}

/**
 * Lists how the return value of one operation differs between two versions.
 *
 * @remarks
 * Breaking: a returned property removed, one that was always present
 * becoming optional, and a type change - unless the old type was `null` or
 * untyped, which only documents what was already being returned.
 *
 * Not breaking: a property added, a property becoming always present, and an
 * enumeration gaining or losing values.
 *
 * @param before - The call in the older version.
 * @param after - The call in the newer version.
 * @returns One detail per difference; empty when the return values have the
 *   same shape.
 */
function compareReturns(before: PveCall, after: PveCall): ChangeDetail[] {
  const details: ChangeDetail[] = [];
  const old = returns(before);
  const current = returns(after);
  const label = (name: string) =>
    name === "(value)" ? "return value" : `returned \`${name}\``;

  for (const [name, field] of current) {
    const previous = old.get(name);
    if (!previous) {
      details.push({ text: `${label(name)} added`, breaking: false });
      continue;
    }
    if (previous.kind !== field.kind) {
      // Proxmox does not count `null`/untyped gaining a type as breaking: it
      // documents something that was already being returned.
      const documented = previous.kind === "null" || previous.kind === "any";
      details.push({
        text: `${label(name)} changed from ${previous.kind} to ${field.kind}`,
        breaking: !documented,
      });
    } else if (field.values && previous.values) {
      const gained = difference(field.values, previous.values);
      const lost = difference(previous.values, field.values);
      if (gained.length > 0) {
        details.push({
          text: `${label(name)} may be ${list(gained)}`,
          breaking: false,
        });
      }
      if (lost.length > 0) {
        details.push({
          text: `${label(name)} is no longer ${list(lost)}`,
          breaking: false,
        });
      }
    }
    if (!previous.optional && field.optional) {
      details.push({ text: `${label(name)} is now optional`, breaking: true });
    } else if (previous.optional && !field.optional) {
      details.push({
        text: `${label(name)} is now always present`,
        breaking: false,
      });
    }
  }
  for (const name of old.keys()) {
    if (!current.has(name)) {
      details.push({ text: `${label(name)} removed`, breaking: true });
    }
  }
  return details;
}

/**
 * Compares two versions of the API, operation by operation, and classifies
 * the result.
 *
 * @remarks
 * Operations are matched by their identity, the method and path. One that
 * exists only in `after` is an addition and one that exists only in `before`
 * a breaking removal. For one that exists in both, the parameters, the return
 * value and whether an API token may call it are compared; an absent
 * `allowtoken` means tokens are allowed, and withdrawing that access is
 * breaking.
 *
 * An operation with none of these differences whose call definition still
 * serialises differently - a description, a default, the permissions - is
 * counted under `summary.documentation` and not listed.
 *
 * @param before - Operations of the older version.
 * @param after - Operations of the newer version.
 * @returns The changed operations, their counts and the resulting level.
 */
export function diffOperations(
  before: Operation[],
  after: Operation[],
): SchemaDiff {
  const old = new Map(before.map((operation) => [operation.id, operation]));
  const current = new Map(after.map((operation) => [operation.id, operation]));
  const changes: OperationChange[] = [];
  let documentation = 0;

  for (const [id, operation] of current) {
    const previous = old.get(id);
    if (!previous) {
      changes.push({ operation: id, change: "added", breaking: false });
      continue;
    }
    const details = [
      ...compareParameters(previous.call, operation.call),
      ...compareReturns(previous.call, operation.call),
    ];
    const allowed = Number(operation.call.allowtoken ?? 1) === 1;
    if ((Number(previous.call.allowtoken ?? 1) === 1) !== allowed) {
      details.push({
        text: allowed
          ? "now callable with an API token"
          : "no longer callable with an API token",
        breaking: !allowed,
      });
    }
    if (details.length > 0) {
      changes.push({
        operation: id,
        change: "changed",
        breaking: details.some((detail) => detail.breaking),
        details,
      });
    } else if (
      JSON.stringify(previous.call) !== JSON.stringify(operation.call)
    ) {
      documentation++;
    }
  }
  for (const id of old.keys()) {
    if (!current.has(id)) {
      changes.push({ operation: id, change: "removed", breaking: true });
    }
  }
  changes.sort((a, b) => {
    const [methodA = "", pathA = ""] = a.operation.split(" ");
    const [methodB = "", pathB = ""] = b.operation.split(" ");
    return pathA.localeCompare(pathB) || methodA.localeCompare(methodB);
  });

  const count = (change: OperationChange["change"]) =>
    changes.filter((entry) => entry.change === change).length;
  const breaking = changes.filter((entry) => entry.breaking).length;
  const level: ChangeLevel =
    breaking > 0
      ? "major"
      : changes.length > 0
        ? "minor"
        : documentation > 0
          ? "patch"
          : "none";

  return {
    level,
    summary: {
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      breaking,
      documentation,
    },
    changes,
  };
}
