import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitRunRecord,
  GitSubmissionRecord,
  GitWorkspaceRecord,
  IntegrationAttemptRecord,
  ReviewDecision,
  ReviewPackageRecord,
  TaskRecord,
  ValidationCommandGrant,
  ValidationRunRecord
} from "@agenttown/runtime-contract";
import { CoreStore, type NewEvent } from "../src/storage/core-store.js";
import { CORE_SCHEMA_SQL } from "../src/storage/schema.js";
import { companyDefinitionFixture } from "./helpers.js";

const temporaryPaths: string[] = [];

const P1A_SCHEMA_SQL = `
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE employees (
  company_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent TEXT NOT NULL,
  reports_to TEXT NOT NULL,
  workspace TEXT NOT NULL,
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE TABLE company_revisions (
  company_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (company_id, revision),
  FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE TABLE tasks (
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
CREATE TABLE task_dependencies (
  company_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (company_id, task_id, depends_on_task_id)
);
CREATE TABLE task_artifacts (
  company_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (company_id, task_id, kind, value)
);
CREATE TABLE agent_sessions (
  company_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  handle_json TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, employee_id)
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  decision_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER,
  captured_at TEXT NOT NULL
);
CREATE TABLE client_leases (
  client_id TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE ipc_mutation_requests (
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  response_json TEXT,
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (client_id, request_id)
);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  task_id TEXT,
  causation_event_id TEXT,
  payload_json TEXT NOT NULL
);
`;

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { force: true });
  }
});

function temporaryDatabasePath(): string {
  const path = join(
    tmpdir(),
    `agenttown-storage-${process.pid}-${crypto.randomUUID()}.sqlite`
  );
  temporaryPaths.push(path);
  return path;
}

function createP1DatabaseWithCompany(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec(P1A_SCHEMA_SQL);
  database.prepare(`
    INSERT INTO companies (id, definition_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("company", "{}", "active", "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z");
  database.close();
  return path;
}

function createCorruptP1Database(): string {
  const path = createP1DatabaseWithCompany();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE VIEW git_runs AS SELECT id AS wrong_column FROM companies;
    PRAGMA user_version = 1;
  `);
  database.close();
  return path;
}

function createUnknownVersionZeroDatabase(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE mystery (id TEXT PRIMARY KEY)");
  database.close();
  return path;
}

function createFutureDatabase(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version = 3");
  database.close();
  return path;
}

