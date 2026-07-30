# Task 8 Report: Deterministic Candidate Integration

## Status

Implemented Task 8 on `codex/p1b-git-collaboration` from required base
`c2a484815e8a507c5514198d8a49ac21af346b2f`.

Task 9 conflict-task creation, Task 10 reconciliation, real Agents, pushes,
runtime dependencies, global timeouts/retries/sleeps, and historical fixtures
were not implemented or changed.

## Delivered

- Added `IntegrationService.enqueue`, `drain`, `integrate`, and
  `recoverPrepared`, plus the public deterministic ordering helper and result,
  options, and fault-hook types.
- Rebuilds task DAG layers from persisted tasks, rejects dangling dependencies
  and cycles, derives immutable creation sequence through each exact
  `createdEventId`, and orders by zero-padded layer, sequence, then task ID.
- Keeps later same-layer work behind earlier nonintegrated tasks, requires
  completed dependencies and the exact latest approved revision, and persists
  the chosen `orderKey` in the prepared attempt.
- Rebinds the persisted company definition, active company-owned run, review
  task, exact latest submission, approval decision/package hash, formal ref,
  and unique registered integration workspace before Git mutation.
- Persists the queued submission transition and one idempotent
  `integration.queued` event before selection, then persists the `prepared`
  attempt + queued submission + event in one transaction before candidate
  creation. Candidate workspaces are exact attempt-owned WorkspaceManager
  assets at the expected old integration SHA.
- Cherry-picks the reviewed commit list in declared order with an actual
  `GIT_EDITOR=true` process environment and never mutates the formal
  integration worktree for candidate application.
- On conflict, collects Git porcelain-v2 unmerged paths, aborts and verifies
  the exact clean candidate, persists conflict evidence, leaves the formal ref
  and worktree unchanged, and cleans only exactly verified candidate assets.
- Runs every configured integration command, including commands after an
  earlier non-passed result, only in the exact registered candidate workspace
  and with exact run/task/workspace/attempt bindings. Returned records must
  match their durable CoreStore facts.
- Stores the candidate SHA and ordered validation IDs while the attempt remains
  prepared, then performs one exact `git update-ref <ref> <new> <old>` CAS.
  Mismatch is not retried and returns `reconciliation_required`.
- Updates the formal worktree through a clean detached checkout of the exact
  old/new commits followed by exact ref reattachment; no reset, force checkout,
  stash, clean, or original-worktree mutation is used.
- Atomically commits the committed attempt, integrated submission, completed
  task, run integration SHA, registered integration workspace head, and both
  events. Listener exceptions remain isolated after the durable commit.
- Added exact-CAS candidate ref removal after WorkspaceManager's verified
  worktree removal. Cleanup ambiguity is preserved for reconciliation rather
  than force-deleted.
- Added `afterPrepared`, `afterRefUpdated`, and `beforeFactsCommitted` crash
  hooks. Prepared facts retain enough old/new SHA evidence for Task 10.
- Added an exact durable-attempt gate to both direct integration and queue
  draining before enqueue, UUID allocation, workspace inspection, Git,
  validation, or cleanup. Prepared and aborted attempts require
  reconciliation; conflicted, validation-failed, and exactly committed
  attempts return their durable result idempotently. Ambiguous or mismatched
  attempt identities fail closed.
- Wired approved Git reviews through coordinator `enqueue` then `drain`, while
  leaving the optional boundary absent for existing P1A/Fake workflow callers.
- Extended ValidationRunner's existing exact scope rules so an attempt-bound
  integration validation must use the one active task-null candidate workspace
  whose ref, base commit, and head commit exactly match the durable attempt.
  Final integration independently rebinds every durable validation to that same
  unique workspace.

## TDD Evidence

### Initial missing-service RED

Command:

```powershell
pnpm exec vitest run test/integration-service.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1
```

Observed:

- 1 suite failed;
- no tests were collected;
- the failure was exactly missing
  `../src/git/integration-service.js`.

The pure stable-order test then passed 1/1 after the minimal helper was added.

### Queue RED/GREEN

Two new tests failed because `IntegrationService` did not exist:

- earlier same-layer non-approved task blocks a later approved task;
- persisted dependency cycles are rejected before selection.

They passed 3/3 with the ordering test after the minimal queue implementation.

### Real-Git main-chain RED/GREEN

Success, validation-failure, and conflict tests failed 3/3 with
`candidate integration is not implemented`. After the prepared/candidate/CAS
implementation, all functional assertions passed; the sole first-run mismatch
was a corrected test assumption that a cherry-picked candidate SHA must equal
the source commit SHA.

Additional focused RED/GREEN covered coordinator approval wiring: 12/13 tests
passed and the new coordinator test failed because `enqueue` had zero calls.
Adding the explicit approval-to-integration boundary made the suite 13/13.

Focused coverage was extended to 15 tests for:

- stable order and same-layer blocking;
- cycle, stale, and foreign fact rejection before candidate mutation;
- successful candidate validation and exact ref/worktree advancement;
- conflict capture and abort;
- validation failure with formal state unchanged;
- execution of every configured integration command;
- one-shot CAS mismatch;
- final SQLite transaction rollback;
- listener isolation;
- all three crash hooks and prepared recovery discovery;
- actual `GIT_EDITOR=true`;
- coordinator enqueue/drain wiring.

### Independent-review fixes RED/GREEN

Three independent-review findings received regression tests before production
changes:

- Strict CoreStore boundary: two omission tests failed 2/17 because unsafe
  callers could omit company/run/workspace context and still mutate facts.
  Making the prepared and final bundle context mandatory at both type and
  runtime boundaries made the focused suite pass 17/17.
