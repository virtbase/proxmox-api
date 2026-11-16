# proxmox-api

[![npm](https://img.shields.io/npm/v/@virtbase/proxmox-api)](https://www.npmjs.com/package/@virtbase/proxmox-api)
[![CI](https://github.com/virtbase/proxmox-api/actions/workflows/ci.yml/badge.svg)](https://github.com/virtbase/proxmox-api/actions/workflows/ci.yml)

The source of [`@virtbase/proxmox-api`](packages/api), a fully typed client for
the Proxmox VE API, and of the generator that keeps it in step with Proxmox.

- Using the client: [documentation](https://virtbase.github.io/proxmox-api/) and
  [`packages/api/README.md`](packages/api/README.md).
- Which release fits which Proxmox VE version:
  [compatibility](https://virtbase.github.io/proxmox-api/guide/compatibility).
- What changed in the Proxmox API between versions:
  [API changelog](https://virtbase.github.io/proxmox-api/reference/api-changelog/).

## Repository

A Bun workspace driven by Turborepo. Everything is ESM.

| Path | |
| --- | --- |
| [`packages/api`](packages/api) | `@virtbase/proxmox-api`, the published client. |
| [`packages/generator`](packages/generator) | Generates the API model, the endpoint reference and the API changelog from the Proxmox VE schema. |
| [`docs`](docs) | The documentation site (VitePress). |
| [`tooling/typescript`](tooling/typescript) | Shared TypeScript configuration. |

## Development

Requires [Bun](https://bun.sh) (the version in `package.json`).

```bash
bun install
bun run verify
```

| Script | |
| --- | --- |
| `bun run verify` | Everything CI checks: lint, types, tests, build, package shape, generated output. |
| `bun run test` | Run the tests. |
| `bun run typecheck` | Type-check every package. |
| `bun run check:write` | Format and apply lint fixes (Biome). |
| `bun run build` | Compile the package and build the docs. |
| `bun run codegen` | Regenerate from the pinned schema version. |
| `bun run codegen:update` | Move to the newest Proxmox schema and regenerate. |
| `bun run docs:dev` | Serve the docs locally. |

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and
[MAINTAINING.md](MAINTAINING.md) for how releases and updates are automated.

## How it stays current

| Trigger | What happens |
| --- | --- |
| Proxmox publishes a new API schema | A daily job regenerates the types, records the differences in the API changelog and opens a pull request. Additive updates merge and release on their own; breaking ones wait for review. |
| A dependency has an update | Renovate opens a pull request after a seven-day cooling-off period and merges it once CI passes. |
| A change lands on `main` | release-please maintains a release pull request; once it merges, the package is published to npm with provenance. |

## Credits

A fork of [UrielCh/proxmox-api](https://github.com/UrielCh/proxmox-api),
maintained by [virtbase](https://virtbase.com).

## License

[MIT](LICENSE)
