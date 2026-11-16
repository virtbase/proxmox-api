/**
 * The shape of the Proxmox VE API schema, as published by the API viewer.
 *
 * There is no specification for this document, so every field here was
 * derived by walking real schemas. Anything described as introduced in PVE 9
 * does not occur in a PVE 8 schema.
 */

/**
 * The HTTP methods the PVE API exposes.
 */
export type PveMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * A boolean flag as the schema spells it.
 *
 * @remarks
 * Flags are `0` or `1`, but the string forms appear in places where the value
 * passed through Perl's JSON encoder as a string.
 */
type PveFlag = 0 | 1 | "0" | "1";

/**
 * A `{ href, rel }` hint that an array of child objects carries.
 */
interface PveLink {
  /**
   * Path of the linked resource relative to the current one, e.g. `{id}`.
   */
  href: string;
  /**
   * The kind of relation, e.g. `child`.
   */
  rel: string;
}

/**
 * One node of the parameter and return schema tree.
 *
 * @remarks
 * The same shape describes a call parameter, a returned value, a nested
 * object property, an array element, and one field of a property-string
 * format. Proxmox reuses it everywhere, so every branch is optional.
 */
export interface PveSchema {
  /**
   * The JSON type of the value. Absent on 176 nodes, which then fall back to
   * `enum`, `properties` or `items`.
   */
  type?:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "object"
    | "array"
    | "null"
    | "any";

  description?: string;
  /**
   * A longer description. The model prefers it over `description`.
   */
  verbose_description?: string;
  /**
   * A short placeholder for the value, e.g. `seconds` or `volume`. Not read
   * by the generator.
   */
  format_description?: string;
  title?: string;
  /**
   * The value's syntax as Proxmox prints it in its own documentation, e.g.
   * `[enable-new=<1|0>] [,full=<1|0>]`.
   */
  typetext?: string;
  /**
   * Set when the value may be left out. See {@link isOptional} for `oneOf`.
   */
  optional?: PveFlag;
  /**
   * The documented default for a value that is left out.
   */
  default?: unknown;
  /**
   * Marks the field of a property string whose key may be omitted. Not read
   * by the generator.
   */
  default_key?: number;
  /**
   * Names how Proxmox's own tools display the value, e.g. `bytes` or
   * `timestamp`. Not read by the generator.
   */
  renderer?: string;
  /**
   * Names a sibling property this one depends on. Documentation only.
   */
  requires?: string;

  /**
   * The complete set of values allowed.
   */
  enum?: string[];
  /**
   * A regular expression the value has to match.
   */
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  /**
   * Lower bound of a number. Numeric bounds arrive as numbers or as their
   * string spellings.
   */
  minimum?: number | string;
  /**
   * Upper bound of a number, as a number or its string spelling.
   */
  maximum?: number | string;
  /**
   * A lower bound spelled `min` instead of `minimum`, seen on a few
   * property-string fields. Not read by the generator.
   */
  min?: number;
  /**
   * An upper bound spelled `max` instead of `maximum`, seen on a few
   * property-string fields. Not read by the generator.
   */
  max?: number;

  /**
   * Either the name of a registered PVE format (`pve-vmid`, `CIDR`, ...) or,
   * for a property string, the schema of each field packed into the value.
   */
  format?: string | Record<string, PveSchema>;

  /**
   * The schema of every element of an array.
   */
  items?: PveSchema;
  /**
   * The schema of each known key of an object.
   */
  properties?: Record<string, PveSchema>;
  /**
   * `1` allows unlisted keys, `0` forbids them, and a schema constrains what
   * those extra values look like.
   */
  additionalProperties?: PveFlag | PveSchema;
  links?: PveLink[];

  /**
   * This field is an alias of another; the target holds the real schema.
   */
  alias?: string;
  /**
   * Accompanies `alias` on some property-string fields, e.g. `model` on the
   * network card models. Not read by the generator.
   */
  keyAlias?: string;

  /**
   * The variants of a discriminated union.
   *
   * @remarks
   * The variant is chosen by the sibling property named in `type-property`,
   * matched against each variant's `instance-types`. Introduced in PVE 9,
   * where the SDN fabrics endpoints use it.
   */
  oneOf?: PveSchema[];
  /**
   * The sibling property that selects the `oneOf` variant.
   */
  "type-property"?: string;
  /**
   * On a `oneOf` variant, the values of the `type-property` it applies to.
   */
  "instance-types"?: string[];
}

/**
 * One HTTP operation on a path.
 */
export interface PveCall {
  method: PveMethod;
  /**
   * The name of the handler in the Proxmox source, e.g. `create_vm`.
   */
  name: string;
  description?: string;
  /**
   * `0` when the call cannot be made with an API token. Absent counts as
   * allowed.
   */
  allowtoken?: PveFlag;
  /**
   * Not read by the generator.
   */
  protected?: PveFlag;
  /**
   * Not read by the generator. Usually `node`, sometimes `null`.
   */
  proxyto?: string | null;
  /**
   * The access check, in a form that differs from call to call: a
   * `description`, a nested `check` array or a `user` class.
   */
  permissions?: unknown;
  /**
   * Introduced in PVE 9. Not read by the generator.
   */
  download_allowed?: PveFlag;
  /**
   * Introduced in PVE 9. Not read by the generator.
   */
  expose_credentials?: PveFlag;
  /**
   * An object schema whose properties are the call's parameters, path
   * placeholders included.
   */
  parameters?: PveSchema;
  /**
   * The schema of the response body. Absent or of type `null` when the call
   * returns nothing.
   */
  returns?: PveSchema;
}

/**
 * One path in the API tree.
 */
export interface PveNode {
  /**
   * Full path with `{}` placeholders, e.g. `/nodes/{node}/qemu/{vmid}`.
   */
  path: string;
  /**
   * This node's own segment: `qemu`, or `{vmid}` for a placeholder.
   */
  text: string;
  /**
   * `1` on a node without children, `0` otherwise. Not read by the
   * generator.
   */
  leaf: number;
  /**
   * The calls this path answers, by method. Absent on a path that only
   * groups children.
   */
  info?: Partial<Record<PveMethod, PveCall>>;
  children?: PveNode[];
}

/**
 * Reports whether a flag is set, in either its numeric or its string form.
 */
function isSet(flag: PveFlag | undefined): boolean {
  return flag === 1 || flag === "1";
}

/**
 * Reports whether a schema node may be left out.
 *
 * @remarks
 * For a `oneOf`, Proxmox puts the flag on the variants instead of on the
 * property itself. TypeScript cannot make requiredness depend on which
 * variant applies, so the property is optional as soon as any variant is.
 *
 * @param schema - The schema of a parameter or property.
 * @returns `true` when `optional` is set on the node or on at least one of
 *   its `oneOf` variants.
 */
export function isOptional(schema: PveSchema): boolean {
  return (
    isSet(schema.optional) ||
    (schema.oneOf?.some((variant) => isSet(variant.optional)) ?? false)
  );
}

/**
 * Extracts the variable a placeholder path segment names.
 *
 * @param text - One path segment, without slashes.
 * @returns The name between the braces, or `undefined` when the segment is a
 *   literal.
 *
 * @example
 * ```ts
 * pathVariable("{vmid}"); // "vmid"
 * pathVariable("qemu"); // undefined
 * ```
 */
export function pathVariable(text: string): string | undefined {
  return text.startsWith("{") && text.endsWith("}")
    ? text.slice(1, -1)
    : undefined;
}
