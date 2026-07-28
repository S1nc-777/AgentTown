import { DatabaseSync } from "node:sqlite";
import type {
  CompanyDefinition,
  SessionHandle,
  TaskRecord,
  UsageSnapshot
} from "@agenttown/runtime-contract";
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

export class CoreStore {
  readonly #database: DatabaseSync;
  readonly #eventListeners = new Set<(event: EventRecord) => void>();

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

  insertEvent(event: NewEvent): EventRecord {
    const inserted = this.inTransaction(() => this.#insertEventRow(event));
    this.#publishEvents([inserted]);
    return inserted;
  }

  listEvents(afterSequence: number): EventRecord[] {
    const rows = this.#database.prepare(`
      SELECT sequence, id, occurred_at, type, actor_id, task_id, causation_event_id, payload_json
      FROM events
      WHERE sequence > ?
      ORDER BY sequence ASC
    `).all(afterSequence) as DatabaseRow[];

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
        SET status = 'paused', updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), checkpoint.companyId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`company not found: ${checkpoint.companyId}`);
      }
      return [
        this.#insertEventRow(checkpointEvent),
        this.#insertEventRow(pausedEvent)
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

  #publishEvents(events: readonly EventRecord[]): void {
    for (const event of events) {
      for (const listener of this.#eventListeners) {
        listener(event);
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
