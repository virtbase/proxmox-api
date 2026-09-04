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

/**
 * The shape of the Proxmox VE API schema, as published by the API viewer.
 *
 * Proxmox does not version this document, so every field here was derived by
 * walking the live PVE 9 schema rather than from a spec. Anything marked
 * "@since PVE 9" is absent from the PVE 8 dump this package used to vendor.
 */

/** HTTP methods the PVE API exposes. */
export type PveMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Truthiness flags are `0`/`1`, but string forms appear in places where the
 * value passed through Perl's JSON encoder as a string.
 */
export type PveFlag = 0 | 1 | "0" | "1";

/** The `{ href, rel }` hints an array of child objects carries. */
export interface PveLink {
  href: string;
  rel: string;
}

/**
 * One node of the parameter/return schema tree.
 *
 * The same shape describes a call parameter, a returned value, a nested
 * object property, an array element, and one field of a property-string
 * format - Proxmox reuses it everywhere, so every branch is optional.
 */
export interface PveSchema {
  /** Absent on 176 nodes, which then fall back to `enum`/`properties`/`items`. */
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
  verbose_description?: string;
  format_description?: string;
  title?: string;
  typetext?: string;
  optional?: PveFlag;
  default?: unknown;
  default_key?: number;
  renderer?: string;
  /** Names a sibling property this one depends on. Documentation only. */
  requires?: string;

  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  /** Numeric bounds arrive as numbers or as their string spellings. */
  minimum?: number | string;
  maximum?: number | string;
  min?: number;
  max?: number;

  /**
   * Either the name of a registered PVE format (`pve-vmid`, `CIDR`, ...) or,
   * for a property string, the schema of each field packed into the value.
   */
  format?: string | Record<string, PveSchema>;

  items?: PveSchema;
  properties?: Record<string, PveSchema>;
  /**
   * `1` allows unlisted keys, `0` forbids them, and a schema constrains what
   * those extra values look like.
   */
  additionalProperties?: PveFlag | PveSchema;
  links?: PveLink[];

  /** This field is an alias of another; the target holds the real schema. */
  alias?: string;
  keyAlias?: string;

  /**
   * A discriminated union: the variant is chosen by the sibling property
   * named in `type-property`, matched against each variant's
   * `instance-types`.
   *
   * @since PVE 9 - used by the SDN fabrics endpoints.
   */
  oneOf?: PveSchema[];
  "type-property"?: string;
  "instance-types"?: string[];
}

/** One HTTP operation on a path. */
export interface PveCall {
  method: PveMethod;
  name: string;
  description?: string;
  allowtoken?: PveFlag;
  protected?: PveFlag;
  proxyto?: string | null;
  permissions?: unknown;
  /** @since PVE 9 */
  download_allowed?: PveFlag;
  /** @since PVE 9 */
  expose_credentials?: PveFlag;
  parameters?: PveSchema;
  returns?: PveSchema;
}

/** One path in the API tree. */
export interface PveNode {
  /** Full path, with `{}` placeholders - `/nodes/{node}/qemu/{vmid}`. */
  path: string;
  /** This node's own segment - `qemu`, or `{vmid}` for a placeholder. */
  text: string;
  leaf: number;
  info?: Partial<Record<PveMethod, PveCall>>;
  children?: PveNode[];
}

/** True when a schema node is flagged optional, in either spelling. */
export function isOptional(schema: PveSchema): boolean {
  return schema.optional === 1 || schema.optional === "1";
}

/** A path segment like `{vmid}` names a variable; return it, else undefined. */
export function pathVariable(text: string): string | undefined {
  return text.startsWith("{") && text.endsWith("}")
    ? text.slice(1, -1)
    : undefined;
}
