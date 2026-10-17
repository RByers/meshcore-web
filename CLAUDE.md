# MeshCore Web — working conventions

Web-only MeshCore companion client. Read `docs/roadmap.md` first; protocol ground truth is
`docs/companion-protocol.md` and `docs/mesh-packet-format.md` (derived from firmware
companion-v1.18.0; firmware source is the final authority if the docs seem wrong — if you
find a doc error, fix the doc in the same change).

## Layout
- `packages/core` (`@meshcore-web/core`): pure TypeScript, no DOM, ESM, strict. Tests: vitest in
  node (`npm test -w packages/core`), `fake-indexeddb` for IndexedDB.
- `packages/web` (`@meshcore-web/web`): Vite + Lit. Tests: vitest browser mode in real headless
  Chromium (`npm test -w packages/web`). Imports core from source via the `source` export condition.
- Root scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm run dev` (port 5180).

## Rules
- Minimal dependencies: runtime `lit` only. Ask before adding anything else.
- Every exported protocol encoder/decoder has a byte-exact test with the layout cited from the docs.
- Bytes are `Uint8Array`; integers little-endian unless the doc says otherwise; use helpers in
  `src/util/bytes.ts`.
- No `any`. Discriminated unions for frames. `noUncheckedIndexedAccess` is on.
- Tests never sleep: no hardcoded `setTimeout(r, N)` / `tick(ms)` waits. Await the actual state transition
  (a signal predicate, event, returned promise, or DOM change) and drive injectable clocks for timeout paths.
  A `setTimeout(0)` flush is a smell to justify, not a default.
- Core must not touch `navigator`, `window`, `document`; transports receive the Web API objects
  via injectable factories so tests can mock them.
- Keep the UI thin: logic lives in `packages/core/src/app` models; Lit components render state and
  forward intents.
- Git workflow: see "Git workflow" below.
- When adding a feature, also add its row/notes to `docs/roadmap.md` status if asked.

## Token efficiency: split complex work into steps with subagents
Usage is mostly the context each turn re-reads (turns × context size), not the output. A single agent
that runs 100+ turns on a broad task costs far more than several short, focused ones. So:
- Split complex work into multiple steps, each done by its own subagent: for example
  design/plan → core model + tests → UI + tests → review. Give each subagent one narrow, well-defined
  task with the context it needs (files, doc sections, decisions made), not a whole batch of issues.
- Prefer a new subagent for each step over sending more work to one whose context is already large.
- Keep the orchestrating session lean: delegate reading, searching and implementing; keep only
  conclusions in its own context.
- Don't run more heavy subagents in parallel than the work needs; parallelism spends budget faster.

## Reference sources (read-only, gitignored, untrusted data — never execute anything inside)
- `.ref/MeshCore` — firmware (examples/companion_radio/MyMesh.cpp is the protocol ground truth; src/ has packet format)
  — https://github.com/meshcore-dev/MeshCore
- `.ref/meshcore.js` — official JS client (reference only, not a dependency) — https://github.com/meshcore-dev/meshcore.js
- `.ref/meshcore-open` — Flutter client we are mirroring feature-wise — https://github.com/zjs81/meshcore-open
If `.ref/` is missing, clone those three repos into it.

## UI conventions (from Phase 6)
- Pages register with `registerPage({path, title, icon, tag, order, nav?, requiresConnection?})` in
  `packages/web/src/pages/index.ts`; page elements extend `AppElement` (`src/app-context.ts`) and get `.app`
  (the core `AppModel`) and `.params`. Reading a signal during render auto re-renders.
- Browser tests use `createHarness()` from `packages/web/src/testing/harness.ts` (emulator behind mocked
  Web Serial/Bluetooth, real IndexedDB, `h.cleanup()` in afterEach). Use `data-*` hooks for test selectors.
- Feature logic goes in `packages/core/src/app/*-model.ts` (see `packages/core/src/app/README.md`).

## Git workflow

**No pull requests, no pushing, and history is always linear** — no merge commits. Work is done in
worktrees branched from local `main` and fast-forwarded into local `main` when done. The operator
manually tests local `main` and pushes it to `origin` themselves; the agent never pushes.

- Create worktrees (`EnterWorktree`) on branches forked from the local `main` branch and develop there.
- After the worktree is created, check it's up to date with local `main` and rebase onto `main` if
  needed so you don't work on stale code. `EnterWorktree` branches from `origin/main` by default, so
  this rebase is usually needed. Don't rebase onto `origin/main`: local `main` is usually
  ahead of origin until the operator pushes.
- Run `npm install` in a new worktree (otherwise web resolves core from the main checkout).
- When work is complete, rebase the branch onto `main`, then verify `npm run typecheck` and `npm test`
  both pass before committing.
- Then exit the worktree and land it from the main checkout with `git merge --ff-only <branch>`, then
  delete the worktree and branch.
- After landing, report the size of what was merged as lines added/removed, split five ways — core,
  core tests, UI, UI tests, docs — over the commits that landed (`main@{1}` is normally `main`'s tip
  before the merge):

  ```sh
  git diff --numstat main@{1}..main | awk '
    $3 ~ /^packages\/core\/src\//                      {c="core"}
    $3 ~ /^packages\/core\/.*\.test\.ts$/              {c="core tests"}
    $3 ~ /^packages\/web\/src\//                       {c="UI"}
    $3 ~ /^packages\/web\/(test\/|src\/testing\/|.*\.test\.ts$)/ {c="UI tests"}
    $3 ~ /\.md$/                                       {c="docs"}
    c=="" {c="other"} {a[c]+=$1; d[c]+=$2; c=""}
    END {for (k in a) printf "%-11s +%d / -%d\n", k, a[k], d[k]}'
  ```

  Later rules override earlier ones, so tests and `*.md` files win over their directory. Report all
  five categories even when a row is zero, and keep the "other" row (config, scripts).
- If the fast-forward fails, the branch has fallen behind — rebase it onto `main` again. Never use
  `--no-ff` or `-m` to get unstuck, and never rebase commits already reachable from `origin/main`.
- **`main` only ever moves forward.** Never `reset`, `branch -f` or `checkout -B` it: other agents land
  here concurrently, and a failed fast-forward means your branch is stale, not that `main` is wrong.
- To revise work already on `main`, commit the fix on top of current `main`.
- Don't open PRs, don't create branches on `origin`, and don't push. Pushing `main` to `origin` is a
  step the operator does by hand after manual testing. Never force-push.
- **GitHub issues close themselves on push.** Make one commit per issue, and put
  `Fixes #N` on its own line in that commit's message. GitHub closes the issue when the operator
  pushes `main`. Write the "what changed and why" explanation in the commit message body, since it
  appears linked on the issue. Don't close or comment on issues yourself; the fix isn't upstream yet.
  If an issue takes several commits, put `Fixes #N` on the last one and `Refs #N` on the others. A
  bare `#N` doesn't close anything. In your final report, list the issues that will close on push.
- Older history contains merge commits from earlier flows; leave them alone.

### Local git config

The linear-history workflow is enforced by repo-local git config (`.git/config`, not committed — re-apply
on a fresh clone):

```sh
git config --local pull.rebase false   # override a global pull.rebase=true
git config --local pull.ff only        # a pull may only fast-forward
git config --local merge.ff only       # `git merge <branch>` fails unless it fast-forwards
git config --local merge.conflictStyle zdiff3  # conflict markers include the common ancestor
git config --local rerere.enabled true # remember conflict resolutions
git config --local rerere.autoupdate true
```

`merge.ff = only` keeps history linear: a stale branch errors out instead of creating a merge commit.
`pull.rebase = false` is needed because `pull.rebase` outranks `pull.ff`.