- Exact candidate binding: two tests failed 2/19 because attempt-bound
  validation could run in another registered candidate workspace and the final
  bundle accepted its record. Requiring one exact active candidate workspace
  at execution and final commit made the focused suite pass 19/19.
- Durable enqueue: one test failed 1/20 because a blocked same-layer submission
  stayed `approved` and emitted no queue event. An atomic idempotent queued
  submission + event bundle made the focused suite pass 20/20.

The stricter signatures also exposed ten legacy storage-test callers at
typecheck. All callers were migrated to explicit context, successful fixtures
were upgraded to the real approved → queued → prepared → validated lifecycle,
and immutable-attempt error ordering was retained. The storage suite passed
30/30.

Final focused behavior is included in the 171-test relevant-suite run below.

### Second-review replay gate RED/GREEN

The Critical replay finding was reproduced by extending the existing real-Git
tests rather than constructing synthetic success paths:

- the focused suite failed 8/20;
- committed replay was rejected at enqueue because the durable submission was
  already integrated;
- validation failure, conflict, CAS mismatch, final fact rollback, and all
  three crash windows reached the poison Git runner on their second call.

A separate mismatched-attempt test failed because replay again reached the
poison Git runner instead of rejecting the stale expected-old SHA. After adding
the single pre-mutation durable-attempt gate, the focused suite passed 21/21.

Every requested replay window now invokes both direct `integrate()` and
`drain()` where a queued submission remains. Assertions prove:

- attempt and validation counts do not increase;
- candidate creation/removal, Git, and validation receive zero replay calls;
- the formal ref does not change again;
- prepared windows and aborted attempts return reconciliation-required;
- conflict and validation failure return the existing durable attempt;
- committed replay returns integrated only after exact durable
  submission/task/run/workspace/completion-event rebinding;
- duplicate exact attempts, tampered attempt facts, and tampered committed
  facts fail closed without choosing a latest attempt.

## Verification

### Relevant Core, storage, Task 7, and workflow suites

```powershell
pnpm exec vitest run test/integration-service.test.ts test/storage-migrations.test.ts test/core-store.test.ts test/git-workflow-coordinator.test.ts test/review-service.test.ts test/validation-runner.test.ts test/workspace-manager.test.ts test/task-service.test.ts test/orchestrator.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1
```

- 9 files passed;
- 171 tests passed;
- 0 failed;
- all real-Git suites ran serially with one worker.

An earlier wider run exposed four legacy CoreStore error-order regressions and
one ValidationRunner error-order regression. Strict Task 8 status validation
was scoped to the new strict bundle, and missing-attempt ownership was restored
ahead of candidate-kind validation. The two directly affected suites then
passed 52/52 before the initial 165/165 run. After the first independent-review
fixes, the storage suite passed 30/30 and the wider run passed 170/170. After
the replay gate, the final wider run passed 171/171.

### P1A gate

```powershell
pnpm test:p1a
```

- 2 files passed;
- 9 tests passed;
- 0 failed.

### Types and source checks

```powershell
pnpm typecheck
git diff --check
```

- root typecheck passed for all eight participating workspace projects;
- `git diff --check` passed;
- only expected Git line-ending notices were printed.

Node's experimental SQLite warning is expected and pre-existing.

## Self-review

- Confirmed prepared intent is durable before candidate ref/worktree creation
  and no candidate command can run before exact company/run/task/revision/
  decision/formal-workspace binding.
- Confirmed enqueue durably changes only the exact latest approved review to
  queued, emits one identity-bound queue event, and remains idempotent while
  an earlier same-layer task blocks selection.
- Confirmed a durable attempt for the exact run/task/revision prevents all
  second-attempt and Git activity across conflict, validation failure, CAS
  mismatch, final transaction rollback, and every crash hook.
- Confirmed committed replay requires exact integrated submission, completed
  task/completion event, run SHA, and unique formal workspace facts; it does not
  infer success from attempt status alone.
- Confirmed task order never trusts mutable timestamps or Agent text; only the
  immutable task-created event sequence is used.
- Confirmed candidate commands use only the verified candidate path and
  authoritative Git/validation facts; reported submission results are ignored.
- Confirmed an attempt-bound validation cannot execute in a different
  registered candidate and final commit rejects validation not bound to the one
  exact attempt ref/base/head workspace.
- Confirmed conflict and non-passed validation leave formal ref/worktree facts
  unchanged and all configured integration commands are attempted.
- Confirmed CAS has exact old/new operands, no force update, no retry, and no
  guessed continuation.
- Confirmed the formal integration worktree changes only after candidate
  validation passes and is updated to the exact new SHA through a detached,
  clean transition.
- Confirmed the successful fact bundle includes attempt, submission, task, run,
  integration workspace, and events in one SQLite transaction; the duplicate
  event injection proves complete rollback.
- Confirmed `afterPrepared` leaves old ref + null candidate SHA,
  `afterRefUpdated` leaves new ref + old durable facts, and
  `beforeFactsCommitted` leaves exact new ref/worktree + old durable facts.
- Confirmed candidate cleanup uses Task 4 verified removal plus exact old-value
  ref deletion and never recursively removes an unproven path.
- Confirmed no conflict task, reconciliation implementation, real Agent,
  project-ref push, runtime dependency, production sleep/retry, timeout
  weakening, or historical fixture deletion entered the diff.

## Concerns

No blocking concern remains. Task 10 must consume the durable prepared intents
left by the demonstrated crash/CAS/transaction windows; Task 8 intentionally
classifies them as reconciliation-required without implementing recovery.
