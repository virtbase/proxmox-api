# Upgrading from `proxmox-api`

This package is a fork of [`proxmox-api`](https://github.com/UrielCh/proxmox-api)
v1.1.1, republished as `@virtbase/proxmox-api`. The calling convention is
unchanged; the breaking changes are below.

## Rename

```diff
-import proxmoxApi from "proxmox-api";
+import proxmoxApi from "@virtbase/proxmox-api";
```

## ESM only

The CommonJS build is gone. `require("proxmox-api")` has no equivalent — use
`import`, or a dynamic `await import()` from CommonJS. Output moved from `esm/`
to `dist/`.

## Proxmox VE 9

The model is generated from the PVE 9 schema, up from PVE 8: 678 operations,
98 added and 3 removed.

Removed, so now type errors:

- `GET /nodes/{node}/hardware/pci/{pciid}`
- `GET /nodes/{node}/hardware/pci/{pciid}/mdev`
- `GET /nodes/{node}/scan/glusterfs`

Added, among others: SDN fabrics, HA rules, `cluster/bulk-action`,
`cluster/qemu` custom CPU models, SDN prefix-lists and route-maps, webhook
notification endpoints and `cluster/metrics/export`.

## Responses are properly typed

Upstream added `[key: string]: any` to every returned object regardless of what
the schema said, which meant any property access on any response compiled. That
index signature is now emitted only where Proxmox actually permits extra keys.

Code that read undeclared properties will start failing to compile. That is the
point — but if you are reading something real that the schema omits, cast at the
call site and please report it upstream to Proxmox.

## Indexed parameters go up to the real limit

Upstream generated `net0`–`net3`, `scsi0`–`scsi3` and so on regardless of the
actual limits, so valid configurations were rejected. The full ranges are now
typed — `scsi` to 30, `net` to 31, `mp` to 255. See
[Calling the API](./calling-the-api#indexed-parameters).

Nothing that compiled before breaks here; more compiles now.

## `undici` is gone

The client uses the platform `fetch`. If you passed a custom `fetch` typed
against undici's `RequestInit` and `Response`, switch to the global types.

If you relied on undici being installed as a transitive dependency — for an
`Agent`, say — depend on it directly. See [Custom fetch](./custom-fetch).
