# Task 10 Report: Git Checkpoints, Reconciliation and Tamper Stops

## Status and scope

Implemented Task 10 from base `5912e0c1f38fdaa0ae9d1bdca9277940fa9c1b09`.
No Task 11 CLI or Task 12 Fake E2E behavior, dependency, push, timeout, retry,
sleep, or historical fixture change was added.

## Delivered

- Added required nullable `CompanyCheckpoint.git` and explicit P1A `git: null`.
- Added strict parsing and semantic validation for Git checkpoint run, ref,
  commit, workspaces, active submission revisions, and prepared attempts.
- Added `GitReconciler` with real-Git commit/ref/worktree inspection and
  `EvidencePackage.verify` integration.
- Classifies exact facts, original-user-worktree warnings, missing commits,
  refs, worktrees and evidence, task/workspace/ref tampering, and prepared old,
  new, or third-SHA crash windows.
- New-SHA recovery uses the existing strict `commitIntegratedTask` bundle for
  ordinary submissions and the Task 9 `ConflictService.completeResolution`
  transaction for superseding resolution submissions; it does not infer or
  fabricate completion.
- Old-SHA recovery only completes a verified candidate workspace, invokes
  WorkspaceManager verified removal, CAS-deletes the exact candidate ref, and
  durably aborts the attempt. It never resets, force-checks out, cleans, or
  recursively deletes a user path.
- `missing` and `tampered` atomically pause the company/run, insert the exact
  discrepancy approval, and emit `git.tampering_detected`. A transaction
  rollback test proves an event failure leaves company/run active with no
  approval.
- Pause order is tested as: stop dispatching; abort validations under the
  existing absolute deadline; settle the in-flight intent boundary; snapshot
  verified Git facts; atomically checkpoint and pause; then interrupt/stop
  sessions. P1A keeps the original path with `git: null`.
- Recovery validates checkpoint Git facts against current durable facts,
  reconciles before changing company status to starting, and never invokes an
  Agent adapter after a missing/tampered result.
- Events state only verified classifications and exact discrepancies.

## TDD evidence

Initial required RED command:

```powershell
pnpm --filter @agenttown/core test -- git-reconciler.test.ts checkpoint-service.test.ts
```

Observed exit 1 in 154.6s. The exact Task 10 failures were:

- `git-reconciler.test.ts`: zero tests collected because
  `../src/git/git-reconciler.js` did not exist.
- checkpoint required-null test: `expected function to throw`; omitted `git`
  was still accepted.

The package script forwards the literal `--`, so this command also ran the
whole Core suite in parallel and exposed six existing submission-validator
five-second timeouts plus cleanup `EBUSY`. No timeout was changed.

Incremental RED -> GREEN:

- Required nullable checkpoint RED became 1/1 GREEN.
- Full real-Git reconciler RED again failed on the missing module; the first
  production pass reached 6/8, then 7/8, then 8/8. Fixture-owned SQLite and
  `.agenttown` state were excluded from the original-user-worktree warning.
- Lifecycle wiring RED was 0/2: snapshot returned null and recovery reached
  SessionManager. The minimal boundary implementation made both GREEN with
  exact order `abort-validations`, `settle-intent`, `snapshot`, `commit`,
  `interrupt`.
- Snapshot-verification RED failed because `snapshot()` was synchronous and
  accepted an externally changed ref; it became async and now verifies real
  ref/worktree/evidence facts first.
- Reconciler coverage grew to 13/13, then full focused reconciliation plus
  checkpoint reached 38/38.
- The CoreStore atomic test was added with the store bundle and passed 1/1;
  unlike the behavior cycles above, it was not separately observed RED.

## Fresh verification

- Direct focused serial:
  `pnpm exec vitest run test/git-reconciler.test.ts test/checkpoint-service.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 2 files, 38 tests passed, 0 failed, 36.88s.
- Complete Core serial:
  `pnpm exec vitest run --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 20 files, 384 tests passed, 0 failed, 417.28s.
- Affected Core serial gate:
  - 8 files, 157 tests passed, 0 failed.
- Runtime contract: 3 files, 30 tests passed.
- P1A: 2 files, 9 tests passed.
- Root `pnpm typecheck`: all participating workspaces passed.
- `git diff --check`: passed; only Git CRLF notices were printed.

The final literal brief command again ran the whole Core suite in parallel and
exited 1 after 159.22s: 375/384 passed; two new real-Git cases and seven
historical submission-validator cases exceeded the unchanged 5-second Vitest
limit, followed by fixture `EBUSY`. The same code passed complete Core 384/384
when run in the required single-worker Git-heavy mode above.

## Self-review and concerns

- Confirmed old/new/third SHA are distinct and no third SHA is accepted.
- Confirmed missing commit/ref/worktree/evidence are `missing`; AgentTown
  branch/worktree/manifest changes are `tampered`; only the original user
  worktree produces a warning.
- Confirmed new-SHA recovery requires queued review/task/evidence, exact passed
  validation bindings, unique candidate/integration workspaces, and the
  existing strict final transaction.
- Confirmed pause/tamper writes are atomic and Agent sessions cannot begin
  before successful reconciliation.
- Confirmed no force/reset/clean/recursive deletion was introduced.
- Concern: the brief's literal pnpm focused command is not focused because of
  the repository script's existing `--` forwarding; under parallel load it
  hits unchanged five-second real-Git test ceilings. Direct single-worker and
  complete serial gates pass.
- Runtime wiring is exposed through `CheckpointService.gitLifecycle`; current
  P1A `main.ts` intentionally does not construct P1B services and therefore
  continues to checkpoint `git: null`.

