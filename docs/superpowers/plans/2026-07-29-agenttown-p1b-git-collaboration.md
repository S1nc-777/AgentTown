# AgentTown P1B Git Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic Git collaboration vertical slice in which two Fake developers work in isolated task worktrees, Core validates and tests their commits, a read-only reviewer evaluates immutable evidence, and approved work reaches an AgentTown integration branch without touching the user's branch.

**Architecture:** Add versioned Git types to the runtime contract and a focused `core/src/git` domain behind `GitWorkflowCoordinator`. Core owns repository preflight, task worktrees, structured validation, evidence, review state, candidate integration, reconciliation, and cleanup; Agents only propose typed actions. SQLite stores Git facts and prepared/committed integration intents so restart recovery can reconcile local Git refs without guessing.

**Tech Stack:** TypeScript 7, Node.js >=22 standard library, Git CLI >=2.31.0, `node:sqlite`, Zod 4, pnpm workspaces, Vitest 4, YAML, Windows Named Pipes.

## Global Constraints

- Windows is the release gate; path and process code must avoid unnecessary Windows-only assumptions.
- Add no runtime dependency for Git. All Git access goes through one typed child-process wrapper.
- P1B uses only Fake Agents. Set `AGENTTOWN_FORBID_REAL_PROBES=1`, `AGENTTOWN_REAL_CODEX=0`, and `AGENTTOWN_REAL_CLAUDE=0` in verification commands.
- The input project must already be a non-bare Git repository with a branch-attached `HEAD`, at least one commit, no in-progress Git operation, and no staged, tracked, or ordinary untracked changes.
- Ignore ignored files; add `/.agenttown/` idempotently to `.git/info/exclude`; never modify project `.gitignore`.
- Never checkout, reset, clean, commit, merge, or cherry-pick in the user's original worktree.
- Construct all AgentTown refs and paths from validated IDs. Never accept an Agent-provided full ref or arbitrary filesystem path.
- Every writable task gets an isolated branch and worktree. Leaders and reviewers get no writable project worktree.
- `task.approve` records an approved submission but does not complete the task. Only successful atomic integration completes it.
- Core reruns pre-approved structured validation commands with `shell: false`; Agent-reported results are evidence only.
- Default validation timeout is 600 seconds; accepted configuration range is 1–3600 seconds.
- Review diff warning defaults to 2 MiB and hard rejection defaults to 20 MiB. Configurable ranges are 256 KiB–20 MiB and 1–100 MiB respectively, with warning <= hard limit.
- P1B never merges into the user's branch, pushes, creates a PR, publishes, deploys, or writes remote refs.
- Pause preserves refs, worktrees, submissions, and evidence. Default cleanup removes only verified AgentTown worktrees.
- Use TDD for every behavior change. Each implementation task ends with focused tests, package typecheck, and a commit.

---

## Planned File Map

### Runtime contract

| File | Responsibility |
|---|---|
| `packages/runtime-contract/src/git.ts` | Git run, workspace, submission, validation, review, integration and reconciliation types plus parsers |
| `packages/runtime-contract/src/company.ts` | Structured validation command and evidence limit configuration |
| `packages/runtime-contract/src/agent.ts` | Writable/review task contexts on `AgentMessage` |
| `packages/runtime-contract/src/task.ts` | Existing task/action types; Task 9 adds the explicit conflict-task link |
| `packages/runtime-contract/src/index.ts` | Public exports |
| `packages/runtime-contract/test/git.test.ts` | Parser and invariant tests |
| `packages/runtime-contract/test/company.test.ts` | YAML validation tests for P1B configuration |

### Core storage and Git domain

| File | Responsibility |
|---|---|
| `packages/core/src/storage/migrations.ts` | Schema v1 detection and transactional v1→v2 migration |
| `packages/core/src/storage/schema.ts` | Fresh v2 schema |
| `packages/core/src/storage/core-store.ts` | Typed Git fact persistence methods |
| `packages/core/src/git/git-command.ts` | Sole typed Git process boundary |
| `packages/core/src/git/repository-preflight.ts` | Repository eligibility and immutable run baseline |
| `packages/core/src/git/workspace-manager.ts` | Integration/task/candidate worktree lifecycle |
| `packages/core/src/git/validation-runner.ts` | Approved command execution, timeout, process cleanup and logs |
| `packages/core/src/git/submission-validator.ts` | Commit-range, cleanliness, path and file-change validation |
| `packages/core/src/git/evidence-package.ts` | Immutable review package generation and hashing |
| `packages/core/src/git/review-service.ts` | Review-decision validation and submission revision state |
| `packages/core/src/git/integration-service.ts` | Stable queue ordering, candidate cherry-pick, tests and CAS ref update |
| `packages/core/src/git/conflict-service.ts` | Conflict-task creation and superseding submissions |
| `packages/core/src/git/git-reconciler.ts` | Restart reconciliation and tamper classification |
| `packages/core/src/git/cleanup-service.ts` | Explicit, bounded worktree/ref/evidence cleanup |
| `packages/core/src/git/git-workflow-coordinator.ts` | Orchestrator-facing facade across Git services |
| `packages/core/src/company/orchestrator.ts` | Route assignment, submission, review and completion through the Git facade |
| `packages/core/src/lifecycle/checkpoint-service.ts` | Git checkpoint and reconciliation hooks |
| `packages/core/src/ipc/core-server.ts` | P1B read/query/cleanup IPC methods |
| `packages/core/src/index.ts` | Public P1B exports |

### Tests and CLI

| File | Responsibility |
|---|---|
| `packages/core/test/helpers/git-fixture.ts` | Temporary local repositories and deterministic Git assertions |
| `packages/core/test/storage-migrations.test.ts` | v1→v2 and failed migration behavior |
| `packages/core/test/repository-preflight.test.ts` | Clean/dirty/in-progress repository gates |
| `packages/core/test/workspace-manager.test.ts` | Isolated worktree lifecycle and path bounds |
| `packages/core/test/validation-runner.test.ts` | Structured commands, timeout, logs and redaction |
| `packages/core/test/submission-validator.test.ts` | Commit range, path, binary, submodule and size rules |
| `packages/core/test/evidence-package.test.ts` | Package shape, hashes, revisions and tampering |
| `packages/core/test/review-service.test.ts` | Approve/reject invariants |
| `packages/core/test/integration-service.test.ts` | Ordering, candidate integration, CAS and failed tests |
| `packages/core/test/conflict-service.test.ts` | Conflict task and supersession workflow |
| `packages/core/test/git-reconciler.test.ts` | Prepared/committed recovery and external tampering |
| `packages/core/test/git-workflow-coordinator.test.ts` | Full Core Git state transitions |
| `packages/cli/src/git-render.ts` | Workspaces, evidence and delivery rendering |
| `packages/cli/src/main.ts` | `workspaces`, `evidence`, `deliver`, and `cleanup` commands |
| `packages/cli/test/git-render.test.ts` | Deterministic P1B text output |
| `packages/cli/test/main.test.ts` | P1B command parsing and IPC behavior |
| `packages/fake-agent/src/git-fixture.ts` | Deterministic task-worktree edits and commits |
| `packages/fake-agent/src/company-cli.ts` | P1B fixture scenarios |
| `packages/fake-agent/test/git-fixture.test.ts` | Fixture path and scenario safety |
| `packages/e2e/test/git-company.test.ts` | Parallel, restart, delivery and conflict E2E |
| `README.md` | P1B local usage and safety boundary |

---

### Task 1: Versioned P1B Runtime Contract and Company Configuration

**Files:**
- Create: `packages/runtime-contract/src/git.ts`
- Create: `packages/runtime-contract/test/git.test.ts`
- Modify: `packages/runtime-contract/src/company.ts`
- Modify: `packages/runtime-contract/src/agent.ts`
- Modify: `packages/runtime-contract/src/index.ts`
- Modify: `packages/runtime-contract/test/company.test.ts`
- Modify: `packages/core/src/company/orchestrator.ts`
- Modify: `packages/core/test/fake-adapter.test.ts`
- Modify: `packages/core/test/orchestrator.test.ts`

