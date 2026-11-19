---
description: "Install @virtbase/proxmox-api, connect to a Proxmox VE cluster with an API token, and deal with the cluster's self-signed certificate."
---

# Getting started

`@virtbase/proxmox-api` maps the Proxmox VE API onto property access. Every
operation is typed from the schema Proxmox publishes, so parameters,
enumerations and return shapes are checked as you write them, and the API
documentation appears in your editor.

## Install

::: code-group
```bash [bun]
bun add @virtbase/proxmox-api
```
```bash [npm]
npm install @virtbase/proxmox-api
```
```bash [pnpm]
pnpm add @virtbase/proxmox-api
```
:::

The package is ESM only and has no runtime dependencies. It uses the platform
`fetch` and imports nothing from `node:`, so it runs on Node 22+, Bun, Deno and
edge runtimes.

Each release is generated from one specific Proxmox VE version. Check
[Compatibility](./compatibility) to pick the release that matches your cluster.

## Connect

```ts
import proxmoxApi from "@virtbase/proxmox-api";

const proxmox = proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: "12345678-1234-1234-1234-1234567890ab",
});

const nodes = await proxmox.nodes.$get();
for (const node of nodes) {
  console.log(node.node, node.status);
}
```

`host` is a bare hostname or IP address. The port defaults to Proxmox's `8006`;
pass `port` if something proxies the API elsewhere, for example `port: 443`.

## Self-signed certificates

A default Proxmox install serves a certificate signed by its own cluster CA,
which `fetch` rejects. In order of preference:

1. Install a certificate the client already trusts. Proxmox has built-in ACME
   support.
2. Trust the cluster CA:

   ```bash
   NODE_EXTRA_CA_CERTS=/etc/pve/pve-root-ca.pem node app.js
   ```

3. Disable verification for this client only — see
   [Custom fetch](./custom-fetch#self-signed-certificates-scoped).

Avoid `NODE_TLS_REJECT_UNAUTHORIZED=0`. It turns certificate checking off for
every outbound request the process makes.

## Next

- [Authentication](./authentication) — tokens versus tickets, and what each can do.
- [Calling the API](./calling-the-api) — how paths become property access.
- [Tasks](./tasks) — waiting for the work a call starts.
- [Errors, retries and timeouts](./errors) — what is thrown, and when.
