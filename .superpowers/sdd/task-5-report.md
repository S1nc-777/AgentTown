# Task 5 Report: Structured Validation Runner and Evidence Logs

## Scope

- Branch: `codex/p1b-git-collaboration`
- Base and starting `HEAD`: `1b27f2e1000453b032ab5f395a53f858bc778809`
- Task brief: `.superpowers/sdd/task-5-brief.md`
- Public `ValidationRunner.run` options remain exactly
  `{ secretValues?: readonly string[] }`; no `timeoutMs` option was added.
- The timeout regression uses `command.timeoutSeconds = 1`.

## TDD history

The inherited Task 5 work already contained the original test-first cycle:

1. `validation-runner.test.ts` was introduced as RED while
   `ValidationRunner` was absent.
2. The runner, CoreStore atomic commit APIs, and public exports were then added.
3. The first single-worker Core run passed 229 tests and exposed one new
   CoreStore listener regression: a synchronous listener exception prevented
   later listeners from receiving an already-durable event.
4. A listener regression test was added, then event publication was changed to
   isolate each listener.
5. Redaction-expansion and multibyte log-cap regressions were added while
   hardening final evidence byte limits.

The finishing audit ran these additional explicit RED -> GREEN cycles:

### UTF-8-safe final evidence cap

- RED:
  `pnpm exec vitest run test/validation-runner.test.ts --reporter=verbose --no-file-parallelism --maxWorkers=1 -t "keeps multibyte"`
- Observed failure: the 4 MiB byte cap cut a multibyte sequence and the decoded
  final log contained `U+FFFD`.
- GREEN: stdout/stderr now use Node's UTF-8 stream decoder and both temporary
  chunk truncation and final post-redaction truncation stop at a valid UTF-8
  boundary.
- Verification: the focused test passed, the final file remained at or below
  4 MiB, and its UTF-8 text contained no replacement character.

This specifically verifies that the cap is applied to
`Buffer.from(redactedLog)` after redaction expansion, while avoiding invalid
UTF-8 or bytes beyond the cap.

### Integration-attempt ownership before execution

- RED:
  `pnpm exec vitest run test/validation-runner.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1 -t "mismatched integration"`
- Observed failure: persistence rejected the mismatched attempt, but a marker
  proved the command had already executed.
- GREEN: scope resolution now requires any supplied integration attempt to
  exist and match the run and task before authorization or spawn.
- Verification: the focused test passed and the marker was never created.

### Strict TypeScript index check

- RED: the first root `pnpm typecheck` reported TS2532 at the bounded UTF-8
  lookahead.
- GREEN: the already range-checked byte access received a local non-null
  assertion.
- Verification: the second root `pnpm typecheck` passed all workspace projects.

## Requirement audit

- **No shell:** validation commands use `spawn(executable, args)` with
  `shell: false`; timeout cleanup uses direct `taskkill.exe` arguments on
  Windows and a detached process group on POSIX.
- **Exact configured/grant authorization:** configured commands must match id,
  executable, args, cwd, and timeout exactly. Suggested commands require an
  approved grant whose SHA-256 fingerprint is the canonical JSON of
  `{ executable, args, cwd, timeoutSeconds, workspaceId }`.
- **Database scope and ownership:** run, workspace, task, registered workspace
  path, and optional integration attempt are checked before execution.
  CoreStore continues to enforce linked validation/attempt ownership.
- **Cwd boundary:** cwd must resolve beneath the registered workspace; the root
  and each existing component are checked with `lstat`/`realpath`, rejecting
  symbolic-link, junction, and reparse escapes.
- **Minimal environment:** only the small platform/runtime allowlist is copied;
  AgentTown secret/token/password/key variables are excluded.
- **Bounded interleaved log:** stdout/stderr chunks are serialized to an
  exclusive temporary file with monotonic sequence and stream labels. Output
  overflow requests process-tree termination.
