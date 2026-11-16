# Maintaining `@virtbase/proxmox-api`

How the automation fits together, the one-time setup it needs, and what is left
for a human.

## How the pieces fit

| Workflow | Runs on | Does |
| --- | --- | --- |
| `ci.yml` | pull request, push to `main`, merge queue | Lint, types, tests, build, package shape, generated output, workflow and dependency audits. `required` is the one check to require. |
| `pr-title.yml` | pull request | Checks the title is a Conventional Commit. |
| `schema-update.yml` | daily, or manually | Looks for a new Proxmox API schema; opens a pull request when there is one. |
| `release.yml` | push to `main` | Maintains the release pull request; publishes to npm once it merges. |
| `docs.yml` | push to `main` | Builds and deploys the documentation site. |

Renovate (the hosted app, configured in `.github/renovate.json`) handles
dependency updates.

```
Proxmox publishes a schema          a dependency is updated
          |                                   |
  schema-update.yml                        Renovate
  feat / fix / feat! pull request     chore(deps) pull request
          |                                   |
          +---------- CI passes --------------+
                          |
              merges on its own (squash)
          breaking schema updates wait for you
                          |
                 release.yml on main
        release-please opens the release pull request
                          |
              CI passes, merges on its own
                          |
        tag + GitHub release + npm publish (provenance)
```

What a human still does:

- **Review breaking schema updates.** A pull request labelled `breaking` does
  not merge on its own. Read it, then merge it; the major release follows.
