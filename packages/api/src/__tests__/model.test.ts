import { describe, expect, test } from "bun:test";
import { proxmoxApi } from "../client.js";
import type { Proxmox } from "../model.js";
import {
  PVE_OPERATION_COUNT,
  PVE_SCHEMA_VERSION,
  PVE_VERSION,
} from "../schema-info.js";
import { RecordingEngine } from "./helpers.js";

/**
 * Mostly compile-time: `bun run typecheck` fails if the generated model stops
 * accepting these calls, or starts accepting the ones marked as errors.
 */
describe("generated model", () => {
  const engine = new RecordingEngine();
  const proxmox = proxmoxApi(engine);
  const vm = proxmox.nodes.$("pve1").qemu.$(100);

  test("typed calls reach the transport with their path and options", async () => {
    const controller = new AbortController();
    await vm.config.$put({ memory: "4096", onboot: true, scsi30: "local:8" });
    await proxmox.version.$get(null, { signal: controller.signal });

    expect(engine.calls[0]).toMatchObject({
      method: "put",
      path: "/api2/json/nodes/pve1/qemu/100/config",
      pathTemplate: "/api2/json/nodes/*/qemu/*/config",
    });
    expect(engine.last.options?.signal).toBe(controller.signal);
  });

  test("rejects what Proxmox would reject", () => {
    const invalid = async () => {
      // @ts-expect-error scsi stops at 30
      await vm.config.$put({ scsi31: "local:8" });
      // @ts-expect-error vmid is a number
      await proxmox.nodes.$("pve1").qemu.$("100").config.$get();
      // @ts-expect-error `node` is required
      await proxmox.cluster.replication.$post({ id: "100-0", type: "local" });
      // @ts-expect-error not a value of the enumeration
      await vm.status.current.$get().then((s) => s.status === "paused");
    };
    expect(invalid).toBeFunction();
  });

  test("returned booleans admit the 0/1 Proxmox actually sends", () => {
    const config: Pick<Proxmox.NodesQemuConfigVmConfig, "onboot"> = {
      onboot: 1,
    };
    expect(config.onboot).toBe(1);
  });

  test("the model is types only and compiles to no code", async () => {
    const source = await Bun.file(
      new URL("../model.ts", import.meta.url),
    ).text();
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    expect(js.replace(/\s|export\{\};?/g, "")).toBe("");
  });

  test("the schema version constants agree with each other", () => {
    expect(PVE_SCHEMA_VERSION.startsWith(`${PVE_VERSION}.`)).toBe(true);
    expect(PVE_OPERATION_COUNT).toBeGreaterThan(600);
  });
});
