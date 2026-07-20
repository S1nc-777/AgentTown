export type ProbeEvent =
  | { type: "ready"; pid: number }
  | { type: "session"; sessionId: string }
  | { type: "output"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "completed"; exitCode: number }
  | { type: "interrupted" }
  | { type: "parse_error"; raw: string; reason: "invalid_json" | "unknown_shape" };

export interface CapabilityReport {
  agent: string;
  version: string;
  command: string;
  durationMs: number;
  rawLogPath: string;
  notes: string[];
  launch: boolean;
  streamOutput: boolean;
  sessionId: boolean;
  resume: boolean;
  interrupt: boolean;
  tokenUsage: boolean;
  nonInteractive: boolean;
  interactivePty: boolean;
  parallelThree: boolean;
}

export function parseProbeEvent(line: string): ProbeEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { type: "parse_error", raw: line, reason: "invalid_json" };
  }
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return { type: "parse_error", raw: line, reason: "unknown_shape" };
  }
  const event = value as Record<string, unknown>;
  if (event.type === "ready" && typeof event.pid === "number") {
    return { type: "ready", pid: event.pid };
  }
  if (event.type === "session" && typeof event.sessionId === "string") {
    return { type: "session", sessionId: event.sessionId };
  }
  if (event.type === "output" && typeof event.text === "string") {
    return { type: "output", text: event.text };
  }
  if (event.type === "usage" && typeof event.inputTokens === "number" && typeof event.outputTokens === "number") {
    return typeof event.cachedInputTokens === "number"
      ? { type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens }
      : { type: "usage", inputTokens: event.inputTokens, outputTokens: event.outputTokens };
  }
  if (event.type === "completed" && typeof event.exitCode === "number") {
    return { type: "completed", exitCode: event.exitCode };
  }
  if (event.type === "interrupted") return { type: "interrupted" };
  return { type: "parse_error", raw: line, reason: "unknown_shape" };
}
