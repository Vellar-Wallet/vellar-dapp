# Contributing to Vellar

Thanks for your interest in contributing! Please read these rules before you
start - pull requests that don't follow them will be closed.

## The rules

1. **Fork the repo and work from your fork.** Clone your fork, make your
   changes on a branch there, and push to your fork. Never push to this
   repository directly.

   ```sh
   gh repo fork Vellar-Wallet/vellar-dapp --clone
   cd vellar-dapp
   git checkout drips
   git checkout -b my-change
   # ...work, commit...
   git push -u origin my-change
   ```

2. **All pull requests must target the `drips` branch - never `main`.**
   When you open a PR, set the base branch to `drips`. PRs opened against
   `main` are closed automatically by a bot. `main` is the release branch and
   is managed by maintainers only.

3. **Contributor changes must stay inside `contrib/`.** External PRs that
   touch any file outside `contrib/` are closed automatically by a bot, even
   if they also target `drips` correctly. See [contrib/README.md](contrib/README.md)
   for what belongs there. If your assigned issue genuinely requires changes
   elsewhere in the codebase, say so on the issue before starting - a
   maintainer will make that change or explicitly widen your scope.

4. **Only work on issues assigned to you.** If you want to pick something up,
   comment on the issue and wait to be assigned before starting. Unsolicited
   PRs for unassigned issues will be closed.

5. **Questions go to the Telegram group.** Don't open issues for questions -
   ask in [our Telegram](https://t.me/+RWPCKXXJTj45Njk0).

## Before you open a PR

CI runs formatting, typecheck, tests, and build on every PR - run them locally
first:

```sh
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

New code is expected to come with tests. See the [README](README.md) for how to
run the stack locally.

## CI pipeline stages

The main CI workflow is [.github/workflows/ci.yml](.github/workflows/ci.yml).
It runs for every pull request and for pushes to `main`, so contributors should
expect the same quality checks before review and again when maintainers merge
release-bound changes.

The pipeline runs these stages in order:

1. **Install dependencies** with `pnpm install --frozen-lockfile` so CI uses the
   exact dependency graph recorded in `pnpm-lock.yaml`.
2. **Audit dependencies** with `pnpm audit --audit-level=high` to block high and
   critical package advisories unless the risk has already been accepted through
   a documented workspace override.
3. **Format check** with `pnpm format:check` to confirm files match the shared
   formatting rules.
4. **Typecheck** with `pnpm typecheck` to catch TypeScript and workspace typing
   errors before runtime.
5. **Test** with `pnpm test`, backed by a PostgreSQL service and
   `CI_REQUIRE_DB=1`, so database-backed integration tests fail loudly if the
   test database is unavailable.
6. **Build** with `pnpm build` to verify the apps and packages can be compiled
   from a clean checkout.
7. **Mocked E2E setup and run** by installing the Chromium browser for the web
   package and running `pnpm --filter @vellar/web test:e2e:ci`; only CI-safe,
   mocked specs are included in this stage.

Two guard workflows also protect contributor PR flow:

- [.github/workflows/close-prs-outside-contrib.yml](.github/workflows/close-prs-outside-contrib.yml)
  checks PRs targeting `drips` and closes external contributions that touch
  files outside `contrib/` unless a maintainer has widened the scope.
- [.github/workflows/close-prs-to-main.yml](.github/workflows/close-prs-to-main.yml)
  handles PRs opened against `main` by redirecting non-maintainer contributions
  away from the release branch.