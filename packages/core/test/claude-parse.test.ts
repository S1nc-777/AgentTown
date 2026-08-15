import { describe, expect, it } from "vitest";
import { parseClaudeResult } from "../src/agents/claude-parse.js";

function resultJson(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    is_error: false,
    type: "result",
    stop_reason: "end_turn",
    session_id: "session-1",
    result: "PONG",
    usage: { input_tokens: 10, output_tokens: 5 }
  };
  return JSON.stringify({ ...base, ...overrides });
}

describe("parseClaudeResult", () => {
  it("maps a result object to session.started, output.completed and usage.updated", () => {
    expect(parseClaudeResult(resultJson())).toEqual([
      {
        type: "session.started",
        handle: {
          employeeId: "",
          adapter: "claude",
          internalSessionId: "",
          nativeSessionId: "session-1"
        }
      },
      { type: "output.completed", text: "PONG" },
      {
        type: "usage.updated",
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      }
    ]);
  });

  it("omits session.started when the result has no session_id", () => {
    const events = parseClaudeResult(resultJson({ session_id: null }));
    expect(events.map((event) => event.type)).not.toContain("session.started");
  });

  it("omits output.completed when the result text is absent", () => {
    const events = parseClaudeResult(resultJson({ result: "" }));
    expect(events.map((event) => event.type)).not.toContain("output.completed");
  });

  it("omits usage.updated when usage tokens are missing", () => {
    const events = parseClaudeResult(resultJson({ usage: undefined }));
    expect(events.map((event) => event.type)).not.toContain("usage.updated");
  });

  it("parses JSON prefixed with ANSI noise", () => {
    const events = parseClaudeResult(
      "\u001b[31m[claude-code:unrecognized_model]\u001b[0m " + resultJson()
    );
    expect(events).toEqual([
      {
        type: "session.started",
        handle: {
          employeeId: "",
          adapter: "claude",
          internalSessionId: "",
          nativeSessionId: "session-1"
        }
      },
      { type: "output.completed", text: "PONG" },
      {
        type: "usage.updated",
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      }
    ]);
  });

  it("maps is_error to a single adapter.error using the api error status", () => {
    const events = parseClaudeResult(resultJson({
      is_error: true,
      stop_reason: "error",
      api_error_status: "429 rate limited",
      result: "rate limited"
    }));
    expect(events).toEqual([
      {
        type: "adapter.error",
        code: "claude_error",
        message: "claude api error: 429 rate limited"
      }
    ]);
  });

  it("maps an abnormal stop_reason to a single adapter.error", () => {
    const events = parseClaudeResult(resultJson({
      stop_reason: "max_tokens",
      result: "partial reply"
    }));
    expect(events).toEqual([
      {
        type: "adapter.error",
        code: "claude_error",
        message: "partial reply"
      }
    ]);
  });

  it("returns an adapter.error for unparseable stdout", () => {
    expect(parseClaudeResult("total garbage")).toEqual([
      {
        type: "adapter.error",
        code: "claude_error",
        message: expect.stringMatching(/unable to parse/i)
      }
    ]);
  });

  it("returns no events for empty or whitespace-only stdout", () => {
    expect(parseClaudeResult("")).toEqual([]);
    expect(parseClaudeResult("   \n  ")).toEqual([]);
  });

  it("returns no events for parseable JSON that is not a result object", () => {
    expect(parseClaudeResult("42")).toEqual([]);
    expect(parseClaudeResult("null")).toEqual([]);
    expect(parseClaudeResult(JSON.stringify({ type: "something.else" }))).toEqual(
      []
    );
  });
});