- **Redaction, hash, and publication:** exact secret values plus common bearer
  and token/secret/password/API-key assignments are redacted. The final
  post-redaction UTF-8 bytes are capped, hashed with SHA-256, written to the
  temporary file, and atomically renamed into
  `.agenttown/runs/<run-id>/validation/`.
- **Durable facts and events:** grant requests, decisions, and validation
  completion facts/events use CoreStore transactions. Listener exceptions are
  isolated after the commit, so one listener cannot suppress later listeners
  or turn a durable commit into an apparent failure.
- **Rejection:** a rejected exact grant persists the user's reason in the grant
  and task-scoped decision event; later execution reports the rejection and
  never silently falls back to running.
- **Timeout/abort cleanup:** timeout and bounded-output abort share the
  process-tree termination path and an absolute cleanup deadline. The timeout
  test records both parent and child PIDs and verifies both are gone.
- **Cleanup failure:** an unverifiable cleanup becomes `cleanup_failed`, not a
  normal test failure, and atomically pauses the active Git run and active
  workspaces with a durable pause event.

## Verification

- Focused validation and CoreStore:
  `pnpm exec vitest run test/validation-runner.test.ts test/core-store.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 2 files passed
  - 18 tests passed
- Core single-worker full suite:
  `pnpm exec vitest run --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 13 files passed
  - 233 tests passed
- Root typecheck:
  `pnpm typecheck`
  - passed for all 8 participating workspace projects
- `git diff --check`
  - passed

Vitest emitted only the repository's expected Node experimental SQLite warning.

## Self-review and cleanup

- Re-read the Task 5 brief and reviewed all Task 5 production/test diffs against
  the runtime-contract Git/company types and CoreStore validation APIs.
- Confirmed base/branch identity and that only Task 5 files plus this report are
  included.
- Confirmed the final byte cap hashes exactly the bytes renamed into the final
  evidence path.
- Removed the exact RED-test leftover
  `C:\Users\S1nc\AppData\Local\Temp\agenttown-core-xZOsco`.
- Did not inspect or delete any pre-existing `agenttown-git-*` history
  directory.
- No live Vitest process or validation parent/child process remained.

## Concerns

The remaining pure-Node OS-open/escaped-descendant proof limits are documented
below and require controller adjudication against the existing P1A trust
model. The experimental SQLite warning is expected and unrelated.

## Independent review fixes

An independent review after `dcc4de5` identified six additional hardening
requirements. They were handled with the following RED -> GREEN evidence.

### 1. Disk-before-redaction and cross-chunk secrets

- RED: a finalization dependency was ignored, proving the old runner could not
  test or guarantee failure residue; inspection also confirmed raw stdout and
  stderr chunks were written to the temporary file before redaction.
- GREEN: raw output is now held only in a bounded in-memory representation.
  Redaction ranges are computed independently for stdout and stderr over the
  complete stream, then mapped back onto the original global chunk sequence.
  Only those redacted, sequence-labelled bytes are opened/written on disk.
- Coverage splits an exact secret and `API_TOKEN` assignment across writes with
  interleaved stderr, then scans every final/temp file. A forced pre-rename
  failure likewise scans the surviving exclusive temp file. Neither path
  contains plaintext.

### 2. Identity-safe process-tree cleanup

- RED: the earlier timeout test only proved parent closure/taskkill completion;
  it did not make PID reuse or identity-query failure fail closed.
- GREEN on Windows: cleanup snapshots the root and current descendants through
  `Win32_Process`, records `pid + CreationDate`, rechecks the root identity
  before `taskkill /T /F`, waits for close, then verifies every captured
  identity is absent. Query error, PID reuse, or a captured member that remains
  present becomes `cleanup_failed`. All inspection/termination work shares one
  independent five-second cleanup deadline.
- A real parent+child timeout test verifies both PIDs disappear. Deterministic
  controller tests cover post-kill query error, PID reuse, and a captured
  escaped member that remains live; each returns `cleanup_failed` and pauses.
