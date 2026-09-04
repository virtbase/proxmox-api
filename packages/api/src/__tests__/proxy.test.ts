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

import { describe, expect, test } from "bun:test";
import type { ApiParamType, ApiRequestable } from "../proxy.js";
import { buildApiProxy } from "../proxy.js";

interface Call {
  method: string;
  path: string;
  template: string;
  params?: ApiParamType;
}

function recorder() {
  const calls: Call[] = [];
  const engine: ApiRequestable = {
    doRequest(method, path, template, params) {
      calls.push({ method, path, template, params });
      return Promise.resolve(null);
    },
  };
  // These tests walk arbitrary paths rather than the generated surface, so
  // the root is deliberately untyped.
  // biome-ignore lint/suspicious/noExplicitAny: untyped root, see above.
  return { calls, api: buildApiProxy<any>(engine, "/api2/json") };
}

describe("path building", () => {
  test("property access becomes path segments", async () => {
    const { calls, api } = recorder();
    await api.cluster.resources.$get();
    expect(calls[0]?.path).toBe("/api2/json/cluster/resources");
    expect(calls[0]?.method).toBe("get");
  });

  test("$() substitutes a path variable", async () => {
    const { calls, api } = recorder();
    await api.nodes.$("pve1").qemu.$(100).config.$get();
    expect(calls[0]?.path).toBe("/api2/json/nodes/pve1/qemu/100/config");
  });

  test("the template keeps substituted values out, for grouping", async () => {
    const { calls, api } = recorder();
    await api.nodes.$("pve1").qemu.$(100).config.$get();
    expect(calls[0]?.template).toBe("/api2/json/nodes/*/qemu/*/config");
  });

  test("each verb maps to its method", async () => {
    const { calls, api } = recorder();
    await api.pools.$get();
    await api.pools.$post();
    await api.pools.$put();
    await api.pools.$delete();
    expect(calls.map((c) => c.method)).toEqual([
      "get",
      "post",
      "put",
      "delete",
    ]);
  });

  test("parameters are handed to the engine untouched", async () => {
    const { calls, api } = recorder();
    await api.nodes.$get({ full: true, tags: ["a", "b"] });
    expect(calls[0]?.params).toEqual({ full: true, tags: ["a", "b"] });
  });

  test("walking the path sends nothing", () => {
    const { calls, api } = recorder();
    const partial = api.nodes.$("pve1").qemu.$(100);
    expect(calls).toHaveLength(0);
    expect(partial).toBeDefined();
  });

  test("a partially walked path can be reused", async () => {
    const { calls, api } = recorder();
    const vm = api.nodes.$("pve1").qemu.$(100);
    await vm.config.$get();
    await vm.status.current.$get();
    expect(calls.map((c) => c.path)).toEqual([
      "/api2/json/nodes/pve1/qemu/100/config",
      "/api2/json/nodes/pve1/qemu/100/status/current",
    ]);
  });
});

describe("segment escaping", () => {
  test("a slash cannot invent a path level", async () => {
    const { calls, api } = recorder();
    await api.storage.$("local/iso").$get();
    expect(calls[0]?.path).toBe("/api2/json/storage/local%2Fiso");
  });

  test("a question mark cannot start a query string", async () => {
    const { calls, api } = recorder();
    await api.storage.$("we?rd").$get();
    expect(calls[0]?.path).toBe("/api2/json/storage/we%3Frd");
  });

  test("a hash cannot truncate the path", async () => {
    const { calls, api } = recorder();
    await api.storage.$("we#rd").$get();
    expect(calls[0]?.path).toBe("/api2/json/storage/we%23rd");
  });

  test("colons survive, because UPIDs are full of them", async () => {
    const { calls, api } = recorder();
    await api.nodes.$("pve1").tasks.$("UPID:pve1:001:qmstart:").status.$get();
    expect(calls[0]?.path).toBe(
      "/api2/json/nodes/pve1/tasks/UPID:pve1:001:qmstart:/status",
    );
  });

  test("numbers are accepted as ids", async () => {
    const { calls, api } = recorder();
    await api.nodes.$("pve1").qemu.$(100).$get();
    expect(calls[0]?.path).toBe("/api2/json/nodes/pve1/qemu/100");
  });
});

describe("reserved names", () => {
  test("toString describes the node instead of extending the path", () => {
    const { api } = recorder();
    expect(String(api.nodes)).toBe("ProxyApi{path:/api2/json/nodes}");
  });

  test("EventEmitter probes on the root do not mint segments", () => {
    const { api } = recorder();
    expect(api.on).toBeUndefined();
    expect(api.emit).toBeUndefined();
  });

  test("those names stay usable deeper down", async () => {
    const { calls, api } = recorder();
    await api.cluster.on.$get();
    expect(calls[0]?.path).toBe("/api2/json/cluster/on");
  });

  test("a leading underscore escapes a reserved name at the root", async () => {
    const { calls, api } = recorder();
    await api._on.$get();
    expect(calls[0]?.path).toBe("/api2/json/on");
  });

  test("symbols do not become segments", () => {
    const { api } = recorder();
    expect(api[Symbol.toStringTag]).toBeUndefined();
  });
});

describe("awkward segment names", () => {
  test("hyphenated segments work through bracket access", async () => {
    const { calls, api } = recorder();
    await api.nodes.$("pve1").qemu.$(100).agent["get-fsinfo"].$get();
    expect(calls[0]?.path).toBe(
      "/api2/json/nodes/pve1/qemu/100/agent/get-fsinfo",
    );
  });

  test("the engine is reachable through a custom implementation", async () => {
    const seen: string[] = [];
    const api = buildApiProxy<Record<string, never>>(
      {
        doRequest(_method, path) {
          seen.push(path);
          return Promise.resolve("ok");
        },
      },
      "/custom",
      // biome-ignore lint/suspicious/noExplicitAny: as above.
    ) as any;
    expect(await api.thing.$get()).toBe("ok");
    expect(seen).toEqual(["/custom/thing"]);
  });
});
