import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  parseGitTaskSubmission,
  parseReviewDecision,
  validationCommandSchema,
  type CompanyDefinition,
  type GitSubmissionRecord,
  type GitWorkspaceRecord,
  type GitRunRecord,
  type IntegrationAttemptRecord,
  type ReviewDecision,
  type ReviewPackageRecord,
  type SessionHandle,
  type TaskRecord,
  type UsageSnapshot,
  type ValidationCommandGrant,
  type ValidationRunRecord
} from "@agenttown/runtime-contract";
import { migrateCoreSchema } from "./migrations.js";

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

export interface StoredReviewDecision {
  runId: string;
  taskId: string;
  revision: number;
  decision: ReviewDecision;
}

type DatabaseRow = Record<string, unknown>;

function parseJsonObject<T extends object>(json: string, label: string): T {
  const value: unknown = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as T;
}

function readString(row: DatabaseRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`${column} must be a string`);
  }
  return value;
}

function readNullableString(row: DatabaseRow, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${column} must be a string or null`);
  }
  return value;
}

function readNumber(row: DatabaseRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new TypeError(`${column} must be a number`);
  }
  return value;
}

function readObjectString(value: DatabaseRow, property: string, label: string): string {
  const result = value[property];
  if (typeof result !== "string") {
    throw new TypeError(`${label}.${property} must be a string`);
  }
  return result;
}

function readObjectNullableString(
  value: DatabaseRow,
  property: string,
  label: string
): string | null {
  const result = value[property];
  if (result === null) return null;
  if (typeof result !== "string") {
    throw new TypeError(`${label}.${property} must be a string or null`);
  }
  return result;
}

function readObjectNumber(value: DatabaseRow, property: string, label: string): number {
  const result = value[property];
  if (typeof result !== "number") {
    throw new TypeError(`${label}.${property} must be a number`);
  }
  return result;
}

function readStringArray(value: DatabaseRow, property: string, label: string): string[] {
  const result = value[property];
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label}.${property} must be a string array`);
  }
  return result;
}

function readEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${label} has an unsupported value: ${value}`);
  }
  return value as T;
}

function parseGitSubmissionRecord(json: string): GitSubmissionRecord {
  const value = parseJsonObject<DatabaseRow>(json, "Git submission");
  return {
    runId: readObjectString(value, "runId", "Git submission"),
    taskId: readObjectString(value, "taskId", "Git submission"),
    revision: readObjectNumber(value, "revision", "Git submission"),
    submission: parseGitTaskSubmission(value.submission),
    status: readEnum(
      readObjectString(value, "status", "Git submission"),
      [
        "received", "validated", "rejected", "in_review", "approved",
        "changes_requested", "queued", "integrated"
      ],
      "Git submission status"
    )
  };
}

function parseValidationCommandGrant(json: string): ValidationCommandGrant {
  const value = parseJsonObject<DatabaseRow>(json, "validation command grant");
  return {
    grantId: readObjectString(value, "grantId", "validation command grant"),
    runId: readObjectString(value, "runId", "validation command grant"),
    taskId: readObjectString(value, "taskId", "validation command grant"),
    workspaceId: readObjectString(value, "workspaceId", "validation command grant"),
    command: validationCommandSchema.parse(value.command),
    status: readEnum(
      readObjectString(value, "status", "validation command grant"),
      ["pending", "approved", "rejected"],
      "validation command grant status"
    ),
    decisionReason: readObjectNullableString(
      value,
      "decisionReason",
      "validation command grant"
    )
  };
}

function parseValidationRunRecord(json: string): ValidationRunRecord {
  const value = parseJsonObject<DatabaseRow>(json, "validation run");
  const exitCode = value.exitCode;
  if (exitCode !== null && typeof exitCode !== "number") {
    throw new TypeError("validation run.exitCode must be a number or null");
  }
  return {
    validationId: readObjectString(value, "validationId", "validation run"),
    runId: readObjectString(value, "runId", "validation run"),
    taskId: readObjectNullableString(value, "taskId", "validation run"),
    integrationAttemptId: readObjectNullableString(
      value,
      "integrationAttemptId",
      "validation run"
    ),
    command: validationCommandSchema.parse(value.command),
    workspaceId: readObjectString(value, "workspaceId", "validation run"),
    outcome: readEnum(
      readObjectString(value, "outcome", "validation run"),
      ["passed", "failed", "timed_out", "start_failed", "cleanup_failed"],
      "validation run outcome"
    ),
    exitCode,
    startedAt: readObjectString(value, "startedAt", "validation run"),
    completedAt: readObjectString(value, "completedAt", "validation run"),
    logPath: readObjectString(value, "logPath", "validation run"),
    logHash: readObjectString(value, "logHash", "validation run")
  };
}

function parseReviewPackageRecord(json: string): ReviewPackageRecord {
  const value = parseJsonObject<DatabaseRow>(json, "review package");
  return {
    runId: readObjectString(value, "runId", "review package"),
    taskId: readObjectString(value, "taskId", "review package"),
    revision: readObjectNumber(value, "revision", "review package"),
    manifestPath: readObjectString(value, "manifestPath", "review package"),
    manifestHash: readObjectString(value, "manifestHash", "review package"),
    totalBytes: readObjectNumber(value, "totalBytes", "review package"),
    status: readEnum(
      readObjectString(value, "status", "review package"),
      ["created", "verified", "tampered", "deleted"],
      "review package status"
    )
  };
}

function parseIntegrationAttemptRecord(json: string): IntegrationAttemptRecord {
  const value = parseJsonObject<DatabaseRow>(json, "integration attempt");
  return {
    attemptId: readObjectString(value, "attemptId", "integration attempt"),
    runId: readObjectString(value, "runId", "integration attempt"),
    taskId: readObjectString(value, "taskId", "integration attempt"),
    submissionRevision: readObjectNumber(
      value,
      "submissionRevision",
      "integration attempt"
    ),
    orderKey: readObjectString(value, "orderKey", "integration attempt"),
    expectedOldCommit: readObjectString(
      value,
      "expectedOldCommit",
      "integration attempt"
    ),
    candidateRef: readObjectString(value, "candidateRef", "integration attempt"),
    candidateCommit: readObjectNullableString(
      value,
      "candidateCommit",
      "integration attempt"
    ),
    status: readEnum(
      readObjectString(value, "status", "integration attempt"),
      ["prepared", "conflicted", "validation_failed", "committed", "aborted"],
      "integration attempt status"
    ),
    conflictFiles: readStringArray(value, "conflictFiles", "integration attempt"),
    validationRunIds: readStringArray(
      value,
      "validationRunIds",
      "integration attempt"
    )
  };
}

function validationCommandFingerprint(grant: ValidationCommandGrant): string {
  return createHash("sha256").update(JSON.stringify({
    executable: grant.command.executable,
    args: grant.command.args,
    cwd: grant.command.cwd,
    timeoutSeconds: grant.command.timeoutSeconds,
    workspaceId: grant.workspaceId
  })).digest("hex");
}

function assertIntegrationFactsMatch(
  attempt: IntegrationAttemptRecord,
  submission: GitSubmissionRecord,
  task?: TaskRecord
): void {
  if (
    attempt.runId !== submission.runId
    || attempt.taskId !== submission.taskId
    || attempt.submissionRevision !== submission.revision
    || (task !== undefined && attempt.taskId !== task.id)
  ) {
    throw new Error("integration attempt, submission and task identities must match");
  }
}

function assertTaskScopedEvents(
  taskId: string,
  events: readonly NewEvent[]
): void {
  for (const event of events) {
    if (event.taskId !== taskId) {
      throw new Error(`integration event taskId must match bundle taskId: ${taskId}`);
    }
  }
}

function parseGitRunRow(row: DatabaseRow): GitRunRecord {
  return {
    runId: readString(row, "run_id"),
    companyId: readString(row, "company_id"),
    projectRoot: readString(row, "project_root"),
    originalBranch: readString(row, "original_branch"),
    baseCommit: readString(row, "base_commit"),
    integrationRef: readString(row, "integration_ref"),
    integrationCommit: readString(row, "integration_commit"),
    status: readEnum(
      readString(row, "status"),
      ["creating", "active", "paused", "completed", "tampered"],
      "Git run status"
    ),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at")
  };
}

function parseGitWorkspaceRow(row: DatabaseRow): GitWorkspaceRecord {
  return {
    workspaceId: readString(row, "workspace_id"),
    runId: readString(row, "run_id"),
    taskId: readNullableString(row, "task_id"),
    employeeId: readNullableString(row, "employee_id"),
    kind: readEnum(
      readString(row, "kind"),
      ["integration", "task", "candidate"],
      "Git workspace kind"
    ),
    path: readString(row, "path"),
    branchRef: readString(row, "branch_ref"),
    baseCommit: readString(row, "base_commit"),
    headCommit: readString(row, "head_commit"),
    status: readEnum(
      readString(row, "status"),
      ["active", "paused", "completed", "removing", "missing", "tampered"],
      "Git workspace status"
    )
  };
}

export class CoreStore {
  readonly #database: DatabaseSync;
  readonly #eventListeners = new Set<(event: EventRecord) => void>();

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
  }

  initialize(): void {
    migrateCoreSchema(this.#database);
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

  insertEvent(event: NewEvent): EventRecord {
    const inserted = this.inTransaction(() => this.#insertEventRow(event));
    this.#publishEvents([inserted]);
    return inserted;
  }

  listEvents(afterSequence: number, limit?: number): EventRecord[] {
    const rows = (limit === undefined
      ? this.#database.prepare(`
      SELECT sequence, id, occurred_at, type, actor_id, task_id, causation_event_id, payload_json
      FROM events
      WHERE sequence > ?
      ORDER BY sequence ASC
    `).all(afterSequence)
      : this.#database.prepare(`
      SELECT sequence, id, occurred_at, type, actor_id, task_id, causation_event_id, payload_json
      FROM events
      WHERE sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(afterSequence, limit)) as DatabaseRow[];

    return rows.map((row) => ({
      sequence: readNumber(row, "sequence"),
      id: readString(row, "id"),
      occurredAt: readString(row, "occurred_at"),
      type: readString(row, "type"),
      actorId: readString(row, "actor_id"),
      taskId: readNullableString(row, "task_id"),
      causationEventId: readNullableString(row, "causation_event_id"),
      payload: parseJsonObject<Record<string, unknown>>(
        readString(row, "payload_json"),
        "event payload"
      )
    }));
  }

  getLatestEventSequence(): number {
    const row = this.#database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM events
    `).get() as DatabaseRow;
    return readNumber(row, "sequence");
  }

  subscribeEvents(listener: (event: EventRecord) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  createCompany(input: {
    id: string;
    definition: CompanyDefinition;
    event: NewEvent;
  }): void {
    const occurredAt = new Date().toISOString();
    const definitionJson = JSON.stringify(input.definition);
    const insertedEvent = this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO companies (id, definition_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.id, definitionJson, "active", occurredAt, occurredAt);
      this.#database.prepare(`
        INSERT INTO company_revisions (company_id, revision, definition_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.id, 1, definitionJson, occurredAt);

      const insertEmployee = this.#database.prepare(`
        INSERT INTO employees (company_id, id, role, agent, reports_to, workspace)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const employee of input.definition.employees) {
        insertEmployee.run(
          input.id,
          employee.id,
          employee.role,
          employee.agent,
          employee.reportsTo,
          employee.workspace
        );
      }

      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  getCompany(id: string): {
    id: string;
    definitionJson: string;
    status: string;
  } | null {
    const row = this.#database.prepare(`
      SELECT id, definition_json, status
      FROM companies
      WHERE id = ?
    `).get(id) as DatabaseRow | undefined;
    if (row === undefined) return null;
    return {
      id: readString(row, "id"),
      definitionJson: readString(row, "definition_json"),
      status: readString(row, "status")
    };
  }

  getOnlyCompanyStatus(): string | null {
    const row = this.#database.prepare(`
      SELECT status
      FROM companies
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get() as DatabaseRow | undefined;
    return row === undefined ? null : readString(row, "status");
  }

  listEmployees(companyId: string): Array<{
    id: string;
    role: string;
  }> {
    const rows = this.#database.prepare(`
      SELECT id, role
      FROM employees
      WHERE company_id = ?
      ORDER BY id ASC
    `).all(companyId) as DatabaseRow[];
    return rows.map((row) => ({
      id: readString(row, "id"),
      role: readString(row, "role")
    }));
  }

  putGitRun(run: GitRunRecord): void {
    this.inTransaction(() => {
      this.#putGitRunRow(run);
    });
  }

  commitGitRunCreation(input: {
    run: GitRunRecord;
    workspace: GitWorkspaceRecord;
    event: NewEvent;
  }): void {
    const insertedEvent = this.inTransaction(() => {
      this.#putGitRunRow(input.run);
      this.#putGitWorkspaceRow(input.workspace);
      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  getGitRun(runId: string): GitRunRecord | null {
    const row = this.#database.prepare(`
      SELECT
        run_id,
        company_id,
        project_root,
        original_branch,
        base_commit,
        integration_ref,
        integration_commit,
        status,
        created_at,
        updated_at
      FROM git_runs
      WHERE run_id = ?
    `).get(runId) as DatabaseRow | undefined;
    if (row === undefined) return null;
    return parseGitRunRow(row);
  }

  listGitRuns(companyId: string): GitRunRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        run_id,
        company_id,
        project_root,
        original_branch,
        base_commit,
        integration_ref,
        integration_commit,
        status,
        created_at,
        updated_at
      FROM git_runs
      WHERE company_id = ?
      ORDER BY created_at ASC, run_id ASC
    `).all(companyId) as DatabaseRow[];
    return rows.map(parseGitRunRow);
  }

  putGitWorkspace(workspace: GitWorkspaceRecord): void {
    this.inTransaction(() => {
      this.#putGitWorkspaceRow(workspace);
    });
  }

  commitGitWorkspace(input: {
    workspace: GitWorkspaceRecord;
    event: NewEvent;
  }): void {
    const insertedEvent = this.inTransaction(() => {
      this.#putGitWorkspaceRow(input.workspace);
      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  commitGitRunPause(input: {
    run: GitRunRecord;
    workspaces: readonly GitWorkspaceRecord[];
    event: NewEvent;
  }): void {
    const insertedEvent = this.inTransaction(() => {
      this.#putGitRunRow(input.run);
      for (const workspace of input.workspaces) {
        this.#putGitWorkspaceRow(workspace);
      }
      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  getGitWorkspace(workspaceId: string): GitWorkspaceRecord | null {
    const row = this.#database.prepare(`
      SELECT
        workspace_id,
        run_id,
        task_id,
        employee_id,
        kind,
        path,
        branch_ref,
        base_commit,
        head_commit,
        status
      FROM git_workspaces
      WHERE workspace_id = ?
    `).get(workspaceId) as DatabaseRow | undefined;
    return row === undefined ? null : parseGitWorkspaceRow(row);
  }

  listGitWorkspaces(runId: string): GitWorkspaceRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        workspace_id,
        run_id,
        task_id,
        employee_id,
        kind,
        path,
        branch_ref,
        base_commit,
        head_commit,
        status
      FROM git_workspaces
      WHERE run_id = ?
      ORDER BY workspace_id ASC
    `).all(runId) as DatabaseRow[];
    return rows.map(parseGitWorkspaceRow);
  }

  putGitSubmission(submission: GitSubmissionRecord): void {
    this.inTransaction(() => {
      this.#putGitSubmissionRow(submission);
    });
  }

  getGitSubmission(
    runId: string,
    taskId: string,
    revision: number
  ): GitSubmissionRecord | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM git_submissions
      WHERE run_id = ? AND task_id = ? AND revision = ?
    `).get(runId, taskId, revision) as DatabaseRow | undefined;
    return row === undefined
      ? null
      : parseGitSubmissionRecord(readString(row, "record_json"));
  }

  listGitSubmissions(
    runId: string,
    taskId?: string
  ): GitSubmissionRecord[] {
    const rows = (taskId === undefined
      ? this.#database.prepare(`
        SELECT record_json
        FROM git_submissions
        WHERE run_id = ?
        ORDER BY task_id ASC, revision ASC
      `).all(runId)
      : this.#database.prepare(`
        SELECT record_json
        FROM git_submissions
        WHERE run_id = ? AND task_id = ?
        ORDER BY revision ASC
      `).all(runId, taskId)) as DatabaseRow[];
    return rows.map((row) =>
      parseGitSubmissionRecord(readString(row, "record_json"))
    );
  }

  putValidationCommandGrant(grant: ValidationCommandGrant): void {
    this.inTransaction(() => {
      this.#putValidationCommandGrantRow(grant);
    });
  }

  commitValidationCommandGrant(input: {
    grant: ValidationCommandGrant;
    event: NewEvent;
  }): void {
    const insertedEvent = this.inTransaction(() => {
      this.#putValidationCommandGrantRow(input.grant);
      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  getValidationCommandGrant(grantId: string): ValidationCommandGrant | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM validation_command_grants
      WHERE grant_id = ?
    `).get(grantId) as DatabaseRow | undefined;
    return row === undefined
      ? null
      : parseValidationCommandGrant(readString(row, "record_json"));
  }

  listValidationCommandGrants(
    runId: string,
    taskId?: string
  ): ValidationCommandGrant[] {
    const rows = (taskId === undefined
      ? this.#database.prepare(`
        SELECT record_json
        FROM validation_command_grants
        WHERE run_id = ?
        ORDER BY task_id ASC, grant_id ASC
      `).all(runId)
      : this.#database.prepare(`
        SELECT record_json
        FROM validation_command_grants
        WHERE run_id = ? AND task_id = ?
        ORDER BY grant_id ASC
      `).all(runId, taskId)) as DatabaseRow[];
    return rows.map((row) =>
      parseValidationCommandGrant(readString(row, "record_json"))
    );
  }

  decideValidationCommandGrant(
    grantId: string,
    decision: "approved" | "rejected",
    reason: string
  ): ValidationCommandGrant {
    if (reason.trim().length === 0) {
      throw new Error("validation command grant decision reason is required");
    }
    return this.inTransaction(() => {
      const current = this.getValidationCommandGrant(grantId);
      if (current === null) {
        throw new Error(`validation command grant not found: ${grantId}`);
      }
      if (current.status !== "pending") {
        if (
          current.status === decision
          && current.decisionReason === reason
        ) {
          return current;
        }
        throw new Error(`validation command grant already ${current.status}: ${grantId}`);
      }
      const decided: ValidationCommandGrant = {
        ...current,
        status: decision,
        decisionReason: reason
      };
      this.#putValidationCommandGrantRow(decided);
      return decided;
    });
  }

  commitValidationCommandGrantDecision(input: {
    grantId: string;
    decision: "approved" | "rejected";
    reason: string;
    event: NewEvent;
  }): ValidationCommandGrant {
    if (input.reason.trim().length === 0) {
      throw new Error("validation command grant decision reason is required");
    }
    const { grant, insertedEvent } = this.inTransaction(() => {
      const current = this.getValidationCommandGrant(input.grantId);
      if (current === null) {
        throw new Error(`validation command grant not found: ${input.grantId}`);
      }
      if (current.status !== "pending") {
        if (
          current.status === input.decision
          && current.decisionReason === input.reason
        ) {
          return { grant: current, insertedEvent: null };
        }
        throw new Error(`validation command grant already ${current.status}: ${input.grantId}`);
      }
      const grant: ValidationCommandGrant = {
        ...current,
        status: input.decision,
        decisionReason: input.reason
      };
      this.#putValidationCommandGrantRow(grant);
      return { grant, insertedEvent: this.#insertEventRow(input.event) };
    });
    if (insertedEvent !== null) this.#publishEvents([insertedEvent]);
    return grant;
  }

  putValidationRun(validation: ValidationRunRecord): void {
    this.inTransaction(() => {
      this.#putValidationRunRow(validation);
    });
  }

  commitValidationRun(input: {
    validation: ValidationRunRecord;
    event: NewEvent;
  }): void {
    const insertedEvent = this.inTransaction(() => {
      this.#putValidationRunRow(input.validation);
      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  commitValidationRunCompletion(input: {
    validation: ValidationRunRecord;
    completedEvent: NewEvent;
    pause?: {
      run: GitRunRecord;
      workspaces: readonly GitWorkspaceRecord[];
      event: NewEvent;
    };
  }): void {
    if (input.pause !== undefined && (
      input.validation.outcome !== "cleanup_failed"
      || input.pause.run.runId !== input.validation.runId
      || input.pause.run.status !== "paused"
      || input.pause.workspaces.some(({ runId }) => runId !== input.validation.runId)
    )) {
      throw new Error("cleanup_failed pause facts do not match validation run");
    }
    const insertedEvents = this.inTransaction(() => {
      this.#putValidationRunRow(input.validation);
      const events = [this.#insertEventRow(input.completedEvent)];
      if (input.pause !== undefined) {
        this.#putGitRunRow(input.pause.run);
        for (const workspace of input.pause.workspaces) {
          this.#putGitWorkspaceRow(workspace);
        }
        events.push(this.#insertEventRow(input.pause.event));
      }
      return events;
    });
    this.#publishEvents(insertedEvents);
  }

  getValidationRun(validationId: string): ValidationRunRecord | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM validation_runs
      WHERE validation_id = ?
    `).get(validationId) as DatabaseRow | undefined;
    return row === undefined
      ? null
      : parseValidationRunRecord(readString(row, "record_json"));
  }

  listValidationRuns(
    runId: string,
    taskId?: string
  ): ValidationRunRecord[] {
    const rows = (taskId === undefined
      ? this.#database.prepare(`
        SELECT record_json
        FROM validation_runs
        WHERE run_id = ?
        ORDER BY validation_id ASC
      `).all(runId)
      : this.#database.prepare(`
        SELECT record_json
        FROM validation_runs
        WHERE run_id = ? AND task_id = ?
        ORDER BY validation_id ASC
      `).all(runId, taskId)) as DatabaseRow[];
    return rows.map((row) =>
      parseValidationRunRecord(readString(row, "record_json"))
    );
  }

  putReviewPackage(reviewPackage: ReviewPackageRecord): void {
    this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO review_packages (
          run_id,
          task_id,
          revision,
          record_json
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, task_id, revision) DO UPDATE SET
          record_json = excluded.record_json
      `).run(
        reviewPackage.runId,
        reviewPackage.taskId,
        reviewPackage.revision,
        JSON.stringify(reviewPackage)
      );
    });
  }

  getReviewPackage(
    runId: string,
    taskId: string,
    revision: number
  ): ReviewPackageRecord | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM review_packages
      WHERE run_id = ? AND task_id = ? AND revision = ?
    `).get(runId, taskId, revision) as DatabaseRow | undefined;
    return row === undefined
      ? null
      : parseReviewPackageRecord(readString(row, "record_json"));
  }

  listReviewPackages(
    runId: string,
    taskId?: string
  ): ReviewPackageRecord[] {
    const rows = (taskId === undefined
      ? this.#database.prepare(`
        SELECT record_json
        FROM review_packages
        WHERE run_id = ?
        ORDER BY task_id ASC, revision ASC
      `).all(runId)
      : this.#database.prepare(`
        SELECT record_json
        FROM review_packages
        WHERE run_id = ? AND task_id = ?
        ORDER BY revision ASC
      `).all(runId, taskId)) as DatabaseRow[];
    return rows.map((row) =>
      parseReviewPackageRecord(readString(row, "record_json"))
    );
  }

  putReviewDecision(input: StoredReviewDecision): void {
    this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO review_decisions (
          run_id,
          task_id,
          revision,
          record_json
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, task_id, revision) DO UPDATE SET
          record_json = excluded.record_json
      `).run(
        input.runId,
        input.taskId,
        input.revision,
        JSON.stringify(input.decision)
      );
    });
  }

  getReviewDecision(
    runId: string,
    taskId: string,
    revision: number
  ): ReviewDecision | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM review_decisions
      WHERE run_id = ? AND task_id = ? AND revision = ?
    `).get(runId, taskId, revision) as DatabaseRow | undefined;
    return row === undefined
      ? null
      : parseReviewDecision(JSON.parse(readString(row, "record_json")));
  }

  listReviewDecisions(
    runId: string,
    taskId?: string
  ): StoredReviewDecision[] {
    const rows = (taskId === undefined
      ? this.#database.prepare(`
        SELECT run_id, task_id, revision, record_json
        FROM review_decisions
        WHERE run_id = ?
        ORDER BY task_id ASC, revision ASC
      `).all(runId)
      : this.#database.prepare(`
        SELECT run_id, task_id, revision, record_json
        FROM review_decisions
        WHERE run_id = ? AND task_id = ?
        ORDER BY revision ASC
      `).all(runId, taskId)) as DatabaseRow[];
    return rows.map((row) => ({
      runId: readString(row, "run_id"),
      taskId: readString(row, "task_id"),
      revision: readNumber(row, "revision"),
      decision: parseReviewDecision(JSON.parse(readString(row, "record_json")))
    }));
  }

  putIntegrationAttempt(attempt: IntegrationAttemptRecord): void {
    this.inTransaction(() => {
      this.#putIntegrationAttemptRow(attempt);
    });
  }

  getIntegrationAttempt(attemptId: string): IntegrationAttemptRecord | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM integration_attempts
      WHERE attempt_id = ?
    `).get(attemptId) as DatabaseRow | undefined;
    if (row === undefined) return null;
    return parseIntegrationAttemptRecord(readString(row, "record_json"));
  }

  listIntegrationAttempts(
    runId: string,
    taskId?: string
  ): IntegrationAttemptRecord[] {
    const rows = (taskId === undefined
      ? this.#database.prepare(`
        SELECT record_json
        FROM integration_attempts
        WHERE run_id = ?
        ORDER BY order_key ASC, attempt_id ASC
      `).all(runId)
      : this.#database.prepare(`
        SELECT record_json
        FROM integration_attempts
        WHERE run_id = ? AND task_id = ?
        ORDER BY order_key ASC, attempt_id ASC
      `).all(runId, taskId)) as DatabaseRow[];
    return rows.map((row) =>
      parseIntegrationAttemptRecord(readString(row, "record_json"))
    );
  }

  commitPreparedIntegration(input: {
    attempt: IntegrationAttemptRecord;
    submission: GitSubmissionRecord;
    event: NewEvent;
  }): void {
    assertIntegrationFactsMatch(input.attempt, input.submission);
    assertTaskScopedEvents(input.attempt.taskId, [input.event]);
    const insertedEvent = this.inTransaction(() => {
      this.#putIntegrationAttemptRow(input.attempt);
      this.#putGitSubmissionRow(input.submission);
      return this.#insertEventRow(input.event);
    });
    this.#publishEvents([insertedEvent]);
  }

  commitIntegratedTask(input: {
    attempt: IntegrationAttemptRecord;
    submission: GitSubmissionRecord;
    task: TaskRecord;
    events: readonly NewEvent[];
  }): void {
    if (input.events.length === 0) {
      throw new Error("commitIntegratedTask requires at least one event");
    }
    assertIntegrationFactsMatch(input.attempt, input.submission, input.task);
    assertTaskScopedEvents(input.attempt.taskId, input.events);
    const insertedEvents = this.inTransaction(() => {
      const run = this.getGitRun(input.attempt.runId);
      if (run === null) {
        throw new Error(`Git run not found: ${input.attempt.runId}`);
      }
      this.#putIntegrationAttemptRow(input.attempt);
      this.#putGitSubmissionRow(input.submission);
      this.#putTaskRow(run.companyId, input.task);
      return input.events.map((event) => this.#insertEventRow(event));
    });
    this.#publishEvents(insertedEvents);
  }

  setCompanyStatus(companyId: string, status: string, event: NewEvent): void {
    const insertedEvent = this.inTransaction(() => {
      const result = this.#database.prepare(`
        UPDATE companies
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(status, new Date().toISOString(), companyId);
      if (Number(result.changes) !== 1) {
        throw new Error(`company not found: ${companyId}`);
      }
      return this.#insertEventRow(event);
    });
    this.#publishEvents([insertedEvent]);
  }

  putTask(companyId: string, task: TaskRecord, events: readonly NewEvent[]): void {
    if (events.length === 0) {
      throw new Error("putTask requires at least one event");
    }

    const insertedEvents = this.inTransaction(() => {
      this.#putTaskRow(companyId, task);
      return events.map((event) => this.#insertEventRow(event));
    });
    this.#publishEvents(insertedEvents);
  }

  getTask(companyId: string, taskId: string): TaskRecord | null {
    const row = this.#database.prepare(`
      SELECT record_json
      FROM tasks
      WHERE company_id = ? AND id = ?
    `).get(companyId, taskId) as DatabaseRow | undefined;
    if (row === undefined) return null;
    return parseJsonObject<TaskRecord>(readString(row, "record_json"), "task record");
  }

  listTasks(companyId: string): TaskRecord[] {
    const rows = this.#database.prepare(`
      SELECT record_json
      FROM tasks
      WHERE company_id = ?
      ORDER BY id ASC
    `).all(companyId) as DatabaseRow[];
    return rows.map((row) =>
      parseJsonObject<TaskRecord>(readString(row, "record_json"), "task record")
    );
  }

  putSession(
    companyId: string,
    employeeId: string,
    handle: SessionHandle,
    status: string,
    event: NewEvent
  ): void {
    const insertedEvent = this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO agent_sessions (
          company_id,
          employee_id,
          handle_json,
          status,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(company_id, employee_id) DO UPDATE SET
          handle_json = excluded.handle_json,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(
        companyId,
        employeeId,
        JSON.stringify(handle),
        status,
        new Date().toISOString()
      );
      return this.#insertEventRow(event);
    });
    this.#publishEvents([insertedEvent]);
  }

  deleteSession(companyId: string, employeeId: string, event: NewEvent): void {
    const insertedEvent = this.inTransaction(() => {
      this.#database.prepare(`
        DELETE FROM agent_sessions
        WHERE company_id = ? AND employee_id = ?
      `).run(companyId, employeeId);
      return this.#insertEventRow(event);
    });
    this.#publishEvents([insertedEvent]);
  }

  listSessions(companyId: string): Array<{
    employeeId: string;
    handle: SessionHandle;
    status: string;
  }> {
    const rows = this.#database.prepare(`
      SELECT employee_id, handle_json, status
      FROM agent_sessions
      WHERE company_id = ?
      ORDER BY employee_id ASC
    `).all(companyId) as DatabaseRow[];
    return rows.map((row) => ({
      employeeId: readString(row, "employee_id"),
      handle: parseJsonObject<SessionHandle>(
        readString(row, "handle_json"),
        "session handle"
      ),
      status: readString(row, "status")
    }));
  }

  putUsageSnapshot(
    companyId: string,
    employeeId: string,
    usage: UsageSnapshot,
    event: NewEvent
  ): void {
    const insertedEvent = this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO usage_snapshots (
          company_id,
          employee_id,
          input_tokens,
          output_tokens,
          context_tokens,
          captured_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        companyId,
        employeeId,
        usage.inputTokens,
        usage.outputTokens,
        usage.contextTokens,
        usage.capturedAt
      );
      return this.#insertEventRow(event);
    });
    this.#publishEvents([insertedEvent]);
  }

  latestUsage(companyId: string, employeeId: string): UsageSnapshot | null {
    const row = this.#database.prepare(`
      SELECT input_tokens, output_tokens, context_tokens, captured_at
      FROM usage_snapshots
      WHERE company_id = ? AND employee_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(companyId, employeeId) as DatabaseRow | undefined;
    if (row === undefined) return null;
    return {
      inputTokens: this.#readNullableNumber(row, "input_tokens"),
      outputTokens: this.#readNullableNumber(row, "output_tokens"),
      contextTokens: this.#readNullableNumber(row, "context_tokens"),
      capturedAt: readString(row, "captured_at")
    };
  }

  putCheckpoint(checkpoint: StoredCheckpoint, event: NewEvent): void {
    const insertedEvent = this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO checkpoints (id, company_id, created_at, payload_json)
        VALUES (?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.companyId,
        checkpoint.createdAt,
        JSON.stringify(checkpoint.payload)
      );
      return this.#insertEventRow(event);
    });
    this.#publishEvents([insertedEvent]);
  }

  commitPauseFacts(
    checkpoint: StoredCheckpoint,
    checkpointEvent: NewEvent,
    pausedEvent: NewEvent
  ): void {
    this.commitSuspensionFacts(
      checkpoint,
      checkpointEvent,
      "paused",
      pausedEvent
    );
  }

  commitSuspensionFacts(
    checkpoint: StoredCheckpoint,
    checkpointEvent: NewEvent,
    terminalStatus: "paused" | "stopped",
    terminalEvent: NewEvent
  ): void {
    const insertedEvents = this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO checkpoints (id, company_id, created_at, payload_json)
        VALUES (?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.companyId,
        checkpoint.createdAt,
        JSON.stringify(checkpoint.payload)
      );
      const updated = this.#database.prepare(`
        UPDATE companies
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(terminalStatus, new Date().toISOString(), checkpoint.companyId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`company not found: ${checkpoint.companyId}`);
      }
      return [
        this.#insertEventRow(checkpointEvent),
        this.#insertEventRow(terminalEvent)
      ];
    });
    this.#publishEvents(insertedEvents);
  }

  commitCompanyStatusWithEvents(
    companyId: string,
    status: string,
    events: readonly NewEvent[]
  ): void {
    if (events.length === 0) {
      throw new Error("commitCompanyStatusWithEvents requires at least one event");
    }
    const insertedEvents = this.inTransaction(() => {
      const updated = this.#database.prepare(`
        UPDATE companies
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(status, new Date().toISOString(), companyId);
      if (Number(updated.changes) !== 1) throw new Error(`company not found: ${companyId}`);
      return events.map((event) => this.#insertEventRow(event));
    });
    this.#publishEvents(insertedEvents);
  }

  latestCheckpoint(companyId: string): StoredCheckpoint | null {
    const row = this.#database.prepare(`
      SELECT id, company_id, created_at, payload_json
      FROM checkpoints
      WHERE company_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(companyId) as DatabaseRow | undefined;
    if (row === undefined) return null;
    return {
      id: readString(row, "id"),
      companyId: readString(row, "company_id"),
      createdAt: readString(row, "created_at"),
      payload: parseJsonObject<Record<string, unknown>>(
        readString(row, "payload_json"),
        "checkpoint payload"
      )
    };
  }

  claimMutationRequest(
    clientId: string,
    requestId: string,
    fingerprint: string
  ): "claimed" | "duplicate" | "conflict" {
    return this.inTransaction(() => {
      const inserted = this.#database.prepare(`
        INSERT OR IGNORE INTO ipc_mutation_requests (
          client_id,
          request_id,
          fingerprint,
          state,
          response_json,
          claimed_at,
          completed_at
        )
        VALUES (?, ?, ?, 'claimed', NULL, ?, NULL)
      `).run(clientId, requestId, fingerprint, new Date().toISOString());
      if (Number(inserted.changes) === 1) return "claimed";
      const row = this.#database.prepare(`
        SELECT fingerprint
        FROM ipc_mutation_requests
        WHERE client_id = ? AND request_id = ?
      `).get(clientId, requestId) as DatabaseRow | undefined;
      if (row === undefined) throw new Error("mutation request claim disappeared");
      return readString(row, "fingerprint") === fingerprint
        ? "duplicate"
        : "conflict";
    });
  }

  completeMutationRequest(
    clientId: string,
    requestId: string,
    response: Record<string, unknown> | null = null
  ): void {
    this.inTransaction(() => {
      const updated = this.#database.prepare(`
        UPDATE ipc_mutation_requests
        SET state = 'completed', response_json = ?, completed_at = ?
        WHERE client_id = ? AND request_id = ?
      `).run(
        response === null ? null : JSON.stringify(response),
        new Date().toISOString(),
        clientId,
        requestId
      );
      if (Number(updated.changes) !== 1) {
        throw new Error(`mutation request claim not found: ${clientId}/${requestId}`);
      }
    });
  }

  upsertLease(clientId: string, expiresAtMs: number): void {
    this.inTransaction(() => {
      this.#database.prepare(`
        INSERT INTO client_leases (client_id, expires_at_ms)
        VALUES (?, ?)
        ON CONFLICT(client_id) DO UPDATE SET
          expires_at_ms = excluded.expires_at_ms
      `).run(clientId, expiresAtMs);
    });
  }

  deleteLease(clientId: string): void {
    this.inTransaction(() => {
      this.#database.prepare(`
        DELETE FROM client_leases
        WHERE client_id = ?
      `).run(clientId);
    });
  }

  deleteExpiredLeases(nowMs: number): number {
    return this.inTransaction(() => {
      const result = this.#database.prepare(`
        DELETE FROM client_leases
        WHERE expires_at_ms <= ?
      `).run(nowMs);
      return Number(result.changes);
    });
  }

  countLeases(): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM client_leases
    `).get() as DatabaseRow;
    return readNumber(row, "count");
  }

  clearLeases(): void {
    this.inTransaction(() => {
      this.#database.exec("DELETE FROM client_leases");
    });
  }

  #insertEventRow(event: NewEvent): EventRecord {
    const occurredAt = new Date().toISOString();
    const result = this.#database.prepare(`
      INSERT INTO events (
        id,
        occurred_at,
        type,
        actor_id,
        task_id,
        causation_event_id,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      occurredAt,
      event.type,
      event.actorId,
      event.taskId,
      event.causationEventId,
      JSON.stringify(event.payload)
    );
    return {
      ...event,
      sequence: Number(result.lastInsertRowid),
      occurredAt
    };
  }

  #putGitRunRow(run: GitRunRecord): void {
    this.#database.prepare(`
      INSERT INTO git_runs (
        run_id,
        company_id,
        project_root,
        original_branch,
        base_commit,
        integration_ref,
        integration_commit,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        company_id = excluded.company_id,
        project_root = excluded.project_root,
        original_branch = excluded.original_branch,
        base_commit = excluded.base_commit,
        integration_ref = excluded.integration_ref,
        integration_commit = excluded.integration_commit,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      run.runId,
      run.companyId,
      run.projectRoot,
      run.originalBranch,
      run.baseCommit,
      run.integrationRef,
      run.integrationCommit,
      run.status,
      run.createdAt,
      run.updatedAt
    );
  }

  #putGitWorkspaceRow(workspace: GitWorkspaceRecord): void {
    this.#database.prepare(`
      INSERT INTO git_workspaces (
        workspace_id,
        run_id,
        task_id,
        employee_id,
        kind,
        path,
        branch_ref,
        base_commit,
        head_commit,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        employee_id = excluded.employee_id,
        kind = excluded.kind,
        path = excluded.path,
        branch_ref = excluded.branch_ref,
        base_commit = excluded.base_commit,
        head_commit = excluded.head_commit,
        status = excluded.status
    `).run(
      workspace.workspaceId,
      workspace.runId,
      workspace.taskId,
      workspace.employeeId,
      workspace.kind,
      workspace.path,
      workspace.branchRef,
      workspace.baseCommit,
      workspace.headCommit,
      workspace.status
    );
  }

  #putIntegrationAttemptRow(attempt: IntegrationAttemptRecord): void {
    const existing = this.getIntegrationAttempt(attempt.attemptId);
    if (
      existing !== null
      && (
        existing.runId !== attempt.runId
        || existing.taskId !== attempt.taskId
        || existing.submissionRevision !== attempt.submissionRevision
      )
    ) {
      throw new Error(
        `integration attempt immutable identity cannot change: ${attempt.attemptId}`
      );
    }
    const linkedValidations = this.#database.prepare(`
      SELECT run_id, task_id
      FROM validation_runs
      WHERE integration_attempt_id = ?
    `).all(attempt.attemptId) as DatabaseRow[];
    if (linkedValidations.some((row) =>
      readString(row, "run_id") !== attempt.runId
      || readNullableString(row, "task_id") !== attempt.taskId
    )) {
      throw new Error(
        `linked validation ownership must match integration attempt: ${attempt.attemptId}`
      );
    }
    this.#database.prepare(`
      INSERT INTO integration_attempts (
        attempt_id,
        run_id,
        task_id,
        order_key,
        record_json,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        order_key = excluded.order_key,
        record_json = excluded.record_json,
        status = excluded.status
    `).run(
      attempt.attemptId,
      attempt.runId,
      attempt.taskId,
      attempt.orderKey,
      JSON.stringify(attempt),
      attempt.status
    );
  }

  #putGitSubmissionRow(submission: GitSubmissionRecord): void {
    this.#database.prepare(`
      INSERT INTO git_submissions (
        run_id,
        task_id,
        revision,
        record_json,
        status
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, task_id, revision) DO UPDATE SET
        record_json = excluded.record_json,
        status = excluded.status
    `).run(
      submission.runId,
      submission.taskId,
      submission.revision,
      JSON.stringify(submission),
      submission.status
    );
  }

  #putValidationCommandGrantRow(grant: ValidationCommandGrant): void {
    this.#database.prepare(`
      INSERT INTO validation_command_grants (
        grant_id,
        run_id,
        task_id,
        workspace_id,
        command_fingerprint,
        record_json,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(grant_id) DO UPDATE SET
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        workspace_id = excluded.workspace_id,
        command_fingerprint = excluded.command_fingerprint,
        record_json = excluded.record_json,
        status = excluded.status
    `).run(
      grant.grantId,
      grant.runId,
      grant.taskId,
      grant.workspaceId,
      validationCommandFingerprint(grant),
      JSON.stringify(grant),
      grant.status
    );
  }

  #putValidationRunRow(validation: ValidationRunRecord): void {
    if (validation.integrationAttemptId !== null) {
      const attempt = this.getIntegrationAttempt(validation.integrationAttemptId);
      if (
        attempt === null
        || validation.runId !== attempt.runId
        || validation.taskId !== attempt.taskId
      ) {
        throw new Error(
          `linked validation ownership must match integration attempt: `
          + validation.integrationAttemptId
        );
      }
    }
    this.#database.prepare(`
      INSERT INTO validation_runs (
        validation_id,
        run_id,
        task_id,
        integration_attempt_id,
        record_json
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(validation_id) DO UPDATE SET
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        integration_attempt_id = excluded.integration_attempt_id,
        record_json = excluded.record_json
    `).run(
      validation.validationId,
      validation.runId,
      validation.taskId,
      validation.integrationAttemptId,
      JSON.stringify(validation)
    );
  }

  #putTaskRow(companyId: string, task: TaskRecord): void {
    this.#database.prepare(`
      INSERT INTO tasks (
        company_id,
        id,
        record_json,
        status,
        owner_employee_id,
        retry_count,
        review_loop_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, id) DO UPDATE SET
        record_json = excluded.record_json,
        status = excluded.status,
        owner_employee_id = excluded.owner_employee_id,
        retry_count = excluded.retry_count,
        review_loop_count = excluded.review_loop_count
    `).run(
      companyId,
      task.id,
      JSON.stringify(task),
      task.status,
      task.ownerEmployeeId,
      task.retryCount,
      task.reviewLoopCount
    );

    this.#database.prepare(`
      DELETE FROM task_dependencies
      WHERE company_id = ? AND task_id = ?
    `).run(companyId, task.id);
    const insertDependency = this.#database.prepare(`
      INSERT INTO task_dependencies (company_id, task_id, depends_on_task_id)
      VALUES (?, ?, ?)
    `);
    for (const dependency of task.dependencies) {
      insertDependency.run(companyId, task.id, dependency);
    }

    this.#database.prepare(`
      DELETE FROM task_artifacts
      WHERE company_id = ? AND task_id = ?
    `).run(companyId, task.id);
    const insertArtifact = this.#database.prepare(`
      INSERT INTO task_artifacts (company_id, task_id, kind, value)
      VALUES (?, ?, ?, ?)
    `);
    for (const artifact of task.artifacts) {
      insertArtifact.run(companyId, task.id, "artifact", artifact);
    }
    for (const evidence of task.evidence) {
      insertArtifact.run(companyId, task.id, "evidence", evidence);
    }
  }

  #publishEvents(events: readonly EventRecord[]): void {
    for (const event of events) {
      for (const listener of this.#eventListeners) {
        try {
          listener(event);
        } catch {
          // Event delivery is best effort; the committed event remains available
          // from the durable cursor for a listener that needs to recover.
        }
      }
    }
  }

  #readNullableNumber(row: DatabaseRow, column: string): number | null {
    const value = row[column];
    if (value === null) return null;
    if (typeof value !== "number") {
      throw new TypeError(`${column} must be a number or null`);
    }
    return value;
  }
}
