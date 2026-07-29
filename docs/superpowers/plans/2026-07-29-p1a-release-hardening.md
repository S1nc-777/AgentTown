# P1A Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Close the five release-review gaps in lifecycle semantics, active
task recovery, start guards, CLI live-only handshakes, and durable IPC
at-most-once mutation handling.

**Architecture:** Keep lifecycle ownership in `CheckpointService`, dispatch
ownership in `CompanyOrchestrator`, persistence in `CoreStore`, and transport
deduplication in `CoreServer`. Ordinary CLI connections subscribe live-only;
historical commands continue to query SQLite through request methods.

**Tech Stack:** TypeScript, Node.js 22, `node:sqlite`, Windows Named Pipes,
Vitest.

## Global Constraints

- P1A scope only; no real-agent adapters or UI work.
- Strict RED-GREEN TDD for every behavior change.
- No Git commands in this task agent.
- Response caches remain bounded; durable mutation tombstones are SQLite-backed.
- Stop retains `.agenttown` state and never represents terminal stop as pause.

---

### Task 1: Explicit stop and start/resume lifecycle guards

**Files:**
- Modify: `packages/core/src/lifecycle/checkpoint-service.ts`
- Modify: `packages/core/src/ipc/core-server.ts`
- Modify: `packages/core/test/checkpoint-service.test.ts`
- Modify: `packages/core/test/core-server.test.ts`

**Interfaces:**
- `CheckpointService.stop(): Promise<void>` performs bounded suspension with
  `stopping`/`stopped` facts.
- `recoverLatest()` accepts only persisted `paused`.
- `company.start` branches on persisted status: `running` is idempotent,
  `paused` rejects with “use company.resume”, and `created`/`stopped` starts
  fresh.

- [ ] Add failing lifecycle tests for stop from running and paused, persisted
  `stopped`, `company.stopping`/`company.stopped`, and rejected recovery.
- [ ] Run `pnpm --filter @agenttown/core test -- checkpoint-service.test.ts`
  and confirm the missing `stop()`/incorrect paused terminal failures.
- [ ] Extract the existing bounded suspend phases into one private operation
  parameterized by terminal status and events; make pause checkpoint to
  `paused`, while stop transitions through `stopping` to `stopped`.
- [ ] Add failing server tests for paused start rejection, running start
  idempotency, stopped fresh start, and no duplicate session/start events.
- [ ] Guard `company.start` from the persisted company status and route
  `company.stop` to `CheckpointService.stop()`.
- [ ] Re-run Core focused tests and typecheck.

### Task 2: Resume persisted active tasks

**Files:**
- Modify: `packages/core/src/company/orchestrator.ts`
- Modify: `packages/core/src/lifecycle/checkpoint-service.ts`
- Modify: `packages/core/test/orchestrator.test.ts`
- Modify: `packages/core/test/checkpoint-service.test.ts`
- Modify: `packages/e2e/test/fake-company.test.ts`

**Interfaces:**
- `CompanyOrchestrator.recoverWork(): void` schedules persisted `running`
  tasks to their owner and `review` tasks to the configured reviewer.
- `CheckpointService` calls `resumeDispatching()` and then `recoverWork()`
  only after all sessions are restored and company status is `running`.

- [ ] Add failing orchestrator tests with persisted running/review records;
  assert stable task-ID order, max-parallel enforcement, no transition
  duplication, and preserved counters/artifacts/evidence.
- [ ] Implement `recoverWork()` using existing `#startInFlight` and a tracked
  review equivalent without changing persisted task status.
- [ ] Add failing lifecycle tests proving recovered sessions reissue active
  work only after session restoration.
- [ ] Invoke recovery work after successful session recovery and dispatch
  resume.
- [ ] Change E2E to disconnect while work is running/reviewing, then prove the
  same task IDs continue to completion after resume.
- [ ] Run orchestrator, checkpoint, and E2E focused suites.

### Task 3: CLI live-only handshake and historical queries

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/core-process.ts`
- Modify: `packages/cli/test/main.test.ts`
- Modify: `packages/cli/test/core-process.test.ts`
- Modify: `packages/e2e/test/fake-company.test.ts`

**Interfaces:**
- Ordinary CLI/Core-start clients call
  `AgentTownClient.connect(..., Number.MAX_SAFE_INTEGER, ...)`.
- SDK callers retain the explicit `afterSequence` argument.
- `timeline` still calls `events.list({afterSequence: 0})`.

- [ ] Add failing connection tests asserting the live-only handshake value.
- [ ] Replace ordinary CLI connection call sites from `0` to
  `Number.MAX_SAFE_INTEGER`.
- [ ] Add a >256-event and >4 MiB persisted-history regression proving
  `status`, `tasks`, and `timeline` complete, while timeline returns history.
- [ ] Run CLI and E2E focused tests and typechecks.

### Task 4: Durable mutation request tombstones

**Files:**
- Modify: `packages/core/src/storage/schema.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/ipc/core-server.ts`
- Modify: `packages/core/test/core-store.test.ts`
- Modify: `packages/core/test/core-server.test.ts`

**Interfaces:**
- SQLite table `ipc_mutation_requests(client_id, request_id,
  fingerprint, state, response_json, claimed_at, completed_at)` has primary key
  `(client_id, request_id)`.
- `CoreStore.claimMutationRequest(...)` atomically returns `claimed`,
  `duplicate`, or `conflict`.
- `CoreStore.completeMutationRequest(...)` optionally records bounded response
  metadata.
- Mutating methods are claimed after handshake identity is known and before
  dispatch; claims survive failures and restart.

- [ ] Add failing store tests for atomic claim, duplicate, conflict, and
  persistence after reopen.
- [ ] Add schema and store claim/complete methods in `BEGIN IMMEDIATE`
  transactions.
- [ ] Add failing server regressions for 1,025+ mutations, same-fingerprint
  eviction (`replay_unavailable`), conflict, no re-execution, failed-dispatch
  fail-closed semantics, and restart duplicates.
- [ ] Classify only mutating request methods for durable claiming; allow
  read-only re-execution after cache eviction.
- [ ] Integrate persistent claims before `#respond`, leaving pending/response
  caches bounded.
- [ ] Run Core focused suites and typecheck.

### Task 5: Final verification and report

**Files:**
- Modify: `.superpowers/sdd/task-9-report.md`

- [ ] Run focused Core, CLI, and E2E tests plus their typechecks.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm probe:fake`.
- [ ] Update the report with RED evidence, lifecycle semantics, recovery
  continuation, live-only CLI history behavior, durable tombstones, and fresh
  counts.
- [ ] Hand off to the root agent for diff review and Git operations.
