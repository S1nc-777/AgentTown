# Task 11 Report: P1B IPC, CLI Delivery and Explicit Cleanup

## Status and scope

Implemented Task 11 from base `9b1b902`.
No Task 12 Fake Agent E2E behavior, dependency, push, merge, timeout, retry,
sleep, global test setting, or historical temporary-directory cleanup was added.

## Delivered

- Added versioned runtime-contract views for Git workspaces, evidence,
  delivery, pending approvals, cleanup selection/preview/result, and the seven
  Task 11 IPC method signatures.
- Added real CoreServer routes for `git.workspaces.list`, `git.evidence.get`,
  `git.delivery.get`, `git.cleanup.preview`, `git.cleanup.execute`,
  `approvals.list`, and `approvals.decide`. Exact parameters are validated;
  approval decisions and cleanup execution use the existing durable mutating
  IPC idempotency boundary.
- Extended the real `GitWorkflowCoordinator` with durable workspace,
  evidence, delivery, approval, and cleanup projections. Delivery requires an
  approved, hash-bound review package and the latest passed outcome for every
  required submission and integration validation command.
- Added `CleanupService` with exact run ownership, paused/completed-state
  checks, stored path/ref resolution, real-Git path/ref/head/cleanliness
  verification, SHA-256 preview fingerprints, and mandatory re-preview before
  execution. Default cleanup removes verified worktrees only; branches and
  evidence require separate explicit selections.
- Branch deletion is compare-and-delete against the stored SHA. Evidence
  removal is limited to verified review roots and validation logs under the
  exact stored run root, then the matching SQLite rows and completion event
  are committed atomically. There is no wildcard run operation.
- Added CLI commands `workspaces`, `evidence`, `deliver`, `approvals`,
  `approve`, `reject`, and `cleanup`. Cleanup previews first, requires `--yes`
  in non-interactive use, and sends the returned fingerprint to execute.
  Approval decisions require a non-empty user reason.
- Added concise renderers. Delivery includes exact read-only diff/log commands
  and explicitly states that AgentTown did not merge into the user branch and
  did not push.

## TDD evidence

- CLI RED: `git-render.js` was missing and the new commands failed usage
  parsing. GREEN: focused CLI reached 2 files, 18 tests passed.
- Cleanup RED: `CleanupService is not a constructor` in five new behaviors.
  GREEN: the suite grew to six real-Git cases covering default worktree-only
  cleanup, explicit branch cleanup, fingerprint invalidation, dirty refusal,
  missing-ref refusal, and evidence/row cleanup.
- Coordinator RED: the new workspace and approval methods did not exist.
  GREEN: durable projections, exact approval decisions, and cleanup delegation
  passed.
- IPC RED: Task 11 methods returned unknown-method responses. GREEN: all seven
  routes passed exact parameter and delegation tests.
- Evidence regression RED: an older failed validation was rendered alongside
  the newer pass. GREEN: only the latest outcome per exact command is exposed.
- Delivery completeness RED: delivery succeeded while a required validation
  command had no outcome. GREEN: delivery now rejects until the complete exact
  validation set exists and passes.

## Fresh verification

- Final affected Core serial command:
  `pnpm --filter @agenttown/core exec vitest run test/cleanup-service.test.ts test/git-workflow-coordinator.test.ts test/core-server.test.ts test/core-store.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 4 files, 77 tests passed, 0 failed.
- Final focused CLI serial command:
  `pnpm --filter @agenttown/cli exec vitest run test/git-render.test.ts test/main.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 2 files, 18 tests passed, 0 failed.
- Complete CLI: 7 files, 40 tests passed.
- Runtime contract: 3 files, 30 tests passed.
- P1A E2E: 2 files, 9 tests passed.
- Complete Core serial: 21 files, 417/418 tests passed. The sole failure was a
  Windows `EPERM` while the historical evidence-package fixture removed its
  temporary directory. The unchanged evidence-package suite immediately
  reran alone and passed 26/26.
- Root `pnpm typecheck`: all eight participating workspace projects passed.
- `git diff --check`: passed; only configured LF-to-CRLF notices were printed.

## Self-review and boundaries

- Confirmed cleanup paths and refs come only from durable Git/evidence facts;
  CLI strings never become deletion targets.
- Confirmed dirty, redirected, missing, changed-head, changed-ref, changed-hash,
  and changed-fingerprint states fail closed before the corresponding removal.
- Confirmed branches and evidence cannot be widened from the default without
  explicit flags and cleanup cannot target `all` runs.
- Confirmed identical approval replays are idempotent and conflicting second
  decisions fail through the existing strict ValidationRunner transaction.
- Confirmed delivery is a verified preview only: it neither merges nor pushes.
- The one complete-Core failure is isolated to Windows fixture teardown rather
  than Task 11 behavior; no production or test timeout/retry workaround was
  introduced.
