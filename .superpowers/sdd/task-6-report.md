# Task 6 Report: Submission Validation and Immutable Review Packages

## Scope

- Branch: `codex/p1b-git-collaboration`
- Base: `31ce670d5a6e1a8ed5180a3e539da02e6c00c9a6`
- Brief: `.superpowers/sdd/task-6-brief.md`
- Task 7, README, specifications, and the full implementation plan were not
  read or changed.

## Delivered

- Added `SubmissionValidator` with runtime submission schema parsing and
  authoritative Git derivation of the exact non-empty ordered commit range,
  canonical bounded commit metadata, clean task branch/head/base facts,
  binary-aware file metadata, raw blob SHA-256 hashes, and a text-only patch.
- Bound both submission validation and package creation to the authoritative
  CoreStore task: the task must belong to the run's company, remain in
  `running` or `review`, and still be owned by the task workspace employee.
- Rejected omitted, foreign, reordered, and duplicate commits; dirty index,
  worktree, or untracked state; in-progress Git operations; changed task
  branch/head/base facts; and gitlink/submodule changes.
- Read warning and hard diff limits only from the persisted company definition
  bound to the run. Patch capture is configured above the permitted hard limit
  so a legal configured patch is measured rather than truncated, while Git
  metadata, blobs, validation logs, and commit fields remain independently
  bounded.
- Modeled current, renamed, and deleted binary content from bounded raw Git
  blob bytes. Git symlink mode `120000` is hashed as the link-target blob and
  never followed through the workspace filesystem. Binary bytes, base64, and
  `GIT binary patch` data never enter `changes.patch`.
- Resolved requested validation command IDs to exact configured commands or
  exact approved grants, selected authoritative passed `ValidationRunRecord`
  facts from CoreStore, and verified run/task/workspace ownership, exact command
  definitions, safe parent-directory identity, log size, and SHA-256 over the
  actual redacted log bytes. Caller `reportedResults` remain declaration-only.
- Added `EvidencePackageBuilder.create` and `verify` with the strict package
  layout, stable sorted JSON and LF output, exclusive file creation, manifest
  written last, fsync where supported, full pre/post-publish verification, and
  an exclusive sibling publish reservation.
- Package creation retains the original parsed submission, reruns
  `SubmissionValidator` immediately before any package write, recomputes patch
  bytes against the current persisted company hard limit, and compares every
  scalar, commit, file, patch, warning, declaration, and authoritative
  validation byte against the caller's `ValidatedSubmission`.
- Every Git diff plumbing invocation explicitly disables external diff and
  textconv. Markdown source text is normalized from CRLF or CR to LF before
  bytes are written.
- Published each revision to its immutable destination only after repeated
  directory identity and destination-absence checks. Existing destinations are
  accepted only when an exact durable CoreStore record exists and every
  manifest path, size, and hash re-verifies; otherwise creation fails closed
  without overwrite.
- Preserved uniquely owned temporary evidence after injected database failure
  and demonstrated retry convergence. Temporary cleanup is limited to the
  exact unique directory identity owned by the current attempt.
- Made the legacy `putReviewPackage` API insert-only and exact-idempotent.
  Added `commitReviewPackageCreation` to commit the package fact and
  `review.package.created` event in one transaction; listener failures remain
  isolated after the durable commit.
- `verify(record)` now requires an exact authoritative CoreStore record and
  rechecks the manifest hash, every listed file hash and size, exact path set,
  totals, directory identities, traversal, symbolic links, junctions, and
  reparse escapes without mutating evidence on failure.

## TDD Evidence

### Initial services

Command:

```powershell
pnpm exec vitest run test/submission-validator.test.ts test/evidence-package.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1
```

Initial RED:

- 2 files failed.
- 20 tests failed because `SubmissionValidator` and
  `EvidencePackageBuilder` were absent.
- After adding binary delete/rename/symlink safety cases, 23/23 tests still
  failed for the same missing-service reason before production implementation.

Initial GREEN:

- 2 files passed.
- 23 tests passed.

### Active workspace and database recovery