- **Approve major dependency updates** from Renovate's dependency dashboard.
- **Move to a new Proxmox major** when one is released — see
  [below](#a-new-proxmox-ve-major).

## One-time setup

The repository works without these, but nothing is automatic until they are
done.

### 1. Repository settings

**Settings → General → Pull Requests**

- Allow **squash merging** only, with the default commit message set to
  **Pull request title** and no description. The title alone decides the
  release; a pull request body can quote text such as `BREAKING CHANGE:` that
  release-please would act on.
- Enable **Allow auto-merge**.
- Enable **Automatically delete head branches**.

**Settings → Rules → Rulesets**, on `main`:

- Require a pull request before merging, with **0** required approvals and
  code-owner review **off**. Automated pull requests have no reviewer; the
  required checks are the gate.
- Require status checks: `required` and `pr-title`.
- Allow only the squash merge method.
- Block force pushes and deletion.

### 2. A GitHub App for the automation

A pull request opened with the built-in `GITHUB_TOKEN` does not start CI until
someone approves the run, and a merge performed with it does not trigger
`release.yml`. An App token has neither limit.

1. **Settings → Developer settings → GitHub Apps → New GitHub App** (in the
   `virtbase` organisation). No webhook. Repository permissions:
   **Contents**, **Pull requests** and **Issues**: read and write.
2. Install it on this repository only.
3. Generate a private key.
4. In this repository, **Settings → Secrets and variables → Actions**:
   - variable `RELEASE_APP_CLIENT_ID`: the App's client ID
   - secret `RELEASE_APP_PRIVATE_KEY`: the private key

Until the variable exists the workflows fall back to `GITHUB_TOKEN`: pull
requests are still opened, but you have to approve their CI runs and merge them
yourself.

### 3. npm trusted publishing

Publishing uses OIDC, so there is no token to leak or rotate.

On npmjs.com, **`@virtbase/proxmox-api` → Settings → Trusted Publisher → GitHub
Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `virtbase` |
| Repository | `proxmox-api` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

Tick **allow `npm publish`**. New configurations default to staged publishing,
which needs a human to approve each release with 2FA.

A new configuration expires unless a publish succeeds within 48 hours, so set
it up shortly before a release. Afterwards, under **Publishing access**, choose
**Require two-factor authentication and disallow tokens**, and delete the old
`NPM_TOKEN` secret from the `npm` environment.

In GitHub, **Settings → Environments → `npm`**: restrict deployment to `main`,
and leave **Required reviewers** empty unless you want to click through every
publish.

### 4. Renovate

Install the [Renovate app](https://github.com/apps/renovate) on this
repository. It reads `.github/renovate.json`; nothing else is needed.

### 5. Documentation site

**Settings → Pages → Source: GitHub Actions.** The site is served at
<https://virtbase.github.io/proxmox-api/>, which is why
`docs/.vitepress/config.ts` sets `base: "/proxmox-api/"`. Change both together
if the site moves to a custom domain (`base: "/"`).

## Schema updates

Proxmox publishes its API schema inside the `pve-docs` package.
`packages/generator/schema.lock.json` pins one version of it, and
`schema-update.yml` checks daily for a newer one. See
[`packages/generator/README.md`](packages/generator/README.md) for the
mechanics.

To check now: **Actions → Schema update → Run workflow**, or locally:

```bash
bun run codegen:update
```

The pull request title depends on what changed:

| Change | Title | Merges on its own | Release |
| --- | --- | --- | --- |
| Something removed or narrowed | `feat(api)!: …` | no, labelled `breaking` | major |
| Only additions | `feat(api): …` | yes | minor |
| Descriptions or metadata only | `fix(api): …` | yes | patch |

### Reviewing a breaking update

The pull request body lists every breaking change, including generated types
that were renamed or removed, and `docs/reference/api-changelog/` in the diff
has the full detail. Check that:

- each one is a real change in Proxmox, not a generator regression — a sudden
  wave of "removed" across unrelated endpoints points at the generator;
- nothing in `model.ts` was renamed that should not have been.

Then merge. If Proxmox simply corrected its documentation and nothing breaks in
practice, you may retitle the pull request to `feat(api): …` before merging to
release a minor instead.

### An indexed property without a bound

If the run warns

```
Warning: no index bound known for <prefix>; emitted as unbounded keys.
```

Proxmox added an indexed property (`net[n]`-style) that
`packages/generator/src/index-bounds.ts` does not know. The types stay usable.
Look up the constant in the Proxmox source, add it to the table and regenerate.

### A new Proxmox VE major

A new major lives in a new apt suite, named after the Debian release it is
built on. The update job stays on the suite in `schema.lock.json` and prints a
warning once a later suite has a release.

To move: change `suite` in `packages/generator/schema.lock.json` (for example
`trixie` to `forky`), run `bun run codegen:update`, and open a pull request
titled `feat(api)!: …`. Add the new codename to `LATER_SUITES` in
`packages/generator/src/cli.ts` if it is not there yet.

## Releases

1. Changes land on `main` with Conventional Commit titles.
2. release-please opens or updates **chore: release main** with the version
   bump and the changelog entry.
3. Once CI passes it merges, release-please tags the commit and creates the
   GitHub release, and the `publish` job publishes that tag to npm.

A release pull request only appears when something under `packages/api`
changed in a way that releases; dependency and CI updates do not.

To hold a release back, close the release pull request or convert it to a
draft. It is recreated on the next push to `main`.

### Checking a release

```bash
npm view @virtbase/proxmox-api version
npm audit signatures
```

### When a publish fails

The tag and the GitHub release exist, but npm does not have the version. Fix
the cause, then **Actions → Release → Run workflow** with the tag. That runs
only the publish job, against that tag.

### A bad release

A version can only be unpublished within 72 hours, and doing so breaks anyone
who installed it. Publish a fix instead, and steer people off the bad one:

```bash
npm deprecate @virtbase/proxmox-api@4.0.1 "Broken build, use 4.0.2"
```

## Dependencies

Renovate opens pull requests on Monday mornings. Updates must be seven days
old before they are proposed — the same cooling-off period `bunfig.toml`
enforces on install — and merge once CI passes. Majors wait for approval in the
dependency dashboard issue.

The published package has no runtime dependencies, so these updates are tooling
only and release nothing.

To update by hand: change the version in the relevant `package.json`, run
`bun install`, and commit the lockfile.

## Troubleshooting

**An automated pull request's CI says "action required".**
It was opened with `GITHUB_TOKEN`. Approve the run, or finish
[the App setup](#2-a-github-app-for-the-automation).

**A pull request does not merge although CI passed.**
Auto-merge is off, or the ruleset requires an approval — see
[repository settings](#1-repository-settings).

**A pull request merged but no release appeared.**
The merge was performed with `GITHUB_TOKEN`, which does not trigger
`release.yml`. Push any commit to `main`, or finish the App setup.

**No release pull request appears.**
Nothing under `packages/api` changed in a releasing way since the last tag.

**Publish fails with `ENEEDAUTH` or a 404 on PUT.**
The trusted publisher does not match: the workflow filename, the environment
name and the repository must be exactly as in
[step 3](#3-npm-trusted-publishing), and `npm publish` must be allowed.

**CI fails on `codegen:check`.**
Generated output was edited by hand, or the generator changed without
regenerating. Run `bun run codegen` and commit the result.

**`pr-title` fails.**
The title is not a Conventional Commit. Edit the title; the check reruns.
