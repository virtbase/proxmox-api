# proxmox-api

Typed Proxmox VE API client (`@virtbase/proxmox-api`) and the generator that
produces its types. Bun and Turborepo monorepo in TypeScript, ESM only.

## Commands

Run from the repository root.

- `bun install`: install dependencies
- `bun run verify`: run before handing a branch over
- `bun run test`, `bun run typecheck`: all packages
- `bun run check:write`: format and apply lint fixes
- `bun run codegen`: regenerate from the pinned Proxmox schema
- `bun run docs:dev`: serve the docs

## Repository map

- `packages/api`: the published client. `src/model.ts` and
  `src/schema-info.ts` are generated.
- `packages/generator`: schema download, diff and code generation.
  `schema.lock.json` pins the Proxmox schema; `history/` feeds the API
  changelog and is append-only.
- `docs`: VitePress site. `reference/endpoints/` and
  `reference/api-changelog/` are generated.
- `tooling/typescript`: shared tsconfig presets.

## Rules the tools do not check

- Bun only; never npm, pnpm, yarn or npx. The one exception is `npm publish`
  in the release workflow.
- Never edit generated files by hand. Change the generator and run
  `bun run codegen`.
- The published package has no runtime dependencies. Do not add one.
- Conventional Commits. The pull request title becomes the commit and decides
  the release, so `feat!` and `fix` are not interchangeable.
- Agents commit to their branch only. They never push, open pull requests,
  merge or touch `main`; the owner does.
- No comments in configuration or CI files.
- Every function has a TSDoc comment in the expanded block form; see
  `CONTRIBUTING.md`. `bun run lint:docs` checks it.
- Never commit secrets or print their values.
