# Task 5 Report: Codex CLI capability probe

## Result

- Added sanitized Codex JSONL fixture parsing for `thread.started`, completed `agent_message`, `turn.completed.usage`, `turn.failed`, and `error`.
- Invalid JSON becomes `parse_error`; unknown valid Codex events are omitted from normalized events but remain in raw evidence.
- Added a deterministic `probeCodex` orchestration path with injectable process execution, bounded commands, an isolated temporary Git repository, Codex read-only sandbox arguments, session resume, explicit blocker mapping, cleanup, and redacted artifacts.
- Added an opt-in real test guarded by `AGENTTOWN_REAL_CODEX=1`; ordinary tests and CI do not launch Codex.

## TDD evidence

- Parser RED: `codex-parser.test.ts` failed because `src/adapters/codex.ts` did not exist.
- Parser GREEN: 5/5 tests passed for fixture extraction, invalid JSON, unknown valid events, and both Codex error shapes.
- Orchestration RED: 6/6 tests failed because `probeCodex` was not implemented.
- Orchestration GREEN: success and five blocker scenarios passed. Tests verify the bounded command order, a shared temporary repository, `git init --quiet`, `--sandbox read-only`, session-ID resume, raw evidence retention, normalized events, and artifact creation.
- Artifact portability RED: persisted `report.json` exposed an absolute machine path. GREEN stores `rawLogPath` as sibling-relative `raw.log` while the returned in-memory report still points to the actual artifact.

## Blocker mapping

Offline tests cover complete reports for:

- `blocker:executable_not_found`
- `blocker:authentication`
- `blocker:timeout`
- `blocker:parse_failure`
- `blocker:resume_failed`

The implementation also reports explicit launch, temporary-repository, missing-response, missing-session, and missing-token-usage blockers rather than silently passing.

## Real Codex evidence

- A read-only `Get-Command` check found two local Application candidates.
- Both candidates exist and are readable, but both fail immediately at Windows process creation with `ApplicationFailedException: Access is denied` when invoked with `--version`.
- The explicit bounded real test completed in under one second and recorded `version: unknown` plus `blocker:launch_failed` in `artifacts/feasibility/codex-real/report.json`.
- No Codex Agent turn, session, authentication step, or credential-file access occurred. No authentication or elevation workaround was attempted.
- Because the local executable cannot run `--help`, this machine could not provide behavioral evidence for alternative resume argument positions. The Task 5 plan order, `codex exec resume <session-id> --json <prompt>`, remains covered by the deterministic orchestration test and was not speculatively changed.

## Fresh verification

- `pnpm --filter @agenttown/probe-runner test`: 8 files passed, 1 real-test file skipped; 59 tests passed, 1 skipped.
- Explicit `AGENTTOWN_REAL_CODEX=1` real test: 1/1 passed with the expected complete blocker report.
- `pnpm test`: probe-contract 8/8; probe-runner 59 passed plus 1 opt-in skip; fake-agent 6 passed plus the intentional Windows plain-child SIGINT skip.
- `pnpm typecheck`: all workspace packages passed.
- `pnpm probe:fake`: 6 passed plus the intentional Windows skip.
- `git diff --check`: passed.
- Bounded Windows process query: `ORPHAN_COUNT=0` for fake-agent, Codex probe, and node-pty helper patterns.

The known intermittent node-pty `AttachConsole failed` helper stderr appeared once after a passing full-workspace probe-runner run. It remains the documented Task 4 dependency risk; all test commands exited successfully and the final orphan query was zero.

## Scope

No Claude, OpenCode, or Task 6+ adapter work was added.

## Review fixes

- Replaced broad exception-to-blocker catches with a strict launch-error taxonomy: `ENOENT` maps to `executable_not_found`, `EACCES`/`EPERM` map to `launch_failed`, and every unknown exception is rethrown.
- Persisted only the allow-listed OS error code as evidence; exception messages, executable paths, usernames, and credentials are never copied into the report.
- Kept the configured executable for actual process launch while recording the portable logical command name `codex` in both in-memory and persisted reports.
- Added regressions proving TypeError propagation from version, Git initialization, first execution, and resume; success and blocker cleanup of the temporary Git repository; separation of artifacts from the temporary repository; and resume authentication precedence.
- Tightened the real-probe assertion so it accepts exactly one known blocker or a complete Task 5 capability success. The bounded opt-in rerun again stopped at `--version`, persisted `error_code:EPERM` with `blocker:launch_failed`, and did not start an Agent session.

## Review-fix verification

- Targeted offline Codex tests: 15 passed; real test skipped by default.
- `pnpm test`: probe-contract 8/8; probe-runner 68 passed plus 1 opt-in skip; fake-agent 6 passed plus the intentional Windows plain-child SIGINT skip.
- `pnpm typecheck`: all workspace packages passed.
- `pnpm probe:fake`: 6 passed plus the intentional Windows skip.
- Explicit bounded real Codex test: 1/1 passed at the version-stage `EPERM` blocker.
- `git diff --check`: passed.
- Bounded process query: `ORPHAN_COUNT=0` for fake-agent, Codex probe, and node-pty helper patterns.
