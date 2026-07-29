import { z } from "zod";

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

const nonEmpty = z.string().trim().min(1);
const safeIdentifier = nonEmpty.regex(/^[a-z][a-z0-9_-]*$/u);
const gitObjectId = z.string().regex(/^[0-9a-f]{40,64}$/u);
const manifestHash = z.string().regex(/^[0-9a-f]{64}$/u);
const relativeCwd = nonEmpty.superRefine((cwd, context) => {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(cwd)) {
    context.addIssue({ code: "custom", message: "cwd must be relative" });
  }
  if (cwd.split(/[\\/]/u).includes("..")) {
    context.addIssue({ code: "custom", message: "cwd cannot contain .." });
  }
});

export const validationCommandSchema = z.object({
  id: safeIdentifier,
  executable: nonEmpty,
  args: z.array(nonEmpty),
  cwd: relativeCwd,
  timeoutSeconds: z.number().int().min(1).max(600)
});

const gitTaskSubmissionSchema = z.object({
  schemaVersion: z.literal(1),
  headCommit: gitObjectId,
  commits: z.array(gitObjectId).min(1),
  changeSummary: nonEmpty,
  validationCommandIds: z.array(safeIdentifier),
  suggestedValidationCommands: z.array(validationCommandSchema),
  reportedResults: z.array(z.object({
    commandId: safeIdentifier,
    outcome: z.enum(["passed", "failed", "not_run"]),
    summary: nonEmpty
  })),
  knownRisks: z.array(nonEmpty)
}).superRefine((submission, context) => {
  if (new Set(submission.commits).size !== submission.commits.length) {
    context.addIssue({ code: "custom", path: ["commits"], message: "commits must be unique" });
  }
  if (submission.commits.at(-1) !== submission.headCommit) {
    context.addIssue({ code: "custom", path: ["commits"], message: "commits must end at headCommit" });
  }
});

const reviewDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  decision: z.enum(["approve", "reject"]),
  findings: z.array(z.object({
    severity: z.enum(["blocking", "advisory"]),
    evidence: nonEmpty,
    requiredChange: nonEmpty.nullable()
  })),
  coverageGaps: z.array(nonEmpty),
  summary: nonEmpty,
  reviewedManifestHash: manifestHash
}).superRefine((review, context) => {
  const blockingFindings = review.findings.filter(({ severity }) => severity === "blocking");
  if (review.decision === "approve" && blockingFindings.length > 0) {
    context.addIssue({ code: "custom", path: ["decision"], message: "approve decisions cannot include blocking findings" });
  }
  if (
    review.decision === "reject"
    && !blockingFindings.some(({ requiredChange }) => requiredChange !== null)
  ) {
    context.addIssue({ code: "custom", path: ["decision"], message: "reject decisions require a blocking finding with a requiredChange" });
  }
});

export function parseGitTaskSubmission(value: unknown): GitTaskSubmission {
  return gitTaskSubmissionSchema.parse(value);
}

export function parseReviewDecision(value: unknown): ReviewDecision {
  return reviewDecisionSchema.parse(value);
}
