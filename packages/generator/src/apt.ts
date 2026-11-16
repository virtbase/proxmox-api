import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Base URL of the Proxmox VE apt repository, the host of every request made
 * here.
 *
 * @remarks
 * Proxmox serves its apt repository over plain HTTP only; the certificate on
 * this host does not cover the name. Integrity therefore comes from the
 * SHA-256 hashes recorded in the lock file, not from the transport.
 */
const APT_BASE_URL = "http://download.proxmox.com/debian/pve";

/**
 * Value of the `User-Agent` header sent with every request to the repository.
 */
const USER_AGENT = "proxmox-api-generator";

/**
 * Path of the API viewer bundle inside the data archive of a `pve-docs`
 * package.
 */
const APIDOC_MEMBER = "./usr/share/pve-docs/api-viewer/apidoc.js";

/**
 * One version of a package as listed in an apt `Packages` index, with what is
 * needed to download and verify it.
 */
export interface AptPackage {
  /**
   * Debian version of the package, for example `9.2.14`.
   */
  version: string;
  /**
   * Path of the `.deb`, relative to {@link APT_BASE_URL}.
   */
  filename: string;
  /**
   * SHA-256 of the `.deb` in lowercase hex, as listed in the index.
   * {@link downloadApidoc} rejects a download that does not match it.
   */
  sha256: string;
}

/**
 * The place in the Proxmox apt repository where one package is looked up.
 */
export interface AptSource {
  /**
   * Debian codename the Proxmox release is built on, for example `trixie`.
   */
  suite: string;
  /**
   * Repository component, for example `pve-no-subscription`.
   */
  component: string;
  /**
   * Name of the Debian package, for example `pve-docs`.
   */
  package: string;
}

/**
 * Returns the weight dpkg gives one character of a non-digit run.
 *
 * @remarks
 * Mirrors `order()` in dpkg. `~` weighs least, so it sorts before everything
 * including the end of the string. A digit and the end of the string weigh
 * nothing, letters weigh their character code, and every other character
 * sorts after all letters.
 *
 * @param char - A single character, or `undefined` past the end of the
 *   string.
 * @returns The weight; the character with the lower weight sorts first.
 */
function order(char: string | undefined): number {
  if (char === undefined || /[0-9]/.test(char)) return 0;
  if (char === "~") return -1;
  if (/[A-Za-z]/.test(char)) return char.charCodeAt(0);
  return char.charCodeAt(0) + 256;
}

/**
 * Reports whether a character is an ASCII digit. `undefined`, which stands
 * for the end of the string, is not.
 */
function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Compares two upstream versions or two revisions the way dpkg's `verrevcmp`
 * does.
 *
 * @remarks
 * Both strings are read as alternating non-digit and digit runs. Non-digit
 * runs are compared character by character by {@link order}, so `~` sorts
 * before anything else, even the end of the string. Digit runs are compared
 * as numbers: leading zeros are ignored, the longer run wins, and runs of
 * equal length are decided by their first differing digit.
 *
 * @returns A negative number when `a` sorts first, a positive number when `b`
 *   does and `0` when they rank the same.
 */
function compareFragment(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while (
      (i < a.length && !isDigit(a[i])) ||
      (j < b.length && !isDigit(b[j]))
    ) {
      const difference = order(a[i]) - order(b[j]);
      if (difference !== 0) return difference;
      i++;
      j++;
    }
    while (a[i] === "0") i++;
    while (b[j] === "0") j++;
    let firstDifference = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDifference === 0) {
        firstDifference =
          (a[i] as string).charCodeAt(0) - (b[j] as string).charCodeAt(0);
      }
      i++;
      j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDifference !== 0) return firstDifference;
  }
  return 0;
}

/**
 * Splits a Debian version into its epoch, upstream version and revision.
 *
 * @remarks
 * The epoch is what precedes the first `:` and defaults to `0`. The revision
 * is what follows the last `-` and defaults to an empty string.
 *
 * @example
 * ```ts
 * splitVersion("1:9.2.14-2"); // [1, "9.2.14", "2"]
 * splitVersion("9.2.14"); // [0, "9.2.14", ""]
 * ```
 */
