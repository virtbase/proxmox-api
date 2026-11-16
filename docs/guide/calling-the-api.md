# Calling the API

Take the path from Proxmox's documentation and read it as property access.

| In the path | In code |
| --- | --- |
| `/` | `.` |
| `{placeholder}` | `.$(value)` |
| the HTTP method | `.$get()`, `.$post()`, `.$put()`, `.$delete()` |

So `GET /nodes/{node}/qemu/{vmid}/config` is:

```ts
await proxmox.nodes.$("pve1").qemu.$(100).config.$get();
```

Nothing is fetched while you walk the path — each step returns a proxy. The
request happens when you call the `$`-prefixed method at the end.

## Path segments that are not identifiers

Many Proxmox paths contain hyphens. Use bracket access:

```ts
await proxmox.nodes.$("pve1").qemu.$(100).agent["get-fsinfo"].$get();
await proxmox.cluster.qemu["custom-cpu-models"].$get();
```

Placeholder values are escaped for you, so an id containing `/`, `?`, `#` or
`%` cannot change which endpoint is called. The values `.`, `..` and the empty
string can never be a path segment and throw a `ProxmoxConfigError`, which
makes it safe to pass ids that come from user input.

## Parameters

Query parameters and body parameters are written the same way; the client puts
them where the method requires — query string for `GET` and `DELETE`, form
encoded body for `POST` and `PUT`.

```ts
await proxmox.nodes.$("pve1").qemu.$get({ full: true });
await proxmox.nodes.$("pve1").qemu.$(100).config.$put({ memory: 4096 });
```

Three conversions happen on the way out:

- `true` becomes `1` and `false` becomes `0`, which is what PVE expects.
- Arrays are sent as the key repeated once per element —
  `{ command: ["touch", "/tmp/x"] }` becomes `command=touch&command=%2Ftmp%2Fx`.
- `null` and `undefined` are dropped rather than sent as empty strings.

## Indexed parameters

Disks, network interfaces and mount points are numbered, and each has a real
limit that the types enforce:

```ts
await proxmox.nodes.$("pve1").qemu.$post({
  vmid: 101,
  scsi0: "local-lvm:32",
  scsi30: "local-lvm:8", // the last SCSI slot
  net0: "virtio,bridge=vmbr0",
});
```

| Prefix | Slots | Prefix | Slots |
| --- | --- | --- | --- |
| `ide` | 0–3 | `net`, `ipconfig` | 0–31 |
| `sata` | 0–5 | `hostpci` | 0–15 |
| `scsi` | 0–30 | `usb` | 0–13 |
| `virtio` | 0–15 | `numa` | 0–7 |
| `serial` | 0–3 | `virtiofs` | 0–9 |
| `parallel` | 0–2 | `link` | 0–7 |
| `mp`, `dev`, `unused` | 0–255 | `acmedomain` | 0–5 |

`scsi31` is a type error, because Proxmox would reject it.

## Property strings

Several parameters pack multiple fields into one string, `key=value` separated
by commas:

```ts
scsi0: "local-lvm:32,cache=writeback,discard=on,ssd=1"
```

These stay typed as `string` — their fields are listed as `@propertyString` in
the type's documentation, and in the parameter notes in the
[endpoint reference](/reference/endpoints/).

## Return values

The client unwraps Proxmox's `{ data }` envelope and gives you the payload.
Responses are typed from the schema:

```ts
const status = await proxmox.nodes.$("pve1").qemu.$(100).status.current.$get();
//    ^? { status: "stopped" | "running"; vmid: number; ... }
```

::: tip Booleans come back as `0` and `1`
Most of Proxmox answers a boolean field with the number `1` or `0`, and newer
endpoints with a real `true` or `false`. Returned booleans are therefore typed
`boolean | 0 | 1`. Test them for truthiness — `if (config.onboot)` — rather
than comparing against `true`.
:::

Calls that start background work return a UPID string rather than the result.
See [Tasks](./tasks) for how to wait for one.

## Per-request options

Every method takes a second argument with options for that one request:

```ts
const controller = new AbortController();

await proxmox.nodes.$("pve1").qemu.$get(
  { full: true },
  { signal: controller.signal, timeout: 5_000 },
);

// For an operation without parameters, pass null first.
await proxmox.version.$get(null, { maxRetries: 0 });
```

| Option | |
| --- | --- |
| `signal` | Cancels the request, including while it waits for a login or a retry. Throws a `ProxmoxAbortError`. |
| `timeout` | Milliseconds for this request, overriding `queryTimeout`. A streamed download is only bound by it until the response headers arrive. |
| `maxRetries` | Retries for this request, overriding the client's `maxRetries`. Only `GET` is ever retried. |
| `headers` | Extra headers for this request. |

## Using the generated types

Every parameter object and every response has a named type under the `Proxmox`
namespace, so you can use them in your own signatures:

```ts
import type { Proxmox } from "@virtbase/proxmox-api";

function defaults(): Proxmox.NodesQemuCreateVmParams {
  return { vmid: 101, memory: "2048", net0: "virtio,bridge=vmbr0" };
}

function summarise(vm: Proxmox.NodesQemuVmlist): string {
  return `${vm.vmid} ${vm.name ?? ""} (${vm.status})`;
}
```

Names follow the path and Proxmox's own name for the operation:
`/nodes/{node}/qemu` + `create_vm` is `NodesQemuCreateVm`, its parameters
`NodesQemuCreateVmParams`. Hover a method in your editor to see both.
