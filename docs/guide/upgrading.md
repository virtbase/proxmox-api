---
description: "Migrate between major versions of @virtbase/proxmox-api, including from the original proxmox-api package."
---

# Upgrading

## From 3.x to 4.x

4.0 rewrites the HTTP client and reshapes the generated types. The calling
convention — `proxmox.nodes.$(node).qemu.$(vmid).config.$get()` — is unchanged.

### The port defaults to 8006

`port` used to have no default, so omitting it sent requests to port 443.

```diff
 proxmoxApi({
   host: "192.0.2.10",
-  port: 8006,
   tokenID: "…",
```

If the API really is on 443 behind a reverse proxy, say so: `port: 443`.

### Errors are typed

Every failure used to be a bare `Error` with the details folded into the
message. They are now [typed errors](./errors) with `status`, `reason` and
`errors` as properties.

```diff
 try {
   await proxmox.nodes.$("pve1").qemu.$(100).config.$put({ memory: "lots" });
 } catch (error) {
-  if (/return Error 400/.test(error.message)) { … }
+  if (error instanceof ProxmoxParameterError) { console.error(error.errors); }
 }
```

The message format changed too, so anything matching on message text needs
updating.

### Only `GET` is retried

A transport failure used to be retried once for every method, which could run a
`POST` twice. Now `GET` is retried up to `maxRetries` times (default `2`) and
nothing else is. See [Retries](./errors#retries).

### `debug` is replaced by `onEvent`

`debug: "curl"` printed failing requests to the console, credentials included.
Use [`onEvent`](./errors#observing-requests), which never sees credentials.

### Generated type names

| Before | Now |
| --- | --- |
| Response types in camelCase: `Proxmox.nodesQemuVmlist` | PascalCase: `Proxmox.NodesQemuVmlist` |
| Parameter types anonymous | Named: `Proxmox.NodesQemuCreateVmParams` |
| Enumerations numbered by order: `Proxmox.Action_2` | Named after their property, or written out where a name would be ambiguous |
| Returned booleans typed `boolean` | `boolean \| 0 \| 1`, which is what Proxmox sends |

Code that compared a returned boolean with `true` now fails to compile; test it
for truthiness instead.

### Smaller changes

- `engine.ticket` and `engine.CSRFPreventionToken` are read-only. Call
  `engine.logout()` to force a new login.
- `engine.getTicket()` rejects for token authentication instead of returning
  the token.
- `engine.host` is gone; use `engine.origin`.
- `tokenSecret` is no longer required to be a lowercase UUID.
- Any `2xx` status is a success, not only `200`.
- The package ships compiled output only; `src` is no longer in the tarball.
- Node 22 or newer is required.
- The licence changed from GPL-3.0 to MIT.

### New

- [`waitForTask`](./tasks) and `parseUpid`.
- [Per-request options](./calling-the-api#per-request-options): `signal`,
  `timeout`, `maxRetries`, `headers`.
- TOTP [two-factor login](./authentication#two-factor-authentication).
- `PVE_VERSION` and `PVE_SCHEMA_VERSION`, for
  [checking compatibility](./compatibility#checking-at-run-time) at run time.

## From `proxmox-api` to 2.x

This package is a fork of [`proxmox-api`](https://github.com/UrielCh/proxmox-api)
v1.1.1, republished as `@virtbase/proxmox-api`.

```diff
-import proxmoxApi from "proxmox-api";
+import proxmoxApi from "@virtbase/proxmox-api";
```

- **ESM only.** `require()` has no equivalent — use `import`, or a dynamic
  `await import()` from CommonJS.
- **Proxmox VE 9.** The types moved from the PVE 8 schema to PVE 9. The
  [API changelog](/reference/api-changelog/pve-9.0) lists what that removed
  and added.
- **Responses are properly typed.** Upstream added `[key: string]: any` to
  every returned object, so any property access compiled. That index signature
  is now emitted only where Proxmox permits extra keys.
- **Indexed parameters go up to the real limit** — `scsi` to 30, `net` to 31,
  `mp` to 255 — instead of stopping at 3.
- **`undici` is gone.** The client uses the platform `fetch`. If you relied on
  undici being installed transitively, depend on it directly; see
  [Custom fetch](./custom-fetch).
