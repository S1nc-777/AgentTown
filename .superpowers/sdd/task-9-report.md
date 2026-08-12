# P1B Task 9 Implementation Report

## Status

DONE

Base commit: `428bce9`

## Implemented

- Added required nullable `TaskRecord.conflictForTaskId` and required nullable
  durable submission `supersedes` facts, with strict runtime parsing and honest
  constructor/fixture updates.
- Added `ConflictService` and its public Core export.
- Captured an exact terminal conflicted attempt into one deterministic,
  idempotent, unassigned conflict task while atomically blocking the original.
- Prepared resolution workspaces from the current formal integration SHA,
  reproduced the reviewed commits with `cherry-pick --no-commit`, and required
  the authoritative unmerged path set to equal the captured scope.
- Requested idempotent user review when the conflict scope changed.
- Derived supersession facts from immutable Core state rather than Agent text.
- Wired conflict workspaces and conflict-attempt creation through the Git
  workflow coordinator and resolution completion through IntegrationService.
- Added the strict CoreStore completion bundle that atomically commits the
  resolution attempt/submission, supersedes the original submission, completes
  both tasks, advances run/workspace facts, and publishes authenticated events
  only after the transaction commits.
- Hardened completed-resolution replay so it revalidates the original terminal
  conflicted attempt, superseded submission, completed original task, exact
  supersession link, and original completion event without re-executing Git.

## TDD evidence

- Initial contract/service RED: focused Task 9 tests failed because conflict
  metadata and `ConflictService` did not exist; contract/create/preparation/
  coordinator slices were then brought GREEN incrementally.
- Completion focused baseline after resume: `conflict-service.test.ts` 8/8
  passed.
- Replay regression RED: after changing the original submission from
  `superseded` back to `queued`, completed resolution replay incorrectly
  resolved as `integrated`.
- Replay GREEN: the two focused replay tests passed 2/2 after binding the full
  supersession chain in the committed-attempt replay path.
- Atomic rollback coverage: duplicate final event insertion fails after bundle
  row writes are attempted and the SQLite transaction restores every run,
  workspace, attempt, submission, task, and event fact; focused test passed 1/1.
- Public API RED: importing `ConflictService` from Core returned
  `ConflictService is not a constructor`; after adding the export the focused
  test passed 1/1.
- Typecheck RED: the coordinator test harness used overly broad `vi.fn`
  signatures that did not satisfy exact optional interfaces. Accurate function
  signatures fixed the compile error; coordinator suite passed 15/15.

## Verification

- Required serial suites:
  `conflict-service.test.ts integration-service.test.ts task-service.test.ts`
  — 3 files, 49 tests passed.
- Directly affected serial suites:
  coordinator, review, evidence, submission validation, workspace manager,
  migrations, orchestrator, checkpoint — 8 files, 182 tests passed.
- Fresh combined Core gate — 10 files passed and 230 tests passed; one existing
  evidence fixture cleanup failed with Windows `EPERM` while removing an
  external redirected-parent directory. The failing evidence suite was then
  run alone without code changes and passed 1 file, 26 tests.
- Runtime contract — 3 files, 30 tests passed.
- P1A E2E — 2 files, 9 tests passed.
- Root `pnpm typecheck` — passed for all workspace projects.
- `git diff --check` — passed (only Git line-ending notices).

## Self-review

Reviewed the full Task 9 diff for strict identity/ownership binding, DAG-cycle
avoidance, immutable conflict scope, Git mutation ordering, candidate/formal
state separation, exact supersession metadata, atomic rollback, event listener
isolation, terminal attempt replay, public exports, and all required model
constructors. No unresolved Task 9 correctness issue found.

## Concerns

- Windows occasionally leaves the historical redirected-parent evidence
  fixture directory busy during suite cleanup (`EPERM`). The same suite passed
  standalone. No timeout, retry, sleep, cleanup implementation, or historical
  fixture was changed, as required.
- Task 10 restart reconciliation is intentionally not implemented.

## Independent review fix pass

Resolved four Important findings in a second TDD pass:

- Resolution submissions that conflict again now preserve the new attempt as
  terminal `conflicted`, clean the verified candidate, create one deterministic
  pending user-review request containing the original and authoritative new
  conflict sets, and return `reconciliation_required`. They never create a
  nested conflict task. Replay returns the same attempt without running Git or
  producing another approval.
- Review-start, review-decision, queue, and prepared-integration bundles now
  compare the complete immutable submission record (normalizing only the exact
  status transition) so callers cannot clear or replace `supersedes`.
- Resolution completion now binds submission run/task/revision directly to the
  attempt, compares the complete durable submission record, and requires an
  exact active formal integration-workspace record with null task/employee
  ownership and the expected advanced head.
- Conflict creation now authenticates exactly two distinct Core events, their
  types, task identities, null causation, event-ID links, and exact payloads.
  Omitted, extra, duplicate-ID, and forged-payload bundles roll back.

Review-fix evidence:

- Focused four-file gate: 4 files, 61 tests passed.
- Required serial gate: 3 files, 52 tests passed.
- Directly affected serial gate: 8 files, 183 tests passed.
- Runtime contract: 3 files, 30 tests passed.
- P1A E2E: 2 files, 9 tests passed.
- Root typecheck and `git diff --check`: passed.