function splitVersion(version: string): [number, string, string] {
  const colon = version.indexOf(":");
  const epoch = colon === -1 ? 0 : Number(version.slice(0, colon));
  const rest = colon === -1 ? version : version.slice(colon + 1);
  const dash = rest.lastIndexOf("-");
  return dash === -1
    ? [epoch, rest, ""]
    : [epoch, rest.slice(0, dash), rest.slice(dash + 1)];
}

/**
 * Compares two Debian package versions the way dpkg does.
 *
 * @remarks
 * The epoch decides first, then the upstream version, then the revision. A
 * version without an epoch has epoch `0`, and one without a revision has an
 * empty revision. The function can be passed to `Array.prototype.sort` as it
 * is to order versions oldest first.
 *
 * @param a - First version, for example `9.2.14` or `1:9.0.0~8-2`.
 * @param b - Second version, in the same notation.
 * @returns A negative number when `a` is older than `b`, a positive number
 *   when it is newer and `0` when both rank the same. Only the sign is
 *   meaningful.
 *
 * @example
 * ```ts
 * compareDebianVersions("9.2.9", "9.2.14"); // -1: 9 is less than 14
 * compareDebianVersions("9.0.0~8", "9.0.0"); // -1: `~` sorts before the end
 * compareDebianVersions("1:1.0", "2.0"); // 1: the epoch decides
 * compareDebianVersions("9.2.14", "9.2.14"); // 0
 * ```
 */
export function compareDebianVersions(a: string, b: string): number {
  const [epochA, upstreamA, revisionA] = splitVersion(a);
  const [epochB, upstreamB, revisionB] = splitVersion(b);
  return (
    epochA - epochB ||
    compareFragment(upstreamA, upstreamB) ||
    compareFragment(revisionA, revisionB)
  );
}

/**
 * Returns the Proxmox VE release a package version belongs to.
 *
 * @param version - Package version; it is split at every `.`, `~` and `-`.
 * @returns The first two components joined by a dot. A missing component
 *   becomes `0`.
 *
 * @example
 * ```ts
 * minorOf("9.2.14"); // "9.2"
 * minorOf("9.0.0~8"); // "9.0"
 * minorOf("9"); // "9.0"
 * ```
 */
export function minorOf(version: string): string {
  const [major = "0", minor = "0"] = version.split(/[.~-]/);
  return `${major}.${minor}`;
}

/**
 * Reports whether a package version is a pre-release.
 *
 * @remarks
 * Proxmox spells pre-releases with a tilde, as in `9.0.0~8`. They are never
 * tracked.
 *
 * @param version - Package version to test.
 * @returns `true` when the version contains a `~`.
 *
 * @example
 * ```ts
 * isPrerelease("9.0.0~8"); // true
 * isPrerelease("9.0.4"); // false
 * ```
 */
export function isPrerelease(version: string): boolean {
  return version.includes("~");
}

/**
 * Extracts every version of one package from an apt `Packages` index.
 *
 * @remarks
 * Stanzas are separated by blank lines. Only `Key: value` lines are read;
 * continuation lines, which start with a space, are ignored. A stanza of the
 * package that lacks `Version`, `Filename` or `SHA256` is skipped without an
 * error. Pre-releases are kept; {@link listVersions} is what drops them.
 *
 * @param index - Uncompressed text of the index.
 * @param name - Package name, matched exactly against the `Package` field.
 * @returns The package's entries, oldest version first; empty when the index
 *   does not list the package.
 *
 * @example
 * ```ts
 * const index = [
 *   "Package: pve-docs",
 *   "Version: 9.2.14",
 *   "Filename: dists/trixie/pve-docs_9.2.14_all.deb",
 *   "SHA256: 723a92d1",
 * ].join("\n");
 * parsePackagesIndex(index, "pve-docs");
 * // [{
 * //   version: "9.2.14",
 * //   filename: "dists/trixie/pve-docs_9.2.14_all.deb",
 * //   sha256: "723a92d1",
 * // }]
 * ```
 */
export function parsePackagesIndex(index: string, name: string): AptPackage[] {
  const packages: AptPackage[] = [];
  for (const stanza of index.split(/\n\n+/)) {
    const fields = new Map<string, string>();
    for (const line of stanza.split("\n")) {
      const separator = line.indexOf(": ");
      if (separator > 0 && !line.startsWith(" ")) {
        fields.set(line.slice(0, separator), line.slice(separator + 2).trim());
      }
    }
    if (fields.get("Package") !== name) continue;
    const version = fields.get("Version");
    const filename = fields.get("Filename");
    const sha256 = fields.get("SHA256");
    if (version && filename && sha256) {
      packages.push({ version, filename, sha256 });
    }
  }
  return packages.sort((a, b) => compareDebianVersions(a.version, b.version));
}

