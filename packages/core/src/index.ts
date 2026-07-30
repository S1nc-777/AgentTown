export {
  CoreStore,
  type ApprovalRecord,
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
export {
  CompanyOrchestrator,
  FakeTaskWorkflow,
  GitTaskWorkflow,
  type GitTaskWorkflowCoordinator,
  type TaskWorkflow,
  type TaskWorkflowHandlers
} from "./company/orchestrator.js";
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
export {
  SubmissionValidator,
  type AuthoritativeValidation,
  type CanonicalCommit,
  type EvidenceFile,
  type EvidenceFileStatus,
  type SubmissionValidatorOptions,
  type SubmissionWarning,
  type ValidatedSubmission
} from "./git/submission-validator.js";
export {
  EvidencePackageBuilder,
  createInjectedEvidencePackageBuilder,
  type EvidencePackageBuilderOptions,
  type EvidencePackageBuilderDependencies,
  type EvidencePackageInput
} from "./git/evidence-package.js";
export {
  ReviewService,
  type RecordReviewDecisionInput,
  type ReviewOutcome,
  type ReviewServiceOptions
} from "./git/review-service.js";
export {
  GitWorkflowCoordinator,
  type AssignTaskOutcome,
  type GitWorkflowCoordinatorOptions,
  type SubmitTaskOutcome
} from "./git/git-workflow-coordinator.js";
export {
  IntegrationService,
  orderIntegrations,
  type IntegrationFaultHooks,
  type IntegrationResult,
  type IntegrationServiceOptions,
  type OrderedIntegration
} from "./git/integration-service.js";
