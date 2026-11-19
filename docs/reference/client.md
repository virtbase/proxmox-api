---
description: "Reference for the hand-written API of @virtbase/proxmox-api: proxmoxApi(), waitForTask(), parseUpid(), the error classes, ProxmoxEngine and QmMonitor."
---

# Client API

The hand-written surface. For the generated endpoints see the
[endpoint reference](/reference/endpoints/).

## `proxmoxApi(options)`

Default export, also available as a named export. Returns the typed proxy.

```ts
import proxmoxApi from "@virtbase/proxmox-api";

const proxmox = proxmoxApi({ host: "192.0.2.10", /* … */ });
```

Accepts either connection options or anything implementing
[`ApiRequestable`](#apirequestable) — which is how you pass a pre-built
[`ProxmoxEngine`](#proxmoxengine) or a stub.

All requests are made under `/api2/json`.

### Options

Common to both authentication modes:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `host` | `string` | — | Bare hostname or IP address. IPv6 addresses are bracketed for you. |
| `port` | `number` | `8006` | |
| `schema` | `"https" \| "http"` | `"https"` | |
| `authTimeout` | `number` | `10000` | Milliseconds for a login request. |
| `queryTimeout` | `number` | `60000` | Milliseconds for every other request. |
| `maxRetries` | `number` | `2` | Retries for a failed `GET`. See [Retries](/guide/errors#retries). |
| `headers` | `Record<string, string>` | — | Extra headers for every request. |
| `fetch` | `FetchInterface` | platform `fetch` | See [Custom fetch](/guide/custom-fetch). |
| `onEvent` | `(event: ProxmoxRequestEvent) => void` | — | See [Observing requests](/guide/errors#observing-requests). |

Token authentication:

| Option | Type | Notes |
| --- | --- | --- |
| `tokenID` | `string` | `USER@REALM!TOKENNAME`. Validated in the constructor. |
| `tokenSecret` | `string` | Sent as issued. |

Password authentication:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `username` | `string` | `"root@pam"` | Must include the realm. |
| `password` | `string` | — | |
| `otp` | `string \| (() => string \| Promise<string>)` | — | TOTP code for [two-factor login](/guide/authentication#two-factor-authentication). |

Invalid options throw a `ProxmoxConfigError` from the constructor.

## Calling an endpoint

Every `$get`, `$post`, `$put` and `$delete` has the same shape:

```ts
$method(params?, options?: RequestOptions): Promise<Result>
```

```ts
interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}
```

See [Calling the API](/guide/calling-the-api).

## `waitForTask(proxmox, upid, options?)`

```ts
waitForTask(
  proxmox: Proxmox.Api,
  upid: string,
  options?: {
    interval?: number;        // default 1000
    timeout?: number;         // default: no limit
    signal?: AbortSignal;
    failOnWarnings?: boolean; // default false
  },
): Promise<TaskStatus>
```

Resolves with the task's final status, or throws a `ProxmoxTaskError`. See
[Tasks](/guide/tasks).

## `parseUpid(upid)`

Splits a task identifier into `{ node, pid, pstart, startTime, type, id, user }`.
Throws a `ProxmoxConfigError` if the string is not a UPID.

## Errors

| Export | Extends | `code` |
| --- | --- | --- |
| `ProxmoxError` | `Error` | any of the below |
| `ProxmoxConfigError` | `ProxmoxError` | `config` |
| `ProxmoxConnectionError` | `ProxmoxError` | `connection` |
| `ProxmoxTimeoutError` | `ProxmoxConnectionError` | `timeout` |
| `ProxmoxAbortError` | `ProxmoxError` | `aborted` |
| `ProxmoxResponseError` | `ProxmoxError` | `response` |
| `ProxmoxApiError` | `ProxmoxError` | `api` |
| `ProxmoxParameterError` | `ProxmoxApiError` | `parameter` |
| `ProxmoxAuthenticationError` | `ProxmoxApiError` | `authentication` |
| `ProxmoxPermissionError` | `ProxmoxApiError` | `permission` |
| `ProxmoxTaskError` | `ProxmoxError` | `task` |

Members, beyond `message`, `cause` and `code`:

| Class | Members |
| --- | --- |
| `ProxmoxError` | `request?: ProxmoxRequestInfo`, `toJSON()`, static `isInstance(value)` |
| `ProxmoxApiError` | `status`, `statusText`, `reason`, `errors`, `body`, `request` |
| `ProxmoxAuthenticationError` | `tfaRequired: boolean` |
| `ProxmoxTimeoutError` | `timeout: number` |
| `ProxmoxResponseError` | `status: number` |
| `ProxmoxTaskError` | `upid`, `exitstatus` |

```ts
interface ProxmoxRequestInfo {
  method: string;
  path: string;         // /api2/json/nodes/pve1/qemu/100/config
  pathTemplate: string; // /api2/json/nodes/*/qemu/*/config
  origin: string;       // https://192.0.2.10:8006
  attempt: number;      // 1 for the first try
}
```

See [Errors, retries and timeouts](/guide/errors).

## `ProxmoxEngine`

Performs the requests. Construct it directly to keep hold of the session; it
takes the same options as `proxmoxApi()`.

```ts
import proxmoxApi, { ProxmoxEngine } from "@virtbase/proxmox-api";

const engine = new ProxmoxEngine({ host: "192.0.2.10", /* … */ });
const proxmox = proxmoxApi(engine);
```

| Member | |
| --- | --- |
| `origin` | `https://host:port`, read-only. |
| `ticket`, `CSRFPreventionToken` | The current session, or `undefined`. Read-only. |
| `getTicket()` | Resolves `{ ticket, CSRFPreventionToken }`, logging in first if needed. Rejects for token authentication. |
| `logout()` | Forgets the ticket; the next request logs in again. |
| `doRequest(method, path, pathTemplate, params?, options?)` | The primitive the proxy calls. Returns the unwrapped `data`. |

## `ApiRequestable`

```ts
interface ApiRequestable {
  doRequest(
    httpMethod: string,
    path: string,
    pathTemplate: string,
    params?: Record<string, unknown> | null,
    options?: RequestOptions,
  ): Promise<unknown>;
}
```

Implement it to route requests somewhere else entirely — a queue, a recorded
fixture, a different cluster per tenant — and pass it to `proxmoxApi()`.

## Schema constants

`PVE_VERSION`, `PVE_SCHEMA_VERSION` and `PVE_OPERATION_COUNT` say which Proxmox
VE release the bundled types describe. See
[Compatibility](/guide/compatibility#checking-at-run-time).

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
| `infoUsbhost(filter?)` | `Promise<USBHostInfo[]>` | USB devices on the host. |
| `deviceAddById(id, { vendorId, productId })` | `Promise<string>` | Attach by vendor and product id. |
| `deviceAddByPort(id, { bus, port })` | `Promise<string>` | Attach by physical port. |
| `deviceAddMissing(id, filter)` | `Promise<string[]>` | Attach every host device matching the filter, as `id`, `id-1`, …; fails if `id` is already in use. |
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
`proxmoxApi()` returns; each operation's parameters and response are named
after it, for example `Proxmox.NodesQemuCreateVmParams` and
`Proxmox.NodesQemuVmlist`.

```ts
import type { Proxmox } from "@virtbase/proxmox-api";

function report(api: Proxmox.Api) { /* … */ }
```

Also exported: `ProxmoxEngineOptions` and its `…OptionsCommon`, `…OptionsPass`
and `…OptionsToken` members, `ProxmoxRequestEvent`, `ProxmoxRequestInfo`,
`ProxmoxErrorCode`, `RequestOptions`, `FetchInterface`, `ApiRequestable`,
`ApiParamType`, `TaskStatus`, `ParsedUpid`, `WaitForTaskOptions`, `USBInfo`,
`USBHostInfo` and `USBHostFilter`.
