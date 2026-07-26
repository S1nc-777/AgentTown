export const CORE_SCHEMA_SQL = `
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
`;
