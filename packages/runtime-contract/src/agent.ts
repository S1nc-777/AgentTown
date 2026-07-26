import type { ActionProposal } from "./task.js";

export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface AgentCapabilities {
  nativeResume: CapabilityState;
  structuredOutput: CapabilityState;
  nonInteractive: CapabilityState;
  interrupt: CapabilityState;
  parallelSessions: CapabilityState;
  tokenUsage: CapabilityState;
  contextUsage: CapabilityState;
  interactiveTakeover: CapabilityState;
}

export interface SessionHandle {
  employeeId: string;
  adapter: string;
  internalSessionId: string;
  nativeSessionId: string | null;
}

export interface AgentMessage {
  messageId: string;
  employeeId: string;
  taskId: string | null;
  text: string;
  actionRequest: ActionProposal | null;
}

export type AgentEvent =
  | { type: "session.started"; handle: SessionHandle }
  | { type: "output.delta"; text: string }
  | { type: "output.completed"; text: string }
  | { type: "action.proposed"; action: ActionProposal }
  | { type: "usage.updated"; inputTokens: number | null; outputTokens: number | null; contextTokens: number | null }
  | { type: "session.interrupted"; reason: string }
  | { type: "session.exited"; exitCode: number | null }
  | { type: "adapter.error"; code: string; message: string };

export interface StartSessionInput {
  employeeId: string;
  role: string;
  projectRoot: string;
  scenario: string;
}

export interface ResumeSessionInput extends StartSessionInput {
  previous: SessionHandle;
  handoff: string;
}

export interface UsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  contextTokens: number | null;
  capturedAt: string;
}

export interface SessionCheckpoint {
  employeeId: string;
  handle: SessionHandle;
  activeTaskId: string | null;
  handoff: string;
}

export interface CompanyCheckpoint {
  companyId: string;
  reason: "user_requested" | "last_client_exited" | "shutdown";
  lastEventSequence: number;
  sessions: SessionCheckpoint[];
}

export interface RecoveryDecision {
  employeeId: string;
  mode: "native" | "rebuilt";
}

export interface AgentAdapter {
  detect(): Promise<{ available: boolean; version: string }>;
  capabilities(): Promise<AgentCapabilities>;
  start(input: StartSessionInput): Promise<SessionHandle>;
  send(session: SessionHandle, message: AgentMessage): AsyncIterable<AgentEvent>;
  interrupt(session: SessionHandle): Promise<{ interrupted: boolean }>;
  resume(input: ResumeSessionInput): Promise<SessionHandle>;
  stop(session: SessionHandle): Promise<void>;
  usage(session: SessionHandle): Promise<UsageSnapshot>;
}
