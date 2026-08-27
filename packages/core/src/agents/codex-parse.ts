import {
  actionTypes,
  type ActionProposal,
  type ActionType,
  type AgentEvent
} from "@agenttown/runtime-contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
 * Parses one line of `codex exec --json` output into runtime AgentEvents.
 *
 * Equivalent port of `probe-runner/src/adapters/codex.ts`'s `parseCodexLine`,
 * mapping the probe event shapes onto `@agenttown/runtime-contract`'s
 * `AgentEvent`. Unknown or malformed lines produce no events (never throws).
 *
 * Session handles are placeholders: the CodexAgentAdapter (Task 4) fills
 * `employeeId` / `internalSessionId` once it knows the session it owns.
 */
export function parseCodexJsonl(line: string): AgentEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return [];
  }

  if (value.type === "thread.started") {
    if (typeof value.thread_id !== "string") return [];
    return [
      {
        type: "session.started",
        handle: {
          employeeId: "",
          adapter: "codex",
          internalSessionId: "",
          nativeSessionId: value.thread_id
        }
      }
    ];
  }

  if (value.type === "item.completed") {
    if (
      !isRecord(value.item)
      || value.item.type !== "agent_message"
      || typeof value.item.text !== "string"
    ) {
      return [];
    }
    return [{ type: "output.completed", text: value.item.text }];
  }

  if (value.type === "turn.completed") {
    if (
      !isRecord(value.usage)
      || typeof value.usage.input_tokens !== "number"
      || typeof value.usage.output_tokens !== "number"
    ) {
      return [];
    }
    return [
      {
        type: "usage.updated",
        inputTokens: value.usage.input_tokens,
        outputTokens: value.usage.output_tokens,
        contextTokens: null
      }
    ];
  }

  if (value.type === "turn.failed" || value.type === "error") {
    const message = failureMessage(value);
    if (message === undefined) return [];
    return [{ type: "adapter.error", code: "codex_error", message }];
  }

  return [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function extractJsonPayload(text: string): string | null {
  const fence = /```json\s*([\s\S]*?)```/u.exec(text);
  if (fence !== null && fence[1] !== undefined) {
    // FORMAT_INSTRUCTION embeds the payload as `ACTION: { ... }` on the
    // fence's first line; strip that prefix (case-insensitively, after any
    // leading whitespace) so the remainder is pure JSON. Pure-JSON fences
    // are returned unchanged.
    return fence[1].trim().replace(/^action:\s*/iu, "");
  }
  // The capture group already excludes the `ACTION:` prefix; no stripping
  // needed on this path.
  const actionLine = /^ACTION:\s*(\{.*)$/mu.exec(text);
  if (actionLine !== null && actionLine[1] !== undefined) {
    return actionLine[1].trim();
  }
  return null;
}

/**
 * Extracts an `ActionProposal` from Codex reply text: a ```json ... ```
 * fenced block first, falling back to a line starting with `ACTION:` followed
 * by a JSON object. Every `ActionProposal` field is validated; any missing or
 * mismatched field returns null.
 */
export function extractStructuredAction(text: string): ActionProposal | null {
  const rawPayload = extractJsonPayload(text);
  if (rawPayload === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;

  if (value.schemaVersion !== 1) return null;
  if (!isNonEmptyString(value.actionId)) return null;
  if (
    typeof value.type !== "string"
    || !actionTypes.includes(value.type as ActionType)
  ) {
    return null;
  }
  if (!isNonEmptyString(value.actorEmployeeId)) return null;
  if (typeof value.taskId !== "string" && value.taskId !== null) return null;
  if (!isPlainObject(value.payload)) return null;
  if (!isNonEmptyString(value.reason)) return null;
  if (
    typeof value.causationEventId !== "string"
    && value.causationEventId !== null
    && value.causationEventId !== undefined
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    actionId: value.actionId,
    type: value.type as ActionType,
    actorEmployeeId: value.actorEmployeeId,
    taskId: value.taskId,
    payload: value.payload,
    reason: value.reason,
    causationEventId: typeof value.causationEventId === "string"
      ? value.causationEventId
      : null
  };
}
