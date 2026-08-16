import type { AgentEvent } from "@agenttown/runtime-contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Extracts the single JSON object from `claude -p --output-format json`
 * stdout. The real CLI prints one JSON object per run, but stderr-style noise
 * (ANSI escapes, warnings) can leak onto stdout, so we try the trimmed text
 * as-is first and fall back to scanning for a balanced-brace JSON object.
 * Returns `undefined` when no JSON object can be extracted.
 */
function extractJsonObject(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to brace scanning for noise-prefixed output.
  }
  let scanStart = 0;
  while (scanStart < trimmed.length) {
    const start = trimmed.indexOf("{", scanStart);
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      scanStart = start + 1;
    }
  }
  return undefined;
}

function failureMessage(value: Record<string, unknown>): string {
  const apiError = value.api_error_status;
  if (isNonEmptyString(apiError)) return `claude api error: ${apiError}`;
  if (isNonEmptyString(value.result)) return value.result;
  return "claude result reported an error";
}

/**
 * Parses one `claude -p --output-format json` result into runtime AgentEvents.
 *
 * Claude is not a JSONL stream: the process prints a single JSON object and
 * exits, so the adapter accumulates stdout and calls this once after the
 * process closes. The mapping mirrors the verified CLI output:
 *
 * - `type === "result"` with a non-empty `session_id` → `session.started`
 *   (the handle is a placeholder; the ClaudeAgentAdapter enriches it with the
 *   live session fields before pushing it onto the event queue)
 * - a non-empty `result` text → `output.completed`
 * - numeric `usage.input_tokens` / `usage.output_tokens` → `usage.updated`
 * - `is_error === true`, a non-empty `api_error_status`, or a `stop_reason`
 *   other than `"end_turn"` → a single `adapter.error` (the error subsumes
 *   the result text so consumers never treat a failed turn as output)
 *
 * Unparseable stdout (no JSON object at all) produces an `adapter.error` so
 * callers observe the failure instead of an empty turn. Unknown or malformed
 * JSON objects produce no events (never throws).
 */
export function parseClaudeResult(text: string): AgentEvent[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const value = extractJsonObject(trimmed);
  if (value === undefined) {
    return [{
      type: "adapter.error",
      code: "claude_error",
      message: "unable to parse claude stdout as JSON"
    }];
  }
  if (!isRecord(value) || value.type !== "result") return [];

  const failed = value.is_error === true
    || isNonEmptyString(value.api_error_status)
    || (typeof value.stop_reason === "string" && value.stop_reason !== "end_turn");

  // A failed result produces only the adapter.error so consumers never mistake
  // an errored turn for a completed one (and #start sees the error first).
  if (failed) {
    return [{
      type: "adapter.error",
      code: "claude_error",
      message: failureMessage(value)
    }];
  }

  const events: AgentEvent[] = [];
  if (isNonEmptyString(value.session_id)) {
    events.push({
      type: "session.started",
      handle: {
        employeeId: "",
        adapter: "claude",
        internalSessionId: "",
        nativeSessionId: value.session_id
      }
    });
  }
  if (typeof value.result === "string" && value.result.length > 0) {
    events.push({ type: "output.completed", text: value.result });
  }
  if (isRecord(value.usage)) {
    const inputTokens = typeof value.usage.input_tokens === "number"
      ? value.usage.input_tokens
      : null;
    const outputTokens = typeof value.usage.output_tokens === "number"
      ? value.usage.output_tokens
      : null;
    if (inputTokens !== null || outputTokens !== null) {
      events.push({
        type: "usage.updated",
        inputTokens,
        outputTokens,
        contextTokens: null
      });
    }
  }
  return events;
}
