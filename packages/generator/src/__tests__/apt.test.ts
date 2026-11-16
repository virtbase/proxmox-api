import { describe, expect, test } from "bun:test";
import {
  compareDebianVersions,
  findDataArchive,
  isPrerelease,
  minorOf,
  parsePackagesIndex,
} from "../apt.js";

describe("compareDebianVersions", () => {
  test.each([
    ["9.2.9", "9.2.14", -1],
    ["9.2.14", "9.2.9", 1],
    ["9.2.14", "9.2.14", 0],
    ["9.0.0~8", "9.0.0", -1],
    ["9.0.0~8", "9.0.0~21", -1],
    ["8.4.2", "9.0.4", -1],
    ["1:1.0", "2.0", 1],
    ["1.0-1", "1.0-2", -1],
  ])("%s vs %s", (a, b, expected) => {
    expect(Math.sign(compareDebianVersions(a, b))).toBe(expected);
  });
});

test("minorOf keeps the Proxmox VE release", () => {
  expect(minorOf("9.2.14")).toBe("9.2");
  expect(minorOf("9.0.0~8")).toBe("9.0");
});

test("isPrerelease spots the ~ suffix", () => {
  expect(isPrerelease("9.0.0~8")).toBe(true);
  expect(isPrerelease("9.0.4")).toBe(false);
});

test("parsePackagesIndex returns one package's versions, oldest first", () => {
  const index = [
    "Package: pve-docs\nVersion: 9.2.14\nFilename: dists/x/pve-docs_9.2.14_all.deb\nSHA256: bb",
    "Package: pve-manager\nVersion: 9.2.28\nFilename: dists/x/pve-manager.deb\nSHA256: cc",
    "Package: pve-docs\nVersion: 9.2.9\nDescription: docs\n more text: here\nFilename: dists/x/pve-docs_9.2.9_all.deb\nSHA256: aa",
  ].join("\n\n");

  expect(parsePackagesIndex(index, "pve-docs")).toEqual([
    {
      version: "9.2.9",
      filename: "dists/x/pve-docs_9.2.9_all.deb",
      sha256: "aa",
    },
    {
      version: "9.2.14",
      filename: "dists/x/pve-docs_9.2.14_all.deb",
      sha256: "bb",
    },
  ]);
});

describe("findDataArchive", () => {
  /**
   * Builds one member of an `ar` archive: its 60-byte header followed by the
   * content, padded to an even length.
   *
   * @param name - Member name, at most 16 characters.
   * @param content - Payload; ASCII only, so that its length is its byte count.
   * @returns The member as text, to be appended to the `ar` magic.
   */
  function member(name: string, content: string): string {
    const header =
      name.padEnd(16) +
      "0".padEnd(12) +
      "0".padEnd(6) +
      "0".padEnd(6) +
      "100644".padEnd(8) +
      String(content.length).padEnd(10) +
      "`\n";
    return header + content + (content.length % 2 ? "\n" : "");
  }

  /**
   * Encodes a string as the bytes `findDataArchive` takes.
   */
  const encode = (text: string) => new TextEncoder().encode(text);

  test("returns the data.tar member, skipping odd-length ones before it", () => {
    const deb = encode(
      `!<arch>\n${member("debian-binary", "2.0")}${member("control.tar.xz", "ctl")}${member("data.tar.xz", "PAYLOAD")}`,
    );
    expect(new TextDecoder().decode(findDataArchive(deb))).toBe("PAYLOAD");
  });

  test("rejects a file that is not an ar archive", () => {
    expect(() => findDataArchive(encode("not a deb"))).toThrow("ar magic");
  });

  test("rejects a package without a data member", () => {
    const deb = encode(`!<arch>\n${member("debian-binary", "2.0")}`);
    expect(() => findDataArchive(deb)).toThrow("no data.tar");
  });
});
