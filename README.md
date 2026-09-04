# proxmox-api

A fork of [UrielCh/proxmox-api](https://github.com/UrielCh/proxmox-api), maintained
for [virtbase](https://virtbase.com).

Bun workspaces + Turborepo. Everything is ESM.

## Packages

| Package | Description |
| --- | --- |
| [`packages/api`](packages/api) | `@virtbase/proxmox-api` — the published client. |
| [`packages/generator`](packages/generator) | Generates `packages/api/src/model.ts` from the upstream PVE API dump. |
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

`packages/api/src/model.ts` is generated from `packages/generator/src/pveapi8.ts`,
the PVE API dump scraped from the [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/).
Refresh the dump, then:

```bash
bun run codegen
```

Upstream hand-edited the generated file twice (a commented-out `ReadableStream`
import and a `TODO` on `nodes.*.storage.*.file-restore.download`), so a bare
regeneration currently drops those two lines. Fold them into the generator
before treating `codegen` output as authoritative.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/);
  `commitlint` enforces this in a `commit-msg` hook.
- **Formatting and linting** are Biome's. A `pre-commit` hook runs `lint-staged`
  over staged files and then the test suite.
- Rules relaxed for code inherited from upstream are marked `TODO(fork)` in the
  package's `biome.jsonc` or `tsconfig.json`.

## License

GPL-3.0. See [LICENSE](LICENSE).