function createMalformedV2Database(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE companies (wrong_column TEXT);
    PRAGMA user_version = 2;
  `);
  database.close();
  return path;
}

function createConstraintDriftVersionZeroDatabase(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec(P1A_SCHEMA_SQL.replace(
    "id TEXT PRIMARY KEY,\n  definition_json",
    "id TEXT,\n  definition_json"
  ));
  database.prepare(`
    INSERT INTO companies (id, definition_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("company", "{}", "active", "created", "updated");
  database.close();
  return path;
}

function createConstraintDriftV2Database(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec(CORE_SCHEMA_SQL.replace(
    "integration_ref TEXT NOT NULL UNIQUE",
    "integration_ref TEXT NOT NULL"
  ));
  database.exec("PRAGMA user_version = 2");
  database.close();
  return path;
}

function createSemanticDriftVersionZeroDatabase(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec(P1A_SCHEMA_SQL.replace(
    "id TEXT PRIMARY KEY,\n  definition_json",
    "id TEXT COLLATE NOCASE PRIMARY KEY,\n  definition_json"
  ));
  database.prepare(`
    INSERT INTO companies (id, definition_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("company", "{}", "active", "created", "updated");
  database.close();
  return path;
}

function createSemanticDriftV2Database(): string {
  const path = temporaryDatabasePath();
  const database = new DatabaseSync(path);
  database.exec(CORE_SCHEMA_SQL.replace(
    "integration_ref TEXT NOT NULL UNIQUE",
    "integration_ref TEXT NOT NULL COLLATE NOCASE UNIQUE"
  ));
  database.prepare(`
    INSERT INTO companies (id, definition_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("company", "{}", "active", "created", "updated");
  database.exec("PRAGMA user_version = 2");
  database.close();
  return path;
}

function readUserVersion(path: string): number {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    return row.user_version;
  } finally {
    database.close();
  }
}

function listTableNames(path: string): string[] {
  const database = new DatabaseSync(path);
  try {
    const rows = database.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    return rows.map(({ name }) => name);
  } finally {
    database.close();
  }
}

function readSchemaLayout(path: string): unknown[] {
  const database = new DatabaseSync(path);
  try {
    return database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all() as unknown[];
  } finally {
    database.close();
  }
}

function countCompanies(path: string): number {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM companies
    `).get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function initializedStore(): CoreStore {
  const store = new CoreStore(":memory:");
  store.initialize();
  store.createCompany({
    id: "company",
    definition: companyDefinitionFixture(),
    event: {
      id: "company-created",
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: { companyId: "company" }
    }
  });
  store.putGitRun(gitRun());
  return store;
}

function gitRun(overrides: Partial<GitRunRecord> = {}): GitRunRecord {
  return {
    runId: "run-1",
    companyId: "company",
    projectRoot: "C:\\project",
    originalBranch: "main",
    baseCommit: "a".repeat(40),
    integrationRef: "refs/agenttown/runs/run-1/integration",
    integrationCommit: "a".repeat(40),
    status: "active",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}

function gitWorkspace(): GitWorkspaceRecord {
  return {
    workspaceId: "workspace-1",
    runId: "run-1",
    taskId: "task-1",
    employeeId: "developer",
    kind: "task",
    path: "C:\\project\\.agenttown\\runs\\run-1\\worktrees\\task-1",
    branchRef: "refs/heads/agenttown/run-1/task-1",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    status: "active"
  };
}

function gitSubmission(
  overrides: Partial<GitSubmissionRecord> = {}
): GitSubmissionRecord {
  return {
    runId: "run-1",
    taskId: "task-1",
    revision: 1,
    submission: {
      schemaVersion: 1,
      headCommit: "b".repeat(40),
      commits: ["b".repeat(40)],
      changeSummary: "Implement task one",
      validationCommandIds: ["unit-tests"],
      suggestedValidationCommands: [],
      reportedResults: [{
        commandId: "unit-tests",
        outcome: "passed",
        summary: "All tests passed"
      }],
      knownRisks: []
    },
    status: "received",
    ...overrides
  };
}

function validationGrant(): ValidationCommandGrant {
  return {
    grantId: "grant-1",
    runId: "run-1",
    taskId: "task-1",
    workspaceId: "workspace-1",
    command: {
      id: "lint",
      executable: "pnpm",
      args: ["lint"],
      cwd: ".",
      timeoutSeconds: 60
    },
    status: "pending",
    decisionReason: null
  };
}

function validationRun(): ValidationRunRecord {
  return {
    validationId: "validation-1",
    runId: "run-1",
    taskId: "task-1",
    integrationAttemptId: null,
    command: {
      id: "unit-tests",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    },
    workspaceId: "workspace-1",
    outcome: "passed",
    exitCode: 0,
    startedAt: "2026-07-29T00:01:00.000Z",
    completedAt: "2026-07-29T00:02:00.000Z",
    logPath: "C:\\project\\.agenttown\\runs\\run-1\\validation\\validation-1.log",
    logHash: "c".repeat(64)
  };
}

function reviewPackage(): ReviewPackageRecord {
  return {
    runId: "run-1",
    taskId: "task-1",
    revision: 1,
    manifestPath: "C:\\project\\.agenttown\\runs\\run-1\\review\\task-1\\1\\manifest.json",
    manifestHash: "d".repeat(64),
    totalBytes: 4096,
    status: "verified"
  };
}

function reviewDecision(): ReviewDecision {
  return {
    schemaVersion: 1,
    decision: "approve",
    findings: [{
      severity: "advisory",
      evidence: "Naming could be clearer",
      requiredChange: null
    }],
    coverageGaps: [],
    summary: "Approved with one advisory",
    reviewedManifestHash: "d".repeat(64)
  };
}

function task(status: TaskRecord["status"]): TaskRecord {
  return {
    id: "task-1",
    title: "Task one",
    objective: "Implement task one",
    ownerEmployeeId: "developer",
    dependencies: [],
    acceptanceCriteria: ["Tests pass"],
    status,
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    createdEventId: "task-created",
    updatedEventId: `task-${status}`
  };
}

function event(id: string, type: string): NewEvent {
  return {
    id,
    type,
    actorId: "core",
    taskId: "task-1",
    causationEventId: null,
    payload: {}
  };
}

function preparedAttempt(): IntegrationAttemptRecord {
  return {
    attemptId: "attempt-1",
    runId: "run-1",
    taskId: "task-1",
    submissionRevision: 1,
    orderKey: "0001:task-1",
    expectedOldCommit: "a".repeat(40),
    candidateRef: "refs/agenttown/candidates/attempt-1",
    candidateCommit: null,
    status: "prepared",
    conflictFiles: [],
    validationRunIds: []
  };
}

describe("Core schema migrations", () => {
  it("creates the complete v2 schema for a fresh database", () => {
    const databasePath = temporaryDatabasePath();
    const store = new CoreStore(databasePath);
    try {
      store.initialize();
      expect(readUserVersion(databasePath)).toBe(2);
      expect(listTableNames(databasePath)).toEqual(expect.arrayContaining([
        "git_runs",
        "git_workspaces",
        "git_submissions",
        "validation_runs",
        "validation_command_grants",
        "review_packages",
        "review_decisions",
        "integration_attempts"
      ]));
    } finally {
      store.close();
    }
  });

  it("migrates a P1A version-zero database to v2 without losing facts", () => {
    const databasePath = createP1DatabaseWithCompany();
    const store = new CoreStore(databasePath);
    try {
      store.initialize();
      expect(readUserVersion(databasePath)).toBe(2);
      expect(store.getCompany("company")).not.toBeNull();
      expect(listTableNames(databasePath)).toContain("git_runs");
    } finally {
      store.close();
    }
  });

  it("migrates an explicitly versioned P1A database to v2", () => {
    const databasePath = createP1DatabaseWithCompany();
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version = 1");
    database.close();
    const store = new CoreStore(databasePath);
    try {
      store.initialize();
      expect(readUserVersion(databasePath)).toBe(2);
      expect(store.getCompany("company")?.id).toBe("company");
    } finally {
      store.close();
    }
  });

  it("round-trips a prepared integration attempt", () => {
    const store = initializedStore();
    try {
      store.putIntegrationAttempt(preparedAttempt());
      expect(store.getIntegrationAttempt("attempt-1")).toEqual(preparedAttempt());
    } finally {
      store.close();
    }
  });

  it("rolls back a failed migration", () => {
    const databasePath = createCorruptP1Database();
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects an unknown nonempty version-zero layout without mutating it", () => {
    const databasePath = createUnknownVersionZeroDatabase();
    const before = listTableNames(databasePath);
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(0);
      expect(listTableNames(databasePath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("rejects a version-zero P1A lookalike with primary-key drift without mutation", () => {
    const databasePath = createConstraintDriftVersionZeroDatabase();
    const before = readSchemaLayout(databasePath);
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(0);
      expect(readSchemaLayout(databasePath)).toEqual(before);
      expect(countCompanies(databasePath)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a version-zero P1A lookalike with NOCASE primary-key drift", () => {
    const databasePath = createSemanticDriftVersionZeroDatabase();
    const before = readSchemaLayout(databasePath);
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(0);
      expect(readSchemaLayout(databasePath)).toEqual(before);
      expect(countCompanies(databasePath)).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a future schema version without mutating it", () => {
    const databasePath = createFutureDatabase();
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(3);
      expect(listTableNames(databasePath)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a malformed current-version layout without mutating it", () => {
    const databasePath = createMalformedV2Database();
    const before = listTableNames(databasePath);
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(2);
      expect(listTableNames(databasePath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("rejects a v2 lookalike with required-unique-index drift without mutation", () => {
    const databasePath = createConstraintDriftV2Database();
    const before = readSchemaLayout(databasePath);
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(2);
      expect(readSchemaLayout(databasePath)).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("rejects a v2 lookalike with NOCASE required-unique-column drift", () => {
    const databasePath = createSemanticDriftV2Database();
    const before = readSchemaLayout(databasePath);
    const store = new CoreStore(databasePath);
    try {
      expect(() => store.initialize()).toThrow("schema migration");
      expect(readUserVersion(databasePath)).toBe(2);
      expect(readSchemaLayout(databasePath)).toEqual(before);
      expect(countCompanies(databasePath)).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("typed Git fact storage", () => {
  it("enforces Git run, workspace and exact grant uniqueness and ownership", () => {
    const store = initializedStore();
    try {
      expect(() => store.putGitRun(gitRun({
        runId: "run-2"
      }))).toThrow();
      const workspace = gitWorkspace();
      store.putGitWorkspace(workspace);
      expect(() => store.putGitWorkspace({
        ...workspace,
        workspaceId: "workspace-2",
        branchRef: "refs/heads/agenttown/run-1/task-2"
      })).toThrow();
      store.putValidationCommandGrant(validationGrant());
      expect(() => store.putValidationCommandGrant({
        ...validationGrant(),
        grantId: "grant-2"
      })).toThrow();
      expect(() => store.putIntegrationAttempt({
        ...preparedAttempt(),
        attemptId: "missing-run-attempt",
        runId: "missing-run"
      })).toThrow();
    } finally {
      store.close();
    }
  });

  it("round-trips and lists Git runs and workspaces", () => {
    const store = initializedStore();
    try {
      const workspace = gitWorkspace();
      store.putGitWorkspace(workspace);
      expect(store.getGitRun("run-1")).toEqual(gitRun());
      expect(store.listGitRuns("company")).toEqual([gitRun()]);
      expect(store.getGitWorkspace("workspace-1")).toEqual(workspace);
      expect(store.listGitWorkspaces("run-1")).toEqual([workspace]);
    } finally {
      store.close();
    }
  });

  it("round-trips and lists parser-validated submissions", () => {
    const store = initializedStore();
    try {
      const first = gitSubmission();
      const second = gitSubmission({
        revision: 2,
        status: "validated"
      });
      store.putGitSubmission(second);
      store.putGitSubmission(first);
      expect(store.getGitSubmission("run-1", "task-1", 1)).toEqual(first);
      expect(store.listGitSubmissions("run-1", "task-1")).toEqual([first, second]);
    } finally {
      store.close();
    }
  });

  it("rejects persisted submission and review JSON that fails Task 1 parsers", () => {
    const databasePath = temporaryDatabasePath();
    const store = new CoreStore(databasePath);
    store.initialize();
    store.createCompany({
      id: "company",
      definition: companyDefinitionFixture(),
      event: {
        id: "company-created",
        type: "company.created",
        actorId: "owner",
        taskId: null,
        causationEventId: null,
        payload: {}
      }
    });
    store.putGitRun(gitRun());
    store.putGitSubmission(gitSubmission());
    store.putReviewDecision({
      runId: "run-1",
      taskId: "task-1",
      revision: 1,
      decision: reviewDecision()
    });
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare(`
      UPDATE git_submissions
      SET record_json = ?
      WHERE run_id = ? AND task_id = ? AND revision = ?
    `).run(JSON.stringify({
      ...gitSubmission(),
      submission: {
        ...gitSubmission().submission,
        headCommit: "NOT-A-GIT-HASH",
        commits: ["NOT-A-GIT-HASH"]
      }
    }), "run-1", "task-1", 1);
    database.prepare(`
      UPDATE review_decisions
      SET record_json = ?
      WHERE run_id = ? AND task_id = ? AND revision = ?
    `).run(JSON.stringify({
      ...reviewDecision(),
      decision: "approve",
      findings: [{
        severity: "blocking",
        evidence: "Broken",
        requiredChange: "Fix it"
      }]
    }), "run-1", "task-1", 1);
    database.close();

    const reopened = new CoreStore(databasePath);
    try {
      reopened.initialize();
      expect(() => reopened.getGitSubmission("run-1", "task-1", 1)).toThrow();
      expect(() => reopened.getReviewDecision("run-1", "task-1", 1)).toThrow();
    } finally {
      reopened.close();
    }
  });

  it("round-trips and atomically decides exact validation command grants", () => {
    const store = initializedStore();
    try {
      store.putGitWorkspace(gitWorkspace());
      const grant = validationGrant();
      store.putValidationCommandGrant(grant);
      expect(store.getValidationCommandGrant("grant-1")).toEqual(grant);
      expect(store.listValidationCommandGrants("run-1", "task-1")).toEqual([grant]);
      const decided = store.decideValidationCommandGrant(
        "grant-1",
        "approved",
        "Needed for acceptance"
      );
      expect(decided).toEqual({
        ...grant,
        status: "approved",
        decisionReason: "Needed for acceptance"
      });
    } finally {
      store.close();
    }
  });

  it("round-trips validation runs, review packages and review decisions", () => {
    const store = initializedStore();
    try {
      store.putGitWorkspace(gitWorkspace());
      const validation = validationRun();
      const review = reviewPackage();
      const decision = reviewDecision();
      store.putValidationRun(validation);
      store.putReviewPackage(review);
      store.putReviewDecision({
        runId: "run-1",
        taskId: "task-1",
        revision: 1,
        decision
      });
      expect(store.getValidationRun("validation-1")).toEqual(validation);
      expect(store.listValidationRuns("run-1", "task-1")).toEqual([validation]);
      expect(store.getReviewPackage("run-1", "task-1", 1)).toEqual(review);
      expect(store.listReviewPackages("run-1", "task-1")).toEqual([review]);
      expect(store.getReviewDecision("run-1", "task-1", 1)).toEqual(decision);
      expect(store.listReviewDecisions("run-1", "task-1")).toEqual([{
        runId: "run-1",
        taskId: "task-1",
        revision: 1,
        decision
      }]);
    } finally {
      store.close();
    }
  });

  it("commits prepared integration facts and their event atomically", () => {
    const store = initializedStore();
    try {
      const attempt = preparedAttempt();
      const submission = gitSubmission({ status: "queued" });
      store.commitPreparedIntegration({
        attempt,
        submission,
        event: event("integration-prepared", "git.integration.prepared")
      });
      expect(store.getIntegrationAttempt("attempt-1")).toEqual(attempt);
      expect(store.getGitSubmission("run-1", "task-1", 1)).toEqual(submission);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual([
        "company-created",
        "integration-prepared"
      ]);

      expect(() => store.commitPreparedIntegration({
        attempt: { ...attempt, status: "aborted" },
        submission: { ...submission, status: "rejected" },
        event: event("integration-prepared", "git.integration.aborted")
      })).toThrow();
      expect(store.getIntegrationAttempt("attempt-1")).toEqual(attempt);
      expect(store.getGitSubmission("run-1", "task-1", 1)).toEqual(submission);
    } finally {
      store.close();
    }
  });

  it("rejects mismatched prepared integration facts before writing any fact", () => {
    const store = initializedStore();
    try {
      expect(() => store.commitPreparedIntegration({
        attempt: preparedAttempt(),
        submission: gitSubmission({ taskId: "different-task" }),
        event: event("mismatched-integration", "git.integration.prepared")
      })).toThrow("must match");
      expect(store.getIntegrationAttempt("attempt-1")).toBeNull();
      expect(store.listGitSubmissions("run-1")).toEqual([]);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual(["company-created"]);
    } finally {
      store.close();
    }
  });

  it("rejects reparenting an existing prepared attempt and preserves linked facts", () => {
    const store = initializedStore();
    try {
      const originalAttempt = preparedAttempt();
      const originalSubmission = gitSubmission();
      const linkedValidation = {
        ...validationRun(),
        integrationAttemptId: "attempt-1"
      };
      store.putIntegrationAttempt(originalAttempt);
      store.putGitSubmission(originalSubmission);
      store.putValidationRun(linkedValidation);

      const reparentedAttempt = {
        ...originalAttempt,
        taskId: "task-2"
      };
      expect(() => store.commitPreparedIntegration({
        attempt: reparentedAttempt,
        submission: gitSubmission({ taskId: "task-2" }),
        event: {
          ...event("reparented-attempt", "git.integration.prepared"),
          taskId: "task-2"
        }
      })).toThrow("immutable");

      expect(store.getIntegrationAttempt("attempt-1")).toEqual(originalAttempt);
      expect(store.getGitSubmission("run-1", "task-1", 1))
        .toEqual(originalSubmission);
      expect(store.getGitSubmission("run-1", "task-2", 1)).toBeNull();
      expect(store.getValidationRun("validation-1")).toEqual(linkedValidation);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual(["company-created"]);
    } finally {
      store.close();
    }
  });

  it("rejects changing the submission revision of an existing prepared attempt", () => {
    const store = initializedStore();
    try {
      const originalAttempt = preparedAttempt();
      store.putIntegrationAttempt(originalAttempt);
      store.putGitSubmission(gitSubmission());

      expect(() => store.commitPreparedIntegration({
        attempt: {
          ...originalAttempt,
          submissionRevision: 2
        },
        submission: gitSubmission({ revision: 2 }),
        event: event("revised-attempt", "git.integration.prepared")
      })).toThrow("immutable");

      expect(store.getIntegrationAttempt("attempt-1")).toEqual(originalAttempt);
      expect(store.getGitSubmission("run-1", "task-1", 2)).toBeNull();
      expect(store.listEvents(0).map(({ id }) => id)).toEqual(["company-created"]);
    } finally {
      store.close();
    }
  });

  it("rejects a prepared integration event outside the bundle task", () => {
    const store = initializedStore();
    try {
      expect(() => store.commitPreparedIntegration({
        attempt: preparedAttempt(),
        submission: gitSubmission(),
        event: {
          ...event("wrong-task-event", "git.integration.prepared"),
          taskId: null
        }
      })).toThrow("event taskId");

      expect(store.getIntegrationAttempt("attempt-1")).toBeNull();
      expect(store.listGitSubmissions("run-1")).toEqual([]);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual(["company-created"]);
    } finally {
      store.close();
    }
  });

  it("rejects writing linked validation ownership that contradicts an attempt", () => {
    const store = initializedStore();
    try {
      store.putGitRun(gitRun({
        runId: "run-2",
        projectRoot: "C:\\project-2",
        integrationRef: "refs/agenttown/runs/run-2/integration"
      }));
      const attempt = preparedAttempt();
      const contradictoryValidation = {
        ...validationRun(),
        runId: "run-2",
        taskId: "task-2",
        integrationAttemptId: "attempt-1"
      };
      store.putIntegrationAttempt(attempt);
      expect(() => store.putValidationRun(contradictoryValidation))
        .toThrow("linked validation");

      expect(store.getIntegrationAttempt("attempt-1")).toEqual(attempt);
      expect(store.getGitSubmission("run-1", "task-1", 1)).toBeNull();
      expect(store.getValidationRun("validation-1")).toBeNull();
      expect(store.listEvents(0).map(({ id }) => id)).toEqual(["company-created"]);
    } finally {
      store.close();
    }
  });

  it("commits an integrated task, attempt, submission and events atomically", () => {
    const store = initializedStore();
    try {
      store.putTask("company", task("running"), [
        event("task-running", "task.running")
      ]);
      const attempt = {
        ...preparedAttempt(),
        candidateCommit: "c".repeat(40),
        status: "committed" as const
      };
      const submission = gitSubmission({ status: "integrated" });
      const completedTask = task("completed");
      store.commitIntegratedTask({
        attempt,
        submission,
        task: completedTask,
        events: [
          event("integration-committed", "git.integration.committed"),
          event("task-completed", "task.completed")
        ]
      });
      expect(store.getIntegrationAttempt("attempt-1")).toEqual(attempt);
      expect(store.getGitSubmission("run-1", "task-1", 1)).toEqual(submission);
      expect(store.getTask("company", "task-1")).toEqual(completedTask);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual([
        "company-created",
        "task-running",
        "integration-committed",
        "task-completed"
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects reparenting an existing attempt through the integrated bundle", () => {
    const store = initializedStore();
    try {
      const originalAttempt = preparedAttempt();
      const originalSubmission = gitSubmission({ status: "queued" });
      const runningTask = task("running");
      store.putTask("company", runningTask, [event("task-running", "task.running")]);
      store.putIntegrationAttempt(originalAttempt);
      store.putGitSubmission(originalSubmission);

      expect(() => store.commitIntegratedTask({
        attempt: {
          ...originalAttempt,
          taskId: "task-2",
          status: "committed"
        },
        submission: gitSubmission({
          taskId: "task-2",
          status: "integrated"
        }),
        task: {
          ...task("completed"),
          id: "task-2"
        },
        events: [{
          ...event("reparented-commit", "git.integration.committed"),
          taskId: "task-2"
        }]
      })).toThrow("immutable");

      expect(store.getIntegrationAttempt("attempt-1")).toEqual(originalAttempt);
      expect(store.getGitSubmission("run-1", "task-1", 1))
        .toEqual(originalSubmission);
      expect(store.getGitSubmission("run-1", "task-2", 1)).toBeNull();
      expect(store.getTask("company", "task-1")).toEqual(runningTask);
      expect(store.getTask("company", "task-2")).toBeNull();
      expect(store.listEvents(0).map(({ id }) => id)).toEqual([
        "company-created",
        "task-running"
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects changing an existing attempt revision through the integrated bundle", () => {
    const store = initializedStore();
    try {
      const originalAttempt = preparedAttempt();
      const runningTask = task("running");
      store.putTask("company", runningTask, [event("task-running", "task.running")]);
      store.putIntegrationAttempt(originalAttempt);
      store.putGitSubmission(gitSubmission({ status: "queued" }));

      expect(() => store.commitIntegratedTask({
        attempt: {
          ...originalAttempt,
          submissionRevision: 2,
          status: "committed"
        },
        submission: gitSubmission({
          revision: 2,
          status: "integrated"
        }),
        task: task("completed"),
        events: [event("revised-commit", "git.integration.committed")]
      })).toThrow("immutable");

      expect(store.getIntegrationAttempt("attempt-1")).toEqual(originalAttempt);
      expect(store.getGitSubmission("run-1", "task-1", 2)).toBeNull();
      expect(store.getTask("company", "task-1")).toEqual(runningTask);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual([
        "company-created",
        "task-running"
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects an integrated bundle when any event targets another task", () => {
    const store = initializedStore();
    try {
      const originalAttempt = preparedAttempt();
      const originalSubmission = gitSubmission({ status: "queued" });
      const runningTask = task("running");
      const linkedValidation = {
        ...validationRun(),
        integrationAttemptId: "attempt-1"
      };
      store.putTask("company", runningTask, [event("task-running", "task.running")]);
      store.putIntegrationAttempt(originalAttempt);
      store.putGitSubmission(originalSubmission);
      store.putValidationRun(linkedValidation);

      expect(() => store.commitIntegratedTask({
        attempt: {
          ...originalAttempt,
          status: "committed",
          candidateCommit: "c".repeat(40)
        },
        submission: gitSubmission({ status: "integrated" }),
        task: task("completed"),
        events: [
          event("integration-commit", "git.integration.committed"),
          {
            ...event("wrong-task-completion", "task.completed"),
            taskId: null
          }
        ]
      })).toThrow("event taskId");

      expect(store.getIntegrationAttempt("attempt-1")).toEqual(originalAttempt);
      expect(store.getGitSubmission("run-1", "task-1", 1))
        .toEqual(originalSubmission);
      expect(store.getTask("company", "task-1")).toEqual(runningTask);
      expect(store.getValidationRun("validation-1")).toEqual(linkedValidation);
      expect(store.listEvents(0).map(({ id }) => id)).toEqual([
        "company-created",
        "task-running"
      ]);
    } finally {
      store.close();
    }
  });

  it("lists integration attempts in stable queue order", () => {
    const store = initializedStore();
    try {
      const second = {
        ...preparedAttempt(),
        attemptId: "attempt-2",
        taskId: "task-2",
        orderKey: "0002:task-2"
      };
      store.putIntegrationAttempt(second);
      store.putIntegrationAttempt(preparedAttempt());
      expect(store.listIntegrationAttempts("run-1")).toEqual([
        preparedAttempt(),
        second
      ]);
    } finally {
      store.close();
    }
  });
});
