# @virtbase/proxmox-api

[![npm](https://img.shields.io/npm/v/@virtbase/proxmox-api)](https://www.npmjs.com/package/@virtbase/proxmox-api)
[![CI](https://github.com/virtbase/proxmox-api/actions/workflows/ci.yml/badge.svg)](https://github.com/virtbase/proxmox-api/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@virtbase/proxmox-api)](https://github.com/virtbase/proxmox-api/blob/main/LICENSE)

A fully typed client for the [Proxmox VE API](https://pve.proxmox.com/wiki/Proxmox_VE_API).
Every endpoint, parameter and response is generated from the schema Proxmox
publishes, so the API documentation shows up in your editor and mistakes are
caught at compile time.

- **The whole API**, typed — nothing hand-maintained, nothing missing.
- **Zero dependencies.** Built on the platform `fetch`; runs on Node 22+, Bun,
  Deno and edge runtimes. ESM only.
- **Useful errors.** Typed error classes with the status, Proxmox's reason and
  the rejected parameters.
- **Tracks Proxmox automatically**, with a published
  [API changelog](https://virtbase.github.io/proxmox-api/reference/api-changelog/).

**[Documentation](https://virtbase.github.io/proxmox-api/)** ·
[Compatibility](https://virtbase.github.io/proxmox-api/guide/compatibility) ·
[Endpoint reference](https://virtbase.github.io/proxmox-api/reference/endpoints/)

## Install

```bash
npm install @virtbase/proxmox-api
```

Each release is generated from one Proxmox VE version; see
[Compatibility](https://virtbase.github.io/proxmox-api/guide/compatibility) for
which release matches your cluster.

## Usage

Take a path from the Proxmox API and read it as property access: `/` becomes
`.`, a `{placeholder}` becomes `.$(value)`, and the HTTP method goes on the end
as `.$get()`, `.$post()`, `.$put()` or `.$delete()`.

```ts
import proxmoxApi, { waitForTask } from "@virtbase/proxmox-api";

const proxmox = proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: process.env.PVE_TOKEN_SECRET!,
});

// GET /nodes
for (const { node } of await proxmox.nodes.$get()) {
  // GET /nodes/{node}/qemu
  for (const vm of await proxmox.nodes.$(node).qemu.$get({ full: true })) {
    console.log(node, vm.vmid, vm.name, vm.status);
  }
}

// POST /nodes/{node}/qemu/{vmid}/status/start returns a task id;
// waitForTask resolves when the task succeeds and throws when it fails.
const upid = await proxmox.nodes.$("pve1").qemu.$(100).status.start.$post();
await waitForTask(proxmox, upid);
```

Path segments with a hyphen use bracket access:

```ts
await proxmox.nodes.$("pve1").qemu.$(100).agent["get-fsinfo"].$get();
```

### Authentication

```ts
// API token (recommended for automation)
proxmoxApi({ host, tokenID: "user@pve!name", tokenSecret });

// Username and password; the ticket is obtained and renewed for you
proxmoxApi({ host, username: "user@pve", password });
```

The port defaults to `8006`. A stock Proxmox install uses a certificate signed
by its own CA; see
[Self-signed certificates](https://virtbase.github.io/proxmox-api/guide/getting-started#self-signed-certificates).

### Errors

```ts
import { ProxmoxApiError, ProxmoxParameterError } from "@virtbase/proxmox-api";

try {
  await proxmox.nodes.$("pve1").qemu.$(100).config.$put({ memory: "lots" });
} catch (error) {
  if (error instanceof ProxmoxParameterError) {
    console.error(error.errors); // { memory: "value is not an integer" }
  } else if (error instanceof ProxmoxApiError) {
    console.error(error.status, error.reason);
  }
}
```

Only `GET` requests are retried. See
[Errors, retries and timeouts](https://virtbase.github.io/proxmox-api/guide/errors).

## Credits

Based on [`proxmox-api`](https://github.com/UrielCh/proxmox-api) by Uriel
Chemouni. Maintained by [virtbase](https://virtbase.com).

## License

[MIT](https://github.com/virtbase/proxmox-api/blob/main/LICENSE)