Targeted RED:

- Forged `ValidatedSubmission` workspace facts produced a package.
- Injected database failure deleted the uniquely owned temporary evidence.
- 2 targeted tests failed and the directory-junction verification control
  passed.

Targeted GREEN:

- Builder now rechecks the active registered workspace facts.
- Database failure preserves the exact owned temp and a later retry converges.
- 3/3 targeted tests passed.

### Review findings

The read-only reviewer reported one Critical, three Important, and one Minor
finding. Six targeted regressions were added before fixes:

- legacy review-package upsert overwrote immutable records;
- a destination appearing in the final publish window was not represented by
  an injectable deterministic race;
- submission validation followed a redirected validation parent directory;
- package creation followed a redirected validation parent directory;
- `verify` accepted a record absent from CoreStore;
- unsupported submission schema versions passed at runtime.

Targeted RED command failed 6/6 for the expected reasons. After insert-only
storage, exclusive publish reservation and late absence check, full parent path
and read-boundary identity validation, exact durable-record verification, and
runtime schema parsing, the same command passed 6/6.

Final focused GREEN:

- 2 files passed.
- 50 tests passed after the independent-review follow-up.
- 0 failed.

### Independent-review follow-up

A second independent review requested five additional hardening changes. The
state-model audit selected `running | review` as the only submission/package
states because TaskService names its awaiting-review state `review`.

Targeted RED:

- 17 tests failed for expected missing behavior and one existing authoritative
  hard-limit control already passed.
- Failures covered forged caller commits/files/patch/patchBytes/warnings and
  oversized caller patch; task absence, reassignment, blocked/completed/failed
  state; configured binary textconv output entering the patch; CR/CRLF
  Markdown bytes; and destination replacement immediately after rename.

Targeted GREEN:

- 18/18 selected tests passed after authoritative builder rederivation,
  persisted task ownership/state checks, explicit
  `--no-textconv --no-ext-diff`, LF normalization, and post-rename owned
  directory identity comparison.
- The two old validation-package fixtures were upgraded to generate real
  authoritative validation results, after which the final focused suite passed
  50/50.

## Final Verification

- Focused:
  `pnpm exec vitest run test/submission-validator.test.ts test/evidence-package.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 2 files passed
  - 50 tests passed
  - duration 123.67s
- Core full:
  `pnpm exec vitest run --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 15 files passed
  - 297 tests passed
  - duration 229.88s
- Root `pnpm typecheck`
  - all 8 participating workspace projects passed
- `git diff --check`
  - passed
- Process audit
  - no live Git, Vitest, or Node validation/test process remained

The Core runs emitted only the pre-existing Node experimental warning for
`node:sqlite`.

## Self-review

- Confirmed all production Git child processes use argument arrays,
  `shell: false`, hidden windows, noninteractive prompting, stable C locale,
  timeouts, and explicit output/blob bounds.
- Confirmed submission-provided commits and results are never authoritative;
  commit/file/patch facts and validation records/logs are independently
  derived.
- Confirmed no workspace symlink is followed for file hashing, no gitlink is
  accepted, and binary bytes never enter the patch.
- Confirmed every finalized payload file is represented in the manifest,
  `manifestHash` is the SHA-256 of actual manifest bytes, and verification
  rejects missing, changed, extra, redirected, or traversing paths.
- Confirmed final package facts/events commit only after final filesystem
  verification, durable listener exceptions do not become false failures, and
  an injected database failure cannot claim package creation.
- Confirmed no destination or tampered package is deleted or overwritten by
  retry and all test cleanup targets only test-owned exact temporary roots.

## Concerns

Node does not expose a portable directory equivalent of
`renameat2(RENAME_NOREPLACE)`. The implementation uses an exclusive sibling
publish reservation, repeated destination absence and directory identity
checks immediately before `rename`, plus post-rename identity/hash
verification. A non-cooperating process could still race the final OS call on
a platform whose directory rename replaces an empty destination; this is the
explicit residual pure-Node OS-open race in the existing trust model, not an
unbounded or unrecorded overwrite path.
