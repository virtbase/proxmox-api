import { describe, expect, test } from "bun:test";
import { diffOperations } from "../diff.js";
import { emitModel, emitSchemaInfo, exportedTypeNames } from "../emit.js";
import { emitChangelog } from "../emit-changelog.js";
import { extractSchemaLiteral, parseSchema } from "../load-schema.js";
import { collectOperations } from "../operations.js";
import type { PveCall, PveNode, PveSchema } from "../schema.js";
import { fixture } from "./fixture.js";

/**
 * Schema version and hash handed to the emitters in every test.
 */
const META = { version: "9.2.14", sha256: "abc" };

/**
 * Looks up the call definition of one operation in a schema tree.
 *
 * @param nodes - The tree to search.
 * @param id - Identity of the operation, for example `GET /nodes`.
 * @returns The call object of the tree itself, so mutating it changes
 *   `nodes`.
 * @throws An {@link Error} if the tree has no such operation.
 */
function callAt(nodes: PveNode[], id: string): PveCall {
  const operation = collectOperations(nodes).find((op) => op.id === id);
  if (!operation) throw new Error(`no operation ${id}`);
  return operation.call;
}

/**
 * Returns the parameter definitions of one operation, for a test to mutate
 * in place.
 *
 * @param nodes - The tree to search.
 * @param id - Identity of the operation, for example `GET /nodes`.
 * @returns The `properties` object of the operation's parameters.
 * @throws An {@link Error} if the tree has no such operation or the operation
 *   declares no parameters.
 */
function parametersOf(nodes: PveNode[], id: string): Record<string, PveSchema> {
  const properties = callAt(nodes, id).parameters?.properties;
  if (!properties) throw new Error(`${id} has no parameters`);
  return properties;
}

/**
 * Returns the property definitions of the array elements one operation
 * returns, for a test to mutate in place.
 *
 * @param nodes - The tree to search.
 * @param id - Identity of the operation, for example `GET /nodes`.
 * @returns The `properties` object of the returned array's element schema.
 * @throws An {@link Error} if the tree has no such operation or the operation
 *   does not return an array of objects.
 */
function itemsOf(nodes: PveNode[], id: string): Record<string, PveSchema> {
  const properties = callAt(nodes, id).returns?.items?.properties;
  if (!properties) throw new Error(`${id} returns no items`);
  return properties;
}

/**
 * Identity of the fixture's operation that creates a VM, the one most tests
 * mutate.
 */
const CREATE = "POST /nodes/{node}/qemu";

/**
 * Diffs the untouched fixture against a mutated copy of it.
 *
 * @param mutate - Applies the change under test, in place, to a fresh fixture
 *   tree that plays the newer version.
 * @returns The diff from the untouched fixture to the mutated one.
 */
function diff(mutate: (nodes: PveNode[]) => void) {
  const after = fixture();
  mutate(after);
  return diffOperations(collectOperations(fixture()), collectOperations(after));
}

describe("extractSchemaLiteral", () => {
  test("slices the array out of the viewer bundle", () => {
    const bundle =
      'const apiSchema = [{"a":"] } \\" ["}]\n;\nExt.onReady(function(){ var x = [1]; });';
    expect(extractSchemaLiteral(bundle)).toBe('[{"a":"] } \\" ["}]');
  });

  test("fails loudly when the bundle changes shape", () => {
    expect(() => parseSchema("var somethingElse = 1;")).toThrow("apiSchema");
    expect(() => parseSchema("const apiSchema = [];")).toThrow("empty");
  });
});

describe("collectOperations", () => {
  const operations = collectOperations(fixture());

  test("names operations after their path and handler", () => {
    expect(operations.map((op) => `${op.id} -> ${op.name}`)).toEqual([
      "GET /nodes -> NodesIndex",
      "GET /nodes/{node} -> NodesNodeIndex",
      "POST /nodes/{node}/qemu -> NodesQemuCreateVm",
      "GET /nodes/{node}/qemu/{vmid} -> NodesQemuVmConfig",
    ]);
  });

  test("records the placeholders in scope", () => {
    expect(operations.at(-1)?.pathVariables).toEqual(["node", "vmid"]);
  });
});