## Independent review remediation (commit after `b54cf08`)

An independent review found one critical and three important omissions in the
first Task 10 commit. All four were reproduced, fixed under TDD, and covered by
real-object or real-Git tests without adding Task 11/12 behavior.

### 1. Strict supersession recovery

Root cause: `GitReconciler.#completePrepared` unconditionally called the
ordinary `commitIntegratedTask` bundle. A resolution submission with a
non-null `supersedes` link therefore bypassed Task 9's strict resolved-conflict
transaction.

- RED:
  `pnpm exec vitest run test/conflict-service.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1 -t "recovers a resolution"`
  - 1 failed, 14 skipped. The original submission was expected to be
    `superseded` but remained `queued`.
- GREEN: the same command passed 1 test, 14 skipped, after injecting the
  existing `ConflictService.completeResolution` recovery boundary.
- Negative recovery coverage forged each original attempt, original
  submission, original task, and conflict creation event chain after CAS.
  `-t "atomically stops supersession recovery"` passed 4 tests, 15 skipped;
  every case retained the prepared resolution attempt, emitted no fabricated
  completion, and atomically paused with approval.

### 2. Verified old-SHA cleanup

Root cause: old-SHA reconciliation called cleanup before authenticating the
candidate's durable identity/path/ref/base/head against current Git, and raw
`WorkspaceTamperError` failures could escape without the atomic stop bundle.

- RED:
  `pnpm exec vitest run test/git-reconciler.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1 -t "old-SHA candidate"`
  - 4 failed: missing path and candidate mismatch were incorrectly aborted;
    missing ref and changed head leaked raw errors.
- GREEN: first 4/4, then 6/6 after durable changed-path/ref cases were added.
  The final table also covers status identity and asserts `removeVerifiedWorkspace`
  is never called for a failed precondition.
- A real-Git ref mutation immediately before verified removal passes 1/1 and
  produces a `tampered` atomic stop while the attempt remains prepared.
- SQLite's existing unique `git_workspaces.branch_ref` constraint rejected a
  duplicate durable candidate before reconciliation, so duplicate identity
  cannot be created through `CoreStore`.

### 3. Production pause fences

Root cause: the initial implementation exposed only an optional checkpoint
seam. `ValidationRunner` had no active-run registry, `IntegrationService` had
no dispatch/settlement fence, and `GitWorkflowCoordinator` had no production
action fence.

- Validation RED: `runner.abortActive is not a function`. A real child-process
  test now passes 1/1 and proves identity-safe termination and settlement under
  the caller's absolute deadline.
- Integration/coordinator RED: both production methods were missing. Their
  focused command now passes 2/2 and proves fenced dispatch.
- A real in-flight integration test initially exposed two incorrect test
  interception points as unchanged 20-second test timeouts. After systematic
  tracing identified the actual `rev-parse --verify` intent boundary, the test
  passed 1/1 (23 skipped, 5.12s): settlement remains pending until the active
  operation is released, completes within the same deadline, and rejects all
  later integration dispatch.
- Production `GitLifecycleHooks` composition RED failed module import before
  test collection. The composition plus checkpoint absolute-deadline test now
  passes 2/2 (40 skipped) and wires real coordinator, validation runner,
  integration service, and reconciler objects. `CheckpointService` supplies
  the same absolute deadline to both abort and settlement phases.

### 4. Deterministic approval episodes

Root cause: approval identity was fixed per run and replay always inserted a
new event. It could neither represent changed/decided episodes nor prove an
exact pending replay.

- RED for pending replay and changed discrepancies: 2/2 failed because replay
  duplicated `git.tampering_detected` and changed facts collided with the fixed
  approval ID.
- GREEN: canonical sorted discrepancies plus SHA-256 episode identity made the
  combined stop/episode gate pass 7/7.
- Decided-episode RED was `commitApprovalDecision is not a function`; the
  strict atomic decision bundle and suffix sequence made decided plus forged
  episode tests pass 2/2 (31 skipped).
- Self-review found a further same-ID hole: a foreign-company approval paired
  with an exact-looking tamper event was accepted. RED was “expected function
  to throw”; strict company/task/decision/created-at ownership, deterministic
  event identity, and reuse of the original pending `createdAt` made the
  episode replay/decision/foreign-owner gate pass 3/3 (33 skipped).

### Remediation verification

- Core typecheck initially found two incomplete `ActionProposal` test values
  (`TS2739`); using the existing authenticated action fixture made
  `pnpm --filter @agenttown/core typecheck` pass.
- Focused/affected serial:
  `pnpm exec vitest run test/git-reconciler.test.ts test/checkpoint-service.test.ts test/conflict-service.test.ts test/integration-service.test.ts test/validation-runner.test.ts test/git-workflow-coordinator.test.ts test/core-store.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 7 files, 143 tests passed, 300.47s.
- Complete Core serial:
  `pnpm exec vitest run --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 20 files, 407 tests passed, 500.58s.
- Runtime contract: 3 files, 30 tests passed.
- P1A: 2 files, 9 tests passed.
- Root `pnpm typecheck`: all 8 participating workspace projects passed.
- Final `git diff --check`: passed (only configured LF-to-CRLF notices).

No force/reset/clean/recursive deletion, dependency, push, production timeout,
retry, sleep, historical fixture deletion, Task 11 CLI, or Task 12 Fake E2E
behavior was introduced. P1A remains explicit `git: null`; the production
P1B lifecycle composition is exported for the later Task 11 runtime assembly.
