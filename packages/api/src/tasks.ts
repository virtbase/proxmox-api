import {
  ProxmoxConfigError,
  ProxmoxError,
  ProxmoxTaskError,
} from "./errors.js";
import type { Proxmox } from "./model.js";

/**
 * Matches a task identifier and captures its fields:
 * `UPID:<node>:<pid>:<pstart>:<starttime>:<type>:<id>:<user>:`.
 *
 * The three numbers are hexadecimal - eight digits each, with a ninth
 * allowed for `pstart` - and `id` may be empty.
 */
const UPID =
  /^UPID:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s]+):([^:\s]*):([^:\s]+):$/;

/**
 * The fields packed into a task identifier, as returned by
 * {@link parseUpid}.
 */
export interface ParsedUpid {
  /**
   * The node the task runs on - the only node that can report its status.
   */
  node: string;
  /**
   * Process id of the task's worker on that node.
   */
  pid: number;
  /**
   * The identifier's `pstart` field as a number: the start time of the
   * worker process in the node's own units. It is not a timestamp; see
   * {@link ParsedUpid.startTime} for that.
   */
  pstart: number;
  /**
   * When the task started. The identifier records it in whole seconds.
   */
  startTime: Date;
  /**
   * What the task does, e.g. `qmstart` or `vzdump`.
   */
  type: string;
  /**
   * What it acts on, usually a guest id. Empty for node-wide tasks.
   */
  id: string;
  /**
   * Who started it: `user@realm`, or `user@realm!token`.
   */
  user: string;
}

/**
 * Splits a UPID, the identifier Proxmox gives a background task, into its
 * fields.
 *
 * @param upid - The identifier, exactly as Proxmox returned it.
 * @returns The fields of the identifier, with its hexadecimal numbers
 *   decoded.
 * @throws A {@link ProxmoxConfigError} if the string is not a UPID.
 * @example
 * ```ts
 * parseUpid("UPID:pve1:0001E240:0A1B2C3D:6553F100:qmstart:100:root@pam:");
 * // { node: "pve1", pid: 123456, type: "qmstart", id: "100",
 * //   user: "root@pam", startTime: 2023-11-14T22:13:20.000Z,
 * //   pstart: 169552957 }
 * ```
 */
export function parseUpid(upid: string): ParsedUpid {
  const match = UPID.exec(upid);
  if (!match) {
    throw new ProxmoxConfigError(
      `Not a task identifier: ${JSON.stringify(upid)}`,
    );
  }
  const [
    ,
    node = "",
    pid = "",
    pstart = "",
    start = "",
    type = "",
    id = "",
    user = "",
  ] = match;
  return {
    node,
    pid: Number.parseInt(pid, 16),
    pstart: Number.parseInt(pstart, 16),
    startTime: new Date(Number.parseInt(start, 16) * 1000),
    type,
    id,
    user,
  };
}

/**
 * Controls how {@link waitForTask} polls and when it gives up.
 */
export interface WaitForTaskOptions {
  /**
   * Milliseconds between the answer to one status check and the start of
   * the next.
   *
   * @defaultValue `1000`
   */
  interval?: number;
  /**
   * Milliseconds to wait before giving up. Without it there is no limit.
   *
   * The limit is looked at after each status check that finds the task
   * running: the wait ends as soon as the next check would fall past it,
   * which can be up to one `interval` early. A status check in flight is
   * not cut short. The task itself keeps running.
   */
  timeout?: number;
  /**
   * Stops waiting. The task itself keeps running. The signal is also passed
   * to each status check, so it cancels one that is in flight.
   */
  signal?: AbortSignal;
  /**
   * Treat a task that finished with `WARNINGS: <n>` as failed. By default it
   * counts as success, which is how Proxmox's own tools read it.
   *
   * @defaultValue `false`
   */
  failOnWarnings?: boolean;
}

/**
 * The state of a task as its status endpoint returns it.
 * {@link waitForTask} resolves with the final one.
 */
export type TaskStatus = Proxmox.NodesTasksStatusReadTaskStatus;

/**
 * Builds the error for a wait that the caller's signal ended.
 *
 * @param upid - Identifier of the task that was being waited for.
 * @param signal - The aborted signal, whose `reason` becomes the `cause`.
 * @returns A plain {@link ProxmoxError} with the code `aborted`.
 */
function stopped(upid: string, signal: AbortSignal): ProxmoxError {
  return new ProxmoxError("aborted", `Stopped waiting for task ${upid}`, {
    cause: signal.reason,
  });
}

/**
 * Waits between two status checks, ending early when the signal aborts.
 *
 * @remarks
 * Never rejects: the caller checks the signal afterwards.
 *
 * @param ms - Milliseconds to wait.
 * @param signal - Ends the wait when it aborts. An abort that happened
 *   before the call goes unnoticed and the full time is waited.
 */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Waits for a background task to finish and settles with its outcome.
 *
 * @remarks
 * Most calls that change something return a UPID straight away and do the
 * work afterwards, so a resolved request says nothing about the outcome.
 * This polls the task's status on the node that runs it: the first check is
 * made at once, each further one `interval` milliseconds after the previous
 * answer. It settles with the task: the final status on success, a
 * {@link ProxmoxTaskError} carrying Proxmox's exit status on failure.
 *
 * Waiting has no effect on the task. When the wait ends early - by timeout,
 * signal or a failed status check - the task keeps running.
 *
 * @param proxmox - Client to send the status checks through.
 * @param upid - Identifier of the task, as returned by the call that started
 *   it.
 * @param options - How often to check, how long to wait and whether
 *   warnings count as failure.
 * @returns The final status of a task that succeeded: one whose
 *   `exitstatus` is `OK` or, unless `failOnWarnings` is set, starts with
 *   `WARNINGS`.
 * @throws A {@link ProxmoxTaskError} if the task stopped with any other exit
 *   status, or with none, which is reported as `unknown`.
 * @throws A {@link ProxmoxConfigError} if `upid` is not a task identifier.
 * @throws A {@link ProxmoxError} with the code `timeout` if the task is
 *   still running when `timeout` runs out, and with the code `aborted` if
 *   `signal` aborts between two status checks. A status check that fails
 *   ends the wait with the error of that request, which is a
 *   {@link ProxmoxAbortError} when `signal` aborts it in flight.
 * @example
 * ```ts
 * const upid = await proxmox.nodes.$("pve1").qemu.$(100).status.start.$post();
 * await waitForTask(proxmox, upid);
 * ```
 */
export async function waitForTask(
  proxmox: Proxmox.Api,
  upid: string,
  options: WaitForTaskOptions = {},
): Promise<TaskStatus> {
  const { interval = 1000, timeout, signal, failOnWarnings = false } = options;
  const { node } = parseUpid(upid);
  const status = proxmox.nodes.$(node).tasks.$(upid).status;
  const deadline = timeout === undefined ? undefined : Date.now() + timeout;

  for (;;) {
    if (signal?.aborted) throw stopped(upid, signal);
    const task = await status.$get(null, { signal });
    if (task.status === "stopped") {
      const exitstatus = task.exitstatus ?? "unknown";
      const warned = exitstatus.startsWith("WARNINGS");
      if (exitstatus === "OK" || (warned && !failOnWarnings)) return task;
      throw new ProxmoxTaskError(upid, exitstatus);
    }
    if (deadline !== undefined && Date.now() + interval > deadline) {
      throw new ProxmoxError(
        "timeout",
        `Task ${upid} was still running after ${timeout} ms`,
      );
    }
    await pause(interval, signal);
  }
}
