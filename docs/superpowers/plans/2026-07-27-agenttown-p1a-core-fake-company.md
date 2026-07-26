# AgentTown P1A Core + Fake Company Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first, headless AgentTown vertical slice that can initialize a configurable four-employee company, run a deterministic Fake Agent task/review loop through the CLI, persist all facts and events, and pause or recover when the last client exits.

**Architecture:** Add a shared runtime contract package, a deterministic TypeScript/Node.js Core backed by SQLite and append-only events, a JSONL Fake Agent process adapter, and a thin CLI connected over a versioned Windows Named Pipe. P1A deliberately excludes Git worktrees and real Claude Code/OpenCode/Hermes transports; it establishes the interfaces and lifecycle those later plans consume.

**Tech Stack:** TypeScript 7, Node.js >=22, pnpm workspaces, `node:sqlite`, `node:net`, `yaml`, `zod`, `tsx`, Vitest 4, JSON Lines.

## Global Constraints

- License remains `AGPL-3.0-only`.
- All production packages use ESM, strict TypeScript, `NodeNext` resolution, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Windows is the first supported runtime; IPC uses a per-user Named Pipe and tests use a random pipe name.
- Core is the only writer of SQLite facts and the only owner of Agent process handles.
- Agent management actions are proposals until Core validates and records them.
- Leaders may address only employee IDs declared in the loaded company YAML; no runtime employee creation action exists.
- Token and context values are `unknown` unless an adapter provides official values.
- The last expired client lease triggers a checkpoint and `paused`; no permanent daemon remains after the grace period.
- Ordinary CI uses only Fake Agents and must set `AGENTTOWN_FORBID_REAL_PROBES=1`, `AGENTTOWN_REAL_CODEX=0`, and `AGENTTOWN_REAL_CLAUDE=0`.
- Every filesystem path is resolved before bounds checks; P1A writes only inside the selected project’s `.agenttown/` directory.
- Automatic task retry is at most one; review rejection is at most two loops before escalation.
- No automatic dependency installation, network side effects, Git push, deployment, or external resource creation.

## P1 Plan Boundaries

The approved P1 specification contains four independently reviewable sub-projects:

1. **P1A — this plan:** deterministic Core, Fake Agent, IPC, CLI, persistence, pause/recovery.
2. **P1B:** Git worktrees, evidence packages, read-only review, deterministic integration branch.
3. **P1C:** Claude Code, OpenCode, and Hermes WSL2 adapters.
4. **P1D:** real four-employee Alpha, hardening, operator documentation, and release gate.

P1B begins only after P1A’s end-to-end Fake Company test passes. P1C consumes the `AgentAdapter` contract proven in P1A. P1D begins only after P1B and all three P1C adapters pass their contract suites.

## Planned File Map

### Shared runtime contract

| File | Responsibility |
| --- | --- |
| `packages/runtime-contract/package.json` | Package metadata, exports, build/test scripts, `yaml` and `zod` dependencies |
| `packages/runtime-contract/tsconfig.json` | Strict package typecheck |
| `packages/runtime-contract/tsconfig.build.json` | Emit declarations and JavaScript to `dist` |
| `packages/runtime-contract/src/company.ts` | Company YAML schema, semantic organization validation, defaults |
| `packages/runtime-contract/src/task.ts` | Task states, task records, transition/action types |
| `packages/runtime-contract/src/agent.ts` | Adapter capabilities, session handles, messages, events, usage |
| `packages/runtime-contract/src/ipc.ts` | IPC request/response/event envelopes and protocol parser |
| `packages/runtime-contract/src/index.ts` | Public exports only |
| `packages/runtime-contract/test/company.test.ts` | YAML and organization validation |
| `packages/runtime-contract/test/ipc.test.ts` | Protocol version and envelope parsing |

### Deterministic Core

| File | Responsibility |
| --- | --- |
| `packages/core/package.json` | Core package scripts and dependencies |
| `packages/core/tsconfig.json` | Strict package typecheck |
| `packages/core/src/storage/schema.ts` | Idempotent SQLite schema |
| `packages/core/src/storage/core-store.ts` | SQLite connection, transactions, fact/event repositories |
| `packages/core/src/tasks/task-service.ts` | DAG validation, assignment, transition and retry/review limits |
| `packages/core/src/policy/action-policy.ts` | Validate actor, employee, permission and action shape |
| `packages/core/src/agents/fake-adapter.ts` | Spawn and control company-mode Fake Agent JSONL processes |
| `packages/core/src/agents/session-manager.ts` | Session identity, event streaming, interrupt/resume/stop |
| `packages/core/src/company/orchestrator.ts` | Route accepted actions and advance deterministic company workflow |
| `packages/core/src/lifecycle/checkpoint-service.ts` | Pause, persist session checkpoints, and recover |
| `packages/core/src/ipc/lease-registry.ts` | Client heartbeat leases and last-client callback |
| `packages/core/src/ipc/core-server.ts` | Versioned Named Pipe command server and event subscription |
| `packages/core/src/main.ts` | Parse Core process arguments, start server, bounded shutdown |
| `packages/core/src/index.ts` | Public exports used by tests and later packages |
| `packages/core/test/helpers.ts` | Temporary project/database/pipe helpers |
| `packages/core/test/core-store.test.ts` | Atomic facts plus event persistence |
| `packages/core/test/task-service.test.ts` | DAG and state-machine constraints |
| `packages/core/test/action-policy.test.ts` | Fixed roster and authorization rules |
| `packages/core/test/fake-adapter.test.ts` | Adapter contract against a real child process |
| `packages/core/test/orchestrator.test.ts` | Four-employee Fake workflow |
| `packages/core/test/lease-registry.test.ts` | Heartbeat expiry and one-shot pause trigger |
| `packages/core/test/checkpoint-service.test.ts` | Pause and native/rebuilt recovery decisions |
| `packages/core/test/core-server.test.ts` | Real Named Pipe requests and event replay |

### Fake Agent

| File | Responsibility |
| --- | --- |
| `packages/fake-agent/package.json` | Add company-mode process script |
| `packages/fake-agent/src/company-cli.ts` | Long-running JSONL stdin/stdout Fake Agent |
| `packages/fake-agent/test/company-cli.test.ts` | Deterministic action, review, crash, silent and resume scenarios |

### CLI and end-to-end acceptance

| File | Responsibility |
| --- | --- |
| `packages/cli/package.json` | `agenttown` executable and workspace dependencies |
| `packages/cli/tsconfig.json` | Strict package typecheck |
| `packages/cli/src/paths.ts` | Resolve project root and bounded `.agenttown/` paths |
| `packages/cli/src/templates.ts` | Built-in `minimal` and `parallel-software` YAML |
| `packages/cli/src/core-process.ts` | Start Core and wait for pipe readiness |
| `packages/cli/src/client.ts` | IPC client, heartbeat, request and event stream |
| `packages/cli/src/render.ts` | Stable text rendering for status/tasks/timeline |
| `packages/cli/src/main.ts` | `doctor`, `init`, `start`, `status`, `tasks`, `timeline`, `pause`, `resume`, `stop` |
| `packages/cli/test/paths.test.ts` | Project-bound path checks |
| `packages/cli/test/templates.test.ts` | Both templates parse and reference known adapters |
| `packages/cli/test/render.test.ts` | Honest `unknown` usage and deterministic tables |
| `packages/e2e/package.json` | End-to-end test package |
| `packages/e2e/tsconfig.json` | End-to-end TypeScript configuration |
| `packages/e2e/test/fake-company.test.ts` | Real CLI/Core/Fake processes and restart acceptance |
| `docs/development/p1a-core.md` | Developer commands, architecture and P1A limitations |

---

### Task 1: Define the Shared Runtime Contract and Company YAML

