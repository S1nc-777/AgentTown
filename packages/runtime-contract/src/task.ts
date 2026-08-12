import { z } from "zod";

export const taskStates = [
  "draft",
  "ready",
  "running",
  "review",
  "completed",
  "blocked",
  "failed"
] as const;

export type TaskState = typeof taskStates[number];

export interface TaskRecord {
  id: string;
  title: string;
  objective: string;
  ownerEmployeeId: string | null;
  dependencies: string[];
  acceptanceCriteria: string[];
  status: TaskState;
  retryCount: number;
  reviewLoopCount: number;
  artifacts: string[];
  evidence: string[];
  conflictForTaskId: string | null;
  createdEventId: string;
  updatedEventId: string;
}

const taskRecordSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  ownerEmployeeId: z.string().trim().min(1).nullable(),
  dependencies: z.array(z.string().trim().min(1)),
  acceptanceCriteria: z.array(z.string().trim().min(1)),
  status: z.enum(taskStates),
  retryCount: z.number().int().min(0),
  reviewLoopCount: z.number().int().min(0),
  artifacts: z.array(z.string()),
  evidence: z.array(z.string()),
  conflictForTaskId: z.string().trim().min(1).nullable(),
  createdEventId: z.string().trim().min(1),
  updatedEventId: z.string().trim().min(1)
});

export function parseTaskRecord(value: unknown): TaskRecord {
  return taskRecordSchema.parse(value);
}

export const actionTypes = [
  "task.propose",
  "task.assign",
  "task.start",
  "task.submit",
  "task.request_review",
  "task.approve",
  "task.reject",
  "task.block",
  "employee.message",
  "user.approval.request",
  "company.complete.request"
] as const;

export type ActionType = typeof actionTypes[number];

export interface ActionProposal {
  schemaVersion: 1;
  actionId: string;
  type: ActionType;
  actorEmployeeId: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  reason: string;
  causationEventId: string | null;
}

const actionProposalSchema = z.object({
  schemaVersion: z.literal(1),
  actionId: z.string().uuid(),
  type: z.enum(actionTypes),
  actorEmployeeId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1),
  causationEventId: z.string().min(1).nullable()
});

export function parseActionProposal(value: unknown): ActionProposal {
  return actionProposalSchema.parse(value);
}
