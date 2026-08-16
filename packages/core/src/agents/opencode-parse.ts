import type { AgentEvent } from "@agenttown/runtime-contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failureMessage(value: Record<string, unknown>): string | undefined {
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return undefined;
}

/**
 * Parses one line of `opencode run --format json` output into runtime
 * AgentEvents. OpenCode streams one JSON object per line on stdout: a
 * `step_start` event carrying the top-level `sessionID` opens the session, a
 * `text` event carries a model output fragment, and a `step_finish` event
 * reports the turn's token usage or failure. Unknown or malformed lines
 * produce no events (never throws).
 *
 * Session handles are placeholders: the OpenCodeAgentAdapter (Task 5c) fills
 * `employeeId` / `internalSessionId` once it knows the session it owns.
 */
export function parseOpenCodeJsonl(line: string): AgentEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return [];
  }

  if (value.type === "step_start") {
    // The sessionID sits at the top level of every event; the first
    // step_start of a fresh run carries it before any reasoning begins.
    if (!isNonEmptyString(value.sessionID)) return [];
    return [
      {
        type: "session.started",
        handle: {
          employeeId: "",
          adapter: "opencode",
          internalSessionId: "",
          nativeSessionId: value.sessionID
        }
      }
    ];
  }

  if (value.type === "text") {
    if (
      !isRecord(value.part)
      || value.part.type !== "text"
      || typeof value.part.text !== "string"
    ) {
      return [];
    }
    return [{ type: "output.completed", text: value.part.text }];
  }

  if (value.type === "step_finish") {
    if (!isRecord(value.part) || typeof value.part.reason !== "string") {
      return [];
    }
    if (value.part.reason === "stop") {
      if (
        !isRecord(value.part.tokens)
        || typeof value.part.tokens.input !== "number"
        || typeof value.part.tokens.output !== "number"
      ) {
        return [];
      }
      return [
        {
          type: "usage.updated",
          inputTokens: value.part.tokens.input,
          outputTokens: value.part.tokens.output,
          contextTokens: null
        }
      ];
    }
    const message = failureMessage(value);
    if (message === undefined) return [];
    return [{ type: "adapter.error", code: "opencode_error", message }];
  }

  return [];
}
