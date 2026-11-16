/**
 * Identifier and property-name handling for the emitted TypeScript.
 */

/**
 * Matches a name that needs no quoting: an ASCII letter, `_` or `$`, followed
 * by any number of those or digits.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Reports whether a name can be written as a bare property name.
 *
 * @remarks
 * Only ASCII identifiers pass. Reserved words such as `delete` pass as well,
 * which is correct for a property name but not for every other position.
 *
 * @param name - The name to test.
 * @returns `true` when the name is usable without quotes.
 *
 * @example
 * ```ts
 * isSafeIdentifier("ceph_version"); // true
 * isSafeIdentifier("file-restore"); // false
 * ```
 */
export function isSafeIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

/**
 * Returns a property name as it is written in an object type, quoted when it
 * is not an identifier.
 *
 * @remarks
 * Property names carry whatever PVE uses: `file-restore`, `ceph_version`,
 * `type-property`. Quoting goes through `JSON.stringify`, so every character
 * is escaped.
 *
 * @param name - The property name as it appears in the schema.
 * @returns The name itself, or a double-quoted string literal holding it.
 *
 * @example
 * ```ts
 * quoteProperty("ceph_version"); // ceph_version
 * quoteProperty("file-restore"); // "file-restore"
 * ```
 */
export function quoteProperty(name: string): string {
  return isSafeIdentifier(name) ? name : JSON.stringify(name);
}

/**
 * Splits text into its runs of ASCII letters and digits.
 *
 * @remarks
 * Everything else is a separator, which also guarantees that nothing from the
 * schema can reach generated code as syntax.
 */
function words(input: string): string[] {
  return input.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/**
 * Converts text to camelCase.
 *
 * @remarks
 * Only the first character of each word changes case, so `VMID` becomes
 * `vMID`. The result starts with a digit when the input does.
 *
 * @param input - Text in any casing, with any separators.
 * @returns The camelCase form, or an empty string when the input holds no
 *   letters or digits.
 *
 * @example
 * ```ts
 * toCamelCase("route-map-id"); // "routeMapId"
 * ```
 */
export function toCamelCase(input: string): string {
  const parts = words(input);
  if (parts.length === 0) return "";
  const [head, ...rest] = parts;
  return (
    (head as string).replace(/^./, (c) => c.toLowerCase()) +
    rest.map(capitalize).join("")
  );
}

/**
 * Converts text to PascalCase.
 *
 * @remarks
 * Only the first character of each word changes case, so `GET` stays `GET`.
 * The result starts with a digit when the input does; use {@link toTypeName}
 * where a valid type name is required.
 *
 * @param input - Text in any casing, with any separators.
 * @returns The PascalCase form, or an empty string when the input holds no
 *   letters or digits.
 *
 * @example
 * ```ts
 * toPascalCase("pve-vmid"); // "PveVmid"
 * toPascalCase("nodes qemu create_vm"); // "NodesQemuCreateVm"
 * ```
 */
export function toPascalCase(input: string): string {
  return words(input).map(capitalize).join("");
}

/**
 * Upper-cases the first character of a word and leaves the rest as it is.
 */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Derives a type name from schema text such as a property name or the name
 * of a PVE format.
 *
 * @remarks
 * The fallback exists for text that is not a name at all, for example a
 * format that is really a regular expression. Such text only falls back when
 * nothing alphanumeric is left of it or the result would start with a digit;
 * otherwise its letters and digits form the name.
 *
 * @param input - The text to convert.
 * @param fallback - Returned when no usable name can be derived. Pass an
 *   empty string to detect that case.
 * @returns The PascalCase form of the input, or `fallback` when the input
 *   holds no letters or digits or the name would start with a digit.
 *
 * @example
 * ```ts
 * toTypeName("pve-vmid", ""); // "PveVmid"
 * toTypeName("file_type", "Enum"); // "FileType"
 * toTypeName("9p", "Enum"); // "Enum"
 * ```
 */
export function toTypeName(input: string, fallback: string): string {
  const pascal = toPascalCase(input.replace(/[^A-Za-z0-9\-_.\s/]/g, " "));
  if (!pascal || !isSafeIdentifier(pascal)) return fallback;
  // Not reached at present: a leading digit already fails the identifier
  // test above, so such a name returns the bare fallback.
  return /^[0-9]/.test(pascal) ? `${fallback}${pascal}` : pascal;
}

/**
 * A registry of the names used in one generated file, which hands out only
 * names that are still free.
 *
 * @remarks
 * A clash is settled with the caller's fallback (`Api` becomes `ApiEnum`)
 * before a counter is considered. Which claim wins a contested name still
 * depends on the order of the claims, so claim in a deterministic order.
 */
export class UniqueNames {
  /**
   * Every name reserved or handed out so far.
   */
  private readonly taken = new Set<string>();

  /**
   * Creates a registry in which the given names are already taken.
   *
   * @param reserved - Names that are never handed out, such as declarations
   *   written by hand into the same file. Defaults to none.
   */
  constructor(reserved: Iterable<string> = []) {
    for (const name of reserved) this.taken.add(name);
  }

  /**
   * Reserves a free name and returns it.
   *
   * @remarks
   * Tries `preferred`, then `fallback`, then the last of the two with a
   * counter appended, starting at `2`. The returned name is recorded as
   * taken.
   *
   * @param preferred - The name to use when it is still free.
   * @param fallback - The name to use when `preferred` is taken. When
   *   omitted, a clash goes straight to the counter.
   * @returns A name that no reservation or earlier claim holds.
   *
   * @example
   * ```ts
   * const names = new UniqueNames(["Api"]);
   * names.claim("Api", "ApiEnum"); // "ApiEnum"
   * names.claim("Api", "ApiEnum"); // "ApiEnum2"
   * names.claim("Api"); // "Api2"
   * ```
   */
  claim(preferred: string, fallback?: string): string {
    let name = preferred;
    if (this.taken.has(name) && fallback) name = fallback;
    const base = name;
    let counter = 2;
    while (this.taken.has(name)) name = `${base}${counter++}`;
    this.taken.add(name);
    return name;
  }
}
