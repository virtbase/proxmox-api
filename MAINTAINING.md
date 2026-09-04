# Maintaining `@virtbase/proxmox-api`

Everything a maintainer needs: first-time setup of GitHub, npm and the docs
site, then the day-to-day loop.

For contributing (commit conventions, local checks) see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Contents

1. [How the pieces fit](#1-how-the-pieces-fit)
2. [GitHub repository setup](#2-github-repository-setup)
3. [npm setup](#3-npm-setup)
4. [Documentation site setup](#4-documentation-site-setup)
5. [The first release](#5-the-first-release)
6. [Publishing, day to day](#6-publishing-day-to-day)
7. [Keeping up with Proxmox](#7-keeping-up-with-proxmox)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. How the pieces fit

Four workflows, each with one job:

| Workflow | Runs on | Does |
| --- | --- | --- |
| `ci.yml` | pull request, push, merge queue | Lint, typecheck, test, build, validate the packed package, check commit subjects. |
| `docs.yml` | pull request, push | Builds the docs site; deploys to Pages on the default branch. |
| `release.yml` | push to the default branch | Maintains a release pull request. Merging it tags and publishes to npm. |
| `schema-drift.yml` | weekly, or manually | Regenerates against the live Proxmox schema; opens a pull request if it changed. |

The releasing chain is worth understanding before you touch it:

```
conventional commit  ->  release-please opens/updates a release PR
                              (version bump + CHANGELOG entry)
        you merge it  ->  tag pushed, GitHub release created
                              -> publish job runs
                                   -> npm publish --provenance
```

Nothing publishes without a merged release pull request. There is no manual
publish path by design, so the tag, the changelog and the tarball can never
disagree.

---

## 2. GitHub repository setup

### 2.1 Create and push

```bash
gh repo create virtbase/proxmox-api --public --source=. --remote=origin --push
```

The repository must be **public** if you want npm provenance — sigstore will not
attest a private build. It also has to match the `repository.url` in
`packages/api/package.json`, or npm rejects the provenance claim.

If you push by hand, keep the full history: the changelog links to commits back
to 2020.

### 2.2 Let Actions open pull requests

Both release-please and the schema-drift job open pull requests, and this is
off by default.

**Settings → Actions → General → Workflow permissions**

- Select **Read and write permissions**.
- Tick **Allow GitHub Actions to create and approve pull requests**.

Miss the second one and `release.yml` fails with `GitHub Actions is not
permitted to create or approve pull requests`.

### 2.3 Protect the default branch

**Settings → Rules → Rulesets → New branch ruleset**, targeting your default
branch:

- Require a pull request before merging.
- Require status checks: `verify` and `commits` (from `ci.yml`).
- Block force pushes.

Do **not** require signed commits unless you are prepared to sign
release-please's commits too — its bot cannot.

### 2.4 Create the `npm` environment

`release.yml` publishes from an environment, which is where the token lives and
where you can require a human to approve a release.

**Settings → Environments → New environment**, named exactly `npm`.

- Optionally add yourself under **Required reviewers**. With this on, every
  publish pauses for a click. Recommended until you trust the pipeline.
- Under **Deployment branches**, restrict to your default branch.

The `NPM_TOKEN` secret goes in this environment (not repository-wide) in
[§3.3](#33-add-the-token-to-github).

---

## 3. npm setup

### 3.1 Claim the scope

`@virtbase` is a scope, and you need to own it:

```bash
npm login
npm org create virtbase     # for an organisation
```

A free organisation can publish unlimited **public** packages. Scoped packages
default to restricted, which is why the publish command passes
`--access public`.

### 3.2 Create an automation token

**npmjs.com → Access Tokens → Generate New Token → Granular Access Token**

- **Expiration**: set a real one — 90 days — and put the renewal in a calendar.
- **Packages and scopes**: read and write, limited to `@virtbase/proxmox-api`.
  Do not grant the whole scope.
- **Organizations**: no access needed.

Choose *Granular*, not *Classic*. A classic automation token works but is
unscoped and unexpiring, so a leak is unbounded.

> **2FA:** if your account enforces two-factor for publishing, a granular token
> satisfies it for automation. You do not need to weaken the account setting.

### 3.3 Add the token to GitHub

**Settings → Environments → `npm` → Add environment secret**

- Name: `NPM_TOKEN`
- Value: the token from §3.2

### 3.4 What provenance needs

The publish job already sets this up; it is listed so you know what breaks it:

- `id-token: write` permission on the job.
- A **public** repository.
- `npm publish --provenance`, run by **npm** — bun cannot emit provenance,
  which is why the job installs Node alongside Bun.
- `repository.url` in `packages/api/package.json` matching the real repo.

Once published, the npm page shows a green *Provenance* block linking back to
the workflow run and commit that built the tarball.

---

## 4. Documentation site setup

### 4.1 Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

Do not pick "Deploy from a branch" — `docs.yml` uploads an artefact and deploys
it directly, and the branch option would look for files that are never
committed.

The first deploy happens on the next push to the default branch. The URL is
`https://virtbase.github.io/proxmox-api/`.

### 4.2 The base path has to match

`docs/.vitepress/config.ts` sets:

```ts
base: "/proxmox-api/",
```

That is correct for a project page. Every stylesheet and script 404s if it is
wrong, so:

| Where the site lives | `base` |
| --- | --- |
| `virtbase.github.io/proxmox-api/` | `"/proxmox-api/"` |
| A custom domain, or `virtbase.github.io` | `"/"` |

### 4.3 Custom domain (optional)

Add a `CNAME` DNS record pointing at `virtbase.github.io`, enter the domain
under **Settings → Pages → Custom domain**, tick **Enforce HTTPS**, then set
`base: "/"`.

### 4.4 Editing the docs

```bash
bun run docs:dev     # http://localhost:5173
bun run docs:build
```

Guides in `docs/guide/` and the client reference in `docs/reference/client.md`
are hand-written. **`docs/reference/endpoints/` is generated** — edits there are
overwritten and CI rejects a stale copy.

---

## 5. The first release

One decision to make before the pipeline runs.

`.release-please-manifest.json` says `1.1.1`, inherited from upstream. But
`@virtbase/proxmox-api` has never been published under that name, and the
pending changes are heavily breaking. Two defensible options:

**A. Continue upstream's numbering (recommended).** The changelog is continuous
with the fork's history, and `2.0.0` signals the break to anyone migrating from
`proxmox-api`. Leave the manifest alone; the first `feat!` commit produces
`2.0.0`.

**B. Start fresh at `1.0.0`.** Treat it as a new package. Set the manifest and
`packages/api/package.json` to `0.0.0` and add `"release-as": "1.0.0"` to the
package block in `release-please-config.json` for one release, then remove it.

Either way, the pending work is already breaking, so commit it as:

```
feat!: fork as @virtbase/proxmox-api targeting Proxmox VE 9

BREAKING CHANGE: ESM only, renamed package, PVE 9 model, no undici dependency.
```

### The `## Unreleased` section

`packages/api/CHANGELOG.md` currently has hand-written notes under
`## Unreleased` that describe the fork in far more detail than commit subjects
ever could. release-please will insert its generated entry *above* that heading.

On the first release, fold the two together by hand: move the prose under the
generated `## [2.0.0]` heading and delete `## Unreleased`. It is a one-off —
after that, release-please owns the top of the file.

---

## 6. Publishing, day to day

### The loop

1. Merge pull requests using conventional commit subjects.
2. release-please opens or updates **chore(main): release ...**. It stays open,
   accumulating changes.
3. Read it. The diff is the version bump plus the changelog entry — check the
   bump matches what actually changed.
4. Merge it. The tag, the GitHub release and the npm publish follow.
5. If the `npm` environment has required reviewers, approve the run.

### Which prefix produces which bump

| Commit | Result |
| --- | --- |
| `fix:` | patch — `2.0.0` → `2.0.1` |
| `feat:` | minor — `2.0.0` → `2.1.0` |
| `feat!:` or a `BREAKING CHANGE:` footer | major — `2.0.0` → `3.0.0` |
| `refactor:`, `docs:`, `perf:`, `build:` | changelog only, no bump |
| `chore:`, `test:`, `ci:`, `style:` | nothing |

A release pull request containing only no-bump commits will not appear. That is
correct: there is nothing for a consumer to install.

### Verifying a release

```bash
npm view @virtbase/proxmox-api version
npm view @virtbase/proxmox-api dist-tags
```

The npm page should show the provenance block. To check the tarball's contents
before any of this, run `bun run lint:package` locally — it packs the package
and validates the exports map and type resolution.

### If you must publish by hand

Only when Actions is down. It bypasses provenance and every gate:

```bash
bun install && bun run build
cd packages/api && npm publish --access public
```

Afterwards, tag the commit to match, or release-please will lose track of where
it is.

### Unpublishing

You mostly cannot — npm allows it only within 72 hours, and it breaks anyone who
already installed. Publish a fixed patch instead. To stop a bad version being
resolved:

```bash
npm deprecate @virtbase/proxmox-api@2.0.1 "Broken build, use 2.0.2"
```

---

## 7. Keeping up with Proxmox

Proxmox rewrites its published schema **in place**, with no version to pin. So
"which Proxmox version does this support" is answered by when you last
regenerated.

`schema-drift.yml` runs weekly and opens a pull request when upstream no longer
matches what is committed. To run it now: **Actions → Schema drift → Run
workflow**. By hand:

```bash
bun run codegen        # fetch and regenerate
bun run codegen:check  # is the committed copy current?
```

### Reviewing a drift pull request

It is committed as `feat!`, so merging it releases a major version. Before you
merge, read the `model.ts` diff for:

- **Removed endpoints** — breaking. Anyone calling one stops compiling.
- **Narrowed types** — an enum losing a member, a parameter becoming required.
  Also breaking.
- **New endpoints, widened enums** — additive and safe.

If the diff is purely additive, downgrade the commit to `feat:` when merging so
consumers get a minor bump rather than a major one.

### New indexed properties

If the generator warns:

```
Warning: no index bound known for <prefix>; emitted as unbounded keys.
```

Proxmox added an indexed property (`net[n]`-style) that
`packages/generator/src/index-bounds.ts` does not know about. The generated
types stay usable, but the slot count is unbounded until you look up the
constant in the Proxmox source and add it. That file documents where each
existing number came from.

### Dependencies

Dependabot opens grouped pull requests weekly with conventional-commit
prefixes, so they flow through the same pipeline. The package itself has **no
runtime dependencies** — every bump is tooling, and CI passing is enough.

---

## 8. Troubleshooting

**`GitHub Actions is not permitted to create or approve pull requests`**
[§2.2](#22-let-actions-open-pull-requests) — the second checkbox.

**No release pull request appears.**
Nothing since the last tag bumps a version. Check with
`git log $(git describe --tags --abbrev=0)..HEAD --oneline`; if everything is
`chore:` or `docs:`, that is correct behaviour.

**Publish fails with `ENEEDAUTH` or `E403`.**
`NPM_TOKEN` is missing, expired, or scoped to the wrong package. Confirm it is
on the **`npm` environment**, not repository secrets — the job cannot see
repository-level secrets when it declares an environment.

**Publish fails on provenance.**
The repository is private, `repository.url` does not match, or `id-token:
write` was dropped from the job.

**Docs deploy succeeds but the site is unstyled.**
`base` in `docs/.vitepress/config.ts` does not match the URL —
[§4.2](#42-the-base-path-has-to-match).

**CI fails on `codegen:check`.**
Generated output was edited by hand, or regenerated against a schema that has
since changed. Run `bun run codegen` and commit the result.

**`commitlint` fails on a pull request.**
A commit subject is not conventional. Rewrite the history — the bump and the
changelog are derived from those subjects, so this is not cosmetic.