describe("emitModel", () => {
  const nodes = fixture();
  const { code, unboundedPrefixes } = emitModel(
    nodes,
    collectOperations(nodes),
    META,
  );

  test("records where the model came from", () => {
    expect(code).toContain("// Source: pve-docs 9.2.14 (Proxmox VE 9.2)");
    expect(code).toContain("// Covers 4 operations.");
  });

  test("turns paths into the nested call tree", () => {
    expect(code).toContain("$(node: string): {");
    expect(code).toContain("$(vmid: number): {");
    expect(code).toContain(
      "$post(param: NodesQemuCreateVmParams, options?: RequestOptions): Promise<string>;",
    );
    expect(code).toContain(
      "$get(param?: NoParams, options?: RequestOptions): Promise<NodesQemuVmConfig>;",
    );
  });

  test("leaves path placeholders out of the parameter type", () => {
    const params = code.slice(
      code.indexOf("export interface NodesQemuCreateVmParams"),
    );
    expect(params.slice(0, params.indexOf("\n  }"))).not.toContain("node:");
  });

  test("expands indexed properties to the slots PVE accepts", () => {
    expect(code).toContain('extends Indexed<"net", Index31, Net> {');
    expect(code).toContain("export type Net = string;");
    expect(unboundedPrefixes).toEqual([]);
  });

  test("an enumeration with one value set gets the property's name", () => {
    expect(code).toContain('export type Ostype = "l26" | "win11";');
    expect(code).toContain("ostype?: Ostype;");
  });

  test("an ambiguous enumeration is written out where it is used", () => {
    expect(code).toContain('status: "online" | "offline";');
    expect(code).toContain('status?: "running" | "stopped";');
    expect(code).not.toContain("export type Status");
  });

  test("booleans are strict going in and 0/1-tolerant coming out", () => {
    const params = code.slice(
      code.indexOf("export interface NodesQemuCreateVmParams"),
    );
    expect(params.slice(0, params.indexOf("\n  }"))).toContain(
      "onboot?: boolean;",
    );
    const config = code.slice(
      code.indexOf("export interface NodesQemuVmConfig"),
    );
    expect(config.slice(0, config.indexOf("\n  }"))).toContain(
      "onboot?: boolean | 0 | 1;",
    );
  });

  test("documents permissions and token restrictions in plain words", () => {
    expect(code).toContain("Permissions: VM.Allocate on /vms/{vmid}");
    expect(code).toContain("Permissions: any authenticated user");
    expect(code).toContain("Not callable with an API token.");
  });

  test("is deterministic", () => {
    const again = fixture();
    expect(emitModel(again, collectOperations(again), META).code).toBe(code);
  });

  test("reports an indexed property with no known bound", () => {
    const custom = fixture();
    const params = callAt(custom, "POST /nodes/{node}/qemu").parameters;
    if (params?.properties)
      params.properties["warp[n]"] = { type: "string", optional: 1 };
    const result = emitModel(custom, collectOperations(custom), META);
    expect(result.unboundedPrefixes).toEqual(["warp"]);
    expect(result.code).toContain("[key: `warp$".concat("{number}`]: string;"));
  });
});

describe("emitModel on hostile or unusual input", () => {
  test("a oneOf property is optional when its variants are", () => {
    const nodes = fixture();
    parametersOf(nodes, CREATE).redistribute = {
      oneOf: [
        { type: "array", items: { type: "string" }, optional: 1 },
        { type: "string", optional: 1 },
      ],
    };
    const { code } = emitModel(nodes, collectOperations(nodes), META);
    expect(code).toContain("redistribute?: string[] | string;");
  });

  test("nothing from the schema reaches the output as code", () => {
    const nodes = fixture();
    const hostile = '"; export const pwned = 1; //';
    const create = callAt(nodes, CREATE);
    create.name = `create_vm${hostile}`;
    create.description = "*/ export const pwned = 2; /*";
    parametersOf(nodes, CREATE)[`x${hostile}[n]`] = {
      type: "string",
      optional: 1,
    };
    parametersOf(nodes, CREATE).mode = { enum: [hostile], optional: 1 };
    parametersOf(nodes, CREATE).cidr = {
      type: "string",
      format: hostile,
      optional: 1,
    };
    nodes.push({
      path: `/x/{id${hostile}}`,
      text: `{id${hostile}}`,
      leaf: 1,
      info: { GET: { method: "GET", name: "read" } },
    });

    const { code } = emitModel(nodes, collectOperations(nodes), META);
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(code);
    expect(js.replace(/\s|export\{\};?/g, "")).toBe("");
  });

  test("exportedTypeNames lists what a consumer can import", () => {
    const nodes = fixture();
    const { code } = emitModel(nodes, collectOperations(nodes), META);
    expect([...exportedTypeNames(code)]).toEqual(
      expect.arrayContaining([
        "Api",
        "NodesQemuCreateVmParams",
        "Ostype",
        "Net",
      ]),
    );
  });
});

