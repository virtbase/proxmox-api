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
| [`docs`](docs) | The documentation site (VitePress). |

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
| `bun run codegen` | Regenerate the API model and the endpoint reference. |
| `bun run lint:package` | Validate the published package shape (publint, attw). |
| `bun run codegen:check` | CI: fail if either is stale. |
| `bun run docs:dev` | Serve the docs site locally. |
| `bun run docs:build` | Build the docs site. |
| `bun run clean` | Drop `node_modules` via `git clean`. |
| `bun run clean:workspaces` | Run each package's `clean`. |

## Regenerating the API model

`packages/api/src/model.ts` is generated from the schema Proxmox publishes with
its [API viewer](https://pve.proxmox.com/pve-docs/api-viewer/):

```bash
bun run codegen           # fetch the current schema and regenerate
bun run codegen:check     # CI: fail if the generated output is stale
```

One command produces two things: `packages/api/src/model.ts`, and the endpoint
reference under `docs/reference/endpoints/`. Both come from the same parse, so
the docs cannot describe a surface the types do not have.

The generator downloads the viewer bundle, caches it under
`packages/generator/.cache/`, and records the source URL and a SHA-256 of the
input in the generated header. Output is deterministic, so regenerating from an
unchanged schema produces no diff. See
[`packages/generator/README.md`](packages/generator/README.md) for the options
and for how the schema maps onto TypeScript.

## Documentation

The site in [`docs/`](docs) is VitePress: hand-written guides, a reference for
the client surface, and the generated endpoint reference. `bun run docs:dev`
serves it; the `Docs` workflow builds it on every push and deploys to GitHub
Pages, failing first if the generated pages are stale.

## Automation

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `CI` | push, pull request | Lint, typecheck, test, build, and validate the published package shape. |
| `Docs` | push, pull request | Builds the site; deploys to Pages on the default branch. |
| `Schema drift` | weekly, manual | Regenerates against the current Proxmox schema and opens a pull request if anything moved. |
| `Release` | push to default branch | Maintains a release pull request; on merge, tags, releases, and publishes to npm with provenance. |

Releases are driven by [release-please](https://github.com/googleapis/release-please):
the version bump and the changelog entry both come from the conventional
commits since the last release, so the only thing to get right is the commit
message. `feat!` or a `BREAKING CHANGE:` footer produces a major.

Publishing needs an `NPM_TOKEN` secret and an `npm` environment; Pages
deployment needs Pages enabled with GitHub Actions as the source.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/);
  `commitlint` enforces this in a `commit-msg` hook.
- **Formatting and linting** are Biome's. A `pre-commit` hook runs `lint-staged`
  over staged files and then the test suite.
- Rules relaxed for code inherited from upstream are marked `TODO(fork)` in the
  package's `biome.jsonc` or `tsconfig.json`.

## License

GPL-3.0. See [LICENSE](LICENSE).
