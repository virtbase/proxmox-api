---
layout: home
title: Typed Proxmox VE API client for TypeScript
description: Every endpoint of the Proxmox VE API, typed from the official schema, with the documentation in your editor. Zero runtime dependencies; runs on Node, Bun, Deno and edge runtimes.
hero:
  name: "@virtbase/proxmox-api"
  text: The Proxmox VE API, fully typed
  tagline: Every endpoint, parameter and response generated from the schema Proxmox publishes. Mistakes are caught at compile time and the API documentation shows up in your editor.
  image:
    src: /logo.svg
    alt: ""
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Browse endpoints
      link: /reference/endpoints/
    - theme: alt
      text: View on GitHub
      link: https://github.com/virtbase/proxmox-api
features:
  - title: The whole API, typed
    details: "Generated from the official schema: parameters, enumerations, return shapes and every description. Nothing hand-maintained, nothing missing."
    link: /reference/endpoints/
    linkText: Endpoint reference
  - title: Paths become property access
    details: "GET /nodes/{node}/qemu/{vmid}/config is proxmox.nodes.$(node).qemu.$(vmid).config.$get(). Nothing to look up."
    link: /guide/calling-the-api
    linkText: Calling the API
  - title: Errors you can act on
    details: "Typed errors carry the status, Proxmox's reason and the rejected parameters. Tasks that fail in the background are surfaced too."
    link: /guide/errors
    linkText: Errors and retries
  - title: Tracks Proxmox automatically
    details: "New Proxmox releases are picked up daily, diffed against the previous schema and published with an API changelog."
    link: /reference/api-changelog/
    linkText: API changelog
  - title: Zero dependencies
    details: "Built on the platform fetch and imports nothing from node:, so it runs on Node 22+, Bun, Deno and edge runtimes."
    link: /guide/custom-fetch
    linkText: Custom fetch
  - title: Matched to your cluster
    details: "Each release is generated from one Proxmox VE version. The compatibility table tells you which release fits yours."
    link: /guide/compatibility
    linkText: Compatibility
---

<div class="home-content">

## From the Proxmox docs to a typed call

<p class="lead">
Take any path from the Proxmox API and read it as property access. Every step
is typed, so your editor completes the next segment, the parameters and the
shape of the response.
</p>

<div class="home-grid">
<div>

| In the path | In code |
| --- | --- |
| `/` | `.` |
| `{placeholder}` | `.$(value)` |
| `get-fsinfo` | `["get-fsinfo"]` |
| the HTTP method | `.$get()`, `.$post()`, `.$put()`, `.$delete()` |

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
```bash [deno]
deno add npm:@virtbase/proxmox-api
```
:::

</div>
<div>

```ts
import proxmoxApi, { waitForTask } from "@virtbase/proxmox-api";

const proxmox = proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: process.env.PVE_TOKEN_SECRET!,
});

const pve1 = proxmox.nodes.$("pve1");

// GET /nodes/{node}/qemu
for (const vm of await pve1.qemu.$get({ full: true })) {
  console.log(vm.vmid, vm.name, vm.status);
}

// POST /nodes/{node}/qemu/{vmid}/status/start returns a task id.
// waitForTask resolves when it succeeds and throws when it fails.
const upid = await pve1.qemu.$(100).status.start.$post();
await waitForTask(proxmox, upid);
```

</div>
</div>

## Why not plain `fetch`?

<p class="lead">
The Proxmox API is a few hundred endpoints of JSON over HTTPS, so a
hand-rolled client is easy to start. Keeping it correct across releases is
the part this package takes over.
</p>

| | Hand-written `fetch` | `@virtbase/proxmox-api` |
| --- | --- | --- |
| Paths | Strings; a typo shows up as a 501 at run time | Property access, checked by the compiler |
| Parameters | Looked up in the API viewer | Completed and type-checked, with Proxmox's descriptions |
| Responses | `any` | Typed per endpoint |
| Authentication | Ticket and CSRF token handled by hand | API token, or a password with the ticket renewed for you |
| Errors | A status code and some text | Typed errors with Proxmox's reason and the rejected parameters |
| Background tasks | Poll the task status yourself | [`waitForTask`](/guide/tasks) |
| New Proxmox releases | Re-read the documentation | An [API changelog](/reference/api-changelog/) of every change |

## Runs where your code runs

<p class="lead">
Built on the platform <code>fetch</code>, with no runtime dependencies and
nothing imported from <code>node:</code>. ESM only.
</p>

<div class="runtimes">
  <span>Node.js 22+</span>
  <span>Bun</span>
  <span>Deno</span>
  <span>Edge runtimes</span>
</div>

<p class="home-links">
  <a href="https://www.npmjs.com/package/@virtbase/proxmox-api">npm package</a>
  <a href="https://github.com/virtbase/proxmox-api">Source on GitHub</a>
  <a href="https://github.com/virtbase/proxmox-api/blob/main/packages/api/CHANGELOG.md">Release notes</a>
</p>

</div>
