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

A segment that collides with something on the proxy can be reached by prefixing
an underscore, which is stripped before the request:

```ts
await proxmox.nodes.$("pve1")._on.$get(); // requests /nodes/pve1/on
```

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

Long-running operations return a UPID string. Poll it for completion:

```ts
const upid = await proxmox.nodes.$("pve1").qemu.$(100).status.start.$post({});
let task = await proxmox.nodes.$("pve1").tasks.$(upid).status.$get();
while (task.status === "running") {
  await new Promise((r) => setTimeout(r, 1000));
  task = await proxmox.nodes.$("pve1").tasks.$(upid).status.$get();
}
if (task.exitstatus !== "OK") throw new Error(task.exitstatus);
```
