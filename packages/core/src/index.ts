export {
  CoreStore,
  type EventRecord,
  type NewEvent,
  type StoredCheckpoint,
  type StoredReviewDecision
} from "./storage/core-store.js";
export { migrateCoreSchema } from "./storage/migrations.js";
export { ActionPolicy } from "./policy/action-policy.js";
export {
  FakeAgentAdapter,
  type FakeAgentAdapterOptions
} from "./agents/fake-adapter.js";
export { SessionManager } from "./agents/session-manager.js";
export { CompanyOrchestrator } from "./company/orchestrator.js";
export { TaskService } from "./tasks/task-service.js";
export {
  LeaseRegistry,
  type LeaseRegistryOptions
} from "./ipc/lease-registry.js";
export {
  CoreServer,
  type CoreServerOptions
} from "./ipc/core-server.js";
export {
  CheckpointService,
  PauseFailedError,
  RecoveryBlockedError,
  parseCompanyCheckpoint,
  type CheckpointServiceOptions,
  type PauseReason,
  type RecoveryResult
} from "./lifecycle/checkpoint-service.js";
export {
  GitCommandError,
  GitCommandRunner,
  GitCommandTimeoutError,
  GitOutputOverflowError,
  type GitCommandOptions,
  type GitCommandResult,
  type GitCommandRunnerOptions
} from "./git/git-command.js";
export {
  RepositoryPreflight,
  type RepositoryBaseline
} from "./git/repository-preflight.js";
export {
  WorkspaceManager,
  candidateRef,
  integrationRef,
  taskRef,
  type CreateCandidateWorkspaceInput,
  type CreateTaskWorkspaceInput,
  type WorkspaceManagerOptions
} from "./git/workspace-manager.js";
export {
  ValidationRunner,
  type ValidationRunnerOptions,
  type ValidationScope
} from "./git/validation-runner.js";
