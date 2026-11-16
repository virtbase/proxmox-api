import { describe, expect, test } from "bun:test";
import { proxmoxApi } from "../client.js";
import {
  ProxmoxConfigError,
  ProxmoxError,
  ProxmoxTaskError,
} from "../errors.js";
import { parseUpid, waitForTask } from "../tasks.js";
import { RecordingEngine } from "./helpers.js";

const UPID = "UPID:pve1:0001E240:0A1B2C3D:6553F100:qmstart:100:root@pam:";
const running = { status: "running", upid: UPID };
/**
 * Builds the status reply of a task that has finished.
 *
 * @param exitstatus - The exit status to report, e.g. `OK`.
 * @returns A status in the shape of the task status endpoint's reply.
 */
const stopped = (exitstatus: string) => ({
  status: "stopped",
  exitstatus,
  upid: UPID,
});

describe("parseUpid", () => {
  test("splits a UPID into its fields", () => {
    expect(parseUpid(UPID)).toEqual({
      node: "pve1",
      pid: 0x1e240,
      pstart: 0x0a1b2c3d,
      startTime: new Date(0x6553f100 * 1000),
      type: "qmstart",
      id: "100",
      user: "root@pam",
    });
  });

  test("accepts an empty id and a token user", () => {
    const upid = "UPID:pve1:0001E240:0A1B2C3D:6553F100:aptupdate::root@pam!ci:";
    expect(parseUpid(upid)).toMatchObject({ id: "", user: "root@pam!ci" });
  });

  test("rejects anything else", () => {
    expect(() => parseUpid("not-a-upid")).toThrow(ProxmoxConfigError);
  });
});

describe("waitForTask", () => {
  test("polls the task's own node until it stops", async () => {
    const engine = new RecordingEngine(running, running, stopped("OK"));
    const task = await waitForTask(proxmoxApi(engine), UPID, { interval: 1 });

    expect(task.exitstatus).toBe("OK");
    expect(engine.calls).toHaveLength(3);
    expect(engine.last.path).toBe(`/api2/json/nodes/pve1/tasks/${UPID}/status`);
  });

  test("a failed task throws with Proxmox's exit status", async () => {
    const engine = new RecordingEngine(
      stopped("unable to start VM 100: timeout"),
    );
    const error = await waitForTask(proxmoxApi(engine), UPID).catch((e) => e);

    expect(error).toBeInstanceOf(ProxmoxTaskError);
    expect(error.code).toBe("task");
    expect(error.upid).toBe(UPID);
    expect(error.exitstatus).toBe("unable to start VM 100: timeout");
  });

  test("warnings count as success unless failOnWarnings is set", async () => {
    const api = () => proxmoxApi(new RecordingEngine(stopped("WARNINGS: 2")));
    expect((await waitForTask(api(), UPID)).exitstatus).toBe("WARNINGS: 2");
    expect(
      waitForTask(api(), UPID, { failOnWarnings: true }),
    ).rejects.toBeInstanceOf(ProxmoxTaskError);
  });

  test("gives up after the timeout", async () => {
    const engine = new RecordingEngine(running, running, running, running);
    const error = await waitForTask(proxmoxApi(engine), UPID, {
      interval: 20,
      timeout: 30,
    }).catch((e) => e);
    expect(ProxmoxError.isInstance(error)).toBe(true);
    expect(error.code).toBe("timeout");
  });

  test("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    const engine = new RecordingEngine(running, running);
    const waiting = waitForTask(proxmoxApi(engine), UPID, {
      interval: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("stop")), 10);
    const error = await waiting.catch((e) => e);
    expect(ProxmoxError.isInstance(error)).toBe(true);
    expect(error.code).toBe("aborted");
    expect(error.cause).toEqual(new Error("stop"));
  });
});
