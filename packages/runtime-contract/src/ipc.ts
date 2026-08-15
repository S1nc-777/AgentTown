import { z } from "zod";

export const IPC_PROTOCOL_VERSION = 1 as const;
export const LIVE_ONLY_AFTER_SEQUENCE = Number.MAX_SAFE_INTEGER;

export interface GitWorkspaceView {
  employeeId: string | null;
  taskId: string | null;
  state: string;
  headCommit: string;
  workspacePath: string;
  branchRef: string;
}

export interface EvidenceView {
  runId: string;
  taskId: string;
  revision: number;
  manifestHash: string;
  manifestPath: string;
  validationOutcomes: Array<{
    commandId: string;
    outcome: "passed" | "failed" | "timed_out" | "start_failed" | "cleanup_failed";
  }>;
}

export interface DeliveryTaskView {
  taskId: string;
  employeeId: string;
  commits: string[];
  submissionRevision: number;
  reviewDecision: "approve";
  validationOutcomes: Array<{
    commandId: string;
    outcome: "passed";
  }>;
}

export interface DeliveryView {
  runId: string;
  originalBranch: string;
  baseCommit: string;
  integrationBranch: string;
  integrationCommit: string;
  tasks: DeliveryTaskView[];
  advisoryFindings: string[];
  knownRisks: string[];
  mergedIntoUserBranch: false;
  pushed: false;
}

export interface ApprovalView {
  approvalId: string;
  runId: string;
  taskId: string;
  workspaceId: string;
  workspacePath: string;
  requestingEmployeeId: string;
  reason: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
}

export interface CleanupSelection {
  runId: string;
  removeWorktrees: boolean;
  removeBranches: boolean;
  removeEvidence: boolean;
}

export interface CleanupPreview extends CleanupSelection {
  workspaces: Array<{
    workspaceId: string;
    path: string;
    branchRef: string;
    headCommit: string;
  }>;
  branchRefs: Array<{ ref: string; headCommit: string }>;
  evidenceRoots: string[];
  fingerprint: string;
}

export interface CleanupExecuteResult {
  removedWorkspaces: number;
  removedBranches: number;
  removedEvidenceRoots: number;
}

export interface AgentTownIpcMethods {
  "git.workspaces.list": { params: Record<string, never>; result: GitWorkspaceView[] };
  "git.evidence.get": {
    params: { taskId: string; revision?: number };
    result: EvidenceView;
  };
  "git.delivery.get": { params: Record<string, never>; result: DeliveryView };
  "git.cleanup.preview": { params: CleanupSelection; result: CleanupPreview };
  "git.cleanup.execute": {
    params: CleanupSelection & { fingerprint: string };
    result: CleanupExecuteResult;
  };
  "approvals.list": { params: Record<string, never>; result: ApprovalView[] };
  "approvals.decide": {
    params: {
      approvalId: string;
      decision: "approved" | "rejected";
      reason: string;
    };
    result: { status: "approved" | "rejected" };
  };
}

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
