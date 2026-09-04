# @virtbase/proxmox-api-generator

Generates [`packages/api/src/model.ts`](../api/src/model.ts) — the typed
Proxmox VE API surface — from the schema Proxmox publishes with its API viewer.

```bash
bun run codegen              # from the repo root
```

## Where the schema comes from

Proxmox has no machine-readable schema endpoint. The
[API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) ships its data and
its ExtJS front-end in one bundle, as `const apiSchema = [...]` followed by
~20 kB of application code, at:

```
https://pve.proxmox.com/pve-docs/api-viewer/apidoc.js
```

`load-schema.ts` slices the array literal back out by balancing brackets, then
hashes the raw bundle. The hash and the source URL are written into the
generated file's header, so any `model.ts` can be traced to the exact input
that produced it.

The bundle is cached at `.cache/apidoc.js`, which makes reruns offline-capable.

## Options

| Flag | Effect |
| --- | --- |
| `--url <url>` | Download a different bundle (an older release, or your own node). |
| `--input <file>` | Read a bundle from disk; skips the network entirely. |
| `--out <file>` | Write somewhere other than `packages/api/src/model.ts`. |
| `--cache <file>` | Move the cache. |
| `--offline` | Use the cache and never touch the network. |
| `--check` | Exit non-zero if the output would change. Writes nothing. |

`bun run codegen:check` is `--check --offline`, for CI.

Output is deterministic: the same bundle produces a byte-identical `model.ts`
whether it came from the network, the cache, or `--input`.

## Layout

| File | Role |
| --- | --- |
| `schema.ts` | Types describing the PVE schema, derived by walking the live PVE 9 document. |
| `load-schema.ts` | Fetch, extract, parse, cache, hash. |
| `naming.ts` | Identifier casing, property quoting, collision-free type names. |
| `emit.ts` | Schema → TypeScript. |
| `cli.ts` | Argument handling. |

## How the schema maps to TypeScript

- **Enumerations** become real unions, deduplicated by value set, so
  `status.status` is `"stopped" | "running"` rather than `string`.
- **Named PVE formats** (`pve-vmid`, `CIDR`, …) become string aliases, which
  keeps the format visible in editor hints.
- **Indexed properties** — PVE spells them `net[n]`, `scsi[n]`, `mp[n]` — become
  pattern index signatures (`` [key: `net${number}`] ``), so every index the
  API accepts is typed. Upstream expanded these to a hand-picked `net0`..`net3`,
  which rejected valid configurations.
- **Property strings** (a `format` holding a schema rather than a name) stay
  `string`; their packed fields are recorded as `@propertyString` in the JSDoc.
- **`additionalProperties`** is honoured as written. An index signature is
  added only when the schema allows extra keys — upstream added one to every
  returned object, which quietly made them all accept any key.
- **`oneOf`** (PVE 9, used by the SDN fabrics endpoints) becomes a union of the
  variants. TypeScript cannot make one property's type depend on a sibling
  field's value, so the discriminant is recorded as `@discriminatedBy` instead.

## Refreshing for a new Proxmox release

Run `bun run codegen`. Proxmox updates the viewer bundle in place, so there is
no version to select. Endpoints removed upstream disappear from the model,
which is a breaking change for consumers — release it as a major version.