- The first Windows GREEN attempt exposed serial CIM post-checks consuming the
  cleanup deadline. Parallel post-checks fixed that root cause while retaining
  the single absolute deadline.

On POSIX, AgentTown snapshots the visible parent tree and kills the detached
process group, then verifies captured identities. Pure Node cannot prove the
absence of an arbitrary malicious descendant that double-forks/creates a new
session before the snapshot and is no longer related by PPID or process group.
The runner therefore does not claim that guarantee; any escaped member that is
captured but cannot be proven absent fails closed.

### 3. Company ownership

- RED: a runner injected with company B's definition executed B's configured
  command against company A's Git run.
- GREEN: `ValidationRunnerOptions` now requires `companyId`. Request, decision,
  and execution paths bind the run's `companyId` and the persisted exact
  definition JSON to that company before any grant mutation, authorization, or
  spawn. Cross-company run execution and cross-company grant decision tests
  reject before mutation/execution.

### 4. Atomic cleanup failure and active scopes

- RED: paused runs/workspaces were executable, and the previous runner committed
  `ValidationRunRecord`/`validation.completed` before a separate pause
  transaction.
- GREEN: scope resolution rejects any non-active run or workspace.
  `commitValidationRunCompletion` writes the cleanup-failed record,
  `validation.completed`, paused run/workspaces, and `git.run.paused` in one
  CoreStore transaction.
- A forced duplicate pause-event failure verifies rollback leaves no validation
  record/event and leaves the run/workspace active. Identity-failure tests
  verify the successful atomic bundle has all facts and both events.

### 5. Cwd/log replacement hardening and pure-Node boundary

- RED: there was only one cwd validation before spawn and no repeated log
  directory identity validation around open/rename.
- GREEN: cwd is checked component-by-component with `lstat`/`realpath` and a
  device/inode identity, then checked again immediately before spawn. The log
  directory is revalidated before exclusive mode-0600 temp open, after close,
  immediately before rename, and after rename. A deterministic dependency
  hook replaces cwd with a symlink/junction between the checks and execution is
  rejected. These harness dependencies are available only through an internal
  source-module factory used by Core tests; they are not part of the package
  root export or `ValidationRunnerOptions` public API.

This follows the existing P1A pure-Node filesystem trust model: validation is
fail-closed for observed reparse/identity changes, but `spawn({ cwd: path })`
cannot bind a previously validated Windows directory handle. Therefore a final
OS-open race remains between the immediately preceding identity check and
Node/Windows opening `cwd`; eliminating it requires a native handle-relative
spawn API that Node does not expose. The same limitation applies to the final
few instructions around path-based open/rename. This report deliberately does
not call the implementation race-free.

### 6. Full command timeout budget

- RED: a command configured for one second but completing after about 500 ms
  returned `timed_out`, because two thirds of the command budget was reserved
  for cleanup.
- GREEN: the command timer now fires only at
  `started + timeoutSeconds * 1000`. Cleanup begins after that deadline and
  receives a separate, explicit, bounded five-second deadline.
- The regression asserts the approximately 500 ms command passes and a command
  exceeding one second times out, with only scheduling tolerance in tests and
  no production-timeout relaxation.

### Independent-review verification

- Focused:
  `pnpm exec vitest run test/validation-runner.test.ts test/core-store.test.ts --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 2 files passed
  - 29 tests passed
- Core single-worker full suite:
  `pnpm exec vitest run --reporter=dot --no-file-parallelism --maxWorkers=1`
  - 13 files passed
  - 244 tests passed
- Root `pnpm typecheck`
  - all 8 participating workspace projects passed
- `git diff --check`
  - passed
- Live-process audit
  - no Node/Vitest validation process remained; the long-lived Codex
    PowerShell AST parser was intentionally not classified as a test process
- Exact RED-test `agenttown-core-*` leftovers listed during this run were
  removed; no `agenttown-git-*` directory was touched.