test("emitSchemaInfo exports the version constants", () => {
  const info = emitSchemaInfo(META, 4);
  expect(info).toContain('export const PVE_VERSION = "9.2";');
  expect(info).toContain('export const PVE_SCHEMA_VERSION = "9.2.14";');
  expect(info).toContain("export const PVE_OPERATION_COUNT = 4;");
});

describe("diffOperations", () => {
  test("identical schemas produce no change", () => {
    expect(diff(() => {}).level).toBe("none");
  });

  test("a description change is a patch", () => {
    const result = diff((nodes) => {
      callAt(nodes, "GET /nodes").description = "Reworded.";
    });
    expect(result.level).toBe("patch");
    expect(result.summary.documentation).toBe(1);
    expect(result.changes).toEqual([]);
  });

  test("a new operation and a new optional parameter are minor", () => {
    const result = diff((nodes) => {
      nodes.push({
        path: "/version",
        text: "version",
        leaf: 1,
        info: { GET: { method: "GET", name: "version" } },
      });
      const params = callAt(nodes, "POST /nodes/{node}/qemu").parameters;
      if (params?.properties)
        params.properties.tags = { type: "string", optional: 1 };
    });
    expect(result.level).toBe("minor");
    expect(result.summary).toMatchObject({ added: 1, changed: 1, breaking: 0 });
  });

  test.each([
    [
      "removing an operation",
      (nodes: PveNode[]) => {
        nodes.splice(0, 1, { ...nodes[0], children: [] } as PveNode);
      },
      "removed",
    ],
    [
      "removing a parameter",
      (nodes: PveNode[]) => {
        Reflect.deleteProperty(parametersOf(nodes, CREATE), "ostype");
      },
      "parameter `ostype` removed",
    ],
    [
      "adding a required parameter",
      (nodes: PveNode[]) => {
        parametersOf(nodes, CREATE).name = { type: "string" };
      },
      "parameter `name` added (required)",
    ],
    [
      "narrowing an enumeration parameter",
      (nodes: PveNode[]) => {
        parametersOf(nodes, CREATE).ostype = { enum: ["l26"], optional: 1 };
      },
      "parameter `ostype` no longer accepts `win11`",
    ],
    [
      "removing a returned property",
      (nodes: PveNode[]) => {
        Reflect.deleteProperty(itemsOf(nodes, "GET /nodes"), "status");
      },
      "returned `[].status` removed",
    ],
    [
      "changing a return type",
      (nodes: PveNode[]) => {
        callAt(nodes, CREATE).returns = { type: "integer" };
      },
      "return value changed from string to number",
    ],
    [
      "closing a parameter object that accepted unlisted keys",
      (nodes: PveNode[]) => {
        const call = callAt(nodes, "GET /nodes");
        call.parameters = { properties: {} };
      },
      "unlisted parameters are no longer accepted",
    ],
    [
      "withdrawing API token access",
      (nodes: PveNode[]) => {
        callAt(nodes, "GET /nodes").allowtoken = 0;
      },
      "no longer callable with an API token",
    ],
  ])("%s is major", (_, mutate, expected) => {
    const result = diff(mutate);
    expect(result.level).toBe("major");
    const texts = result.changes.flatMap((change) => [
      change.change,
      ...(change.details ?? []).filter((d) => d.breaking).map((d) => d.text),
    ]);
    expect(texts).toContain(expected);
  });

  test("widening is not breaking", () => {
    const result = diff((nodes) => {
      parametersOf(nodes, CREATE).ostype = {
        enum: ["l26", "win11", "other"],
        optional: 1,
      };
      itemsOf(nodes, "GET /nodes").cpu = { type: "number" };
    });
    expect(result.level).toBe("minor");
  });
});

test("emitChangelog groups versions by Proxmox VE release, newest first", () => {
  const base = { schemaSha256: "x", operations: 4, ...diff(() => {}) };
  const pages = emitChangelog([
    { ...base, version: "9.1.5" },
    { ...base, version: "9.2.9", previous: "9.1.5", released: "2026-08-01" },
    { ...base, version: "9.2.14", previous: "9.2.9" },
  ]);
  expect(pages.map((page) => page.slug)).toEqual([
    "index",
    "pve-9.2",
    "pve-9.1",
  ]);
  const page = pages[1]?.markdown ?? "";
  expect(page.indexOf("## 9.2.14")).toBeLessThan(page.indexOf("## 9.2.9"));
  expect(pages[0]?.markdown).toContain(
    "[9.2.9](./pve-9.2#_9-2-9) | 2026-08-01",
  );
});
