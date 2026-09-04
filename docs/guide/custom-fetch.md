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
  port: 8006,
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

## Logging

```ts
fetch: async (url, options) => {
  const started = performance.now();
  const response = await fetch(url, options);
  console.log(options?.method ?? "GET", String(url), response.status,
              `${Math.round(performance.now() - started)}ms`);
  return response;
},
```

## Rate limiting and retries

Proxmox's API is single-threaded per node, and hammering it during a migration
will make things worse. Wrap the transport rather than the call sites:

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
    tokenSecret: "12345678-1234-1234-1234-1234567890ab",
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ node: "pve1" }] }), {
        headers: { "content-type": "application/json;charset=UTF-8" },
      });
    },
  });

  expect(await proxmox.nodes.$get()).toEqual([{ node: "pve1" }] as never);
  expect(calls[0]).toBe("https://127.0.0.1/api2/json/nodes");
});
```

Using a token avoids the login round trip, so the stub only sees the call you
are testing.
