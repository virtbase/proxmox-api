# @virtbase/proxmox-api-generator

Turns the Proxmox VE API schema into everything in this repository that is not
written by hand:

| Output | |
| --- | --- |
| [`packages/api/src/model.ts`](../api/src/model.ts) | The typed API surface. |
| [`packages/api/src/schema-info.ts`](../api/src/schema-info.ts) | `PVE_VERSION` and friends. |
| [`docs/reference/endpoints/`](../../docs/reference/endpoints) | The endpoint reference. |
| [`docs/reference/api-changelog/`](../../docs/reference/api-changelog) | What changed between schema versions. |

```bash
bun run codegen          # regenerate from the pinned version
bun run codegen:check    # fail if generated output is stale
bun run codegen:update   # move to the newest Proxmox schema
```

## Where the schema comes from

Proxmox has no machine-readable schema endpoint. Its
[API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) embeds the schema in
`apidoc.js`, and the copy on the website is replaced in place with no version
attached.

The same file ships inside the `pve-docs` Debian package, and Proxmox's public
apt repository keeps every version of it. So that is what is used:

1. `schema.lock.json` pins one `pve-docs` version together with the SHA-256 of
   the `.deb` and of the schema inside it.
2. `codegen` downloads that package, checks it against the `.deb` hash,
   extracts `apidoc.js`, checks the schema inside against its hash and
   generates from it. The extracted file is cached under `.cache/`; a cached
   copy is checked against the schema hash only.
3. `codegen:update` reads the repository index, and if a newer package carries
   a different schema, moves the lock, writes a `history/<version>.json`
   describing the differences, and regenerates.

Output is deterministic: the same lock produces byte-identical files, which is
what `codegen:check` relies on in CI.

The repository is only served over plain HTTP, and `update` does not verify
the apt signature, so the moment the lock moves is trust-on-first-use. Two
things bound what a tampered download could do. From then on the pinned hashes
apply: a regeneration can never silently use different input than the one that
was reviewed. And the generator treats the schema as untrusted text: names are
reduced to alphanumerics, values are quoted, and a test asserts that the model
compiles to no runtime code, so a schema can change types and wording but
cannot put code into the published package. Extraction needs a `tar` that reads xz, which GNU tar and
bsdtar both do.

Most `pve-docs` releases change the prose and leave the schema alone. Those are
skipped, so the lock always names the first version that shipped a schema.

## Commands

```
bun src/cli.ts [generate] [--check] [--offline] [--input <apidoc.js>]
bun src/cli.ts update [--to <version>] [--summary <file>]
bun src/cli.ts backfill <version>...
```

| | |
| --- | --- |
| `generate` | Regenerate from the lock. `--check` writes nothing and exits 1 if anything is stale. `--offline` refuses to download. `--input` generates from a file on disk, for experiments. |
| `update` | Move the lock to the newest release in the tracked suite, or to `--to`. Prints a summary; `--summary` also writes it to a file. In GitHub Actions it sets the outputs `updated`, `version`, `previous` and `level`. |
| `backfill` | Record history for specific versions, oldest first. Used once to seed `history/`. |

## Classifying a schema update

`update` compares the old and new schema operation by operation
([`diff.ts`](src/diff.ts)) and derives how far the package version has to move:

| Level | Meaning | Examples |
| --- | --- | --- |
| `major` | Existing callers can break. | Operation or parameter removed, parameter newly required, enumeration parameter narrowed, returned property removed or changed type, API token access withdrawn, an exported type renamed or removed. |
| `minor` | Additive. | New operation, new optional parameter, new returned property, wider enumeration. |
| `patch` | Wording or metadata only. | Descriptions, defaults, permissions. |

The scheduled workflow turns the level into the commit type — `feat!`, `feat`
or `fix` — and release-please turns that into the version.

## Following a new Proxmox major

A Proxmox VE major is built on a new Debian release, which is a new apt suite.
`update` only looks at the suite named in `schema.lock.json` and prints a
warning when a later one has a release. Switching is deliberate: change `suite`
in the lock file (for example `trixie` to `forky`) and run
`bun run codegen:update`.

## How the schema maps to TypeScript

- **Operations** become methods on a tree that mirrors the path. Each one's
  parameters and response are named interfaces, named after the literal path
  segments and Proxmox's handler name: `/nodes/{node}/qemu` + `create_vm` gives
  `NodesQemuCreateVmParams`. Both inputs are stable upstream, so names only
  move when an endpoint does.
- **Enumerations** become unions. One that is the only value set for its
  property name is named after the property (`Ostype`). Property names that
  mean different things in different places (`type`, `mode`, `state`) are
  written out where they are used, or — past eight members — get a name
  qualified by the path they occur under. A counter is only the last resort
  when two such names still collide.
- **Named PVE formats** (`pve-vmid`, `CIDR`, …) become string aliases, which
  keeps the format visible in editor hints.
- **Indexed properties** — `net[n]`, `scsi[n]`, `mp[n]` — are expanded to
  exactly the slots the API accepts through `Indexed<"scsi", Index30, …>`. The
  bound is not in the schema, so [`index-bounds.ts`](src/index-bounds.ts)
  carries a table taken from the constants in the Proxmox source, each entry
  citing where it came from. A prefix missing from the table is emitted as an
  unbounded key pattern and reported as a warning.
- **Booleans** are `boolean` as parameters and `boolean | 0 | 1` in responses,
  because most of Proxmox answers with `1` and `0`.
- **Property strings** stay `string`; their packed fields are recorded as
  `@propertyString` in the documentation comment.
- **`additionalProperties`** is honoured as written: an index signature appears
  only where the schema allows extra keys.
- **`oneOf`** becomes a union of the variants, with the discriminating property
  recorded as `@discriminatedBy`.

## Layout

| File | Role |
| --- | --- |
| `apt.ts` | Repository index, version ordering, `.deb` download and extraction. |
| `load-schema.ts` | Lock file, cache, hashing, slicing the schema out of the bundle. |
| `schema.ts` | Types describing the PVE schema. |
| `operations.ts` | Flattens the tree into named operations. |
| `emit.ts` | Schema → TypeScript. |
| `emit-docs.ts` | Schema → endpoint reference. |
| `diff.ts` | Compares two schema versions and classifies the result. |
| `history.ts`, `emit-changelog.ts` | Stored differences → API changelog. |
| `index-bounds.ts` | Slot counts for indexed properties. |
| `naming.ts` | Identifier casing and collision handling. |
| `cli.ts` | Commands. |
