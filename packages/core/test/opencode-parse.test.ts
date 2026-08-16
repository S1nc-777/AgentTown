import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl } from "../src/agents/opencode-parse.js";

function stepStarted(sessionId: string): string {
  return JSON.stringify({
    type: "step_start",
    timestamp: 1786810448512,
    sessionID: sessionId,
    part: {
      id: "prt_start",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "step-start"
    }
  });
}

function textEvent(text: string, sessionId = "ses_1"): string {
  return JSON.stringify({
    type: "text",
    timestamp: 1786810448637,
    sessionID: sessionId,
    part: {
      id: "prt_text",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "text",
      text,
      time: { start: 1, end: 2 }
    }
  });
}

function stepFinished(
  reason: string,
  inputTokens: number,
  outputTokens: number,
  sessionId = "ses_1"
): string {
  return JSON.stringify({
    type: "step_finish",
    timestamp: 1786810448645,
    sessionID: sessionId,
    part: {
      id: "prt_finish",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "step-finish",
      reason,
      cost: 0.0018263,
      tokens: {
        total: inputTokens + outputTokens,
        input: inputTokens,
        output: outputTokens,
        reasoning: 0,
        cache: { read: 0, write: 0 }
      }
    }
  });
}

describe("parseOpenCodeJsonl", () => {
  it("maps step_start with a top-level sessionID to session.started", () => {
    const events = parseOpenCodeJsonl(stepStarted("ses_1"));
    expect(events).toEqual([
      {
        type: "session.started",
        handle: {
          employeeId: "",
          adapter: "opencode",
          internalSessionId: "",
          nativeSessionId: "ses_1"
        }
      }
    ]);
  });

  it("maps a text part to output.completed", () => {
    const events = parseOpenCodeJsonl(textEvent("PONG"));
    expect(events).toEqual([{ type: "output.completed", text: "PONG" }]);
  });

  it("maps step_finish reason stop to usage.updated from part.tokens", () => {
    const events = parseOpenCodeJsonl(stepFinished("stop", 12989, 16));
    expect(events).toEqual([
      {
        type: "usage.updated",
        inputTokens: 12989,
        outputTokens: 16,
        contextTokens: null
      }
    ]);
  });

  it("maps step_finish with a non-stop reason to adapter.error", () => {
    const events = parseOpenCodeJsonl(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        message: "model errored",
        part: { type: "step-finish", reason: "error" }
      })
    );
    expect(events).toEqual([
      {
        type: "adapter.error",
        code: "opencode_error",
        message: "model errored"
      }
    ]);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(parseOpenCodeJsonl("this is not json")).toEqual([]);
    expect(parseOpenCodeJsonl("{")).toEqual([]);
  });

  it("returns an empty array when the line is valid JSON but not an object", () => {
    expect(parseOpenCodeJsonl("42")).toEqual([]);
    expect(parseOpenCodeJsonl("null")).toEqual([]);
  });

  it("returns an empty array for an unrecognized event type", () => {
    expect(parseOpenCodeJsonl(
      JSON.stringify({ type: "something.else", sessionID: "ses_1" })
    )).toEqual([]);
  });

  it("returns an empty array for step_start without a sessionID", () => {
    expect(parseOpenCodeJsonl(JSON.stringify({ type: "step_start" }))).toEqual(
      []
    );
    expect(parseOpenCodeJsonl(
      JSON.stringify({ type: "step_start", sessionID: "" })
    )).toEqual([]);
  });

  it("returns an empty array for text events without part.text", () => {
    expect(
      parseOpenCodeJsonl(
        JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "tool_use" } })
      )
    ).toEqual([]);
    expect(
      parseOpenCodeJsonl(
        JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text" } })
      )
    ).toEqual([]);
  });

  it("returns an empty array for step_finish stop without numeric tokens", () => {
    expect(parseOpenCodeJsonl(
      JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "stop" } })
    )).toEqual([]);
    expect(parseOpenCodeJsonl(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        part: { type: "step-finish", reason: "stop", tokens: { input: "ten", output: 5 } }
      })
    )).toEqual([]);
  });

  it("returns an empty array for step_finish without a string reason", () => {
    expect(parseOpenCodeJsonl(
      JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish" } })
    )).toEqual([]);
  });

  it("returns an empty array for step_finish non-stop without an extractable message", () => {
    expect(parseOpenCodeJsonl(
      JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "error" } })
    )).toEqual([]);
  });
});
