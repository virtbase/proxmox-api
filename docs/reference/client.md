# Client API

The hand-written surface. For the 678 generated endpoints see the
[endpoint reference](/reference/endpoints/).

## `proxmoxApi(options)`

Default export. Returns the typed proxy.

```ts
import proxmoxApi from "@virtbase/proxmox-api";

const proxmox = proxmoxApi({ host: "192.0.2.10", port: 8006, /* … */ });
```

Accepts either connection options or anything implementing
[`ApiRequestable`](#apirequestable) — which is how you pass a pre-built
[`ProxmoxEngine`](#proxmoxengine) or a stub.

All requests are made under `/api2/json`.

### Options

Common to both authentication modes:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `host` | `string` | — | Hostname only. A port here will not work; use `port`. |
| `port` | `number` | *none* | **No default.** Omitted means the scheme's port — 443, not 8006. |
| `schema` | `"https" \| "http"` | `"https"` | |
| `authTimeout` | `number` | `5000` | Milliseconds for the login request. |
| `queryTimeout` | `number` | `60000` | Milliseconds for every other request. |
| `debug` | `"curl" \| "fetch"` | — | Print failing requests. Includes credentials. |
| `fetch` | `FetchInterface` | platform `fetch` | See [Custom fetch](/guide/custom-fetch). |

Token authentication:

| Option | Type | Notes |
| --- | --- | --- |
| `tokenID` | `string` | `USER@REALM!TOKENID`. Validated in the constructor. |
| `tokenSecret` | `string` | Lowercase UUID. Validated in the constructor. |

Password authentication:

| Option | Type | Default |
| --- | --- | --- |
| `username` | `string` | `"root@pam"` |
| `password` | `string` | — |

## `ProxmoxEngine`

Performs the requests. Construct it directly to keep hold of the session.

```ts
import { ProxmoxEngine } from "@virtbase/proxmox-api";

const engine = new ProxmoxEngine({ host: "192.0.2.10", port: 8006, /* … */ });
```

### `engine.getTicket()`

```ts
getTicket(): Promise<{ ticket: string; CSRFPreventionToken: string }>
```

Returns the cached credentials, logging in first if there are none. With token
authentication the ticket is the `PVEAPIToken=…` header value and
`CSRFPreventionToken` is empty.

### `engine.doRequest(method, path, pathTemplate, params?)`

The primitive the proxy calls. `path` has placeholders substituted;
`pathTemplate` keeps them, for logging. Returns the unwrapped `data`.

### `engine.ticket` / `engine.CSRFPreventionToken`

The current credentials, or `undefined`. Writable — assign `undefined` to
`ticket` to force a fresh login.

### `engine.host`

Read-only. `hostname` and, when set, `:port`.

## `ApiRequestable`

```ts
interface ApiRequestable {
  doRequest(
    httpMethod: string,
    path: string,
    pathTemplate: string,
    params?: { [key: string]: any },
  ): Promise<any>;
}
```

Implement it to route requests somewhere else entirely — a queue, a recorded
fixture, a different cluster per tenant — and pass it to `proxmoxApi()`.

## `QmMonitor`

A wrapper over `POST /nodes/{node}/qemu/{vmid}/monitor`, for QEMU monitor
commands with no dedicated endpoint.

```ts
import { QmMonitor } from "@virtbase/proxmox-api";

const monitor = new QmMonitor(proxmox, "pve1", 100);
```

| Member | Returns | Purpose |
| --- | --- | --- |
| `monitor(command)` | `Promise<string>` | Send a raw monitor command. |
| `info(type, ...args)` | `Promise<string>` | `info <type>`, with the valid types typed. |
| `infoUsb()` | `Promise<USBInfo[]>` | USB devices attached to the guest. |
| `infoUsbhost(filters?)` | `Promise<USBHostInfo[]>` | USB devices on the host. |
| `deviceAddById(id, { vendorId, productId })` | `Promise<any>` | Attach by vendor/product. |
| `deviceAddByPort(id, { bus, port })` | `Promise<any>` | Attach by physical port. |
| `deviceDel(id)` | `Promise<string>` | Detach. |
| `vmid` / `node` | `number` / `string` | Read-only. |

::: warning
The monitor is a debugging interface. Commands are passed through unvalidated,
output is unstructured text whose format is not guaranteed across QEMU
versions, and mistakes can destabilise a running guest. Prefer a real endpoint
where one exists.
:::

## Types

`Proxmox` is a namespace of every generated type. `Proxmox.Api` is the shape
`proxmoxApi()` returns:

```ts
import type { Proxmox } from "@virtbase/proxmox-api";

function report(api: Proxmox.Api) { /* … */ }
```

Also exported: `ProxmoxEngineOptions` and its `…OptionsCommon`, `…OptionsPass`
and `…OptionsToken` members, `FetchInterface`, `ApiRequestable`, `USBInfo` and
`USBHostInfo`.
