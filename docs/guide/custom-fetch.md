# Custom fetch

Pass `fetch` to replace the transport. Anything matching the platform signature
works:

```ts
type FetchInterface = (
  url: string | URL,
  options?: RequestInit,
) => Promise<Response>;
```

## Self-signed certificates, scoped

Rather than disabling TLS verification process-wide, scope it to this client.
On Node, with an undici agent:

```ts
import { Agent } from "undici";

const insecure = new Agent({ connect: { rejectUnauthorized: false } });

const proxmox = proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: "…",
  fetch: (url, options) =>
    fetch(url, { ...options, dispatcher: insecure } as RequestInit),
});
```

On Bun:

```ts
fetch: (url, options) => fetch(url, { ...options, tls: { rejectUnauthorized: false } }),
```

::: danger
Disabling certificate verification removes the protection against an
intercepted connection. Prefer `NODE_EXTRA_CA_CERTS` with the cluster CA.
:::

## Logging and metrics

Use [`onEvent`](./errors#observing-requests) rather than wrapping `fetch`: it
reports retries and failures as well, and never sees credentials.

## Limiting concurrency

Proxmox does not rate limit, but flooding a busy node makes things worse. To
send one request at a time, wrap the transport rather than the call sites:

```ts
let chain: Promise<unknown> = Promise.resolve();

const serialised: FetchInterface = (url, options) => {
  const next = chain.then(() => fetch(url, options));
  chain = next.catch(() => {});
  return next;
};
```

## Testing without a server

The client only needs something that returns a `Response`:

```ts
import { expect, test } from "bun:test";

test("requests the node list", async () => {
  const calls: string[] = [];
  const proxmox = proxmoxApi({
    host: "127.0.0.1",
    tokenID: "root@pam!t",
    tokenSecret: "secret",
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ node: "pve1" }] }), {
        headers: { "content-type": "application/json;charset=UTF-8" },
      });
    },
  });

  expect(await proxmox.nodes.$get()).toEqual([{ node: "pve1" }] as never);
  expect(calls[0]).toBe("https://127.0.0.1:8006/api2/json/nodes");
});
```

Using a token avoids the login round trip, so the stub only sees the call you
are testing.

To stub above the HTTP layer instead, pass any object with a `doRequest` method
to `proxmoxApi()` — see [`ApiRequestable`](/reference/client#apirequestable).
