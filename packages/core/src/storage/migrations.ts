import type { DatabaseSync } from "node:sqlite";
import {
  CORE_SCHEMA_SQL,
  CORE_SCHEMA_V2_SQL
} from "./schema.js";

const CURRENT_SCHEMA_VERSION = 2;

const P1A_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  agent_sessions: [
    "company_id", "employee_id", "handle_json", "status", "updated_at"
  ],
  approvals: [
    "id", "company_id", "task_id", "status", "request_json", "decision_json",
    "created_at", "decided_at"
  ],
  checkpoints: ["id", "company_id", "created_at", "payload_json"],
  client_leases: ["client_id", "expires_at_ms"],
  companies: ["id", "definition_json", "status", "created_at", "updated_at"],
  company_revisions: [
    "company_id", "revision", "definition_json", "created_at"
  ],
  employees: [
    "company_id", "id", "role", "agent", "reports_to", "workspace"
  ],
  events: [
    "sequence", "id", "occurred_at", "type", "actor_id", "task_id",
    "causation_event_id", "payload_json"
  ],
  ipc_mutation_requests: [
    "client_id", "request_id", "fingerprint", "state", "response_json",
    "claimed_at", "completed_at"
  ],
  task_artifacts: ["company_id", "task_id", "kind", "value"],
  task_dependencies: ["company_id", "task_id", "depends_on_task_id"],
  tasks: [
    "company_id", "id", "record_json", "status", "owner_employee_id",
    "retry_count", "review_loop_count"
  ],
  usage_snapshots: [
    "id", "company_id", "employee_id", "input_tokens", "output_tokens",
    "context_tokens", "captured_at"
  ]
};

const P1B_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  git_runs: [
    "run_id", "company_id", "project_root", "original_branch", "base_commit",
    "integration_ref", "integration_commit", "status", "created_at", "updated_at"
  ],
  git_submissions: [
    "run_id", "task_id", "revision", "record_json", "status"
  ],
  git_workspaces: [
    "workspace_id", "run_id", "task_id", "employee_id", "kind", "path",
    "branch_ref", "base_commit", "head_commit", "status"
  ],
  integration_attempts: [
    "attempt_id", "run_id", "task_id", "order_key", "record_json", "status"
  ],
  review_decisions: ["run_id", "task_id", "revision", "record_json"],
  review_packages: ["run_id", "task_id", "revision", "record_json"],
  validation_command_grants: [
    "grant_id", "run_id", "task_id", "workspace_id", "command_fingerprint",
    "record_json", "status"
  ],
  validation_runs: [
    "validation_id", "run_id", "task_id", "integration_attempt_id", "record_json"
  ]
};

type DatabaseRow = Record<string, unknown>;

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as DatabaseRow;
  const version = row.user_version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new TypeError("PRAGMA user_version did not return an integer");
  }
  return version;
}

function listUserTableNames(database: DatabaseSync): string[] {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as DatabaseRow[];
  return rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new TypeError("sqlite_schema table name must be a string");
    }
    return row.name;
  });
}

function listColumns(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as DatabaseRow[];
  return rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new TypeError(`${table} column name must be a string`);
    }
    return row.name;
  });
}

function hasExpectedTables(
  database: DatabaseSync,
  expected: Readonly<Record<string, readonly string[]>>
): boolean {
  const actualTables = listUserTableNames(database);
  const expectedTables = Object.keys(expected).sort();
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    return false;
  }
  return expectedTables.every((table) => {
    const actualColumns = listColumns(database, table);
    const expectedColumns = expected[table];
    return expectedColumns !== undefined
      && actualColumns.length === expectedColumns.length
      && actualColumns.every((column, index) => column === expectedColumns[index]);
  });
}

function isExpectedP1A(database: DatabaseSync): boolean {
  return hasExpectedTables(database, P1A_COLUMNS);
}

function isExpectedV2(database: DatabaseSync): boolean {
  return hasExpectedTables(database, { ...P1A_COLUMNS, ...P1B_COLUMNS });
}

function runMigration(
  database: DatabaseSync,
  schemaSql: string
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(schemaSql);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function migrateCoreSchema(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const version = readUserVersion(database);
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`unsupported future schema version: ${version}`);
    }
    if (version === CURRENT_SCHEMA_VERSION) {
      if (!isExpectedV2(database)) {
        throw new Error("malformed v2 layout");
      }
      return;
    }
    if (version !== 0 && version !== 1) {
      throw new Error(`unsupported schema version: ${version}`);
    }

    const tables = listUserTableNames(database);
    if (version === 0 && tables.length === 0) {
      runMigration(database, CORE_SCHEMA_SQL);
      return;
    }
    if (!isExpectedP1A(database)) {
      throw new Error(`malformed v1 layout at schema version ${version}`);
    }
    runMigration(database, CORE_SCHEMA_V2_SQL);
  } catch (error) {
    throw new Error("schema migration failed", { cause: error });
  }
}
