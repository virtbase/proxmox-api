# Getting started

`@virtbase/proxmox-api` maps the Proxmox VE API onto property access. Every one
of the 678 operations is typed from the schema Proxmox publishes, so parameters,
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
`fetch` and imports nothing from `node:`, so it runs on Node 18+, Bun, Deno,
edge runtimes and the browser.

## Connect

```ts
import proxmoxApi from "@virtbase/proxmox-api";

const proxmox = proxmoxApi({
  host: "192.0.2.10",
  port: 8006,
  tokenID: "root@pam!automation",
  tokenSecret: "12345678-1234-1234-1234-1234567890ab",
});

const nodes = await proxmox.nodes.$get();
for (const node of nodes) {
  console.log(node.node, node.status);
}
```

::: warning Set the port explicitly
`port` has no default. Omit it and requests go to `https://host/api2/json` —
port 443, not Proxmox's 8006. Pass `port: 8006` unless something is proxying
the API onto 443 for you.
:::

## Self-signed certificates

A default Proxmox install serves a self-signed certificate, which `fetch`
rejects. The blunt fix is to disable verification for the whole process:

```ts
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
```

That turns off certificate checking for *every* outbound request, so prefer
pointing Node at the cluster CA instead:

```bash
NODE_EXTRA_CA_CERTS=/etc/pve/pve-root-ca.pem node app.js
```

Better still, install a certificate the client already trusts — Proxmox has
built-in ACME support.

## Next

- [Authentication](./authentication) — tokens versus tickets, and what each can do.
- [Calling the API](./calling-the-api) — how paths become property access.
- [Endpoint reference](/reference/endpoints/) — all 678 operations.
