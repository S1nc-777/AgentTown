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
