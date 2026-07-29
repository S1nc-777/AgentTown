export const CORE_SCHEMA_V1_SQL = `
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

CREATE TABLE IF NOT EXISTS ipc_mutation_requests (
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  response_json TEXT,
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (client_id, request_id)
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

export const CORE_SCHEMA_V2_SQL = `
CREATE TABLE git_runs (
  run_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  original_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  integration_ref TEXT NOT NULL UNIQUE,
  integration_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id)
);

CREATE TABLE git_workspaces (
  workspace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  employee_id TEXT,
  kind TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  branch_ref TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id)
);

CREATE TABLE git_submissions (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (run_id, task_id, revision),
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id)
);

CREATE TABLE validation_runs (
  validation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  integration_attempt_id TEXT,
  record_json TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id),
  FOREIGN KEY (integration_attempt_id) REFERENCES integration_attempts(attempt_id)
);

CREATE TABLE validation_command_grants (
  grant_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (run_id, task_id, workspace_id, command_fingerprint),
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id),
  FOREIGN KEY (workspace_id) REFERENCES git_workspaces(workspace_id)
);

CREATE TABLE review_packages (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (run_id, task_id, revision),
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id)
);

CREATE TABLE review_decisions (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (run_id, task_id, revision),
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id)
);

CREATE TABLE integration_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES git_runs(run_id)
);
`;

export const CORE_SCHEMA_SQL = `${CORE_SCHEMA_V1_SQL}\n${CORE_SCHEMA_V2_SQL}`;
