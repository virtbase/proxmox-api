# Changelog

## Unreleased

Forked from [UrielCh/proxmox-api](https://github.com/UrielCh/proxmox-api) at v1.1.1
and republished as `@virtbase/proxmox-api`.

* **Breaking:** ESM only. The CommonJS build (`cjs/`, `tsconfig-cjs.json`) and the
  `require` condition in `exports` are gone; output moved from `esm/` to `dist/`.
* **Breaking:** renamed to `@virtbase/proxmox-api`.
* **Breaking:** the API model now targets **Proxmox VE 9** (was PVE 8): 678
  operations, +98 added and -3 removed. New surface includes SDN fabrics, HA
  rules, `cluster/bulk-action`, `cluster/qemu` custom CPU models, SDN
  prefix-lists and route-maps, webhook notification endpoints, and
  `cluster/metrics/export`. Gone: `nodes/{node}/hardware/pci/{pciid}`,
  `.../{pciid}/mdev` and `nodes/{node}/scan/glusterfs`.
* **Breaking:** returned objects no longer carry a blanket
  `[key: string]: any`. It was applied to every response regardless of the
  schema, which defeated type checking on all of them; it is now emitted only
  where the schema permits extra keys.
* Indexed parameters (`net[n]`, `scsi[n]`, `mp[n]`, ...) are expanded to the
  slots the API actually accepts - `scsi0`..`scsi30`, `ide0`..`ide3`,
  `net0`..`net31`, `usb0`..`usb13`, `mp0`..`mp255`, and so on - taken from the
  constants that generate them in qemu-server, pve-container, pve-cluster and
  pve-manager. Upstream capped them at a hand-picked `net0`..`net3`, which
  rejected valid configurations.
* Enumerations are emitted as unions and named PVE formats as string aliases,
  both deduplicated across the whole model.
* **Breaking:** `undici` is no longer a dependency - the client uses the
  platform `fetch`. The package now has no runtime dependencies and no `node:`
  imports.
* Import via `node:` protocol in `ProxmoxEngine`.
* Documentation moved to a VitePress site: hand-written guides, a client
  reference, and an endpoint reference generated from the same schema parse as
  the types. Replaces 63 MB of committed typedoc HTML that documented the PVE 8
  surface.

## v1.1.0
* update ESM compatibility
* add support for Proxmox 8
* update deps

## v1.0.2
* Merge PR 20

## v1.0.1
* improve codebase adding CODE_OF_CONDUCT.md, CONTRIBUTING.md
* add funding
* fix common-js usage for the project

## v1.0.0
* Dual stack package, ESM + CJS
* Should work with deno

## v0.4.2
* add application/octet-stream support

## v0.4.1
* rewrite undici fetch integration.
* add debug parameter.
* add cause in Exception
* remove console.log

## v0.4.0
* use undici fetch (will fix issue 14 in the next release)
* add proxmoxApi export (same as default)
* fix missing GET params. (issue 11 and 12)

## v0.3.2
* add missing uppercase on method. (issue 10)

## v0.3.1
 * fix regrestion in API Keys usage. (issue 9)

## V0.3.0
 * fix project layout
 * add doc
 * change proxmoxApi signature to proxmoxApi(options: ProxmoxEngineOptions | ApiRequestable): Proxmox.Api.

## V0.1.3
 * add authTimeout option, to limit authentification time.
 * add queryTimeout option to limit non auth request timeout.
