# ADR 0001: Desktop and Core Runtime

- **Status:** Blocked / Deferred
- **Date:** 2026-07-23
- **Decision scope:** P0 desktop/runtime feasibility gate

## Context

AgentTown needs a Windows desktop runtime whose UI can host an embedded terminal while an independent core continues running after the UI exits. P0 compared Electron and Tauri with four hard gates: PTY stability, core survival, packaging, and embedded terminal operation. A candidate that fails any hard gate is rejected. A candidate is also excluded from weighted comparison when `measurementEligible`, `installSizeMeasured`, or `coldStartMeasured` is false; its install size, cold start, and weighted score must then be shown as `N/A`.

The decision is based on these recorded artifacts:

- `artifacts/feasibility/feasibility-summary.json`
- `artifacts/feasibility/framework-electron.json`
- `artifacts/feasibility/framework-tauri.json`
- `artifacts/feasibility/capabilities-summary.json`
- `artifacts/feasibility/real-probes-summary.json`
- `artifacts/feasibility/environment.json`
- `artifacts/feasibility/codex-real/report.json`
- `artifacts/feasibility/claude-real/report.json`

Recorded tool/runtime versions are Node `v24.14.0`, pnpm `11.9.0`, Electron `43.2.0`, Electron Packager `20.0.3`, Claude Code `2.1.214`, and Codex `unknown`. The artifacts contain no completed Tauri or Rust compiler/runtime version, so this ADR does not invent one.

## Evidence

With `AGENTTOWN_FORBID_REAL_PROBES=1`, `AGENTTOWN_REAL_CODEX=0`, and `AGENTTOWN_REAL_CLAUDE=0`, `pnpm --filter @agenttown/probe-runner score-frameworks` produced the following table and exited `1`, as expected because no candidate qualifies:

| Framework | Eligible | Install MiB | Cold start ms | Weighted score | Implementation minutes | Rank | Blockers |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| electron | no | N/A | N/A | N/A | 60 | - | core_survival, packaged_window_exit_timeout |
| tauri | no | N/A | N/A | N/A | 15 | - | pty_stability, core_survival, packaging, terminal_embedding, rust_toolchain_download_stalled |

Both `-` rank entries mean **unranked**. Neither candidate enters the weighted comparison.

`framework-electron.json` contains raw observed values of `497.03` MiB and `798` ms. Those values are not eligible benchmark measurements: the cold-start value is one preserved packaged observation, not the required three-run median, and the packaged window did not exit inside the bounded close window. Consequently, `feasibility-summary.json` correctly reports Electron `measurementEligible: false`, zero benchmark runs, and `N/A` for install size, cold start, and weighted score. Raw observations must not be presented as benchmark evidence.

`framework-tauri.json` contains numeric zero schema placeholders for install size and cold start. It explicitly records `installSizeMeasured: false`, `coldStartMeasured: false`, `measurementEligible: false`, `runtimeImplemented: false`, and `numericZeroSemantics: schema_placeholders_not_comparable`. The zero values are not measurements and are suppressed as `N/A`.

The implementation-time column is descriptive, not a comparable benchmark for rejected candidates. Electron records 60 minutes of spike work. Tauri's 15 minutes records only the prerequisite audit (`implementationMeasurement: prerequisite_audit_only`), not a completed runtime implementation.

The Agent evidence is also incomplete: `capabilities-summary.json` records a shell-wrapper timeout after reports were written; `real-probes-summary.json` records Codex launch failure and unverified capabilities, while Claude Code lacks verified interrupt and three-session parallel operation. Those adapter failures do not alter the runtime decision below.

## Decision

Select neither candidate. The decision is blocked/deferred, and **P1 must not begin**.

Electron fails the core-survival hard gate and records `packaged_window_exit_timeout`. Tauri is unimplemented and measurement-ineligible after `rust_toolchain_download_stalled`; it fails PTY stability, core survival, packaging, and embedded terminal operation. Because neither candidate remains, there is no accepted runtime, no rejected-alternative winner, and no P1 stack.

The P0 runtime evaluation must be revised before this ADR can be superseded with an accepted candidate. Do not evaluate OpenCode: the blocking decision is a framework/runtime failure, even though the Agent adapter evidence also contains failures.

## Consequences

- The P0 to P1 dependency is blocked; P1 implementation and detailed stack planning stop here.
- No Electron or Tauri production commitment is authorized by the current evidence.
- No weighted ranking or tie-break is valid because there are zero eligible candidates.
- Future P0 work needs a revised runtime-evaluation plan and new eligible evidence that passes all four hard gates.
- Existing feasibility artifacts remain the immutable record of this evaluation; this ADR does not reinterpret raw observations or placeholders as measurements.

## Rejected Candidates

### Electron

Electron is rejected for this evaluation because `coreSurvivesUiExit` is false. Packaging, PTY output, and embedded terminal evidence do not override the failed core-survival hard gate. The recorded blocker is `packaged_window_exit_timeout`, and its single size/start observations are not eligible three-run benchmark measurements.

### Tauri

Tauri is rejected for this evaluation because the runtime was not implemented after `rust_toolchain_download_stalled`. It fails all four hard gates and has no eligible install-size or cold-start measurement. No Tauri or Rust runtime version is claimed.

## P1 Constraints

The intended P1 requirements remain future requirements: an independent background process, versioned local IPC, a SQLite fact store, an event log, company/employee/session lifecycle handling, and scripted fake Agents. The core must continue working while the UI is not running and must restore fact state after restart.

Until a runtime candidate passes all hard gates, the following remain explicitly **unassigned**:

- core language;
- UI framework;
- PTY library;
- IPC transport;
- package format;
- minimum Windows version.

These fields must not be inferred from either rejected candidate or from the earlier feasibility plan's provisional stack.