/**
 * Sends a request to the apt repository, over IPv4 where possible.
 *
 * @remarks
 * GitHub-hosted runners have no IPv6 route, and there `fetch` waits out its
 * whole timeout on the repository's AAAA record instead of falling back to
 * IPv4. The repository is plain HTTP, so the request is addressed to an A
 * record directly, with the original name in the `Host` header. A URL that is
 * not plain HTTP, or a name without an A record, is requested unchanged.
 *
 * @param url - Absolute URL to request.
 * @param options - The HTTP method, `GET` when omitted, and the timeout in
 *   milliseconds, which covers the whole exchange including the body.
 * @returns The response, whatever its status.
 * @throws An {@link Error} if the connection fails or the timeout expires.
 */
async function request(
  url: string,
  options: { method?: string; timeout: number },
): Promise<Response> {
  const target = new URL(url);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (target.protocol === "http:") {
    const [address] = await resolve4(target.hostname).catch(() => []);
    if (address) {
      headers.Host = target.host;
      target.hostname = address;
    }
  }
  return fetch(target, {
    method: options.method,
    headers,
    signal: AbortSignal.timeout(options.timeout),
  });
}

/**
 * Downloads a file from the apt repository, allowing five minutes.
 *
 * @remarks
 * The timeout covers the whole exchange, so reading a slow body can still
 * fail after this function has returned.
 *
 * @param url - Absolute URL to fetch.
 * @returns The response, whose status is in the 2xx range.
 * @throws An {@link Error} if the server answers with any other status.
 * @throws An {@link Error} if the connection fails or the timeout expires.
 */
async function download(url: string): Promise<Response> {
  const response = await request(url, { timeout: 300_000 });
  if (!response.ok)
    throw new Error(`GET ${url} failed with ${response.status}`);
  return response;
}

/**
 * Lists the released versions of a package in the Proxmox apt repository.
 *
 * @remarks
 * Downloads `dists/<suite>/<component>/binary-amd64/Packages.gz` from
 * `download.proxmox.com` over plain HTTP and unpacks it in memory. The index
 * is not signature-checked: the hashes it lists are taken as received and
 * become binding only once they are written to the lock file.
 *
 * @param source - Suite, component and package name to look up.
 * @returns The package's versions without pre-releases, oldest first; empty
 *   when the index does not list the package.
 * @throws An {@link Error} if the server answers with a status outside the
 *   2xx range.
 * @throws An {@link Error} if the connection fails or the download takes
 *   longer than five minutes.
 * @throws An {@link Error} if the response is not valid gzip data.
 */
export async function listVersions(source: AptSource): Promise<AptPackage[]> {
  const url = `${APT_BASE_URL}/dists/${source.suite}/${source.component}/binary-amd64/Packages.gz`;
  const response = await download(url);
  const index = gunzipSync(Buffer.from(await response.arrayBuffer()));
  return parsePackagesIndex(index.toString("utf8"), source.package).filter(
    (entry) => !isPrerelease(entry.version),
  );
}

/**
 * Checks whether a suite has a package index yet, which is how a new Proxmox
 * VE major is noticed.
 *
 * @remarks
 * Sends a `HEAD` request for the suite's `Packages.gz` to
 * `download.proxmox.com`, with a 30-second timeout. Nothing is downloaded.
 *
 * @param source - Suite and component to probe; the package name is not
 *   used.
 * @returns `true` when the server answers with a 2xx status, `false` for any
 *   other status.
 * @throws An {@link Error} if the connection fails or the timeout expires.
 */
export async function suiteExists(source: AptSource): Promise<boolean> {
  const url = `${APT_BASE_URL}/dists/${source.suite}/${source.component}/binary-amd64/Packages.gz`;
  const response = await request(url, { method: "HEAD", timeout: 30_000 });
  return response.ok;
}

