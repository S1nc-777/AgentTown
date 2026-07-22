# Task 9 Report: Parallel, interruption, recovery, and evidence benchmark

## Result

Task 9 implemented the bounded parallel fake queue, offline framework scoring/suppression, guarded PowerShell entry points, remaining-capability evidence handling, and sanitized feasibility summaries. No runtime candidate passes all hard gates, so this task makes no Task 10 selection or ADR decision.

## Fake queue TDD evidence

- Initial RED: `benchmark.ts` did not exist.
- First implementation exposed Windows ConPTY ANSI/OSC prefixes before otherwise valid JSONL. The parser was corrected to strip terminal control sequences before fake-event parsing.
- The real three-session fake run completes in input order with three unique session IDs and no project-owned orphan process.
- Additional RED-to-GREEN cases cover explicit concurrency limits, launch partial failure without queue cancellation, timeout classification, input-order preservation, worker rejection, interrupt-then-kill cleanup, and bounded orphan polling.
- Per-session logs remain local and ignored.

## Real-Agent evidence

- The authorized Codex base probe recorded Windows launch `EPERM`: launch, first turn, resume, interrupt, and parallel-three remain false. The report preserves `error_code:EPERM`, `blocker:launch_failed`, and the derived prerequisite blocker.
- The authorized Claude base probe verified launch, streamed output, session ID, resume, token usage, and non-interactive plan mode with Claude Code 2.1.214.
- The remaining Claude capability attempt recorded `interrupt_session_not_observed` and three `parallel_partial_failure:*:exit_1` blockers. Interrupt and parallel-three remain false.
- The outer shell watchdog returned exit `124` after `capabilities-summary.json` and the per-Agent reports had been written. This is recorded as `shell_wrapper_timeout`; no PowerShell exit code was observed, and the report does not mislabel `124` as a PowerShell result.
- A post-run audit found that normalized parallel handles had replaced original PTY output and that session detection depended on complete line-delimited JSON. Offline fixes now preserve original raw PTY/stderr logs, classify through a separate callback, remove ANSI/terminal whitespace for session/marker evidence, and resize each capability PTY to 240x60 immediately after launch.
- These offline parser fixes were not used to rewrite or upgrade the already-recorded real results. No real Agent was rerun during post-real repair.

## Explicit CLI termination

`run-real-capabilities` now has an injectable main/exit boundary. It awaits all capability cleanup and orphan judgments, writes the summary atomically through a temporary file and rename, and only then performs an explicit process exit. An offline test verifies summary visibility, empty orphan evidence, completed cleanup, exit code `1`, and no temporary summary file before the exit callback runs.

## Framework evidence and suppression

- Electron retains `core_survival` and `packaged_window_exit_timeout`.
- Tauri retains all four hard-gate failures and `rust_toolchain_download_stalled`.
- Both candidates show install size, cold start, and weighted score as `N/A`; rank is `null` and benchmark runs are `0`.
- `SummarizeOnly` and framework aggregation were each run once under `AGENTTOWN_FORBID_REAL_PROBES=1` with real gates set to `0`. Both returned the expected exit code `1`.
- SHA-256 comparisons proved the Codex report, Claude report, Electron artifact, and Tauri artifact were unchanged by the offline summary runs.
- `feasibility-summary.json` combines the preserved Agent blockers with the suppressed framework rows. No packaged candidate was run.

## Safety boundary

- Real execution is refused when `AGENTTOWN_FORBID_REAL_PROBES=1`.
- Real gates are scoped to child commands and restored in `finally`.
- Temporary Git directories are resolved and verified strictly below the OS temp root before recursive removal.
- Final audit found one Git-only temp directory left by the earlier outer-timeout run. Its exact resolved path was verified below the OS temp root with no associated process, then moved to the Recycle Bin; the cleanup is recoverable.
- Committed summaries contain no temporary path, credential data, raw prompt output, or numeric placeholder presented as a measurement.
- Task 10 ADR/roadmap work was not implemented.

## Offline review hardening

- A queue-race regression now proves that the first worker error atomically stops further dequeue, waits for worker/handle settlement, applies interrupt-grace-kill to a stable active snapshot, and audits every started PID before returning the error.
- Capability evidence now strips terminal controls and starts JSON extraction only at a standalone terminal line whose trimmed first character is `{`; soft-wrapped content is accumulated only until one balanced object ends, and prose prefixes or non-empty trailing text invalidate that frame. Only adapter-produced session/output events are trusted. Complete valid Claude/Codex events embedded in prose are rejected while ANSI-prefixed standalone soft-wrapped JSON remains accepted.
- Interrupt verification captures the original PTY stream and writes a redacted local log plus lifecycle metadata on success, timeout, early exit, and error. Timeout and apparent-early-exit survivor tests both require an orphan PID judgment after bounded cleanup.
- Launch is the only prerequisite for remaining-capability probes. Offline fixtures verify Claude is attempted despite failed resume/session flags and Codex uses `exec --json --sandbox read-only --cd` with `parseCodexLine`.
- The PowerShell real-probe wrapper now applies one total deadline to child processes and records PID plus process start time. Before and after `taskkill /T /F`, it re-queries process identity, checks the taskkill exit code and bounded second wait, and reports `termination_unverified` or `orphan_process` whenever tree cleanup cannot be proved. The PID-reuse window is reduced by checking the saved identity immediately before termination and querying again immediately afterward; it cannot be eliminated atomically with Windows command-line process APIs, so identity ambiguity fails closed.
- Process identity reads distinguish a confirmed absent PID from a `Get-Process` or `StartTime` query error. Only confirmed absence proves termination; query errors fail closed as `termination_unverified` without issuing taskkill against an unverified identity.
- Test-only child actions were removed from the production real-probe entry point and moved to standalone harnesses over shared helpers. Missing, malformed, or truncated Agent reports become per-Agent blockers and cannot prevent summary creation.
- Framework measurement no longer accepts an arbitrary command. Production maps Electron and Tauri to fixed repository-owned scripts and package paths, rejects paths outside the repository, uses bounded verified child termination per run, and recursively measures stable package size. Test harnesses exercise exactly three samples, median/score/rank, timeout, start error, malformed output, and partial failure. Current source candidates remain ineligible and no packaged candidate was run.
- Framework temporary-log cleanup is isolated behind a non-throwing helper. A Windows exclusive-file-lock regression proves cleanup failure records `framework_temp_cleanup_unverified`, still writes the failure summary, and exits nonzero.
- All review changes and tests were executed with `AGENTTOWN_FORBID_REAL_PROBES=1`, `AGENTTOWN_REAL_CODEX=0`, and `AGENTTOWN_REAL_CLAUDE=0`. Recorded real `false` results were not upgraded and no real Agent was rerun.