**Files:**
- Create: `packages/runtime-contract/package.json`
- Create: `packages/runtime-contract/tsconfig.json`
- Create: `packages/runtime-contract/tsconfig.build.json`
- Create: `packages/runtime-contract/src/company.ts`
- Create: `packages/runtime-contract/src/task.ts`
- Create: `packages/runtime-contract/src/agent.ts`
- Create: `packages/runtime-contract/src/ipc.ts`
- Create: `packages/runtime-contract/src/index.ts`
- Create: `packages/runtime-contract/test/company.test.ts`
- Create: `packages/runtime-contract/test/ipc.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: root `tsconfig.base.json` strict settings and pnpm’s `packages/*` workspace discovery.
- Produces: `parseCompanyYaml(text: string): CompanyDefinition`, `parseIpcMessage(value: unknown): IpcMessage`, and the exact domain types imported by every later task.

- [ ] **Step 1: Create the package shell and install its only runtime dependencies**

Create `packages/runtime-contract/package.json`:

```json
{
  "name": "@agenttown/runtime-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "files": ["dist"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "yaml": "^2.8.1",
    "zod": "^4.1.5"
  }
}
```

Create `packages/runtime-contract/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/runtime-contract/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

Run: `pnpm install`

Expected: exit `0`; the lockfile contains `yaml` and `zod` under the new workspace importer.

- [ ] **Step 2: Write failing company-schema tests**

Create `packages/runtime-contract/test/company.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import { parseCompanyYaml } from "../src/company.js";

const valid = `
schema_version: 1
company:
  name: alpha
  mission: Ship a tested change
  success_criteria: [Tests pass]
  operating_rules: [Use evidence]
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: developer
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: reviewer
    role: reviewer
    agent: fake
    reports_to: leader
    workspace: review_package
limits:
  max_task_retry: 1
  max_review_loops: 2
  max_parallel_tasks: 2
`;

describe("parseCompanyYaml", () => {
  it("parses a valid fixed roster", () => {
    const company = parseCompanyYaml(valid);
    expect(company.employees.map((employee) => employee.id)).toEqual([
      "leader",
      "developer",
      "reviewer"
    ]);
    expect(company.limits).toEqual({
      maxTaskRetry: 1,
      maxReviewLoops: 2,
      maxParallelTasks: 2
    });
  });

  it.each([
    ["duplicate employee", `${valid}\n  - id: leader\n    role: duplicate\n    agent: fake\n    reports_to: owner\n    workspace: read_only`],
    ["unknown manager", valid.replace("reports_to: leader", "reports_to: missing")],
    ["reporting cycle", valid.replace("reports_to: owner", "reports_to: developer")],
    ["retry above one", valid.replace("max_task_retry: 1", "max_task_retry: 2")],
    ["review loops above two", valid.replace("max_review_loops: 2", "max_review_loops: 3")]
  ])("rejects %s", (_name, text) => {
    expect(() => parseCompanyYaml(text)).toThrow();
  });
});
```

- [ ] **Step 3: Run the company test and verify the red state**

Run: `pnpm --filter @agenttown/runtime-contract test -- company.test.ts`

Expected: FAIL because `../src/company.js` does not exist.

- [ ] **Step 4: Implement company types, normalization and semantic validation**

Create `packages/runtime-contract/src/company.ts` with these public types:

```ts
import { parse } from "yaml";
import { z } from "zod";

export const workspaceModes = ["read_only", "git_worktree", "review_package"] as const;
export type WorkspaceMode = typeof workspaceModes[number];

export interface EmployeeDefinition {
  id: string;
  role: string;
  agent: string;
  reportsTo: "owner" | string;
  workspace: WorkspaceMode;
}

export interface CompanyDefinition {
  schemaVersion: 1;
  company: {
    name: string;
    mission: string;
    successCriteria: string[];
    operatingRules: string[];
  };
  employees: EmployeeDefinition[];
  limits: {
    maxTaskRetry: 0 | 1;
    maxReviewLoops: 0 | 1 | 2;
    maxParallelTasks: number;
  };
}
```

Use this input schema, then normalize snake-case input into the camel-case interface:

```ts
const nonEmpty = z.string().trim().min(1);
const companyInputSchema = z.object({
  schema_version: z.literal(1),
  company: z.object({
    name: nonEmpty,
    mission: nonEmpty,
    success_criteria: z.array(nonEmpty).min(1),
    operating_rules: z.array(nonEmpty).min(1)
  }),
  employees: z.array(z.object({
    id: nonEmpty.regex(/^[a-z][a-z0-9_-]*$/u),
    role: nonEmpty,
    agent: nonEmpty,
    reports_to: nonEmpty,
    workspace: z.enum(workspaceModes)
  })).min(1),
  limits: z.object({
    max_task_retry: z.union([z.literal(0), z.literal(1)]),
    max_review_loops: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    max_parallel_tasks: z.number().int().positive()
  })
});

function validateOrganization(company: CompanyDefinition): CompanyDefinition {
  const ids = new Set<string>();
  for (const employee of company.employees) {
    if (ids.has(employee.id)) throw new Error(`duplicate employee id: ${employee.id}`);
    ids.add(employee.id);
  }
  for (const employee of company.employees) {
    if (employee.reportsTo !== "owner" && !ids.has(employee.reportsTo)) {
      throw new Error(`unknown reports_to: ${employee.reportsTo}`);
    }
  }
  for (const employee of company.employees) {
    const visited = new Set<string>([employee.id]);
    let manager = employee.reportsTo;
    while (manager !== "owner") {
      if (visited.has(manager)) throw new Error(`reporting cycle at: ${manager}`);
      visited.add(manager);
      const record = company.employees.find((item) => item.id === manager);
      if (record === undefined) throw new Error(`unknown reports_to: ${manager}`);
      manager = record.reportsTo;
    }
  }
  return company;
}

export function parseCompanyYaml(text: string): CompanyDefinition {
  const input = companyInputSchema.parse(parse(text));
  return validateOrganization({
    schemaVersion: 1,
    company: {
      name: input.company.name,
      mission: input.company.mission,
      successCriteria: input.company.success_criteria,
      operatingRules: input.company.operating_rules
    },
    employees: input.employees.map((employee) => ({
      id: employee.id,
      role: employee.role,
      agent: employee.agent,
      reportsTo: employee.reports_to,
      workspace: employee.workspace
    })),
    limits: {
      maxTaskRetry: input.limits.max_task_retry,
      maxReviewLoops: input.limits.max_review_loops,
      maxParallelTasks: input.limits.max_parallel_tasks
    }
  });
}
```

Do not add coercion for numeric or string fields.

- [ ] **Step 5: Define stable task and adapter types**

Create `packages/runtime-contract/src/task.ts`:

```ts
import { z } from "zod";

export const taskStates = [
  "draft",
  "ready",
  "running",
  "review",
  "completed",
  "blocked",
  "failed"
] as const;

export type TaskState = typeof taskStates[number];

export interface TaskRecord {
  id: string;
  title: string;
  objective: string;
  ownerEmployeeId: string | null;
  dependencies: string[];
  acceptanceCriteria: string[];
  status: TaskState;
  retryCount: number;
  reviewLoopCount: number;
  artifacts: string[];
  evidence: string[];
  createdEventId: string;
  updatedEventId: string;
}

export const actionTypes = [
  "task.propose",
  "task.assign",
  "task.start",
  "task.submit",
  "task.request_review",
  "task.approve",
  "task.reject",
  "task.block",
  "employee.message",
  "user.approval.request",
  "company.complete.request"
] as const;

export type ActionType = typeof actionTypes[number];

export interface ActionProposal {
  schemaVersion: 1;
  actionId: string;
  type: ActionType;
  actorEmployeeId: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  reason: string;
  causationEventId: string | null;
}

const actionProposalSchema = z.object({
  schemaVersion: z.literal(1),
  actionId: z.string().uuid(),
  type: z.enum(actionTypes),
  actorEmployeeId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1),
  causationEventId: z.string().min(1).nullable()
});

export function parseActionProposal(value: unknown): ActionProposal {
  return actionProposalSchema.parse(value);
}
```

Create `packages/runtime-contract/src/agent.ts`:

```ts
export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface AgentCapabilities {
  nativeResume: CapabilityState;
  structuredOutput: CapabilityState;
  nonInteractive: CapabilityState;
  interrupt: CapabilityState;
  parallelSessions: CapabilityState;
  tokenUsage: CapabilityState;
  contextUsage: CapabilityState;
  interactiveTakeover: CapabilityState;
}

export interface SessionHandle {
  employeeId: string;
  adapter: string;
  internalSessionId: string;
  nativeSessionId: string | null;
}

export interface AgentMessage {
  messageId: string;
  employeeId: string;
  taskId: string | null;
  text: string;
  actionRequest: ActionProposal | null;
}

export type AgentEvent =
  | { type: "session.started"; handle: SessionHandle }
  | { type: "output.delta"; text: string }
  | { type: "output.completed"; text: string }
  | { type: "action.proposed"; action: ActionProposal }
  | { type: "usage.updated"; inputTokens: number | null; outputTokens: number | null; contextTokens: number | null }
  | { type: "session.interrupted"; reason: string }
  | { type: "session.exited"; exitCode: number | null }
  | { type: "adapter.error"; code: string; message: string };

export interface StartSessionInput {
  employeeId: string;
  role: string;
  projectRoot: string;
  scenario: string;
}

export interface ResumeSessionInput extends StartSessionInput {
  previous: SessionHandle;
  handoff: string;
}

export interface UsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  contextTokens: number | null;
  capturedAt: string;
}

export interface SessionCheckpoint {
  employeeId: string;
  handle: SessionHandle;
  activeTaskId: string | null;
  handoff: string;
}

export interface CompanyCheckpoint {
  companyId: string;
  reason: "user_requested" | "last_client_exited" | "shutdown";
  lastEventSequence: number;
  sessions: SessionCheckpoint[];
}

export interface RecoveryDecision {
  employeeId: string;
  mode: "native" | "rebuilt";
}

export interface AgentAdapter {
  detect(): Promise<{ available: boolean; version: string }>;
  capabilities(): Promise<AgentCapabilities>;
  start(input: StartSessionInput): Promise<SessionHandle>;
  send(session: SessionHandle, message: AgentMessage): AsyncIterable<AgentEvent>;
  interrupt(session: SessionHandle): Promise<{ interrupted: boolean }>;
  resume(input: ResumeSessionInput): Promise<SessionHandle>;
  stop(session: SessionHandle): Promise<void>;
  usage(session: SessionHandle): Promise<UsageSnapshot>;
}
```

- [ ] **Step 6: Write failing IPC parser tests**

Create `packages/runtime-contract/test/ipc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseIpcMessage } from "../src/ipc.js";
import { parseActionProposal } from "../src/task.js";

describe("parseIpcMessage", () => {
  it("accepts a versioned request", () => {
    expect(parseIpcMessage({
      protocolVersion: 1,
      kind: "request",
      requestId: "r1",
      method: "company.status",
      params: {}
    })).toMatchObject({ kind: "request", requestId: "r1" });
  });

  it("rejects an incompatible protocol", () => {
    expect(() => parseIpcMessage({
      protocolVersion: 2,
      kind: "request",
      requestId: "r1",
      method: "company.status",
      params: {}
    })).toThrow("unsupported protocol version");
  });
});

describe("parseActionProposal", () => {
  it("rejects actions outside the closed management vocabulary", () => {
    expect(() => parseActionProposal({
      schemaVersion: 1,
      actionId: "7b346f2d-626f-4998-a678-bdd25c0013e2",
      type: "employee.create",
      actorEmployeeId: "leader",
      taskId: null,
      payload: {},
      reason: "hire another worker",
      causationEventId: null
    })).toThrow();
  });
});
```

Run: `pnpm --filter @agenttown/runtime-contract test -- ipc.test.ts`

Expected: FAIL because `../src/ipc.js` does not exist.

- [ ] **Step 7: Implement the versioned IPC envelope**

Create `packages/runtime-contract/src/ipc.ts`:

```ts
import { z } from "zod";

export const IPC_PROTOCOL_VERSION = 1 as const;

export type IpcRequest = {
  protocolVersion: 1;
  kind: "request";
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};

export type IpcResponse = {
  protocolVersion: 1;
  kind: "response";
  requestId: string;
  ok: boolean;
  result: unknown;
  error: { code: string; message: string } | null;
};

export type IpcEvent = {
  protocolVersion: 1;
  kind: "event";
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
};

export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;

const envelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion: z.number(),
    kind: z.literal("request"),
    requestId: z.string().min(1),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown())
  }),
  z.object({
    protocolVersion: z.number(),
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown(),
    error: z.object({ code: z.string(), message: z.string() }).nullable()
  }),
  z.object({
    protocolVersion: z.number(),
    kind: z.literal("event"),
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown())
  })
]);

export function parseIpcMessage(value: unknown): IpcMessage {
  const parsed = envelopeSchema.parse(value);
  if (parsed.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version: ${parsed.protocolVersion}`);
  }
  return parsed as IpcMessage;
}
```

Export every public type and function from `packages/runtime-contract/src/index.ts`.

- [ ] **Step 8: Run package verification and commit**

Run:

```powershell
pnpm --filter @agenttown/runtime-contract test
pnpm --filter @agenttown/runtime-contract typecheck
pnpm --filter @agenttown/runtime-contract build
```

Expected: all commands exit `0`; 2 test files pass and `dist/index.js` plus `dist/index.d.ts` exist.

Commit:

```powershell
git add packages/runtime-contract pnpm-lock.yaml
git commit -m "feat: add AgentTown runtime contract"
```

---

### Task 2: Add Atomic SQLite Facts and Append-Only Events

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/storage/schema.ts`
- Create: `packages/core/src/storage/core-store.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/helpers.ts`
- Create: `packages/core/test/core-store.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `CompanyDefinition`, `TaskRecord`, `SessionHandle` from `@agenttown/runtime-contract`.
- Produces: `CoreStore`, `EventRecord`, `StoredCheckpoint`, and temporary-store test helpers.

- [ ] **Step 1: Create the Core package shell**

Create `packages/core/package.json`:

```json
{
  "name": "@agenttown/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "pretest": "pnpm --filter @agenttown/runtime-contract build",
    "test": "vitest run",
    "pretypecheck": "pnpm --filter @agenttown/runtime-contract build",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@agenttown/runtime-contract": "workspace:*"
  }
}
```

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run: `pnpm install`

Expected: exit `0`; the Core workspace links `@agenttown/runtime-contract`.

- [ ] **Step 2: Write the failing atomicity and persistence tests**

Create `packages/core/test/helpers.ts` with:

- `createTemporaryProject()` returning `{ root, databasePath, cleanup }` using `mkdtemp`, `tmpdir`, `join`, and bounded `rm`;
- `companyDefinitionFixture(): CompanyDefinition` returning leader, developer and reviewer employees with valid limits `1`, `2`, `2`.

Create `packages/core/test/core-store.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { CoreStore } from "../src/storage/core-store.js";
import { companyDefinitionFixture, createTemporaryProject } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CoreStore", () => {
  it("persists a fact and its event in one transaction", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();

    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: {
        id: "event-1",
        type: "company.created",
        actorId: "owner",
        payload: { companyId: "company-1" },
        causationEventId: null,
        taskId: null
      }
    });

    expect(store.getCompany("company-1")?.id).toBe("company-1");
    expect(store.listEvents(0).map((event) => event.type)).toEqual(["company.created"]);
    store.close();
  });

  it("rolls back both fact and event when mutation fails", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();

    const event = {
      id: "duplicate-event",
      type: "company.created",
      actorId: "owner",
      payload: {},
      causationEventId: null,
      taskId: null
    };
    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event
    });

    expect(() => store.createCompany({
      id: "company-2",
      definition: companyDefinitionFixture(),
      event
    })).toThrow();

    expect(store.getCompany("company-2")).toBeNull();
    expect(store.listEvents(0)).toHaveLength(1);
    store.close();
  });
});
```

- [ ] **Step 3: Run the storage test and verify the red state**

Run: `pnpm --filter @agenttown/core test -- core-store.test.ts`

Expected: FAIL because `CoreStore` does not exist.

- [ ] **Step 4: Add the idempotent schema**

Create `packages/core/src/storage/schema.ts` exporting `CORE_SCHEMA_SQL`. It must enable foreign keys and create these exact tables:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent TEXT NOT NULL,
  reports_to TEXT NOT NULL,
  workspace TEXT NOT NULL,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS company_revisions (
  company_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (company_id, revision),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_employee_id TEXT,
  retry_count INTEGER NOT NULL,
  review_loop_count INTEGER NOT NULL,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  company_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (company_id, task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_artifacts (
  company_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (company_id, task_id, kind, value)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  company_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  handle_json TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, employee_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_leases (
  client_id TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  task_id TEXT,
  causation_event_id TEXT,
  payload_json TEXT NOT NULL
);
```

- [ ] **Step 5: Implement transaction-safe storage methods**

Create `packages/core/src/storage/core-store.ts` with:

```ts
import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA_SQL } from "./schema.js";

export interface NewEvent {
  id: string;
  type: string;
  actorId: string;
  taskId: string | null;
  causationEventId: string | null;
  payload: Record<string, unknown>;
}

export interface EventRecord extends NewEvent {
  sequence: number;
  occurredAt: string;
}

export interface StoredCheckpoint {
  id: string;
  companyId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export class CoreStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
  }

  initialize(): void {
    this.#database.exec(CORE_SCHEMA_SQL);
  }

  close(): void {
    this.#database.close();
  }

  inTransaction<T>(work: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
```

Add prepared-statement methods with these exact signatures:

```ts
insertEvent(event: NewEvent): EventRecord;
listEvents(afterSequence: number): EventRecord[];
subscribeEvents(listener: (event: EventRecord) => void): () => void;
createCompany(input: { id: string; definition: CompanyDefinition; event: NewEvent }): void;
getCompany(id: string): { id: string; definitionJson: string; status: string } | null;
setCompanyStatus(companyId: string, status: string, event: NewEvent): void;
putTask(companyId: string, task: TaskRecord, events: readonly NewEvent[]): void;
getTask(companyId: string, taskId: string): TaskRecord | null;
listTasks(companyId: string): TaskRecord[];
putSession(companyId: string, employeeId: string, handle: SessionHandle, status: string): void;
listSessions(companyId: string): Array<{ employeeId: string; handle: SessionHandle; status: string }>;
putUsageSnapshot(companyId: string, employeeId: string, usage: UsageSnapshot, event: NewEvent): void;
latestUsage(companyId: string, employeeId: string): UsageSnapshot | null;
putCheckpoint(checkpoint: StoredCheckpoint, event: NewEvent): void;
latestCheckpoint(companyId: string): StoredCheckpoint | null;
upsertLease(clientId: string, expiresAtMs: number): void;
deleteLease(clientId: string): void;
deleteExpiredLeases(nowMs: number): number;
countLeases(): number;
clearLeases(): void;
```

Implement a private `#insertEventRow` that does not publish. Every fact-changing public method must call `inTransaction`, mutate the fact, call `#insertEventRow`, commit, and only then notify `subscribeEvents` listeners. Public `insertEvent` wraps `#insertEventRow` in its own transaction and publishes after commit. JSON parsing must reject non-object payloads rather than return unchecked values.

`createCompany` writes revision `1` and all fixed employees in the same transaction. `putTask` requires at least one event, replaces that task’s dependency and artifact rows from the `TaskRecord` arrays, inserts all supplied events in array order, then commits once. `latestUsage` returns `null` when no snapshot exists; callers render all usage fields as `unknown` and never estimate values.

- [ ] **Step 6: Export storage types and run verification**

Export `CoreStore`, `EventRecord`, `NewEvent`, and `StoredCheckpoint` from `packages/core/src/index.ts`.

Run:

```powershell
pnpm --filter @agenttown/core test -- core-store.test.ts
pnpm --filter @agenttown/core typecheck
```

Expected: both commands exit `0`; both storage tests pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/core pnpm-lock.yaml
git commit -m "feat: add atomic AgentTown core store"
```

---

### Task 3: Implement the Task DAG, State Machine, and Fixed-Roster Policy

**Files:**
- Create: `packages/core/src/tasks/task-service.ts`
- Create: `packages/core/src/policy/action-policy.ts`
- Create: `packages/core/test/task-service.test.ts`
- Create: `packages/core/test/action-policy.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CoreStore`, `CompanyDefinition`, `TaskRecord`, and `ActionProposal`.
- Produces: `TaskService.create`, `TaskService.assign`, `TaskService.transition`, and `ActionPolicy.validate`.

- [ ] **Step 1: Write failing task-service tests**

Create `packages/core/test/task-service.test.ts` covering:

```ts
it("rejects a dependency cycle", () => {
  service.create(task("a", ["b"]));
  expect(() => service.create(task("b", ["a"]))).toThrow("dependency cycle");
});

it("does not start before dependencies complete", () => {
  service.create(task("build", []));
  service.create(task("test", ["build"]));
  service.assign("test", "developer");
  expect(() => service.transition("test", "running", "leader")).toThrow("dependencies incomplete");
});

it("allows one execution retry and blocks the second failure", () => {
  service.create(task("build", []));
  service.assign("build", "developer");
  service.transition("build", "running", "developer");
  service.transition("build", "failed", "developer");
  expect(service.retry("build", "leader").status).toBe("ready");
  service.transition("build", "running", "developer");
  service.transition("build", "failed", "developer");
  expect(service.retry("build", "leader").status).toBe("blocked");
});

it("blocks after two review rejections", () => {
  const record = advanceToReview(service, "build");
  service.reject(record.id, "reviewer", ["first"]);
  advanceToReview(service, "build");
  service.reject(record.id, "reviewer", ["second"]);
  expect(service.get("build").status).toBe("blocked");
});
```

The local `task(id, dependencies)` fixture must build a complete `TaskRecord`; `advanceToReview` must use only public service methods.

- [ ] **Step 2: Run the task test and verify the red state**

Run: `pnpm --filter @agenttown/core test -- task-service.test.ts`

Expected: FAIL because `TaskService` does not exist.

- [ ] **Step 3: Implement explicit legal transitions and DAG checks**

Create `packages/core/src/tasks/task-service.ts` with:

```ts
const legalTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["ready"],
  ready: ["running"],
  running: ["review", "blocked", "failed"],
  review: ["completed", "ready", "blocked"],
  completed: [],
  blocked: ["ready"],
  failed: ["ready", "blocked"]
};
```

Expose:

```ts
export class TaskService {
  constructor(
    private readonly store: CoreStore,
    private readonly companyId: string,
    private readonly company: CompanyDefinition
  ) {}

  create(input: Omit<TaskRecord, "createdEventId" | "updatedEventId">): TaskRecord;
  get(taskId: string): TaskRecord;
  list(): TaskRecord[];
  assign(taskId: string, employeeId: string): TaskRecord;
  transition(taskId: string, next: TaskState, actorId: string): TaskRecord;
  submit(taskId: string, actorId: string, artifacts: string[], evidence: string[]): TaskRecord;
  retry(taskId: string, actorId: string): TaskRecord;
  reject(taskId: string, reviewerId: string, findings: string[]): TaskRecord;
}
```

Implement cycle detection by constructing a map of existing tasks plus the proposed task and performing depth-first search with `visiting` and `visited` sets. `assign` is legal only from `draft`, requires a known employee with `git_worktree`, stores that employee as the unique owner, and moves the task to `ready`. Starting `running` requires all dependency tasks to be `completed`. `submit` is legal only from `running`, requires the actor to equal the task owner plus non-empty artifact and evidence arrays, persists both arrays, emits `task.submitted`, then moves the task to `review` with `task.review_requested`. `reject` increments `reviewLoopCount`; counts below the configured maximum return to `ready`, and reaching the maximum moves to `blocked`. Every stored state change has an event in the same transaction; a compound submit uses two ordered events in one transaction.

Task creation may reference a task ID that will be proposed later, which lets the leader submit a DAG in any order. Assignment rejects any dependency ID that still does not exist. This makes dependency existence and cycle handling deterministic.

Use these event names so storage, IPC, CLI and end-to-end assertions agree:

| Mutation | Event type |
| --- | --- |
| create draft | `task.created` |
| assign and make ready | `task.assigned` |
| enter running | `task.started` |
| submit artifacts/evidence | `task.submitted` |
| enter review | `task.review_requested` |
| reviewer approves | `task.completed` |
| reviewer rejects below limit | `task.rework_requested` |
| failure gets one retry | `task.retry_scheduled` |
| limit reached | `task.blocked` |

- [ ] **Step 4: Write failing action-policy tests**

Create `packages/core/test/action-policy.test.ts`:

```ts
describe("ActionPolicy", () => {
  it("rejects an unknown actor", () => {
    expect(() => policy.validate(action({ actorEmployeeId: "invented" })))
      .toThrow("unknown employee");
  });

  it("rejects assignment to an employee outside the fixed roster", () => {
    expect(() => policy.validate(action({
      type: "task.assign",
      payload: { assignee: "new-hire" }
    }))).toThrow("unknown assignee");
  });

  it("rejects employee creation because no such action exists", () => {
    expect(() => policy.validate({
      ...action({}),
      type: "employee.create"
    } as never)).toThrow("unsupported action");
  });

  it("lets only the reviewer approve or reject review", () => {
    expect(() => policy.validate(action({
      actorEmployeeId: "developer",
      type: "task.approve"
    }))).toThrow("review permission required");
  });
});
```

Run: `pnpm --filter @agenttown/core test -- action-policy.test.ts`

Expected: FAIL because `ActionPolicy` does not exist.

- [ ] **Step 5: Implement action authorization**

Create `packages/core/src/policy/action-policy.ts`:

```ts
const supportedActions = new Set<ActionType>([
  "task.propose",
  "task.assign",
  "task.start",
  "task.submit",
  "task.request_review",
  "task.approve",
  "task.reject",
  "task.block",
  "employee.message",
  "user.approval.request",
  "company.complete.request"
]);

export class ActionPolicy {
  constructor(
    private readonly company: CompanyDefinition,
    private readonly leaderId: string,
    private readonly reviewerIds: ReadonlySet<string>
  ) {}

  validate(action: ActionProposal): ActionProposal {
    if (!supportedActions.has(action.type)) throw new Error(`unsupported action: ${String(action.type)}`);
    const actor = this.company.employees.find((employee) => employee.id === action.actorEmployeeId);
    if (actor === undefined) throw new Error(`unknown employee: ${action.actorEmployeeId}`);
    if (action.type === "task.assign") {
      if (action.actorEmployeeId !== this.leaderId) throw new Error("leader permission required");
      const assignee = action.payload.assignee;
      if (typeof assignee !== "string"
        || !this.company.employees.some((employee) => employee.id === assignee)) {
        throw new Error(`unknown assignee: ${String(assignee)}`);
      }
    }
    if ((action.type === "task.approve" || action.type === "task.reject")
      && !this.reviewerIds.has(action.actorEmployeeId)) {
      throw new Error("review permission required");
    }
    return action;
  }
}
```

All leader-only actions (`task.propose`, `task.assign`, `company.complete.request`) must enforce `leaderId`. `employee.message` must validate a string `recipient` from the fixed roster. No validation branch may silently coerce an invalid payload.

- [ ] **Step 6: Run focused and package verification**

Run:

```powershell
pnpm --filter @agenttown/core test -- task-service.test.ts action-policy.test.ts
pnpm --filter @agenttown/core test
pnpm --filter @agenttown/core typecheck
```

Expected: all commands exit `0`; cycle, dependency, retry, review-loop and fixed-roster tests pass.

- [ ] **Step 7: Commit**

```powershell
git add packages/core/src/tasks packages/core/src/policy packages/core/test packages/core/src/index.ts
git commit -m "feat: enforce task and roster policy"
```

---

### Task 4: Turn Fake Agent into a Long-Running Adapter Fixture

**Files:**
- Modify: `packages/fake-agent/package.json`
- Create: `packages/fake-agent/src/company-cli.ts`
- Create: `packages/fake-agent/test/company-cli.test.ts`
- Create: `packages/core/src/agents/fake-adapter.ts`
- Create: `packages/core/test/fake-adapter.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the `AgentAdapter`, `AgentMessage`, `AgentEvent`, and `SessionHandle` contract.
- Produces: source-mode `company` process entrypoint and `FakeAgentAdapter`.

- [ ] **Step 1: Write failing company-mode Fake Agent tests**

Create `packages/fake-agent/test/company-cli.test.ts` that spawns:

```ts
const child = spawn(process.execPath, [
  "--import",
  "tsx",
  "src/company-cli.ts",
  "--employee-id",
  "developer",
  "--scenario",
  "complete"
], {
  cwd: packageRoot,
  stdio: ["pipe", "pipe", "pipe"]
});
```

Write one JSON line:

```json
{"type":"message","messageId":"m1","taskId":"task-1","text":"implement"}
```

Assert ordered output types:

```ts
expect(events.map((event) => event.type)).toEqual([
  "session.started",
  "output.completed",
  "action.proposed",
  "usage.updated"
]);
```

Add scenario tests:

- `idle` emits `output.completed` but no management action;
- `review-approve` emits `task.approve`;
- `review-reject-twice` emits `task.reject`;
- `malformed-once` emits one invalid line and then a valid response to the next message;
- `silent` emits only `session.started`;
- `crash` exits `23`;
- `--resume <native-id>` reuses the native session ID.

- [ ] **Step 2: Run the Fake Agent test and verify the red state**

Run: `pnpm --filter @agenttown/fake-agent test -- company-cli.test.ts`

Expected: FAIL because `src/company-cli.ts` does not exist.

- [ ] **Step 3: Implement the company JSONL process**

Create `packages/fake-agent/src/company-cli.ts`. Parse `--employee-id`, `--scenario`, and optional `--resume`. Emit:

```ts
type InputLine = {
  type: "message" | "interrupt" | "stop";
  messageId?: string;
  taskId?: string | null;
  text?: string;
};

const sessionId = resumeId ?? randomUUID();
emit({
  type: "session.started",
  handle: {
    employeeId,
    adapter: "fake",
    internalSessionId: randomUUID(),
    nativeSessionId: sessionId
  }
});
```

Use `createInterface({ input: process.stdin, crlfDelay: Infinity })`. For each `message`, generate the exact deterministic output for the selected scenario. A `complete` developer action must be:

```ts
emit({ type: "output.completed", text: `completed:${line.taskId ?? "none"}` });
emit({
  type: "action.proposed",
  action: {
    schemaVersion: 1,
    actionId: randomUUID(),
    type: "task.submit",
    actorEmployeeId: employeeId,
    taskId: line.taskId ?? null,
    payload: {
      artifacts: [`artifact:${line.taskId ?? "none"}`],
      evidence: ["fake:test:pass"]
    },
    reason: "deterministic fake completion",
    causationEventId: null
  }
});
emit({
  type: "usage.updated",
  inputTokens: 10,
  outputTokens: 5,
  contextTokens: null
});
```

For `idle`, emit only `output.completed` and `usage.updated` for a message. On `interrupt`, emit `session.interrupted`; on `stop`, exit `0`. Add the source-mode process script in `packages/fake-agent/package.json`:

```json
{
  "scripts": {
    "company": "tsx src/company-cli.ts"
  }
}
```

- [ ] **Step 4: Run Fake Agent tests**

Run:

```powershell
pnpm --filter @agenttown/fake-agent test
pnpm --filter @agenttown/fake-agent typecheck
```

Expected: existing probe tests and all company-mode scenarios pass.

- [ ] **Step 5: Write failing adapter contract tests**

Create `packages/core/test/fake-adapter.test.ts`:

```ts
it("starts, sends, reports usage, interrupts and resumes", async () => {
  const project = await createTemporaryProject();
  const projectRoot = project.root;
  const adapter = new FakeAgentAdapter({ executable: process.execPath, packageRoot: fakeRoot });
  expect(await adapter.detect()).toMatchObject({ available: true });
  try {
    const input = { ...startInput("developer", "complete"), projectRoot };
    const first = await adapter.start(input);
    const events = await collect(adapter.send(first, message("task-1")));
    expect(events.some((event) => event.type === "action.proposed")).toBe(true);
    expect(await adapter.usage(first)).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(await adapter.interrupt(first)).toEqual({ interrupted: true });
    const resumed = await adapter.resume({
      ...input,
      previous: first,
      handoff: "continue task-1"
    });
    expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
    await adapter.stop(resumed);
    await expect(readFile(join(projectRoot, ".agenttown", "logs", "developer.jsonl"), "utf8"))
      .resolves.toContain("\"type\":\"action.proposed\"");
  } finally {
    await project.cleanup();
  }
});
```

Run: `pnpm --filter @agenttown/core test -- fake-adapter.test.ts`

Expected: FAIL because `FakeAgentAdapter` does not exist.

- [ ] **Step 6: Implement the process-backed Fake adapter**

Create `packages/core/src/agents/fake-adapter.ts` implementing every `AgentAdapter` method. Maintain:

```ts
interface AsyncJsonLineQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(error?: Error): void;
}

interface LiveFakeSession {
  handle: SessionHandle;
  child: ChildProcessWithoutNullStreams;
  lines: AsyncJsonLineQueue<AgentEvent>;
  usage: UsageSnapshot;
}
```

Implement `createAsyncJsonLineQueue<T>(): AsyncJsonLineQueue<T>` with an internal value array and pending resolver array. `push` resolves the oldest waiter or enqueues the value. `close()` completes pending and future iterators; `close(error)` rejects them. The async iterator must deliver each value exactly once and never busy-loop.

`start` creates `<projectRoot>/.agenttown/logs` and spawns the Fake company CLI, then waits at most 5 seconds for `session.started`. Before parsing, append every complete stdout line with an ISO timestamp to `<employeeId>.jsonl`; validate the employee ID against the fixed roster before constructing the path. `send` writes one message line and yields until an `action.proposed`, `adapter.error`, or `session.exited` boundary. `interrupt` writes an interrupt line and waits for confirmation. `resume` starts with `--resume` set to the previous native ID. `stop` writes `stop`, waits 2 seconds, then kills the process only if it remains alive. Malformed JSON is preserved in the raw log and yields:

```ts
{
  type: "adapter.error",
  code: "invalid_json",
  message: "Fake Agent emitted invalid JSON"
}
```

Capabilities return `supported` for native resume, structured output, noninteractive operation, interrupt, parallel sessions and Token usage; `contextUsage` is `unknown`, and `interactiveTakeover` is `unsupported`.

- [ ] **Step 7: Run adapter verification and commit**

Run:

```powershell
pnpm --filter @agenttown/core test -- fake-adapter.test.ts
pnpm --filter @agenttown/core typecheck
pnpm test
```

Expected: all commands exit `0`; existing P0 tests remain green.

Commit:

```powershell
git add packages/fake-agent packages/core pnpm-lock.yaml
git commit -m "feat: add process-backed Fake Agent adapter"
```

---

### Task 5: Add Session Management and the Deterministic Company Orchestrator

**Files:**
- Create: `packages/core/src/agents/session-manager.ts`
- Create: `packages/core/src/company/orchestrator.ts`
- Create: `packages/core/test/orchestrator.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `CoreStore`, `TaskService`, `ActionPolicy`, and a validated `CompanyDefinition`.
- Produces: `SessionManager.startAll`, `SessionManager.send`, `CompanyOrchestrator.start`, and `CompanyOrchestrator.dispatch`.

- [ ] **Step 1: Write the failing four-employee orchestration test**

Create `packages/core/test/orchestrator.test.ts` with a company containing leader, developer A, developer B, and reviewer. Use a `ScriptedAdapter` test double implementing the exact `AgentAdapter` interface.

The test must:

```ts
await orchestrator.start({});
expect(adapter.startedEmployees).toEqual([
  "leader",
  "developer-a",
  "developer-b",
  "reviewer"
]);
await orchestrator.dispatch(leaderAssigns("task-a", "developer-a"));
await orchestrator.dispatch(leaderAssigns("task-b", "developer-b"));

expect(adapter.activeSends).toBe(2);
await adapter.complete("developer-a", submitAction("task-a"));
await adapter.complete("developer-b", submitAction("task-b"));
await adapter.complete("reviewer", approveAction("task-a"));
await adapter.complete("reviewer", approveAction("task-b"));

expect(tasks.list().map((task) => task.status)).toEqual(["completed", "completed"]);
expect(store.listEvents(0).map((event) => event.type)).toEqual(expect.arrayContaining([
  "company.started",
  "task.assigned",
  "task.submitted",
  "task.review_requested",
  "task.completed"
]));
```

Also assert that assigning a third task while two are running produces `user.approval.requested` or leaves the third task `ready`, rather than exceeding `maxParallelTasks`.

Add a crash path in the same test file: the adapter emits `session.exited` for a running task, the orchestrator schedules exactly one retry, and a second exit leaves the task `blocked` with one `user.approval.requested` event.

Add a reviewer-serialization assertion: developer A and developer B sends overlap, but two messages addressed to the single reviewer have a maximum reviewer concurrency of one.

- [ ] **Step 2: Run the orchestrator test and verify the red state**

Run: `pnpm --filter @agenttown/core test -- orchestrator.test.ts`

Expected: FAIL because `SessionManager` and `CompanyOrchestrator` do not exist.

- [ ] **Step 3: Implement SessionManager**

Create `packages/core/src/agents/session-manager.ts`:

```ts
export class SessionManager {
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #sendTails = new Map<string, Promise<void>>();

  constructor(
    private readonly adapterFor: (agentName: string) => AgentAdapter,
    private readonly store: CoreStore,
    private readonly companyId: string,
    private readonly projectRoot: string
  ) {}

  async startAll(company: CompanyDefinition, scenarios: Readonly<Record<string, string>>): Promise<void>;
  get(employeeId: string): SessionHandle;
  async *send(employee: EmployeeDefinition, message: AgentMessage): AsyncIterable<AgentEvent>;
  async interruptAll(): Promise<void>;
  async stopAll(): Promise<void>;
  async resumeOne(employee: EmployeeDefinition, checkpoint: SessionCheckpoint): Promise<SessionHandle>;
  async rebuildOne(employee: EmployeeDefinition, handoff: string): Promise<SessionHandle>;
}
```

`startAll` calls every configured employee adapter concurrently with `Promise.allSettled`, including idle employees, and stores handles only after evaluating the full result set. If any start fails, it stops all successful sessions in reverse employee order and throws a single error listing failed employee IDs. `send` rejects unknown or unstated sessions and persists usage events without inventing null Token values.

Serialize messages per employee while retaining cross-employee parallelism. Each `send` captures the previous promise in `#sendTails`, installs a new deferred tail, awaits the previous promise, streams exactly one adapter send in a `try`, and resolves its tail in `finally`.

- [ ] **Step 4: Implement the orchestrator action router**

Create `packages/core/src/company/orchestrator.ts`:

```ts
export class CompanyOrchestrator {
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly companyId: string,
    private readonly company: CompanyDefinition,
    private readonly store: CoreStore,
    private readonly tasks: TaskService,
    private readonly policy: ActionPolicy,
    private readonly sessions: SessionManager,
    private readonly leaderId: string,
    private readonly reviewerId: string
  ) {}

  async start(scenarios: Readonly<Record<string, string>>): Promise<void>;
  async dispatch(action: ActionProposal): Promise<void>;
  async sendTask(taskId: string): Promise<void>;
  async requestReview(taskId: string): Promise<void>;
  async stopDispatching(): Promise<void>;
}
```

`dispatch` first calls `policy.validate`, then uses an exhaustive switch:

```ts
switch (action.type) {
  case "task.propose":
    this.createProposedTask(action);
    return;
  case "task.assign":
    await this.assignAndSend(action);
    return;
  case "task.submit":
    await this.recordSubmissionAndRequestReview(action);
    return;
  case "task.approve":
    this.tasks.transition(requiredTaskId(action), "completed", action.actorEmployeeId);
    return;
  case "task.reject":
    await this.rejectAndMaybeRequeue(
      requiredTaskId(action),
      action.actorEmployeeId,
      requiredStringArray(action.payload.findings)
    );
    return;
  case "task.start":
  case "task.request_review":
  case "task.block":
  case "employee.message":
  case "user.approval.request":
  case "company.complete.request":
    await this.applySupportedControlAction(action);
    return;
}
```

Add these parsing helpers in the same file:

```ts
function requiredTaskId(action: ActionProposal): string {
  if (action.taskId === null) throw new Error(`${action.type} requires taskId`);
  return action.taskId;
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("expected non-empty string array");
  }
  return value;
}
```

The Core decides state changes; Agent output cannot write status directly. `assignAndSend` enforces the parallel limit by counting `running` tasks. `recordSubmissionAndRequestReview` requires non-empty artifacts and evidence before moving to review. `rejectAndMaybeRequeue` sends a `ready` task back to its existing owner; when `TaskService.reject` returns `blocked`, it records `user.approval.requested` and does not send another Agent message.

`sendTask` treats `adapter.error` and premature `session.exited` as execution failures. It transitions the task to `failed`, calls `TaskService.retry`, resumes or rebuilds that employee session, and resends only when the returned state is `ready`. A returned `blocked` state records one approval request and stops.

`assignAndSend` must not await an Agent’s full task response. After moving the task to `running`, it stores `runTask(taskId)` in `#inFlight`, attaches a rejection handler that records `task.execution_error`, and returns. The promise removes itself from the map in `finally`. This is what allows two sequential leader assignment actions to create two concurrently running developers.

- [ ] **Step 5: Run orchestration verification**

Run:

```powershell
pnpm --filter @agenttown/core test -- orchestrator.test.ts
pnpm --filter @agenttown/core test
pnpm --filter @agenttown/core typecheck
```

Expected: all commands exit `0`; two tasks run concurrently, the third does not exceed the limit, and only reviewer actions complete tasks.

- [ ] **Step 6: Commit**

```powershell
git add packages/core/src/agents/session-manager.ts packages/core/src/company packages/core/test/orchestrator.test.ts packages/core/src/index.ts
git commit -m "feat: orchestrate fixed Fake Agent companies"
```

---

### Task 6: Implement Named Pipe IPC, Idempotent Requests, and Client Leases

**Files:**
- Create: `packages/core/src/ipc/lease-registry.ts`
- Create: `packages/core/src/ipc/core-server.ts`
- Create: `packages/core/test/lease-registry.test.ts`
- Create: `packages/core/test/core-server.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `parseIpcMessage`, `IPC_PROTOCOL_VERSION`, `CoreStore`, `CompanyOrchestrator`.
- Produces: `LeaseRegistry`, `CoreServer.listen`, request methods, and replayable IPC events.

- [ ] **Step 1: Write failing lease tests with a fake clock**

Create `packages/core/test/lease-registry.test.ts`:

```ts
it("fires last-client callback once after the final lease expires", () => {
  const store = createInitializedMemoryStore();
  let now = 1_000;
  let pauses = 0;
  const leases = new LeaseRegistry(store, {
    ttlMs: 5_000,
    now: () => now,
    onLastClientExpired: () => { pauses += 1; }
  });
  leases.heartbeat("client-a");
  leases.heartbeat("client-b");
  now = 7_000;
  leases.sweep();
  leases.sweep();
  expect(pauses).toBe(1);
});

it("does not pause when another lease remains valid", () => {
  const store = createInitializedMemoryStore();
  let now = 1_000;
  let pauses = 0;
  const leases = new LeaseRegistry(store, {
    ttlMs: 5_000,
    now: () => now,
    onLastClientExpired: () => { pauses += 1; }
  });
  leases.heartbeat("client-a");
  now = 4_000;
  leases.heartbeat("client-b");
  now = 7_000;
  leases.sweep();
  expect(pauses).toBe(0);
});
```

Define the test helper in the same file:

```ts
function createInitializedMemoryStore(): CoreStore {
  const store = new CoreStore(":memory:");
  store.initialize();
  return store;
}
```

- [ ] **Step 2: Run lease tests and verify the red state**

Run: `pnpm --filter @agenttown/core test -- lease-registry.test.ts`

Expected: FAIL because `LeaseRegistry` does not exist.

- [ ] **Step 3: Implement persisted leases**

Create `packages/core/src/ipc/lease-registry.ts`:

```ts
export interface LeaseRegistryOptions {
  ttlMs: number;
  now: () => number;
  onLastClientExpired: () => void | Promise<void>;
}

export class LeaseRegistry {
  #hadLease = false;
  #pauseTriggered = false;

  constructor(
    private readonly store: CoreStore,
    private readonly options: LeaseRegistryOptions
  ) {}

  initialize(): void {
    this.store.clearLeases();
  }

  heartbeat(clientId: string): void {
    this.store.upsertLease(clientId, this.options.now() + this.options.ttlMs);
    this.#hadLease = true;
    this.#pauseTriggered = false;
  }

  disconnect(clientId: string): void {
    this.store.deleteLease(clientId);
    void this.#triggerIfEmpty();
  }

  sweep(): void {
    this.store.deleteExpiredLeases(this.options.now());
    void this.#triggerIfEmpty();
  }

  async #triggerIfEmpty(): Promise<void> {
    if (!this.#hadLease || this.#pauseTriggered || this.store.countLeases() !== 0) return;
    this.#pauseTriggered = true;
    await this.options.onLastClientExpired();
  }
}
```

Tests may use an in-memory CoreStore; do not replace persisted leases with a test-only map.

Call `leases.initialize()` once during Core startup before `CoreServer.listen()`. Leases belong to one Core process generation, so a crashed process cannot leave a still-unexpired phantom client after restart.

- [ ] **Step 4: Write failing real-pipe server tests**

Create `packages/core/test/core-server.test.ts` using a unique pipe name:

```ts
const pipeName = `agenttown-test-${randomUUID()}`;
const server = new CoreServer({ pipeName, store, orchestrator, leases });
await server.listen();
const client = await connectTestClient(pipeName);

expect(await client.request("handshake", {
  clientId: "client-a",
  protocolVersion: 1,
  afterSequence: 0
})).toMatchObject({ ok: true });

const first = await client.requestWithId("same-id", "company.status", {});
const second = await client.requestWithId("same-id", "company.status", {});
expect(second).toEqual(first);

await storeTestEvent(store, "event-after-handshake");
expect(await client.nextEvent()).toMatchObject({
  kind: "event",
  type: "event-after-handshake"
});

function storeTestEvent(store: CoreStore, type: string): void {
  store.insertEvent({
    id: randomUUID(),
    type,
    actorId: "test",
    taskId: null,
    causationEventId: null,
    payload: {}
  });
}
```

Add rejection tests for protocol `2`, an unknown method, invalid JSON, and the same request ID with different method/params.

- [ ] **Step 5: Run server tests and verify the red state**

Run: `pnpm --filter @agenttown/core test -- core-server.test.ts`

Expected: FAIL because `CoreServer` does not exist.

- [ ] **Step 6: Implement newline-delimited IPC**

Create `packages/core/src/ipc/core-server.ts`. Use `createServer` from `node:net`. Maintain per-socket:

```ts
interface ClientConnection {
  socket: Socket;
  clientId: string | null;
  buffer: string;
  afterSequence: number;
}
```

Expose this lifecycle surface:

```ts
export class CoreServer {
  listen(): Promise<void>;
  closeAfterResponses(): Promise<void>;
  close(): Promise<void>;
}
```

Maintain a bounded request cache:

```ts
interface CachedRequest {
  fingerprint: string;
  response: IpcResponse;
}
```

Fingerprint `method` plus a stable JSON serialization of `params`. A reused ID with a different fingerprint returns `request_id_conflict`. Implement these methods:

```text
handshake
client.heartbeat
company.status
company.start
company.pause
company.resume
company.stop
tasks.list
events.list
action.dispatch
```

For every request, return exactly one `IpcResponse`. After handshake, replay `store.listEvents(afterSequence)` and register `store.subscribeEvents` to forward newly committed events. On socket close, unsubscribe that listener and call `leases.disconnect(clientId)`. `close()` must stop accepting sockets, destroy live sockets, close the server, and clear its sweep timer.

The `action.dispatch` handler must call `parseActionProposal(request.params.action)` before invoking the orchestrator. Zod validation errors return `invalid_action`; raw IPC objects are never cast directly to `ActionProposal`.

- [ ] **Step 7: Run IPC verification and commit**

Run:

```powershell
pnpm --filter @agenttown/core test -- lease-registry.test.ts core-server.test.ts
pnpm --filter @agenttown/core test
pnpm --filter @agenttown/core typecheck
```

Expected: all commands exit `0`; duplicate requests are idempotent, incompatible versions fail closed, and last-client expiry is one-shot.

Commit:

```powershell
git add packages/core/src/ipc packages/core/test packages/core/src/index.ts
git commit -m "feat: add versioned Core IPC and leases"
```

---

### Task 7: Add Checkpointed Pause and Honest Session Recovery

**Files:**
- Create: `packages/core/src/lifecycle/checkpoint-service.ts`
- Create: `packages/core/test/checkpoint-service.test.ts`
- Modify: `packages/core/src/company/orchestrator.ts`
- Modify: `packages/core/src/ipc/core-server.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `SessionManager`, `CoreStore`, adapter capabilities and the last-client callback.
- Produces: `CheckpointService.pause`, `CheckpointService.recover`, and bounded Core shutdown.

- [ ] **Step 1: Write failing pause and recovery tests**

Create `packages/core/test/checkpoint-service.test.ts`:

```ts
it("interrupts sessions, writes a checkpoint, marks paused and stops processes", async () => {
  await service.pause("last_client_exited");
  expect(sessions.calls).toEqual(["interruptAll", "stopAll"]);
  expect(store.getCompany("company-1")?.status).toBe("paused");
  expect(store.latestCheckpoint("company-1")).toMatchObject({
    payload: { reason: "last_client_exited" }
  });
});

it("uses native resume only when declared supported and an ID exists", async () => {
  const result = await service.recover(checkpointWithNativeIds(), company);
  expect(result.decisions).toEqual([
    { employeeId: "leader", mode: "native" },
    { employeeId: "reviewer", mode: "rebuilt" }
  ]);
  expect(store.listEvents(0).map((event) => event.type)).toContain("session.rebuilt");
});

it("does not label a rebuilt session as native", async () => {
  const result = await service.recover(checkpointWithoutNativeIds(), company);
  expect(result.decisions.every((decision) => decision.mode === "rebuilt")).toBe(true);
});
```

- [ ] **Step 2: Run recovery tests and verify the red state**

Run: `pnpm --filter @agenttown/core test -- checkpoint-service.test.ts`

Expected: FAIL because `CheckpointService` does not exist.

- [ ] **Step 3: Implement checkpoint payloads and pause ordering**

Create `packages/core/src/lifecycle/checkpoint-service.ts` and import `CompanyCheckpoint`, `RecoveryDecision`, and `SessionCheckpoint` from `@agenttown/runtime-contract`.

`pause` must execute in this order:

```ts
await this.orchestrator.stopDispatching();
await this.sessions.interruptAll();
const checkpoint = await this.buildCheckpoint(reason);
this.store.putCheckpoint({
  id: randomUUID(),
  companyId: checkpoint.companyId,
  createdAt: new Date().toISOString(),
  payload: checkpoint as unknown as Record<string, unknown>
}, checkpointEvent(checkpoint));
await this.sessions.stopAll();
this.store.setCompanyStatus(this.companyId, "paused", pausedEvent(reason));
```

If interrupt fails, record `session.interrupt_failed`, continue building a checkpoint from known facts, and still stop the process. The method has a total default deadline of 10 seconds; deadline expiry records `company.pause_timeout` and force-stops remaining child processes.

- [ ] **Step 4: Implement explicit native versus rebuilt recovery**

For each configured employee:

```ts
const capabilities = await adapter.capabilities();
const native = capabilities.nativeResume === "supported"
  && checkpoint.handle.nativeSessionId !== null;

if (native) {
  await sessions.resumeOne(employee, checkpoint);
  decisions.push({ employeeId: employee.id, mode: "native" });
  store.insertEvent(sessionRecoveredEvent(employee.id));
} else {
  await sessions.rebuildOne(employee, checkpoint.handoff);
  decisions.push({ employeeId: employee.id, mode: "rebuilt" });
  store.insertEvent(sessionRebuiltEvent(employee.id));
}
```

After every employee succeeds, set company status to `running`. If one employee fails, stop sessions started during that recovery attempt, set company status to `blocked`, and include the failing employee ID in `company.recovery_blocked`.

- [ ] **Step 5: Wire leases and explicit pause to the same service**

Construct `LeaseRegistry.onLastClientExpired` as:

```ts
async () => {
  await checkpointService.pause("last_client_exited");
  await coreServer.closeAfterResponses();
}
```

The `company.pause` IPC method calls `pause("user_requested")`. Both paths must produce the same checkpoint schema and status transition.

- [ ] **Step 6: Run recovery and regression verification**

Run:

```powershell
pnpm --filter @agenttown/core test -- checkpoint-service.test.ts lease-registry.test.ts core-server.test.ts
pnpm --filter @agenttown/core test
pnpm --filter @agenttown/core typecheck
```

Expected: all commands exit `0`; native and rebuilt decisions are distinguishable in returned data and events.

- [ ] **Step 7: Commit**

```powershell
git add packages/core/src/lifecycle packages/core/src/company/orchestrator.ts packages/core/src/ipc/core-server.ts packages/core/test packages/core/src/index.ts
git commit -m "feat: checkpoint and recover AgentTown companies"
```

---

### Task 8: Build the Core Entrypoint and Thin CLI

**Files:**
- Create: `packages/core/src/main.ts`
- Modify: `packages/core/package.json`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/paths.ts`
- Create: `packages/cli/src/templates.ts`
- Create: `packages/cli/src/core-process.ts`
- Create: `packages/cli/src/client.ts`
- Create: `packages/cli/src/render.ts`
- Create: `packages/cli/src/main.ts`
- Create: `packages/cli/test/paths.test.ts`
- Create: `packages/cli/test/templates.test.ts`
- Create: `packages/cli/test/render.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `CoreServer`, `CoreStore`, `parseCompanyYaml`, and the IPC contract.
- Produces: `agenttown-core` and `agenttown` executables with stable text output.

- [ ] **Step 1: Write failing path-boundary and template tests**

Create `packages/cli/test/paths.test.ts`:

```ts
it("resolves all state beneath the selected project", () => {
  const paths = resolveAgentTownPaths("C:\\work\\project");
  expect(paths.stateDir).toBe("C:\\work\\project\\.agenttown");
  expect(paths.databasePath.startsWith(paths.stateDir)).toBe(true);
  expect(paths.companyPath.startsWith(paths.stateDir)).toBe(true);
});

it("rejects a state path that escapes the project", () => {
  expect(() => assertWithinProject("C:\\work\\project", "C:\\work\\other"))
    .toThrow("outside project");
});

it("derives a stable per-user, per-project pipe name", () => {
  const first = pipeNameForProject("C:\\work\\project", {
    username: "alice",
    homedir: "C:\\Users\\alice"
  });
  const second = pipeNameForProject("C:\\work\\project", {
    username: "bob",
    homedir: "C:\\Users\\bob"
  });
  expect(first).toMatch(/^agenttown-[a-f0-9]{24}$/u);
  expect(second).not.toBe(first);
});
```

Create `packages/cli/test/templates.test.ts`:

```ts
it.each(["minimal", "parallel-software"] as const)("parses %s", (name) => {
  const company = parseCompanyYaml(templateYaml(name));
  expect(company.employees.length).toBeGreaterThanOrEqual(3);
  expect(company.employees.every((employee) => employee.agent === "fake")).toBe(true);
});
```

P1A templates use `agent: fake`; P1C replaces adapter values in the production Alpha template after real adapters pass.

- [ ] **Step 2: Run CLI tests and verify the red state**

Create `packages/cli/package.json`:

```json
{
  "name": "@agenttown/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "pretest": "pnpm --filter @agenttown/runtime-contract build",
    "test": "vitest run",
    "pretypecheck": "pnpm --filter @agenttown/runtime-contract build",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@agenttown/core": "workspace:*",
    "@agenttown/runtime-contract": "workspace:*"
  }
}
```

Create `packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run `pnpm install`, then run:

`pnpm --filter @agenttown/cli test -- paths.test.ts templates.test.ts`

Expected: FAIL because `paths.ts` and `templates.ts` do not exist.

- [ ] **Step 3: Implement bounded paths and both templates**

Create `packages/cli/src/paths.ts`:

```ts
export interface AgentTownPaths {
  projectRoot: string;
  stateDir: string;
  databasePath: string;
  companyPath: string;
  logsDir: string;
}

export function assertWithinProject(projectRoot: string, candidate: string): string {
  const root = resolve(projectRoot);
  const target = resolve(candidate);
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`path outside project: ${target}`);
  }
  return target;
}

export function resolveAgentTownPaths(projectRoot: string): AgentTownPaths {
  const root = resolve(projectRoot);
  const stateDir = assertWithinProject(root, join(root, ".agenttown"));
  return {
    projectRoot: root,
    stateDir,
    databasePath: assertWithinProject(root, join(stateDir, "agenttown.sqlite")),
    companyPath: assertWithinProject(root, join(stateDir, "company.yaml")),
    logsDir: assertWithinProject(root, join(stateDir, "logs"))
  };
}

export function pipeNameForProject(
  projectRoot: string,
  identity = { username: userInfo().username, homedir: homedir() }
): string {
  const digest = createHash("sha256")
    .update(`${identity.username}\0${identity.homedir}\0${resolve(projectRoot)}`)
    .digest("hex")
    .slice(0, 24);
  return `agenttown-${digest}`;
}
```

Create `packages/cli/src/templates.ts` with these two complete templates:

```ts
const minimal = `schema_version: 1
company:
  name: minimal
  mission: Complete the user-confirmed task
  success_criteria:
    - All task acceptance criteria pass
    - Independent review passes
  operating_rules:
    - Each task has one owner
    - Every completion includes evidence
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: developer
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: reviewer
    role: reviewer
    agent: fake
    reports_to: leader
    workspace: review_package
limits:
  max_task_retry: 1
  max_review_loops: 2
  max_parallel_tasks: 1
`;

const parallelSoftware = `schema_version: 1
company:
  name: parallel-software
  mission: Deliver a runnable and tested small software project
  success_criteria:
    - All confirmed acceptance criteria pass
    - Project verification passes
    - Independent review passes
  operating_rules:
    - Each task has one owner
    - Every conclusion includes evidence
    - Requirement ambiguity is escalated to the user
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: developer-a
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: developer-b
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: reviewer
    role: reviewer
    agent: fake
    reports_to: leader
    workspace: review_package
limits:
  max_task_retry: 1
  max_review_loops: 2
  max_parallel_tasks: 2
`;

export type TemplateName = "minimal" | "parallel-software";

export function templateYaml(name: TemplateName): string {
  return name === "minimal" ? minimal : parallelSoftware;
}
```

- [ ] **Step 4: Write failing render tests**

Create `packages/cli/test/render.test.ts`:

```ts
it("renders unavailable usage as unknown", () => {
  expect(renderEmployee({
    id: "reviewer",
    role: "reviewer",
    status: "idle",
    currentTaskId: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      capturedAt: "2026-07-27T00:00:00.000Z"
    }
  })).toContain("unknown");
});

it("renders tasks in stable ID order", () => {
  expect(renderTasks([task("b"), task("a")]).split(/\r?\n/u)[1]).toContain("a");
});
```

Run: `pnpm --filter @agenttown/cli test -- render.test.ts`

Expected: FAIL because `render.ts` does not exist.

- [ ] **Step 5: Implement deterministic text rendering**

Create `packages/cli/src/render.ts` with pure functions:

```ts
export interface CompanyStatusView {
  companyId: string;
  status: string;
  activeTaskCount: number;
  pendingApprovalCount: number;
}

export interface EmployeeStatusView {
  id: string;
  role: string;
  status: string;
  currentTaskId: string | null;
  usage: UsageSnapshot;
}

export function renderUsage(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function renderTasks(tasks: readonly TaskRecord[]): string;
export function renderTimeline(events: readonly EventRecord[]): string;
export function renderCompanyStatus(status: CompanyStatusView): string;
export function renderEmployee(employee: EmployeeStatusView): string;
```

Sort tasks by ID and events by sequence. Never infer employee activity from text; render only Core status fields.

- [ ] **Step 6: Implement Core process arguments and bounded shutdown**

Add a source-mode process script in `packages/core/package.json`:

```json
{
  "scripts": {
    "start": "tsx src/main.ts"
  }
}
```

`packages/core/src/main.ts` accepts:

```text
--project-root <absolute path>
--database <absolute path under project>
--company <absolute path under project>
--pipe-name <name>
--lease-ttl-ms <positive integer>
```

It validates paths before opening the database, constructs the store, company, adapters, services and server, then prints one JSON readiness line:

```json
{"type":"core.ready","protocolVersion":1,"pipeName":"agenttown-0123456789abcdef01234567"}
```

For P1A only, derive deterministic Fake Agent scenarios from roles:

```ts
const scenarios = Object.fromEntries(company.employees.map((employee) => [
  employee.id,
  employee.role === "reviewer"
    ? "review-approve"
    : employee.role === "developer"
      ? "complete"
      : "idle"
]));
```

On `SIGINT` or `SIGTERM`, call `checkpointService.pause("shutdown")`, close the server and store, and exit `0`. A second signal exits `130` without claiming a clean checkpoint.

- [ ] **Step 7: Implement IPC client and Core launcher**

Create `packages/cli/src/client.ts` exposing:

```ts
export class AgentTownClient {
  static connect(pipeName: string, clientId: string, afterSequence: number): Promise<AgentTownClient>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  events(): AsyncIterable<IpcEvent>;
  close(): Promise<void>;
}
```

After handshake, send `client.heartbeat` every `ttlMs / 3`; `close` clears the timer before closing the socket.

Create `packages/cli/src/core-process.ts` exposing:

```ts
export async function startCore(input: {
  projectRoot: string;
  paths: AgentTownPaths;
  pipeName: string;
  leaseTtlMs: number;
}): Promise<{ child: ChildProcess; client: AgentTownClient }>;
```

Spawn `process.execPath --import tsx <core-main>` with `windowsHide: true`, `detached: true`, and piped stdout/stderr. Wait at most 10 seconds for `core.ready`, connect the client, remove readiness listeners, unref the child and both readable pipes, then return both. Detachment gives Core enough time to observe lease loss and checkpoint after the terminal exits; it is not permission to remain as a permanent daemon. If readiness fails, terminate the child and include at most the final 8 KiB of stderr in the thrown error.

- [ ] **Step 8: Implement CLI commands without a second business-logic layer**

Create `packages/cli/src/main.ts` with a small explicit argument parser. It must support:

```text
agenttown doctor
agenttown init [--template minimal|parallel-software]
agenttown start
agenttown status
agenttown tasks
agenttown timeline
agenttown pause
agenttown resume
agenttown stop
```

Command behavior:

- `doctor`: print Node, Git, project write access and Fake Agent availability; nonzero if required P1A prerequisites fail.
- `init`: create `.agenttown`, `logs`, and `company.yaml` with exclusive creation; refuse to overwrite.
- `start`: parse YAML, start or connect Core, request `company.start`, stream status until interrupted.
- read commands: connect, make one request, render result, close.
- `pause`: request `company.pause` and wait for `paused`.
- `resume`: start Core if absent, request `company.resume`, render each recovery decision as `native` or `rebuilt`.
- `stop`: require `--yes` in noninteractive mode, request `company.stop`, and never delete state.

Add a source-mode command script in `packages/cli/package.json`:

```json
{
  "scripts": {
    "start": "tsx src/main.ts"
  }
}
```

- [ ] **Step 9: Run CLI and Core verification**

Run:

```powershell
pnpm --filter @agenttown/cli test
pnpm --filter @agenttown/cli typecheck
pnpm --filter @agenttown/core test
pnpm --filter @agenttown/core typecheck
```

Expected: all commands exit `0`; templates parse, paths stay bounded, output is stable, and unknown usage is honest.

- [ ] **Step 10: Commit**

```powershell
git add packages/cli packages/core/src/main.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat: add AgentTown Core and CLI processes"
```

---

### Task 9: Prove the Complete Fake Company Across Process Restart

**Files:**
- Create: `packages/e2e/package.json`
- Create: `packages/e2e/tsconfig.json`
- Create: `packages/e2e/test/fake-company.test.ts`
- Create: `docs/development/p1a-core.md`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: real CLI, Core, and company-mode Fake Agent source processes launched with `tsx`.
- Produces: P1A acceptance evidence and operator/developer commands.

- [ ] **Step 1: Create the end-to-end package and failing acceptance test**

Create `packages/e2e/package.json`:

```json
{
  "name": "@agenttown/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "pretest": "pnpm --filter @agenttown/runtime-contract build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/e2e/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["test/**/*.ts"]
}
```

Run `pnpm install` so the new workspace participates in recursive test and typecheck commands.

Create `packages/e2e/test/fake-company.test.ts`. The test uses a temporary Git repository and real child processes. It must:

```ts
function cliCommand(args: readonly string[]): { file: string; args: string[] } {
  return process.platform === "win32"
    ? { file: "pnpm.cmd", args: ["--filter", "@agenttown/cli", "start", "--", ...args] }
    : { file: "pnpm", args: ["--filter", "@agenttown/cli", "start", "--", ...args] };
}
```

1. Run `agenttown init --template parallel-software`.
2. Start Core with four Fake Agent sessions.
3. Dispatch two independent developer tasks through IPC.
4. Assert both reach `running` before either completes.
5. Let both Fake developers submit evidence.
6. Let the Fake reviewer approve both.
7. Close the only client without sending explicit pause.
8. Wait for Core exit and assert database company status is `paused`.
9. Start a new Core and request resume.
10. Assert every recovery decision is recorded as `native` for Fake Agent.
11. Assert tasks remain `completed`.
12. Assert event sequence is strictly increasing across restart.
13. Assert `status` contains four employees and `unknown` context usage.
14. Stop with `--yes` and assert state files remain.

Use bounded waits no longer than 15 seconds per process phase. On failure, print child stdout/stderr and the last 30 events.

- [ ] **Step 2: Run the end-to-end acceptance test**

Run:

```powershell
$env:AGENTTOWN_FORBID_REAL_PROBES='1'
$env:AGENTTOWN_REAL_CODEX='0'
$env:AGENTTOWN_REAL_CLAUDE='0'
pnpm --filter @agenttown/e2e test -- fake-company.test.ts
```

Expected: exit `0`; the restart scenario passes with four real Fake Agent child processes. If it fails, stop this task, invoke `superpowers:systematic-debugging`, add a focused regression test in the owning package, and rerun this exact command after the diagnosed fix.

- [ ] **Step 3: Document the proven P1A commands and boundaries**

Create `docs/development/p1a-core.md` with:

- prerequisites: Windows, Node >=22, pnpm 11.9.0, Git;
- install: `pnpm install`;
- verification environment variables;
- `pnpm test` and `pnpm typecheck`;
- a local Fake Company walkthrough using a disposable Git repository;
- process diagram: CLI → Named Pipe → Core → Fake Agent children;
- `.agenttown/` file ownership and safe cleanup instructions;
- explicit P1A limitations: no worktree integration, no real adapters, no desktop UI, no push/deploy;
- recovery semantics: last client lease expires, checkpoint, children stop, next start native/rebuilt decision.

Add `.agenttown/` to `.gitignore` because it is local runtime state. Add root scripts:

```json
{
  "scripts": {
    "test:p1a": "pnpm --filter @agenttown/e2e test",
    "agenttown": "pnpm --filter @agenttown/cli exec tsx src/main.ts"
  }
}
```

- [ ] **Step 4: Run the full repository verification gate**

Run:

```powershell
$env:AGENTTOWN_FORBID_REAL_PROBES='1'
$env:AGENTTOWN_REAL_CODEX='0'
$env:AGENTTOWN_REAL_CLAUDE='0'
pnpm typecheck
pnpm test
pnpm probe:fake
git diff --check
```

Expected:

- all commands exit `0`;
- no real Agent command is launched;
- P0 probe tests remain green;
- P1A package tests and end-to-end Fake Company test pass;
- `git diff --check` prints no errors.

- [ ] **Step 5: Commit P1A acceptance**

```powershell
git add .gitignore package.json pnpm-lock.yaml packages/e2e packages/core packages/cli packages/fake-agent docs/development/p1a-core.md
git commit -m "test: prove AgentTown Fake Company lifecycle"
```

## P1A Completion Gate

Before beginning P1B, verify all of the following from fresh command output:

- `pnpm typecheck` exits `0`.
- `pnpm test` exits `0`.
- `pnpm probe:fake` exits `0`.
- Four Fake Agent child sessions start together.
- Two Fake developer tasks are concurrently `running`.
- Only the configured reviewer can approve.
- A fifth employee cannot be invented through an action.
- The last client’s departure causes a checkpoint, `paused`, process shutdown, and Core exit.
- Restart preserves tasks and event ordering.
- Recovery events distinguish native resume from rebuilt sessions.
- CLI displays unknown Token/context fields as `unknown`.
- All runtime state stays under `.agenttown/`.
- No P1B, P1C, desktop, push, deployment, or telemetry behavior has entered the slice.

After this gate passes, write the P1B implementation plan against the actual committed interfaces rather than predicting their final shape here.
