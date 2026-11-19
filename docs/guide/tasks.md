---
description: "Wait for Proxmox VE background tasks to finish, read their logs and inspect a UPID with @virtbase/proxmox-api."
---

# Tasks

Most calls that change something — starting a guest, taking a backup, cloning,
migrating — do not do the work before they answer. Proxmox starts a background
task and returns its identifier, a UPID:

```ts
const upid = await proxmox.nodes.$("pve1").qemu.$(100).status.start.$post();
// "UPID:pve1:0001E240:0A1B2C3D:6553F100:qmstart:100:root@pam:"
```

A resolved call therefore only means the task was *accepted*. Whether the guest
actually started is the task's outcome.

## Waiting for a task

```ts
import { waitForTask } from "@virtbase/proxmox-api";

const upid = await proxmox.nodes.$("pve1").qemu.$(100).status.start.$post();
await waitForTask(proxmox, upid);
```

`waitForTask` polls the task on the node that runs it and settles with its
outcome: it resolves with the final status when the task succeeds, and throws a
[`ProxmoxTaskError`](./errors#error-classes) carrying Proxmox's exit status when
it fails.

```ts
import { ProxmoxTaskError, waitForTask } from "@virtbase/proxmox-api";

try {
  await waitForTask(proxmox, upid, { timeout: 120_000 });
} catch (error) {
  if (error instanceof ProxmoxTaskError) {
    console.error(error.exitstatus); // "unable to start VM 100: ..."
  }
  throw error;
}
```

| Option | Default | |
| --- | --- | --- |
| `interval` | `1000` | Milliseconds between status checks. |
| `timeout` | none | Milliseconds to wait before giving up with a `ProxmoxError` whose `code` is `"timeout"`. The task keeps running. |
| `signal` | — | An `AbortSignal` that stops the waiting with a `ProxmoxError` whose `code` is `"aborted"`. The task keeps running. |
| `failOnWarnings` | `false` | Treat `WARNINGS: <n>` as a failure. By default it counts as success, as it does in Proxmox's own tools. |

To stop the task itself, call
`proxmox.nodes.$(node).tasks.$(upid).$delete()`.

## Reading the log

```ts
import { parseUpid } from "@virtbase/proxmox-api";

const { node } = parseUpid(upid);
const lines = await proxmox.nodes.$(node).tasks.$(upid).log.$get({ limit: 100 });
for (const line of lines) console.log(line.t);
```

## Inspecting a UPID

A task's status can only be read from the node it runs on, and that node is
part of the identifier:

```ts
import { parseUpid } from "@virtbase/proxmox-api";

parseUpid("UPID:pve1:0001E240:0A1B2C3D:6553F100:qmstart:100:root@pam:");
// { node: "pve1", pid: 123456, type: "qmstart", id: "100",
//   user: "root@pam", startTime: 2023-11-14T22:13:20.000Z, pstart: 169552957 }
```
