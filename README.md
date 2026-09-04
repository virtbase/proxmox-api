# proxmox-api

A fork of [UrielCh/proxmox-api](https://github.com/UrielCh/proxmox-api), maintained
for [virtbase](https://virtbase.com).

Bun workspaces + Turborepo. Everything is ESM.

## Packages

| Package | Description |
| --- | --- |
| [`packages/api`](packages/api) | `@virtbase/proxmox-api` — the published client. |
| [`packages/generator`](packages/generator) | Generates `packages/api/src/model.ts` from the published PVE API schema. |
| [`tooling/typescript`](tooling/typescript) | `@virtbase/tsconfig` — the shared TypeScript configs. |

Usage docs live in [`packages/api/README.md`](packages/api/README.md).

## Getting started

```bash
bun install
bun run build
bun run test
```

## Scripts

| Script | Description |
| --- | --- |
| `bun run build` | Compile every package. |
| `bun run typecheck` | Type-check without emitting. |
| `bun run test` | Run every package's tests. |
| `bun run test:coverage` | Same, with coverage reporters. |
| `bun run check` | Biome lint + format check. |
| `bun run check:write` | Apply Biome's safe fixes. |
| `bun run check:unsafe` | Apply Biome's unsafe fixes too. |
| `bun run codegen` | Regenerate `packages/api/src/model.ts`. |
| `bun run clean` | Drop `node_modules` via `git clean`. |
| `bun run clean:workspaces` | Run each package's `clean`. |

## Regenerating the API model

`packages/api/src/model.ts` is generated from the schema Proxmox publishes with
its [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/):

```bash
bun run codegen           # fetch the current schema and regenerate
bun run codegen:check     # CI: fail if model.ts is stale
```

The generator downloads the viewer bundle, caches it under
`packages/generator/.cache/`, and records the source URL and a SHA-256 of the
input in the generated header. Output is deterministic, so regenerating from an
unchanged schema produces no diff. See
[`packages/generator/README.md`](packages/generator/README.md) for the options
and for how the schema maps onto TypeScript.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/);
  `commitlint` enforces this in a `commit-msg` hook.
- **Formatting and linting** are Biome's. A `pre-commit` hook runs `lint-staged`
  over staged files and then the test suite.
- Rules relaxed for code inherited from upstream are marked `TODO(fork)` in the
  package's `biome.jsonc` or `tsconfig.json`.

## License

GPL-3.0. See [LICENSE](LICENSE).
