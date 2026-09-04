# Errors and timeouts

## What gets thrown

Every non-`200` response throws an `Error` whose message carries the method,
URL, status, Proxmox's status text and the decoded body:

```
PUT https://192.0.2.10:8006/api2/json/nodes/pve1/qemu/100/config return Error 400 \
Parameter verification failed.: {"data":null,"errors":{"memory":"value is not an integer"}}
```

Proxmox puts per-parameter messages in `errors`, which is usually the part worth
reading.

Transport failures — DNS, connection refused, TLS rejection, timeout — throw
with the original attached as `cause`:

```ts
try {
  await proxmox.nodes.$get();
} catch (error) {
  console.error(error.message);
  console.error((error as Error).cause);
}
```

## Timeouts

Two, both configurable, both in milliseconds:

```ts
proxmoxApi({
  host: "192.0.2.10",
  port: 8006,
  tokenID: "root@pam!automation",
  tokenSecret: "…",
  authTimeout: 5_000,   // login request; default 5000
  queryTimeout: 60_000, // every other request; default 60000
});
```

They are enforced with `AbortSignal.timeout`, so an abort aborts the underlying
connection rather than leaving it running.

::: tip
Backups, migrations and image conversions return a UPID immediately and run in
the background — `queryTimeout` applies to the call that *starts* the task, not
to the task. Raise it only for endpoints that genuinely block, such as large
`POST /nodes/{node}/storage/{storage}/upload`.
:::

## Retries

The client retries in two narrow cases, once each:

- A transport-level failure is retried a single time.
- A `401` whose status text is `invalid PVE ticket` discards the cached ticket,
  logs in again and replays the request. Token authentication is not retried,
  because a rejected token will be rejected again.

Nothing else is retried. `500`s in particular are surfaced immediately — with
Proxmox they usually mean the request was wrong, not that the cluster is busy.

## Debugging a request

`debug` prints failing requests, either as a runnable `curl` command or as the
`fetch` call the client made:

```ts
proxmoxApi({ host: "…", port: 8006, tokenID: "…", tokenSecret: "…", debug: "curl" });
```

::: warning
Both formats include the credential — the `Authorization` header or the auth
cookie. Do not leave `debug` on in production, and scrub the output before
pasting it anywhere.
:::
