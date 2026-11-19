---
description: "The typed errors @virtbase/proxmox-api throws for Proxmox VE API failures, which requests are retried, and how timeouts and request hooks work."
---

# Errors, retries and timeouts

## What gets thrown

Everything the client throws is a `ProxmoxError` with a `code`, a readable
`message` and, for a failed request, the `request` it belongs to. The one
exception is an error thrown by your own callback — `otp` or a custom `fetch`
that throws something other than a network error — which is passed through
untouched. Catch the class you can act on:

```ts
import {
  ProxmoxApiError,
  ProxmoxConnectionError,
  ProxmoxParameterError,
} from "@virtbase/proxmox-api";

try {
  await proxmox.nodes.$("pve1").qemu.$(100).config.$put({ memory: "lots" });
} catch (error) {
  if (error instanceof ProxmoxParameterError) {
    console.error(error.errors); // { memory: "value is not an integer" }
  } else if (error instanceof ProxmoxApiError) {
    console.error(error.status, error.reason);
  } else if (error instanceof ProxmoxConnectionError) {
    console.error("cluster unreachable", error.cause);
  } else {
    throw error;
  }
}
```

The message alone is enough for a log line:

```
PUT /api2/json/nodes/pve1/qemu/100/config failed: 400 Parameter verification failed. (memory: value is not an integer)
```

### Error classes

| Class | `code` | When |
| --- | --- | --- |
| `ProxmoxConfigError` | `config` | An option or argument is unusable — a malformed `tokenID`, a port in `host`, `..` as a path value, a string that is not a UPID. Thrown before any request is sent. |
| `ProxmoxConnectionError` | `connection` | No response: DNS, refused connection, TLS rejection, reset. The original error is on `cause`. |
| `ProxmoxTimeoutError` | `timeout` | The request exceeded its timeout. Extends `ProxmoxConnectionError`. |
| `ProxmoxAbortError` | `aborted` | Your own `AbortSignal` cancelled the request. |
| `ProxmoxApiError` | `api` | Proxmox answered with an error status not covered below — typically `500`. |
| `ProxmoxParameterError` | `parameter` | `400`: parameters were rejected. Extends `ProxmoxApiError`. |
| `ProxmoxAuthenticationError` | `authentication` | `401`: wrong password, unknown token, or a login that needs a second factor (`tfaRequired`). Extends `ProxmoxApiError`. |
| `ProxmoxPermissionError` | `permission` | `403`: a missing privilege, or a token used on a ticket-only endpoint. Extends `ProxmoxApiError`. |
| `ProxmoxResponseError` | `response` | A response arrived but could not be decoded. |
| `ProxmoxTaskError` | `task` | A background task finished with a failure — see [Tasks](./tasks). |

### What an API error carries

| Property | |
| --- | --- |
| `status` | The HTTP status. |
| `reason` | Proxmox's explanation. Taken from the response body where there is one, and from the status line otherwise, so it survives reverse proxies that drop the status text. |
| `errors` | Per-parameter messages, `{}` when there are none. |
| `body` | The decoded response body. |
| `request` | `{ method, path, pathTemplate, origin, attempt }`. |

`pathTemplate` is the path with `*` in place of each id —
`/api2/json/nodes/*/qemu/*/config` — which is what you want as a metric label.

Error messages and their JSON form never contain credentials or request
parameters, so they are safe to log.

### Proxmox reports most failures as 500

Proxmox rarely answers `404`. A guest that does not exist, a storage that is
offline and a lock that is held all come back as `500` with the explanation in
`reason`:

```ts
if (error instanceof ProxmoxApiError && /does not exist/.test(error.reason)) {
  // treat as not found
}
```

### Checking without `instanceof`

If your dependency tree can contain two copies of the package, `instanceof`
only matches errors from the same copy. `code` and `ProxmoxError.isInstance()`
work across copies:

```ts
if (ProxmoxError.isInstance(error) && error.code === "permission") { /* … */ }
```

## Retries

Only `GET` requests are retried, up to `maxRetries` times (default `2`) with
exponential backoff, and only when the failure is one that a second attempt can
fix:

- no response at all — a connection error or a timeout;
- `408`, `429`, `502`, `503`, `504`;
- `595`, `596`, `597` and `599`, which Proxmox returns when the node a request
  is proxied to cannot be reached.

`POST`, `PUT` and `DELETE` are **never** retried. They start tasks and change
state, a request that timed out may well have been carried out, and Proxmox has
no idempotency keys to make a repeat safe. Decide for yourself:

```ts
try {
  await proxmox.nodes.$("pve1").qemu.$(100).status.start.$post();
} catch (error) {
  if (error instanceof ProxmoxTimeoutError) {
    // Unknown outcome: check the guest's state before trying again.
  }
  throw error;
}
```

One exception applies to every method: a request rejected with `401` because
its ticket expired is replayed once after logging in again, since a rejected
ticket means the request was not run.

```ts
proxmoxApi({ host: "192.0.2.10", /* … */ maxRetries: 0 }); // never retry
```

## Timeouts

In milliseconds:

```ts
proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: "…",
  authTimeout: 10_000,  // login request; default 10000
  queryTimeout: 60_000, // every other request; default 60000
});
```

Override it for one call with the [`timeout` option](./calling-the-api#per-request-options).

::: tip
Backups, migrations and clones return a UPID immediately and run in the
background — the timeout applies to the call that *starts* the task, not to the
task. Use [`waitForTask`](./tasks) for that.
:::

## Observing requests

`onEvent` is called for every request, response, retry and failure — enough for
logging and metrics without wrapping `fetch`:

```ts
proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: "…",
  onEvent(event) {
    if (event.type === "response") {
      metrics.observe(event.method, event.pathTemplate, event.status, event.durationMs);
    } else if (event.type === "retry") {
      log.warn(`${event.method} ${event.path} retrying in ${event.delayMs} ms`, event.error);
    }
  },
});
```

| `type` | Extra fields |
| --- | --- |
| `request` | — |
| `response` | `status`, `durationMs` |
| `retry` | `delayMs`, `error` |
| `error` | `durationMs`, `error` |

Every event also has `method`, `path`, `pathTemplate`, `origin` and `attempt`.
Events never include credentials or parameters. An exception thrown by
`onEvent` is ignored, so a faulty observer cannot fail a request.
