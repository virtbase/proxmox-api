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

/** Identifier and property-name handling for the emitted TypeScript. */

const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Can this be written as a bare property name? */
export function isSafeIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

/**
 * Property names carry whatever PVE uses - `file-restore`, `ceph_version`,
 * `type-property`. Quote the ones that are not identifiers.
 */
export function quoteProperty(name: string): string {
  return isSafeIdentifier(name) ? name : JSON.stringify(name);
}

/** Split on the separators PVE mixes: `-`, `_`, `.`, spaces and `/`. */
function words(input: string): string[] {
  return input.split(/[-_./\s]+/).filter(Boolean);
}

/** `route-map-id` -> `routeMapId` */
export function toCamelCase(input: string): string {
  const parts = words(input);
  if (parts.length === 0) return "";
  const [head, ...rest] = parts;
  return (
    (head as string).replace(/^./, (c) => c.toLowerCase()) +
    rest.map(capitalize).join("")
  );
}

/** `pve-vmid` -> `PveVmid` */
export function toPascalCase(input: string): string {
  return words(input).map(capitalize).join("");
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Turn arbitrary text into something usable as a type name, falling back when
 * PVE hands us a format that is really a regex or is otherwise unusable.
 */
export function toTypeName(input: string, fallback: string): string {
  const pascal = toPascalCase(input.replace(/[^A-Za-z0-9\-_.\s/]/g, " "));
  if (!pascal || !isSafeIdentifier(pascal)) return fallback;
  // A leading digit survives the identifier test only behind a prefix.
  return /^[0-9]/.test(pascal) ? `${fallback}${pascal}` : pascal;
}

/**
 * Hands out names that are unique within one generated file, appending `_2`,
 * `_3` and so on. Deterministic: the same request order gives the same names.
 */
export class UniqueNames {
  private readonly taken = new Set<string>();

  constructor(reserved: Iterable<string> = []) {
    for (const name of reserved) this.taken.add(name);
  }

  claim(preferred: string): string {
    let name = preferred;
    let counter = 2;
    while (this.taken.has(name)) name = `${preferred}_${counter++}`;
    this.taken.add(name);
    return name;
  }
}
