# Task 6 Report: Claude Code CLI capability probe

## Status

Complete on base `83370cab1263e97c24990248e50054e59c40787f`. Committed as `1ffd09d0c80bbf6cf37c5204705ee8ec79feb834` (`feat: probe Claude Code capabilities`). Implementation is limited to Task 6.

## Delivered behavior

- `parseClaudeLine(line)` normalizes Claude stream-json init sessions, assistant text, successful result usage, error events, and failed result events.
- Invalid JSON becomes explicit `parse_error`; unknown valid Claude events remain only in raw evidence.
- `probeClaude(options)` performs bounded version, temporary Git initialization, first-turn, and exact-session resume stages.
- First and resume turns use `--output-format stream-json --verbose --permission-mode plan`.
- No command uses or persists `--dangerously-skip-permissions`.
- Reports persist only the logical `claude` command, never configured or PATH-resolved shim paths.
- Known OS launch codes are classified without persisting exception messages; unknown exceptions propagate after guaranteed temp cleanup.
- Raw and normalized evidence are retained with Claude failure messages, home paths, credentials, and secret assignments redacted.
- On Windows, explicit or PATH-resolved PowerShell shims run through `powershell.exe -NoProfile -File`. This addresses Node's inability to launch the local shim directly.
- Normal CI cannot start Claude because the real test is gated by `AGENTTOWN_REAL_CLAUDE=1`.

## TDD evidence

### Parser RED/GREEN

- RED: focused parser test failed because `src/adapters/claude.ts` did not exist.
- GREEN: the minimal Claude parser passed 5/5 fixture and failure-shape tests.

### Orchestration RED/GREEN

- RED: 20 initial deterministic orchestration cases failed with `probeClaude is not a function`.
- First GREEN attempt passed 25/26; the remaining assertion incorrectly expected resume to be false after a successful resume followed by a token-usage blocker. Correcting the stage-aware expected state produced 26/26 GREEN.
- Windows shim RED: a direct explicit `.ps1` test proved the adapter attempted to spawn the script directly.
- Windows shim GREEN: explicit shim routing passed, then a PATH-resolution test RED/GREEN cycle verified default Windows discovery.
- Final offline Claude set: 28 passed, with the opt-in real test correctly skipped when its environment flag is absent.

## Deterministic coverage

- Exact first and resume argument order, including `permission-mode plan`.
- Explicit negative assertion for `--dangerously-skip-permissions`.
- Session ID, resume output, usage, cached usage, raw evidence, normalized evidence, and logical command persistence.
- Authentication precedence on first and resume stages.
- Timeout, parse failure, missing response, missing session ID, missing token usage, and resume failure.
- `ENOENT`, `EACCES`, and `EPERM`; Git launch errors map only to `temporary_repo_init_failed`.
- Unknown exception propagation at version, Git, first-turn, and resume stages.
- Cleanup after success, blockers, and exceptions.
- Windows path portability and PowerShell shim resolution.
- Error-message and private-path redaction.

## Safe executable audit and real probe

- Read-only `Get-Command` found Claude Code.
- Read-only `--version` returned `2.1.214 (Claude Code)` with exit 0.
- The first default Node launch produced an evidenced `ENOENT` before Agent execution because Windows exposed script shims rather than a directly spawnable executable.
- After the offline shim regression was GREEN, one explicit bounded opt-in real probe ran using the resolved PowerShell shim, existing login state, and `permission-mode plan`.
- No authentication, privilege elevation, or credential-file inspection occurred.
- Real result: `launch`, `streamOutput`, `sessionId`, `resume`, `tokenUsage`, and `nonInteractive` were all true; no blocker was recorded.
- Real duration was approximately 22 seconds, within the configured bound.
- A metadata-only scan of raw/events/report found no user-home path, dangerous permission flag, or unredacted secret assignment.

## Files

- Added `packages/probe-runner/src/adapters/claude.ts`.
- Added `packages/probe-runner/test/claude-parser.test.ts`.
- Added `packages/probe-runner/test/claude-probe.test.ts`.
- Added `packages/probe-runner/test/claude-real.test.ts`.
- Added `packages/probe-runner/test/fixtures/claude-success.jsonl`.
- Added sanitized `artifacts/feasibility/claude-real/report.json`.

## Verification

- Focused parser/orchestration/real-gate tests: 28 passed, 1 expected opt-in skip.
- `pnpm test`: exit 0; contract 8 passed, probe-runner 99 passed/2 gated skips, fake-agent 6 passed/1 Windows signal skip.
- `pnpm typecheck`: exit 0 for all workspace packages.
- `pnpm probe:fake`: exit 0; fake-agent 6 passed/1 Windows signal skip.
- `git diff --check`: exit 0.
- Bounded orphan query: `CLAUDE_PROBE_ORPHAN_PROCESS_COUNT=0`.
- Temporary repository query: `CLAUDE_PROBE_TEMP_DIR_COUNT=0`.

## Self-review and concerns

- Reviewed the adapter against the Task 6 brief, plan, hardened Task 5 adapter, contract, process runner, and artifact writer.
- The real report contains only the logical command, version, capability booleans, duration, relative raw-log name, and empty notes; it contains no shim path or error output.
- Raw and normalized real logs remain preserved locally under the existing ignore policy; only the compact sanitized report is staged.
- Interrupt, interactive PTY, and three-session parallel capabilities remain false because they belong to later tasks; no Task 7+ work was added.
- Windows installations exposing only a `.cmd` shim and no `.exe` or `.ps1` remain a possible launch blocker. The audited npm-style installation exposes a `.ps1` shim and passed the real probe.

## Independent review fixes

- Resume success now requires the resume stream to contain a `system/init` event whose session ID exactly matches the first-turn session. Deterministic cases cover matching, missing, and mismatched IDs; a Claude failure result cannot be masked by a successful-looking assistant message.
- Shared artifact redaction now exposes `redactJsonlLine` / `redactJsonlOutput` and structurally redacts JSON secret keys before parsing and again before persistence. Unknown valid events remain in raw evidence only; malformed known shapes and syntax-damaged JSON both produce a safe `parse_error.raw`; usage counters remain numeric.
- Targeted review regressions: 5/5 passed.
- Artifacts plus Claude offline suite: 61 passed plus 1 real-test gate skip.
- Probe-runner full suite: 104 passed plus 2 opt-in real-test skips.
- Full workspace tests and typechecks passed; `pnpm probe:fake` and `git diff --check` passed; `ORPHAN_COUNT=0`; `CLAUDE_TEMP_DIR_COUNT=0`.
- This takeover verification explicitly removed `AGENTTOWN_REAL_CLAUDE` and did not launch a real Claude process.