**Interfaces:**
- Produces: `GitRunRecord`, `GitWorkspaceRecord`, `GitTaskSubmission`, `GitSubmissionRecord`, `ValidationCommand`, `ValidationCommandGrant`, `ValidationRunRecord`, `ReviewPackageRecord`, `ReviewDecision`, `IntegrationAttemptRecord`, `ReconciliationResult`, `WritableTaskContext`, `ReviewTaskContext`.
- Produces: `parseGitTaskSubmission(value)`, `parseReviewDecision(value)`, and P1B `CompanyDefinition.validation`.
- Consumes: existing Zod parsing style and `AgentMessage`.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  parseCompanyYaml,
  parseGitTaskSubmission,
  parseReviewDecision
} from "../src/index.js";

describe("P1B Git contract", () => {
  it("parses a continuous declared submission shape", () => {
    expect(parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: "a".repeat(40),
      commits: ["a".repeat(40)],
      changeSummary: "Add greeting",
      validationCommandIds: ["unit-tests"],
      suggestedValidationCommands: [],
      reportedResults: [{
        commandId: "unit-tests",
        outcome: "passed",
        summary: "12 tests passed"
      }],
      knownRisks: []
    }).commits).toHaveLength(1);
  });

  it("rejects an approving review with a blocking finding", () => {
    expect(() => parseReviewDecision({
      schemaVersion: 1,
      decision: "approve",
      findings: [{
        severity: "blocking",
        evidence: "test failed",
        requiredChange: "fix it"
      }],
      coverageGaps: [],
      summary: "not actually approved",
      reviewedManifestHash: "b".repeat(64)
    })).toThrow("approve");
  });

  it("parses structured validation commands and exact limits", () => {
    const company = parseCompanyYaml(`
schema_version: 1
company:
  name: Test
  mission: Test Git collaboration
  success_criteria: [Integrated]
  operating_rules: [No push]
employees:
  - id: leader
    role: leader
    agent: fake
    reports_to: owner
    workspace: read_only
limits:
  max_task_retry: 1
  max_review_loops: 2
  max_parallel_tasks: 2
validation:
  commands:
    - id: unit-tests
      executable: pnpm
      args: [test]
      cwd: .
      timeout_seconds: 600
  integration_command_ids: [unit-tests]
evidence:
  diff_warning_bytes: 2097152
  diff_hard_limit_bytes: 20971520
`);
    expect(company.validation.commands[0]?.timeoutSeconds).toBe(600);
    expect(company.evidence.diffHardLimitBytes).toBe(20 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run tests and verify the new exports are missing**

Run:

```powershell
pnpm --filter @agenttown/runtime-contract test -- git.test.ts company.test.ts
```

Expected: FAIL because P1B types/parsers and configuration fields do not exist.

- [ ] **Step 3: Add exact contract types and parsers**

Implement `packages/runtime-contract/src/git.ts` with these public discriminants and states:

```ts
export type GitWorkspaceKind = "integration" | "task" | "candidate";
export type GitWorkspaceStatus = "active" | "paused" | "completed" | "missing" | "tampered";
export type SubmissionStatus =
  | "received" | "validated" | "rejected" | "in_review"
  | "approved" | "changes_requested" | "queued" | "integrated";
export type IntegrationStatus =
  | "prepared" | "conflicted" | "validation_failed" | "committed" | "aborted";
export type ReconciliationClassification =
  | "verified" | "completed_recovery" | "rolled_back_recovery"
  | "user_workspace_changed" | "tampered" | "missing";

export interface ValidationCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface ValidationCommandGrant {
  grantId: string;
  runId: string;
  taskId: string;
  workspaceId: string;
  command: ValidationCommand;
  status: "pending" | "approved" | "rejected";
  decisionReason: string | null;
}

export interface GitSubmissionRecord {
  runId: string;
  taskId: string;
  revision: number;
  submission: GitTaskSubmission;
  status: SubmissionStatus;
}

export interface GitRunRecord {
  runId: string;
  companyId: string;
  projectRoot: string;
  originalBranch: string;
  baseCommit: string;
  integrationRef: string;
  integrationCommit: string;
  status: "creating" | "active" | "paused" | "completed" | "tampered";
  createdAt: string;
  updatedAt: string;
}

export interface GitWorkspaceRecord {
  workspaceId: string;
  runId: string;
  taskId: string | null;
  employeeId: string | null;
  kind: GitWorkspaceKind;
  path: string;
  branchRef: string;
  baseCommit: string;
  headCommit: string;
  status: GitWorkspaceStatus;
}

export interface GitTaskSubmission {
  schemaVersion: 1;
  headCommit: string;
  commits: string[];
  changeSummary: string;
  validationCommandIds: string[];
  suggestedValidationCommands: ValidationCommand[];
  reportedResults: Array<{
    commandId: string;
    outcome: "passed" | "failed" | "not_run";
    summary: string;
  }>;
  knownRisks: string[];
}

export interface ValidationRunRecord {
  validationId: string;
  runId: string;
  taskId: string | null;
  integrationAttemptId: string | null;
  command: ValidationCommand;
  workspaceId: string;
  outcome: "passed" | "failed" | "timed_out" | "start_failed" | "cleanup_failed";
  exitCode: number | null;
  startedAt: string;
  completedAt: string;
  logPath: string;
  logHash: string;
}

export interface ReviewPackageRecord {
  runId: string;
  taskId: string;
  revision: number;
  manifestPath: string;
  manifestHash: string;
  totalBytes: number;
  status: "created" | "verified" | "tampered" | "deleted";
}

export interface ReviewDecision {
  schemaVersion: 1;
  decision: "approve" | "reject";
  findings: Array<{
    severity: "blocking" | "advisory";
    evidence: string;
    requiredChange: string | null;
  }>;
  coverageGaps: string[];
  summary: string;
  reviewedManifestHash: string;
}

export interface IntegrationAttemptRecord {
  attemptId: string;
  runId: string;
  taskId: string;
  submissionRevision: number;
  orderKey: string;
  expectedOldCommit: string;
  candidateRef: string;
  candidateCommit: string | null;
  status: IntegrationStatus;
  conflictFiles: string[];
  validationRunIds: string[];
}

export interface ReconciliationResult {
  runId: string;
  classification: ReconciliationClassification;
  discrepancies: Array<{
    kind: string;
    expected: string | null;
    actual: string | null;
  }>;
}

export interface WritableTaskContext {
  kind: "git_worktree";
  runId: string;
  taskId: string;
  employeeId: string;
  workspaceRoot: string;
  branch: string;
  baseCommit: string;
  approvedValidationCommandIds: string[];
}

export interface ReviewTaskContext {
  kind: "review_package";
  runId: string;
  taskId: string;
  revision: number;
  manifestPath: string;
  manifestHash: string;
}
```

Add Zod schemas that enforce:

- 40–64 lowercase hexadecimal Git object IDs;
- non-empty, unique, ordered `commits`;
- SHA-256 manifest hashes of exactly 64 lowercase hexadecimal characters;
- `approve` has no blocking finding;
- `reject` has at least one blocking finding with non-null `requiredChange`;
- validation command IDs use the existing employee-ID-safe pattern;
- `cwd` is relative and cannot contain an absolute root or `..`;
- timeouts are 1–3600;
- warning bytes are 262144–20971520;
- hard bytes are 1048576–104857600;
- warning bytes do not exceed hard bytes;
- every integration command ID names a configured command.

`GitTaskSubmission` includes `suggestedValidationCommands: ValidationCommand[]`. Parsing a suggestion never authorizes execution; it requires a persisted exact `ValidationCommandGrant`.

Extend `AgentMessage`:

```ts
export interface AgentMessage {
  messageId: string;
  employeeId: string;
  taskId: string | null;
  text: string;
  actionRequest: ActionProposal | null;
  taskContext: WritableTaskContext | ReviewTaskContext | null;
}
```

Default omitted YAML sections to one `unit-tests`-free configuration:

```ts
validation: { commands: [], integrationCommandIds: [] },
evidence: {
  diffWarningBytes: 2 * 1024 * 1024,
  diffHardLimitBytes: 20 * 1024 * 1024
}
```

- [ ] **Step 4: Export the contract and update all P1A message constructors**

Add:

```ts
export * from "./git.js";
```

to `packages/runtime-contract/src/index.ts`. Update every existing `AgentMessage` literal in Core/tests with `taskContext: null` so typecheck remains honest rather than making the field optional.

- [ ] **Step 5: Run contract tests and workspace typecheck**

Run:

```powershell
pnpm --filter @agenttown/runtime-contract test
pnpm typecheck
```

Expected: all runtime-contract tests pass and every workspace package typechecks.

- [ ] **Step 6: Commit**

```powershell
git add packages/runtime-contract packages/core packages/e2e
git commit -m "feat: define P1B git collaboration contracts"
```

---

### Task 2: Transactional Schema v2 and Typed Git Fact Store

**Files:**
- Create: `packages/core/src/storage/migrations.ts`
- Create: `packages/core/test/storage-migrations.test.ts`
- Modify: `packages/core/src/storage/schema.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 Git record types.
- Produces: `migrateCoreSchema(database)`, `CoreStore.putGitRun`, `getGitRun`, `putGitWorkspace`, `listGitWorkspaces`, `putGitSubmission`, `putValidationCommandGrant`, `decideValidationCommandGrant`, `putValidationRun`, `putReviewPackage`, `putReviewDecision`, `putIntegrationAttempt`, and list/get counterparts.

- [ ] **Step 1: Write failing migration and round-trip tests**

```ts
it("migrates a P1A database from v1 to v2 without losing facts", () => {
  const databasePath = createP1DatabaseWithCompany();
  const store = new CoreStore(databasePath);
  store.initialize();
  expect(readUserVersion(databasePath)).toBe(2);
  expect(store.getCompany("company")).not.toBeNull();
  expect(listTableNames(databasePath)).toContain("git_runs");
  store.close();
});

it("round-trips a prepared integration attempt", () => {
  const store = initializedStore();
  store.putIntegrationAttempt(preparedAttempt());
  expect(store.getIntegrationAttempt("attempt-1")).toEqual(preparedAttempt());
  store.close();
});

it("rolls back a failed migration", () => {
  const databasePath = createCorruptP1Database();
  expect(() => new CoreStore(databasePath).initialize()).toThrow("schema migration");
  expect(readUserVersion(databasePath)).toBe(1);
});
```

- [ ] **Step 2: Run focused tests and verify missing schema behavior**

Run:

```powershell
pnpm --filter @agenttown/core test -- storage-migrations.test.ts
```

Expected: FAIL because schema versioning and Git tables are absent.

- [ ] **Step 3: Implement explicit v1→v2 migration**

Use `PRAGMA user_version`. Fresh databases apply the complete v2 schema and set `user_version = 2`. Existing databases with P1A tables and `user_version = 0` are classified as v1 only after checking the expected P1A table set.

Create these v2 tables with foreign keys and uniqueness constraints:

```sql
git_runs(
  run_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  original_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  integration_ref TEXT NOT NULL UNIQUE,
  integration_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

git_workspaces(
  workspace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  employee_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  branch_ref TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  status TEXT NOT NULL
);

git_submissions(
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, revision)
);

validation_runs(
  validation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  integration_attempt_id TEXT,
  record_json TEXT NOT NULL
);

validation_command_grants(
  grant_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(run_id, task_id, workspace_id, command_fingerprint)
);

review_packages(
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, revision)
);

review_decisions(
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, revision)
);

integration_attempts(
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL
);
```

Run all migration DDL and `PRAGMA user_version = 2` inside one `BEGIN IMMEDIATE` transaction. Reject unknown future versions and malformed v1 layouts without changing them.

- [ ] **Step 4: Add focused typed store methods**

Keep Git persistence in `CoreStore` for the current architecture, but group methods by record. Every mutation that changes a Git fact and emits an event must have one transaction-level method; do not expose generic SQL or `putJson(kind, value)`.

Representative signature:

```ts
commitPreparedIntegration(input: {
  attempt: IntegrationAttemptRecord;
  submission: GitSubmissionRecord;
  event: NewEvent;
}): void;

commitIntegratedTask(input: {
  attempt: IntegrationAttemptRecord;
  submission: GitSubmissionRecord;
  task: TaskRecord;
  events: readonly NewEvent[];
}): void;
```

Add row readers that validate JSON with Task 1 parsers before returning it.

- [ ] **Step 5: Run storage tests, Core tests and typecheck**

Run:

```powershell
pnpm --filter @agenttown/core test -- storage-migrations.test.ts
pnpm --filter @agenttown/core test
pnpm typecheck
```

Expected: migration tests and all existing P1A Core tests pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/storage packages/core/src/index.ts packages/core/test/storage-migrations.test.ts
git commit -m "feat: persist versioned P1B git facts"
```

---

### Task 3: Typed Git Boundary and Repository Preflight

**Files:**
- Create: `packages/core/src/git/git-command.ts`
- Create: `packages/core/src/git/repository-preflight.ts`
- Create: `packages/core/test/helpers/git-fixture.ts`
- Create: `packages/core/test/repository-preflight.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `GitCommandRunner.run(args, options)`, `RepositoryPreflight.inspect(projectRoot)`, `RepositoryBaseline`.
- Consumes: Node `spawn`, Task 1 `GitRunRecord`.

- [ ] **Step 1: Write failing preflight tests using real temporary repositories**

```ts
it("records a clean attached baseline and excludes AgentTown locally", async () => {
  const repo = await createGitFixture();
  const result = await preflight.inspect(repo.root);
  expect(result.originalBranch).toBe("main");
  expect(result.baseCommit).toMatch(/^[0-9a-f]{40,64}$/u);
  expect(await repo.readInfoExclude()).toContain("/.agenttown/");
});

it.each([
  ["tracked", dirtyTrackedRepo],
  ["staged", dirtyStagedRepo],
  ["untracked", dirtyUntrackedRepo]
])("rejects a %s user worktree", async (_label, arrange) => {
  const repo = await arrange();
  await expect(preflight.inspect(repo.root)).rejects.toThrow("worktree is not clean");
});

it("allows ignored files", async () => {
  const repo = await ignoredFileRepo();
  await expect(preflight.inspect(repo.root)).resolves.toBeDefined();
});

it("rejects detached HEAD and in-progress cherry-pick", async () => {
  await expect(preflight.inspect((await detachedRepo()).root)).rejects.toThrow("attached branch");
  await expect(preflight.inspect((await cherryPickInProgressRepo()).root)).rejects.toThrow("in-progress");
});
```

- [ ] **Step 2: Run the focused test**

Run:

```powershell
pnpm --filter @agenttown/core test -- repository-preflight.test.ts
```

Expected: FAIL because `RepositoryPreflight` and fixture helpers do not exist.

- [ ] **Step 3: Implement the sole Git command wrapper**

```ts
export interface GitCommandOptions {
  cwd: string;
  timeoutMs?: number;
  stdin?: string;
  allowedExitCodes?: readonly number[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}
```

Requirements:

- spawn `git` with an argument array, `shell: false`, `windowsHide: true`;
- set `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `LANG=C`;
- bound stdout/stderr capture and return a typed overflow error;
- use a default 30-second timeout;
- terminate the process tree on timeout using the existing bounded cleanup patterns from Fake Agent lifecycle;
- include the Git subcommand and safe stderr in errors, never dump the environment.

- [ ] **Step 4: Implement preflight in the specified order**

Probe:

```text
git --version
git rev-parse --show-toplevel
git rev-parse --is-bare-repository
git symbolic-ref --quiet --short HEAD
git rev-parse HEAD
git status --porcelain=v2 --untracked-files=normal
git rev-parse --git-common-dir
git worktree list --porcelain
```

Resolve the project root and returned toplevel with realpath and require equality. Check Git >=2.31.0. Detect merge/rebase/cherry-pick/revert/bisect state through `git rev-parse --git-path <marker>` followed by bounded filesystem checks.

Update `.git/info/exclude` atomically and idempotently before status:

```text
/.agenttown/
```

Reject every porcelain v2 entry except ignored entries, which are not requested by `--untracked-files=normal` anyway. Return:

```ts
export interface RepositoryBaseline {
  projectRoot: string;
  gitCommonDir: string;
  originalBranch: string;
  baseCommit: string;
  objectIdLength: 40 | 64;
}
```

- [ ] **Step 5: Run preflight tests and Core typecheck**

Run:

```powershell
pnpm --filter @agenttown/core test -- repository-preflight.test.ts
pnpm --filter @agenttown/core typecheck
```

Expected: all preflight cases pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/git packages/core/test/helpers packages/core/test/repository-preflight.test.ts packages/core/src/index.ts
git commit -m "feat: gate P1B runs on safe git repositories"
```

---

### Task 4: Run and Task Worktree Lifecycle

**Files:**
- Create: `packages/core/src/git/workspace-manager.ts`
- Create: `packages/core/test/workspace-manager.test.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `GitCommandRunner`, `RepositoryBaseline`, CoreStore Git methods.
- Produces: `WorkspaceManager.createRun`, `createTaskWorkspace`, `createCandidateWorkspace`, `pauseRun`, `removeVerifiedWorkspace`.

- [ ] **Step 1: Write failing real-worktree tests**

```ts
it("creates integration and task worktrees without moving the user branch", async () => {
  const before = await repo.head();
  const run = await manager.createRun("run-1", baseline);
  const task = await manager.createTaskWorkspace({
    runId: run.runId,
    employeeId: "developer-a",
    taskId: "task-a",
    baseCommit: run.integrationCommit
  });
  expect(await repo.head()).toBe(before);
  expect(task.branchRef).toBe("refs/heads/agenttown/run-1/developer-a/task-a");
  expect(await repo.worktreeHead(task.path)).toBe(before);
});

it("rejects a task path that resolves outside the run root", async () => {
  await expect(manager.createTaskWorkspace({
    runId: "run-1",
    employeeId: "developer-a",
    taskId: "../escape",
    baseCommit: baseline.baseCommit
  })).rejects.toThrow("task id");
});

it("preserves worktrees on pause and removes only a verified worktree on cleanup", async () => {
  const task = await createTaskWorkspace();
  await manager.pauseRun("run-1");
  await expect(access(task.path)).resolves.toBeUndefined();
  await manager.removeVerifiedWorkspace(task.workspaceId);
  await expect(access(task.path)).rejects.toThrow();
  expect(await repo.refExists(task.branchRef)).toBe(true);
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- workspace-manager.test.ts
```

Expected: FAIL because workspace lifecycle does not exist.

- [ ] **Step 3: Implement deterministic ref/path builders**

```ts
export function integrationRef(runId: string): string;
export function taskRef(runId: string, employeeId: string, taskId: string): string;
export function candidateRef(runId: string, attemptId: string): string;

export interface CreateTaskWorkspaceInput {
  runId: string;
  employeeId: string;
  taskId: string;
  baseCommit: string;
}
```

Validate each ID independently; join paths beneath `.agenttown/worktrees/<run-id>`. Before and after `git worktree add`, resolve the nearest existing parent and resulting real path, reject symbolic links/reparse escapes, and verify `git worktree list --porcelain`.

- [ ] **Step 4: Implement persisted lifecycle**

`createRun`:

1. persist a run creation intent;
2. create `agenttown/<run-id>/integration` at baseline;
3. create the integration worktree;
4. verify branch and head;
5. mark the run active and emit `git.run.created`.

`createTaskWorkspace` follows the same intent/create/verify/commit pattern. On partial failure, remove only assets whose exact path/ref still matches the intent; otherwise mark `tampered`.

`removeVerifiedWorkspace` requires:

- database status is completed or paused;
- path is beneath the exact run root;
- `git worktree list` maps that path to the recorded ref/head;
- no uncommitted changes;
- removal does not delete the branch ref.

- [ ] **Step 5: Run worktree and regression tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- workspace-manager.test.ts repository-preflight.test.ts
pnpm --filter @agenttown/core test
```

Expected: all focused and existing Core tests pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/git/workspace-manager.ts packages/core/src/storage/core-store.ts packages/core/src/index.ts packages/core/test/workspace-manager.test.ts
git commit -m "feat: isolate P1B task worktrees"
```

---

### Task 5: Structured Validation Runner and Evidence Logs

**Files:**
- Create: `packages/core/src/git/validation-runner.ts`
- Create: `packages/core/test/validation-runner.test.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CompanyDefinition.validation`, registered workspace path.
- Produces: `ValidationRunner.run(command, scope)`, `ValidationRunner.requestGrant(command, scope)`, `ValidationRunner.decideGrant`, `ValidationRunRecord`.

- [ ] **Step 1: Write failing validation tests**

```ts
it("runs an approved executable without a shell and records ordered output", async () => {
  const result = await runner.run(nodeCommand([
    "-e",
    "process.stdout.write('out'); process.stderr.write('err')"
  ]), taskScope);
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("passed");
  expect(await readFile(result.logPath, "utf8")).toContain("out");
});

it("rejects a cwd outside the registered worktree", async () => {
  await expect(runner.run(command({ cwd: ".." }), taskScope))
    .rejects.toThrow("outside workspace");
});

it("times out and reaps the process tree", async () => {
  const result = await runner.run(hangingChildCommand(), taskScope, { timeoutMs: 100 });
  expect(result.outcome).toBe("timed_out");
  expect(await processIsGone(result.rootPid)).toBe(true);
});

it("redacts configured secret values before persistence", async () => {
  const result = await runner.run(printSecretCommand("secret-value"), taskScope, {
    secretValues: ["secret-value"]
  });
  expect(await readFile(result.logPath, "utf8")).not.toContain("secret-value");
});

it("refuses a suggested command until the user approves its exact fingerprint", async () => {
  const pending = await runner.requestGrant(suggestedCommand, taskScope);
  await expect(runner.run(suggestedCommand, taskScope))
    .rejects.toThrow(`approval required: ${pending.grantId}`);
  await runner.decideGrant(pending.grantId, "approved", "Needed for acceptance");
  await expect(runner.run(suggestedCommand, taskScope))
    .resolves.toEqual(expect.objectContaining({ outcome: "passed" }));
});

it("does not let an approval cover changed args, cwd or workspace", async () => {
  await approveExactCommand(suggestedCommand, taskScope);
  await expect(runner.run(
    { ...suggestedCommand, args: [...suggestedCommand.args, "--write"] },
    taskScope
  )).rejects.toThrow("approval required");
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- validation-runner.test.ts
```

Expected: FAIL because `ValidationRunner` is absent.

- [ ] **Step 3: Implement command resolution and approval**

```ts
export interface ValidationScope {
  runId: string;
  taskId: string | null;
  integrationAttemptId: string | null;
  workspaceId: string;
  workspaceRoot: string;
}

export class ValidationRunner {
  run(
    command: ValidationCommand,
    scope: ValidationScope,
    options?: { secretValues?: readonly string[] }
  ): Promise<ValidationRunRecord>;
  requestGrant(
    command: ValidationCommand,
    scope: ValidationScope
  ): Promise<ValidationCommandGrant>;
  decideGrant(
    grantId: string,
    decision: "approved" | "rejected",
    reason: string
  ): Promise<ValidationCommandGrant>;
}
```

Resolve the configured relative `cwd` beneath `workspaceRoot`; reject symlink/reparse escape. Spawn the configured executable and args directly. Give the child a minimal inherited environment minus variables explicitly classified as AgentTown secrets.

A command is executable only if it exactly equals a company-configured command referenced by ID, or an approved grant matches the SHA-256 of canonical `{ executable, args, cwd, timeoutSeconds, workspaceId }`. Persist pending/approved/rejected grants in the v2 table from Task 2 and emit `user.approval.requested` for pending suggestions. Rejection returns the task to the leader with the user's reason; it never silently falls back to executing the command.

- [ ] **Step 4: Implement bounded execution, redaction and persistence**

Write interleaved chunks to a temporary log with stream labels and monotonic sequence. On exit:

1. close the file;
2. redact known exact secret values and common bearer/token assignment forms into the final log;
3. hash the final log;
4. atomically rename it under `.agenttown/runs/<run-id>/validation/`;
5. persist `ValidationRunRecord`;
6. emit `validation.completed`.

Timeout and abort must use the Fake Agent process-tree cleanup strategy with an absolute deadline. If cleanup cannot be verified, return `cleanup_failed`, pause the affected workflow, and never report a normal test failure.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
pnpm --filter @agenttown/core test -- validation-runner.test.ts
pnpm --filter @agenttown/core typecheck
```

Expected: pass with no surviving child processes.

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/git/validation-runner.ts packages/core/src/storage/core-store.ts packages/core/src/index.ts packages/core/test/validation-runner.test.ts
git commit -m "feat: run authoritative P1B validation commands"
```

---

### Task 6: Submission Validation and Immutable Review Packages

**Files:**
- Create: `packages/core/src/git/submission-validator.ts`
- Create: `packages/core/src/git/evidence-package.ts`
- Create: `packages/core/test/submission-validator.test.ts`
- Create: `packages/core/test/evidence-package.test.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: task workspace, `GitTaskSubmission`, authoritative `ValidationRunRecord`.
- Produces: `ValidatedSubmission`, `EvidencePackageBuilder.create`, hash-verified `ReviewPackageRecord`.

- [ ] **Step 1: Write failing submission tests**

```ts
it("accepts the exact continuous commits after the task base", async () => {
  const fixture = await repo.twoCommitTask();
  const result = await validator.validate(fixture.workspace, {
    ...submission,
    headCommit: fixture.second,
    commits: [fixture.first, fixture.second]
  });
  expect(result.commits).toEqual([fixture.first, fixture.second]);
});

it.each([
  ["omitted commit", omitFirstCommit],
  ["foreign commit", useForeignCommit],
  ["dirty index", dirtyIndex],
  ["dirty worktree", dirtyWorktree],
  ["gitlink change", changeSubmodule]
])("rejects %s", async (_label, arrange) => {
  const input = await arrange();
  await expect(validator.validate(input.workspace, input.submission))
    .rejects.toThrow();
});

it("records binary metadata without embedding bytes in the patch", async () => {
  const result = await validator.validate(...await binaryChange());
  expect(result.files[0]?.binary).toBe(true);
  expect(result.patch).not.toContain("base64");
});
```

- [ ] **Step 2: Write failing evidence tests**

```ts
it("creates a versioned package with hashes for every file", async () => {
  const record = await builder.create(validatedInput({ revision: 1 }));
  const manifest = JSON.parse(await readFile(record.manifestPath, "utf8"));
  expect(Object.keys(manifest.files)).toContain("changes.patch");
  expect(record.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
});

it("does not overwrite revision one when revision two is created", async () => {
  const first = await builder.create(validatedInput({ revision: 1 }));
  const second = await builder.create(validatedInput({ revision: 2 }));
  expect(first.manifestPath).not.toBe(second.manifestPath);
  expect(await fileExists(first.manifestPath)).toBe(true);
});

it("detects a changed package before review", async () => {
  const record = await builder.create(validatedInput({ revision: 1 }));
  await appendFile(record.manifestPath, "tamper");
  await expect(builder.verify(record)).rejects.toThrow("tampered");
});
```

- [ ] **Step 3: Run both focused suites**

Run:

```powershell
pnpm --filter @agenttown/core test -- submission-validator.test.ts evidence-package.test.ts
```

Expected: FAIL because both services are missing.

- [ ] **Step 4: Implement authoritative Git derivation**

Use Git plumbing to derive:

- actual ordered commits from `baseCommit..headCommit`;
- reachability of `headCommit` from the registered task ref;
- clean porcelain v2 state;
- name/status/size list;
- full binary-aware patch;
- gitlink mode `160000` rejection;
- canonical commit metadata.

Do not trust `submission.commits` until it exactly equals the derived list. Reject an empty range. Apply 2 MiB warning and 20 MiB hard default after measuring UTF-8 patch bytes; validate configured limits from Task 1.

- [ ] **Step 5: Implement atomic evidence generation**

Write all package files into a unique sibling temporary directory using exclusive creation. Hash every finalized file, write `manifest.json` last, fsync files and directory where Node supports it, then atomically rename the directory to:

```text
.agenttown/runs/<run-id>/reviews/<task-id>/<revision>
```

If the destination already exists, verify it exactly matches the stored record; never overwrite. Persist the record and `review.package.created` only after the final directory and hashes verify.

- [ ] **Step 6: Run focused and Core regression suites**

Run:

```powershell
pnpm --filter @agenttown/core test -- submission-validator.test.ts evidence-package.test.ts
pnpm --filter @agenttown/core test
```

Expected: all suites pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/core/src/git packages/core/src/storage/core-store.ts packages/core/src/index.ts packages/core/test/submission-validator.test.ts packages/core/test/evidence-package.test.ts
git commit -m "feat: validate submissions and build review evidence"
```

---

### Task 7: Review State and Git Workflow Coordinator

**Files:**
- Create: `packages/core/src/git/review-service.ts`
- Create: `packages/core/src/git/git-workflow-coordinator.ts`
- Create: `packages/core/test/review-service.test.ts`
- Create: `packages/core/test/git-workflow-coordinator.test.ts`
- Modify: `packages/core/src/company/orchestrator.ts`
- Modify: `packages/core/src/policy/action-policy.ts`
- Modify: `packages/core/src/tasks/task-service.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: workspaces, submission validator, validation runner, evidence builder, review parser.
- Produces: `GitWorkflowCoordinator.assignTask`, `submitTask`, `recordReview`, and `ReviewService`.

- [ ] **Step 1: Write failing review-state tests**

```ts
it("keeps an approved task in review until integration", async () => {
  const task = await coordinator.submitTask(validSubmissionAction());
  await coordinator.recordReview(task.id, approvingDecision());
  expect(tasks.get(task.id).status).toBe("review");
  expect(store.latestSubmission(runId, task.id)?.status).toBe("approved");
});

it("returns a rejected task to the same owner and increments review loops", async () => {
  await coordinator.recordReview("task-a", rejectingDecision());
  const task = tasks.get("task-a");
  expect(task.status).toBe("running");
  expect(task.ownerEmployeeId).toBe("developer-a");
  expect(task.reviewLoopCount).toBe(1);
});

it("escalates after the second rejection", async () => {
  await rejectTwoRevisions();
  expect(tasks.get("task-a").status).toBe("blocked");
  expect(store.listPendingApprovals("company")).toHaveLength(1);
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- review-service.test.ts git-workflow-coordinator.test.ts
```

Expected: FAIL because approval still completes a P1A task immediately.

- [ ] **Step 3: Implement review-service invariants**

```ts
export class ReviewService {
  recordDecision(input: {
    runId: string;
    task: TaskRecord;
    reviewerId: string;
    revision: number;
    decision: ReviewDecision;
  }): ReviewOutcome;
}

export type ReviewOutcome =
  | { kind: "approved"; submission: GitSubmissionRecord }
  | { kind: "changes_requested"; task: TaskRecord }
  | { kind: "escalated"; task: TaskRecord; approvalId: string };
```

Before accepting a decision:

- verify reviewer permission;
- verify the current review package hash;
- require `reviewedManifestHash` equality;
- reject stale revision decisions;
- apply blocking/advisory rules from Task 1.

- [ ] **Step 4: Route P1B assignment and submission**

`assignTask` creates the task worktree before sending the task message and injects `WritableTaskContext`. `submitTask` performs:

1. parse structured submission;
2. create pending grants for unrecognized suggested validation commands and pause submission until the user decides;
3. validate Git facts;
4. execute configured and exactly approved commands;
5. reject on non-pass or cleanup failure;
6. persist submission revision;
7. create/verify review package;
8. transition to `review`;
9. send reviewer a `ReviewTaskContext`.

Change `CompanyOrchestrator` so `task.approve` delegates to the coordinator and does not call `tasks.transition(..., "completed")`.

- [ ] **Step 5: Protect P1A compatibility**

Keep a Fake-only non-Git mode for existing P1A tests by selecting the Git coordinator only when a run has a configured `git_worktree` employee. Do not make Git services nullable across the whole Core; define a small `TaskWorkflow` interface with `FakeTaskWorkflow` and `GitTaskWorkflow` implementations.

```ts
export interface TaskWorkflow {
  assign(action: ActionProposal): Promise<void>;
  submit(action: ActionProposal): Promise<void>;
  review(action: ActionProposal): Promise<void>;
}
```

- [ ] **Step 6: Run review, orchestrator and Core suites**

Run:

```powershell
pnpm --filter @agenttown/core test -- review-service.test.ts git-workflow-coordinator.test.ts orchestrator.test.ts
pnpm --filter @agenttown/core test
pnpm typecheck
```

Expected: P1B review semantics and all P1A regressions pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/core/src/git packages/core/src/company packages/core/src/policy packages/core/src/tasks packages/core/src/index.ts packages/core/test
git commit -m "feat: gate task completion on P1B review workflow"
```

---

### Task 8: Deterministic Candidate Integration and Atomic Ref Progress

**Files:**
- Create: `packages/core/src/git/integration-service.ts`
- Create: `packages/core/test/integration-service.test.ts`
- Modify: `packages/core/src/git/git-workflow-coordinator.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: approved submissions, DAG/task creation event sequence, workspace manager, validation runner.
- Produces: `IntegrationService.enqueue`, `drain`, `recoverPrepared`, `IntegrationResult`.

- [ ] **Step 1: Write failing stable-order and atomicity tests**

```ts
it("orders ready submissions by DAG layer, creation sequence, then task id", () => {
  expect(orderIntegrations([
    candidate("task-b", { layer: 0, createdSequence: 12 }),
    candidate("task-a", { layer: 0, createdSequence: 11 }),
    candidate("task-c", { layer: 1, createdSequence: 5 })
  ]).map(({ taskId }) => taskId)).toEqual(["task-a", "task-b", "task-c"]);
});

it("waits for an earlier same-layer task that is not approved", async () => {
  await service.enqueue(approvedTaskB);
  expect(await service.drain()).toEqual({ kind: "waiting", taskId: "task-a" });
});

it("advances integration only after candidate tests pass", async () => {
  const before = await repo.ref(integrationRef);
  const result = await service.integrate(approvedTaskA);
  expect(result.kind).toBe("integrated");
  expect(await repo.ref(integrationRef)).not.toBe(before);
  expect(tasks.get("task-a").status).toBe("completed");
});

it("leaves integration unchanged when candidate validation fails", async () => {
  const before = await repo.ref(integrationRef);
  const result = await service.integrate(failingApprovedTask);
  expect(result.kind).toBe("validation_failed");
  expect(await repo.ref(integrationRef)).toBe(before);
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- integration-service.test.ts
```

Expected: FAIL because the integration queue does not exist.

- [ ] **Step 3: Implement stable queue selection**

Calculate DAG layers from persisted tasks, reject cycles defensively, and use `createdEventId` to retrieve the immutable event sequence. The next candidate is eligible only when:

- all dependencies are completed;
- it is approved;
- no lower sort-key task in the same layer remains nonterminal and nonintegrated.

Persist the chosen `orderKey` as zero-padded layer, sequence and task ID so database ordering is stable.

- [ ] **Step 4: Implement prepared intent and candidate integration**

```ts
export type IntegrationResult =
  | { kind: "integrated"; attempt: IntegrationAttemptRecord }
  | { kind: "conflicted"; attempt: IntegrationAttemptRecord; files: string[] }
  | { kind: "validation_failed"; attempt: IntegrationAttemptRecord }
  | { kind: "waiting"; taskId: string }
  | { kind: "reconciliation_required"; attemptId: string };
```

Algorithm:

1. record `prepared` with expected old integration SHA;
2. create candidate ref/worktree at old SHA;
3. cherry-pick each reviewed commit with `GIT_EDITOR=true`;
4. on success run every integration command ID;
5. record candidate new SHA;
6. perform compare-and-swap with `git update-ref <integration-ref> <new-sha> <old-sha>`;
7. update the registered integration worktree using a safe detached update to the exact new SHA;
8. atomically persist committed attempt, integrated submission, completed task, and events;
9. remove the verified candidate worktree/ref.

If step 6 reports compare failure, do not retry; return `reconciliation_required`.

- [ ] **Step 5: Prove crash windows**

Add fault-injection hooks used only by tests:

```ts
export interface IntegrationFaultHooks {
  afterPrepared?(): void;
  afterRefUpdated?(): void;
  beforeFactsCommitted?(): void;
}
```

Tests must stop after each hook and assert that formal reconciliation in Task 10 can distinguish old-ref and new-ref cases. Do not add production sleeps.

- [ ] **Step 6: Run integration and Core suites**

Run:

```powershell
pnpm --filter @agenttown/core test -- integration-service.test.ts
pnpm --filter @agenttown/core test
pnpm typecheck
```

Expected: integration tests and P1A tests pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/core/src/git packages/core/src/storage/core-store.ts packages/core/src/index.ts packages/core/test/integration-service.test.ts
git commit -m "feat: integrate reviewed work through atomic candidates"
```

---

### Task 9: Conflict Tasks and Superseding Submissions

**Files:**
- Create: `packages/core/src/git/conflict-service.ts`
- Create: `packages/core/test/conflict-service.test.ts`
- Modify: `packages/core/src/git/integration-service.ts`
- Modify: `packages/core/src/git/git-workflow-coordinator.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/src/tasks/task-service.ts`

**Interfaces:**
- Consumes: conflicted integration attempt and original approved submission.
- Produces: `ConflictService.createTask`, `prepareResolutionWorkspace`, `completeResolution`.

- [ ] **Step 1: Write failing conflict workflow tests**

```ts
it("aborts the candidate and leaves formal integration clean", async () => {
  const before = await repo.ref(integrationRef);
  const result = await service.integrate(conflictingApprovedTask);
  expect(result.kind).toBe("conflicted");
  expect(await repo.ref(integrationRef)).toBe(before);
  expect(await repo.status(integrationWorktree)).toBe("");
});

it("creates an unassigned conflict task without a dependency cycle", async () => {
  const conflict = conflictService.createTask(conflictedAttempt);
  expect(conflict.ownerEmployeeId).toBeNull();
  expect(conflict.dependencies).not.toContain(conflictedAttempt.taskId);
  expect(conflict.conflictForTaskId).toBe(conflictedAttempt.taskId);
});

it("completes the conflict task and original only after reviewed resolution integrates", async () => {
  await completeResolutionFlow();
  expect(tasks.get("conflict-task").status).toBe("completed");
  expect(tasks.get("original-task").status).toBe("completed");
});
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- conflict-service.test.ts
```

Expected: FAIL because conflict tasks are not modeled.

- [ ] **Step 3: Add explicit conflict metadata**

Extend `TaskRecord` with an honest nullable field, updating all constructors:

```ts
conflictForTaskId: string | null;
```

Normal tasks use `null`. A conflict task copies the original completed dependencies, not the blocked original task itself, and records conflict files/evidence in task artifacts.

- [ ] **Step 4: Implement safe conflict preparation**

After candidate cherry-pick reports conflicts:

1. collect unmerged file paths with porcelain v2;
2. run `git cherry-pick --abort`;
3. verify candidate status clean and candidate ref unchanged;
4. remove candidate assets if verified;
5. set original task `blocked`;
6. create the unassigned conflict task and event.

When the leader assigns the conflict task, create a fresh task worktree at current integration SHA and apply the original reviewed commits with `git cherry-pick --no-commit` until the conflict is reproduced. Verify the conflicted file set matches recorded evidence before giving the workspace to the employee.

- [ ] **Step 5: Implement resolution supersession**

The resolution submission uses the normal test/review pipeline. On successful integration, store:

```ts
supersedes: {
  taskId: originalTaskId,
  revision: originalRevision,
  attemptId: conflictedAttemptId
}
```

In one Core transaction, mark the resolution submission integrated and both tasks completed. If resolution creates a different conflict set, stop and request user review instead of silently replacing scope.

- [ ] **Step 6: Run conflict, integration and task suites**

Run:

```powershell
pnpm --filter @agenttown/core test -- conflict-service.test.ts integration-service.test.ts task-service.test.ts
pnpm --filter @agenttown/core test
```

Expected: all suites pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/runtime-contract/src/task.ts packages/core/src/git packages/core/src/storage/core-store.ts packages/core/src/tasks packages/core/test
git commit -m "feat: turn git conflicts into reviewed tasks"
```

---

### Task 10: Git Checkpoints, Reconciliation and Tamper Stops

**Files:**
- Create: `packages/core/src/git/git-reconciler.ts`
- Create: `packages/core/test/git-reconciler.test.ts`
- Modify: `packages/runtime-contract/src/agent.ts`
- Modify: `packages/core/src/lifecycle/checkpoint-service.ts`
- Modify: `packages/core/src/git/git-workflow-coordinator.ts`
- Modify: `packages/core/src/storage/core-store.ts`
- Modify: `packages/core/test/checkpoint-service.test.ts`

**Interfaces:**
- Consumes: Git records, real refs/worktrees/packages and prepared attempts.
- Produces: `GitCheckpoint`, `GitReconciler.reconcile`, typed reconciliation results.

- [ ] **Step 1: Write failing reconciliation tests**

```ts
it("verifies an unchanged paused run", async () => {
  expect(await reconciler.reconcile(runId)).toEqual(
    expect.objectContaining({ classification: "verified" })
  );
});

it("completes facts when a prepared attempt ref already moved to new SHA", async () => {
  await arrangePreparedAttempt({ refAt: "new" });
  const result = await reconciler.reconcile(runId);
  expect(result.classification).toBe("completed_recovery");
  expect(store.getIntegrationAttempt("attempt-1")?.status).toBe("committed");
});

it("rolls back a prepared attempt whose ref remains at old SHA", async () => {
  await arrangePreparedAttempt({ refAt: "old" });
  expect((await reconciler.reconcile(runId)).classification)
    .toBe("rolled_back_recovery");
});

it.each(["unknown-ref", "missing-worktree", "changed-task-head", "changed-manifest"])(
  "stops on %s",
  async (scenario) => {
    await arrangeTamper(scenario);
    expect((await reconciler.reconcile(runId)).classification)
      .toMatch(/tampered|missing/u);
  }
);
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
pnpm --filter @agenttown/core test -- git-reconciler.test.ts checkpoint-service.test.ts
```

Expected: FAIL because Git checkpoint facts are absent.

- [ ] **Step 3: Extend checkpoints**

```ts
export interface GitCheckpoint {
  runId: string;
  integrationRef: string;
  integrationCommit: string;
  workspaces: Array<{
    workspaceId: string;
    branchRef: string;
    headCommit: string;
    status: GitWorkspaceStatus;
  }>;
  activeSubmissionRevisions: Array<{ taskId: string; revision: number }>;
  integrationAttemptIds: string[];
}
```

Add `git: GitCheckpoint | null` to `CompanyCheckpoint`. P1A checkpoints use `null`. Pause order:

1. stop new dispatch;
2. abort validation processes within the existing absolute deadline;
3. allow an in-flight CAS to finish its intent boundary;
4. snapshot verified Git facts;
5. commit checkpoint and paused status;
6. interrupt/stop sessions.

- [ ] **Step 4: Implement strict reconciliation**

For each record, query real Git and hash evidence. Classify:

- exact equality → `verified`;
- prepared attempt with ref at new SHA → finish Core facts;
- prepared attempt with ref at old SHA → remove verified candidate and mark aborted;
- original user worktree changed → `user_workspace_changed` warning only;
- AgentTown ref at any third SHA or task head changed → `tampered`;
- missing commit/ref/worktree/evidence → `missing`.

On `tampered` or `missing`, set company `paused`, create a user approval request containing exact discrepancies, and do not start Agent sessions.

- [ ] **Step 5: Run recovery and lifecycle regressions**

Run:

```powershell
pnpm --filter @agenttown/core test -- git-reconciler.test.ts checkpoint-service.test.ts
pnpm --filter @agenttown/e2e test -- fake-company.test.ts
pnpm typecheck
```

Expected: Git recovery and all P1A pause/restart behavior pass.

- [ ] **Step 6: Commit**

```powershell
git add packages/runtime-contract/src/agent.ts packages/core/src/git packages/core/src/lifecycle packages/core/src/storage/core-store.ts packages/core/test
git commit -m "feat: reconcile P1B git state across restarts"
```

---

### Task 11: P1B IPC, CLI Delivery and Explicit Cleanup

**Files:**
- Create: `packages/core/src/git/cleanup-service.ts`
- Create: `packages/cli/src/git-render.ts`
- Create: `packages/cli/test/git-render.test.ts`
- Modify: `packages/runtime-contract/src/ipc.ts`
- Modify: `packages/core/src/ipc/core-server.ts`
- Modify: `packages/core/src/git/git-workflow-coordinator.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/test/main.test.ts`
- Modify: `packages/cli/src/render.ts`

**Interfaces:**
- Produces IPC: `git.workspaces.list`, `git.evidence.get`, `git.delivery.get`, `git.cleanup.preview`, `git.cleanup.execute`, `approvals.list`, and `approvals.decide`.
- Produces CLI: `workspaces`, `evidence <task-id> [--revision N]`, `deliver`, `approvals`, `approve <approval-id>`, `reject <approval-id>`, and `cleanup <run-id>`.

- [ ] **Step 1: Write failing render and command tests**

```ts
it("renders delivery with explicit non-push status", () => {
  expect(renderDelivery(deliveryFixture())).toContain(
    "not merged into user branch; not pushed"
  );
});

it("requires an exact run id for cleanup", async () => {
  await expect(runCli(["cleanup"], root, runtime)).rejects.toThrow("run id");
});

it("defaults cleanup to worktrees only", async () => {
  await runCli(["cleanup", "run-1", "--yes"], root, runtime);
  expect(runtime.lastRequest).toEqual({
    method: "git.cleanup.execute",
    params: {
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    }
  });
});

it("requires separate flags and confirmation for branches and evidence", async () => {
  await expect(runCli([
    "cleanup", "run-1", "--branches", "--evidence"
  ], root, nonInteractiveRuntime)).rejects.toThrow("--yes");
});

it("approves one exact pending command grant with a reason", async () => {
  await runCli([
    "approve", "grant-1", "--reason", "Required project test"
  ], root, runtime);
  expect(runtime.lastRequest).toEqual({
    method: "approvals.decide",
    params: {
      approvalId: "grant-1",
      decision: "approved",
      reason: "Required project test"
    }
  });
});
```

- [ ] **Step 2: Run CLI tests**

Run:

```powershell
pnpm --filter @agenttown/cli test -- git-render.test.ts main.test.ts
```

Expected: FAIL because P1B commands and IPC methods are absent.

- [ ] **Step 3: Add versioned IPC methods and views**

Define exact result types in `runtime-contract/src/ipc.ts`, including:

```ts
export interface DeliveryTaskView {
  taskId: string;
  employeeId: string;
  commits: string[];
  submissionRevision: number;
  reviewDecision: "approve";
  validationOutcomes: Array<{
    commandId: string;
    outcome: "passed";
  }>;
}

export interface DeliveryView {
  runId: string;
  originalBranch: string;
  baseCommit: string;
  integrationBranch: string;
  integrationCommit: string;
  tasks: DeliveryTaskView[];
  advisoryFindings: string[];
  knownRisks: string[];
  mergedIntoUserBranch: false;
  pushed: false;
}
```

Every cleanup is two-step: preview returns exact verified paths/refs/evidence roots plus a fingerprint; execute requires the same fingerprint so changed state invalidates approval.

`approvals.list` returns pending command grants with the exact executable, argument array, relative cwd, timeout, workspace, requesting employee and reason. `approvals.decide` accepts only an existing pending ID, `approved|rejected`, and a non-empty user reason; duplicate identical decisions are idempotent and conflicting second decisions fail.

- [ ] **Step 4: Implement cleanup bounds**

`CleanupService` must:

- accept one exact run ID;
- resolve every path/ref from stored records, not CLI strings;
- verify ownership and current head/hash;
- refuse dirty or mismatched worktrees;
- remove worktrees by default;
- remove task/integration branches only with `removeBranches: true`;
- remove run-scoped review/log files and their corresponding Git evidence rows only with `removeEvidence: true`;
- never offer wildcard “all runs” execution.

- [ ] **Step 5: Implement concise product-language rendering**

`workspaces` columns:

```text
EMPLOYEE  TASK  STATE  HEAD  WORKSPACE
```

`evidence` prints revision, manifest hash, validation summary and path. `deliver` prints base/integration refs, task commits, review/test results, advisory findings, and suggested read-only inspection commands:

```text
git diff <base>..<integration>
git log --oneline <base>..<integration>
```

It may show a manual merge example but must state AgentTown did not execute it.

- [ ] **Step 6: Run CLI, IPC and typecheck**

Run:

```powershell
pnpm --filter @agenttown/cli test
pnpm --filter @agenttown/core test -- core-server.test.ts
pnpm typecheck
```

Expected: all CLI/IPC tests pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/runtime-contract/src/ipc.ts packages/core/src/git/cleanup-service.ts packages/core/src/ipc packages/cli
git commit -m "feat: expose P1B delivery and cleanup commands"
```

---

### Task 12: Deterministic Git Fake Agent and Full P1B E2E

**Files:**
- Create: `packages/fake-agent/src/git-fixture.ts`
- Create: `packages/fake-agent/test/git-fixture.test.ts`
- Create: `packages/e2e/test/git-company.test.ts`
- Modify: `packages/fake-agent/src/company-cli.ts`
- Modify: `packages/core/src/agents/fake-adapter.ts`
- Modify: `packages/core/src/main.ts`
- Modify: `packages/cli/src/templates.ts`
- Modify: `packages/cli/test/templates.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `WritableTaskContext`, `ReviewTaskContext`, P1B submission/review parsers, all Core Git services.
- Produces: deterministic scenarios `git-developer-a`, `git-developer-b`, `git-review-approve`, `git-review-reject`, `git-conflict`, `git-conflict-resolve`, and root script `test:p1b`.

- [ ] **Step 1: Write failing Fake Agent safety tests**

```ts
it("writes and commits only inside the supplied task worktree", async () => {
  const result = await runGitFixture({
    context: writableContext,
    scenario: "git-developer-a"
  });
  expect(result.action.type).toBe("task.submit");
  expect(await gitStatus(userRoot)).toBe("");
  expect(await gitLog(writableContext.workspaceRoot)).toContain("fake: task-a");
});

it("rejects review scenarios with a writable context", async () => {
  await expect(runGitFixture({
    context: writableContext,
    scenario: "git-review-approve"
  })).rejects.toThrow("review package");
});

it("refuses a workspace path outside the registered project root", async () => {
  await expect(runGitFixture({
    context: { ...writableContext, workspaceRoot: outside },
    scenario: "git-developer-a"
  })).rejects.toThrow("workspace");
});
```

- [ ] **Step 2: Run Fake Agent tests**

Run:

```powershell
pnpm --filter @agenttown/fake-agent test -- git-fixture.test.ts
```

Expected: FAIL because Git scenarios are missing.

- [ ] **Step 3: Implement deterministic fixture actions**

The Fake Agent may execute only a closed scenario table:

```ts
const scenarios: Record<GitFixtureScenario, GitFixtureHandler> = {
  "git-developer-a": addIndependentFileA,
  "git-developer-b": addIndependentFileB,
  "git-review-approve": approveManifest,
  "git-review-reject": rejectManifest,
  "git-conflict": editSharedLine,
  "git-conflict-resolve": resolveSharedLine
};
```

Handlers receive a Core-produced context, resolve and verify its root, write fixed fixture filenames/content, and call Git with fixed argument arrays. They return structured `task.submit`, `task.approve`, or `task.reject` actions. No scenario accepts arbitrary command, file path, commit message, ref, or shell text from stdin.

- [ ] **Step 4: Write the parallel/restart/delivery E2E first**

```ts
it("runs two isolated Git developers through restart, review and delivery", async () => {
  const project = await createP1BGitProject();
  const original = await project.head("main");
  const company = await startP1BCompany(project.root);
  await company.createParallelTasks();
  await company.waitForBothRunning();
  await company.closeLastClientAndWaitForPause();

  const recovered = await company.restart();
  await recovered.waitForCompletedTasks(["task-a", "task-b"]);
  const delivery = await recovered.delivery();

  expect(await project.head("main")).toBe(original);
  expect(delivery.integrationCommit).not.toBe(original);
  expect(await project.changedFiles(delivery.integrationCommit))
    .toEqual(["feature-a.txt", "feature-b.txt"]);
  expect(delivery.pushed).toBe(false);
});
```

Run:

```powershell
pnpm --filter @agenttown/e2e test -- git-company.test.ts
```

Expected: FAIL until Core main, template scenarios and workflow wiring are complete.

- [ ] **Step 5: Wire the P1B default template and Core startup**

The `parallel-software` template keeps four employees but gains validation configuration. Core startup:

1. runs repository preflight;
2. creates or reconciles the active Git run;
3. constructs Git services and `GitTaskWorkflow`;
4. starts sessions only after reconciliation allows it.

The leader remains Fake in P1B, both developers use distinct Git scenarios, and reviewer receives only review-package context.

- [ ] **Step 6: Add the conflict E2E**

```ts
it("turns a deterministic cherry-pick conflict into a reviewed resolution task", async () => {
  const company = await startConflictCompany();
  await company.waitForConflictTask();
  expect((await company.deliveryPreview()).integrationTaskIds)
    .toEqual(["first-task"]);

  await company.assignConflictTask("developer-a");
  await company.waitForCompletedTasks([
    "first-task",
    "second-task",
    "conflict-second-task-1"
  ]);
  expect((await company.timeline()).map(({ type }) => type)).toContain(
    "integration.conflicted"
  );
});
```

- [ ] **Step 7: Add root verification script and documentation**

Add:

```json
"test:p1b": "pnpm --filter @agenttown/e2e test -- git-company.test.ts"
```

Document:

- Git >=2.31 and clean existing repository requirement;
- `.agenttown` local exclude behavior;
- `agenttown workspaces`, `evidence`, `deliver`, and bounded `cleanup`;
- no merge/push/PR behavior;
- Fake-only P1B status and P1C adapter roadmap;
- how to inspect and manually merge the integration branch.

- [ ] **Step 8: Run full P1B verification**

Run:

```powershell
$env:AGENTTOWN_FORBID_REAL_PROBES='1'
$env:AGENTTOWN_REAL_CODEX='0'
$env:AGENTTOWN_REAL_CLAUDE='0'
pnpm typecheck
pnpm test
pnpm test:p1b
pnpm probe:fake
```

Expected:

- all packages typecheck;
- all unit/integration/E2E tests pass;
- both P1B E2E scenarios pass;
- Fake probe passes;
- no real Agent is launched.

- [ ] **Step 9: Verify repository safety evidence**

Run the P1B E2E with retained fixture output and verify:

```powershell
git -C <fixture-root> status --porcelain=v2
git -C <fixture-root> rev-parse main
git -C <fixture-root> show-ref
git -C <fixture-root> worktree list --porcelain
```

Expected:

- user worktree is clean;
- `main` remains at the recorded baseline;
- only run-scoped AgentTown refs were created;
- every worktree path is beneath `.agenttown/worktrees/<run-id>`.

- [ ] **Step 10: Commit**

```powershell
git add packages/fake-agent packages/e2e packages/core/src packages/cli/src packages/cli/test package.json README.md
git commit -m "feat: complete the P1B git collaboration loop"
```

---

## Spec Coverage Matrix

| Confirmed design requirement | Implementation task |
|---|---|
| Existing clean Git repository, attached baseline, local exclude | Task 3 |
| Per-task branches/worktrees and separate integration worktree | Task 4 |
| Structured configured commands and exact user-approved suggestions | Tasks 1, 2, 5, 7, 11 |
| Authoritative tests, bounded execution, cleanup and redacted logs | Task 5 |
| Continuous commit range, clean tree, gitlink/path/binary/size rules | Task 6 |
| Immutable revisioned review packages and hash verification | Task 6 |
| Blocking/advisory review semantics and two-loop escalation | Task 7 |
| Approval does not complete before integration | Task 7 |
| Stable DAG queue, candidate cherry-pick and CAS integration ref | Task 8 |
| Conflict becomes an unassigned reviewed task without a dependency cycle | Task 9 |
| Pause preservation, prepared-intent recovery and tamper detection | Task 10 |
| Workspaces/evidence/delivery/approval/cleanup CLI | Task 11 |
| No automatic merge, push, PR, publish or deploy | Global constraints, Tasks 11–12 |
| Parallel/restart/delivery and conflict E2E | Task 12 |
| P1A regression safety and Fake-only ordinary CI | Every task’s verification; Task 12 |

---

## Final Review Gate

- [ ] **Step 1: Re-run fresh verification**

```powershell
$env:AGENTTOWN_FORBID_REAL_PROBES='1'
$env:AGENTTOWN_REAL_CODEX='0'
$env:AGENTTOWN_REAL_CLAUDE='0'
pnpm typecheck
pnpm test
pnpm test:p1b
pnpm probe:fake
git diff --check main...HEAD
git status --short
```

Expected: all commands exit 0; only intentionally ignored local artifacts may remain untracked.

- [ ] **Step 2: Request independent code review**

Use `superpowers:requesting-code-review` against the full `main...HEAD` diff. Require the reviewer to check:

- no command path can target the user's original worktree;
- no Agent controls refs, absolute paths, or shell command strings;
- task approval cannot complete before integration;
- failed/conflicted candidate attempts cannot advance the formal integration ref;
- recovery distinguishes old SHA, new SHA, unknown SHA and missing assets;
- cleanup cannot widen from worktrees to branches/evidence without explicit flags;
- P1A lifecycle, IPC idempotency and Fake Agent cleanup remain intact.

- [ ] **Step 3: Resolve review findings and verify again**

For each accepted finding, use `superpowers:receiving-code-review`, add a failing regression test, implement the smallest fix, and rerun the affected focused suite plus the full verification block.

- [ ] **Step 4: Finish the development branch**

Use `superpowers:finishing-a-development-branch` only after the independent review is approved and the fresh full verification passes. Do not merge, push, or create a PR without the user's explicit choice at that gate.