/**
 * Locates the `data.tar.*` member of a Debian package.
 *
 * @remarks
 * A `.deb` is an `ar` archive: an 8-byte magic followed by members, each a
 * 60-byte header ahead of its payload, which is padded to an even length.
 * The header starts with the 16-byte member name and holds the payload size
 * as decimal text in bytes 48 to 57.
 *
 * @param deb - The complete package file.
 * @returns The payload of the first member whose name starts with
 *   `data.tar`, still compressed. It is a view on `deb`, not a copy.
 * @throws An {@link Error} if `deb` does not start with the `ar` magic.
 * @throws An {@link Error} if the size in a member header is not a whole
 *   number.
 * @throws An {@link Error} if the archive has no `data.tar` member.
 */
export function findDataArchive(deb: Uint8Array): Uint8Array {
  const decoder = new TextDecoder("latin1");
  if (decoder.decode(deb.subarray(0, 8)) !== "!<arch>\n") {
    throw new Error("not a Debian package: missing ar magic");
  }
  let offset = 8;
  while (offset + 60 <= deb.length) {
    const header = decoder.decode(deb.subarray(offset, offset + 60));
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    const size = Number(header.slice(48, 58).trim());
    if (!Number.isInteger(size)) throw new Error("corrupt ar header");
    const start = offset + 60;
    if (name.startsWith("data.tar")) return deb.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  throw new Error("Debian package has no data.tar member");
}

/**
 * What {@link downloadApidoc} takes out of one `pve-docs` package.
 */
export interface DownloadedSchema {
  /**
   * Content of `apidoc.js`, the API viewer bundle that embeds the schema.
   */
  apidoc: string;
  /**
   * Upload date of the package (`YYYY-MM-DD`, UTC), from the `Last-Modified`
   * header of the download. Absent when the server sends no such header.
   */
  released?: string;
}

/**
 * Downloads one `pve-docs` package, verifies it against the index hash and
 * extracts the API viewer bundle from it.
 *
 * @remarks
 * The `.deb` is fetched from `download.proxmox.com` over plain HTTP, and its
 * SHA-256 is compared with `entry.sha256` before anything is unpacked. The
 * data archive is then written to a new `pve-docs-*` directory under the
 * system's temporary directory, `tar -xOf` is spawned to print the bundle,
 * and the directory is removed again whether or not that succeeds.
 *
 * Decompression is left to the system `tar`: the payload is xz, which neither
 * Node nor Bun can read natively, and GNU tar and bsdtar both detect it. A
 * `tar` that reads xz must therefore be on the `PATH`. The process is started
 * with `Bun.spawn`, so this only runs under Bun.
 *
 * @param entry - The package to fetch: `filename` locates it and `sha256` is
 *   the hash the download must have.
 * @returns The content of `apidoc.js` and, when the server reports one, the
 *   upload date of the package.
 * @throws An {@link Error} if the server answers with a status outside the
 *   2xx range.
 * @throws An {@link Error} if the connection fails or the download takes
 *   longer than five minutes.
 * @throws An {@link Error} if the SHA-256 of the download differs from
 *   `entry.sha256`.
 * @throws An {@link Error} if the download is not a Debian package with a
 *   `data.tar` member; see {@link findDataArchive}.
 * @throws An {@link Error} if `tar` cannot be started, exits with a non-zero
 *   status or prints nothing.
 * @throws A {@link RangeError} if the `Last-Modified` header is not a date.
 */
export async function downloadApidoc(
  entry: AptPackage,
): Promise<DownloadedSchema> {
  const response = await download(`${APT_BASE_URL}/${entry.filename}`);
  const deb = new Uint8Array(await response.arrayBuffer());
  const actual = createHash("sha256").update(deb).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(
      `${entry.filename}: sha256 ${actual} does not match the expected ${entry.sha256}`,
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "pve-docs-"));
  try {
    const archive = join(directory, "data.tar");
    await writeFile(archive, findDataArchive(deb));
    const tar = Bun.spawn(["tar", "-xOf", archive, APIDOC_MEMBER], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [apidoc, stderr, exitCode] = await Promise.all([
      new Response(tar.stdout).text(),
      new Response(tar.stderr).text(),
      tar.exited,
    ]);
    if (exitCode !== 0 || apidoc.length === 0) {
      throw new Error(
        `could not extract ${APIDOC_MEMBER} from ${entry.filename}: ${stderr.trim()}`,
      );
    }
    const modified = response.headers.get("last-modified");
    return {
      apidoc,
      released: modified
        ? new Date(modified).toISOString().slice(0, 10)
        : undefined,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
