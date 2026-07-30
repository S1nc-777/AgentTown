# Task 7 Report: Review State and Git Workflow Coordinator

## Status

Implemented Task 7 on `codex/p1b-git-collaboration` from base `39a34d5`.
Task 8, the full implementation plan, README, and specifications were not read
or changed.

## Delivered

- Added asynchronous `ReviewService.recordDecision` with runtime review parsing,
  exact configured reviewer authorization, self-review rejection, active
  company/run/task/workspace/latest-revision/package binding, immutable evidence
  package verification, reviewed-manifest equality, and a post-filesystem
  verification rebind.
- Approval changes only the submission to `approved`; the task remains in
  `review` for Task 8 integration. Advisory findings are retained in the
  immutable decision.
- Rejection changes the reviewed revision to `changes_requested`, returns the
  same owner directly to `running`, and increments `reviewLoopCount`. At the
  configured `maxReviewLoops` boundary (including configurations 0 and 1), it
  blocks the task and creates one deterministic, idempotent pending user
  approval.
- Added CoreStore atomic bundles for immutable validated submission creation,
  package-backed review start, and review decision + submission + task +
  optional approval + events. Listener exceptions remain isolated after the
  durable commit. The legacy low-level review-decision writer is now
  insert-only and exact-idempotent.
- Added `GitWorkflowCoordinator.assignTask`, `submitTask`, and `recordReview`.
  Assignment creates and verifies the durable task worktree before assignment
  delivery, injects exact `WritableTaskContext`, and changes the task to
  `running` only after delivery succeeds. Worktree failure sends nothing;
  delivery failure leaves a durable `ready` task/workspace for safe retry.
- Submission runtime-parses structured input, requests idempotent grants before
  execution or revision/package creation, returns pending/rejected decisions
  without executing, rejects configured-ID aliases, runs exact configured or
  approved commands, rejects every non-`passed` result, validates Git facts,
  creates an immutable increasing revision, creates and verifies the evidence
  package, atomically enters review, and sends exact `ReviewTaskContext` to the
  single authorized non-owner reviewer. Reported results are never used as
  authoritative outcomes.
- Added the small `TaskWorkflow` boundary with default `FakeTaskWorkflow` and
  optional `GitTaskWorkflow`. Existing P1A orchestration retains immediate fake
  approval completion; only a coordinator that matches the current active run
  and git-worktree task handles P1B actions. Direct Git `task.start`,
  `task.request_review`, and TaskService completion paths cannot bypass the
  coordinator/integration gate.
- Strengthened `ActionPolicy` so reviewer IDs must be fixed-roster
  `review_package` employees, review actors must use that workspace, task
  assignees must be fixed-roster `git_worktree` employees, and an optional
  authoritative task lookup rejects self-review.
- Exported the new services, workflow boundary, outcomes, options, and approval
  record from Core.

## TDD Evidence

### Initial service RED

Command:

```powershell
pnpm exec vitest run test/review-service.test.ts test/git-workflow-coordinator.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1
```

Observed:

- 2/2 suites failed;
- no tests were collected;
- failures were exactly the missing
  `src/git/review-service.ts` and
  `src/git/git-workflow-coordinator.ts` modules.

### Initial GREEN

The same two files passed 15/15 tests after the first production
implementation.

### Additional RED -> GREEN cycles

- Direct `TaskService.transition(..., "completed")` initially completed an
  approved Git submission. The focused regression failed 1/1, then passed
  after TaskService added the integration-only completion gate.
- A suggested validation command could reuse a configured ID with different
  arguments and execute the configured definition, while the legacy
  `putReviewDecision` API could overwrite an existing revision. The combined
  targeted run failed 2/2, then passed 2/2 after conflict rejection and
  immutable decision insertion.

### Final focused GREEN

```powershell
pnpm exec vitest run test/review-service.test.ts test/git-workflow-coordinator.test.ts test/orchestrator.test.ts test/action-policy.test.ts test/task-service.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1
```

- 5 files passed;
- 68 tests passed;
- 0 failed.

The wider storage/migration/workflow focused run passed 108/108 tests across
seven files.

## Verification

### Core full run

```powershell
pnpm exec vitest run --reporter=dot --no-file-parallelism --maxWorkers=1
```

- 15 files passed and 2 files reported cleanup/test-fixture failures;
- 312 tests passed, 2 failed;
- neither failure was a Task 7 functional assertion.

The failures were:

1. `EvidencePackageBuilder > rejects validation evidence read through a
   redirected parent directory`: the tamper assertion passed, then the
   pre-existing `afterEach` concurrently removed a Windows junction and its
   target through `Promise.all`, producing `EPERM` during `rmdir`.
2. `SubmissionValidator > requires authoritative passed validation evidence
   with matching log bytes`: the pre-existing five-second test limit expired
   during the full real-Git run, followed by fixture cleanup `EBUSY`.

Per the controller boundary, no historical test, timeout, retry, or sleep was
changed. The two source suites were then run individually:

- `submission-validator.test.ts`: 24/24 passed.
- `evidence-package.test.ts`: 25/26 assertions completed; the same one test
  again failed only in the pre-existing concurrent Windows junction cleanup
  with `EPERM`.

The condition for a second full run (both isolated files GREEN) was therefore
not met, so no second full run was made.

### Type and source checks

- Root `pnpm typecheck`: passed for all eight participating workspace projects.
- `git diff --check`: passed.
- Task 7 focused and relevant CoreStore/migration regressions: passed.
- Process audit: no live Git, Vitest, or test Node process remained.

Node's experimental SQLite warning is expected and pre-existing.

## Self-review

- Confirmed every ReviewService mutation is preceded by exact durable scope,
  reviewer, latest `in_review` revision, decision absence, package record, and
  full filesystem verification checks; facts are rebound after the async
  filesystem boundary.
- Confirmed the review transaction cannot leave an approved submission with an
  inconsistent task, or a decision without the associated task/submission and
  escalation facts. A duplicate-event injection proves the whole bundle rolls
  back.
- Confirmed no review revision, package, or decision is overwritten and stale,
  replayed, decided, mismatched-hash, malformed, unauthorized, and self reviews
  fail before mutation.
- Confirmed limits 0, 1, and 2 use the configured boundary rather than a hard
  coded default; escalation creates at most one task-scoped pending approval.
- Confirmed assignment never sends before exact durable workspace creation,
  never marks `running` before successful delivery, and preserves uncertain
  Git assets on failure.
- Confirmed submission pauses before execution/package creation for pending
  grants, never executes rejected or non-exact grants, treats
  `cleanup_failed` as a rejection after ValidationRunner's atomic pause, and
  ignores declared results when deciding success.
- Confirmed the review package is created and independently verified before the
  task/submission atomically enter review, and only the configured authorized
  reviewer receives its exact manifest path/hash context.
- Confirmed P1A tests retain fake approval-to-completed semantics while Git
  tasks cannot complete outside Task 8 integration.
- Confirmed no real Agent was run, no remote/push/destructive user-worktree
  operation was added, and no runtime dependency was added.

## Concerns

The pre-existing evidence-package Windows fixture cleanup race prevents a
fully green Core full command on this host even though its functional tamper
assertion passes. It is outside Task 7 scope and was deliberately left
unchanged.

One exact current-run fixture directory,
`C:\Users\S1nc\AppData\Local\Temp\agenttown-git-5ERaGc`, remained after the
full-run timeout/cleanup failure. It was resolved and verified under the system
temporary root, but the environment blocked the literal PowerShell recursive
removal command. No historical fixture directory was enumerated or touched.
