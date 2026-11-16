# Contributing

Thanks for taking the time.

## Getting set up

You need [Bun](https://bun.sh); the exact version is in `package.json`.

```bash
bun install
bun run verify
```

`bun run verify` runs everything CI does: Biome, type-checking, the tests, the
build, the package-shape checks, and a check that generated files are current.

## Making a change

- **Client code** lives in `packages/api/src`. Add or adjust a test in
  `src/__tests__` for anything you change — the engine tests run against a real
  local HTTP server, so they are a good place to pin down wire behaviour.
- **Generated types** come from `packages/generator`. Change the generator,
  then run `bun run codegen`. Never edit these by hand; CI rejects a stale or
  hand-edited copy:
  - `packages/api/src/model.ts` and `packages/api/src/schema-info.ts`
  - `docs/reference/endpoints/` and `docs/reference/api-changelog/`
- **Documentation** is in `docs/`. `bun run docs:dev` serves it locally.

`packages/generator/history/` records how each Proxmox schema version differed
from the last. It is written once per version by `bun run codegen:update` and
not regenerated.

## Documentation comments

Every function, method and class has a doc comment, and `bun run lint:docs`
checks it. The conventions:

- Always the expanded block form, with `/**` and `*/` on their own lines.
- [TSDoc](https://tsdoc.org/) syntax: `@param name - Description.`, `@returns`,
  `@throws A {@link SomeError} if …`, and no `{type}` annotations — the types
  are already in the signature.
- The summary is one sentence starting with a verb: "Sends …", "Returns …".
- Say what the code cannot: units, defaults, side effects, the errors thrown
  and the reason behind a decision. Do not restate the signature.
- `@example` stands alone on its line, followed by one fenced `ts` block.
- Inside a function body, `//` comments explain why, not what.

## Commit messages and pull request titles

Pull requests are squash-merged, so the **pull request title** becomes the
commit. It must follow [Conventional Commits](https://www.conventionalcommits.org/);
`commitlint` checks it in CI and in a local `commit-msg` hook.

This is not a style preference: the release version and the changelog are
generated from these titles.

| Title starts with | Effect on the next release |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:`, `fix!:`, or a `BREAKING CHANGE:` footer | major |
| `perf:`, `refactor:`, `docs:`, `build:` | patch, listed in the changelog |
| `chore:`, `test:`, `ci:`, `style:` | no release |

Only changes under `packages/api` count; a `docs:` change to the docs site
releases nothing.

## Reporting a problem with the types

The types are generated from Proxmox's own schema, so a wrong or missing type
is usually wrong upstream as well. Check the
[API viewer](https://pve.proxmox.com/pve-docs/api-viewer/) first: if it agrees
with the types, the fix belongs with Proxmox; if it does not, it is a generator
bug and belongs here.

## Releasing

Nobody publishes by hand. See [MAINTAINING.md](MAINTAINING.md).
