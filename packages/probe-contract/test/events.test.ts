import { describe, expect, it } from "vitest";
import { parseProbeEvent } from "../src/index.js";

describe("parseProbeEvent", () => {
  it("accepts a session event", () => {
    expect(parseProbeEvent('{"type":"session","sessionId":"s-1"}')).toEqual({
      type: "session",
      sessionId: "s-1"
    });
  });

  it("returns an explicit parse error instead of dropping the line", () => {
    expect(parseProbeEvent("not-json")).toEqual({
      type: "parse_error",
      raw: "not-json",
      reason: "invalid_json"
    });
  });

  it("accepts each complete event shape", () => {
    expect(parseProbeEvent('{"type":"ready","pid":42}')).toEqual({ type: "ready", pid: 42 });
    expect(parseProbeEvent('{"type":"output","text":"hello"}')).toEqual({ type: "output", text: "hello" });
    expect(parseProbeEvent('{"type":"usage","inputTokens":4,"outputTokens":2,"cachedInputTokens":1}')).toEqual({
      type: "usage",
      inputTokens: 4,
      outputTokens: 2,
      cachedInputTokens: 1
    });
    expect(parseProbeEvent('{"type":"completed","exitCode":0}')).toEqual({ type: "completed", exitCode: 0 });
    expect(parseProbeEvent('{"type":"interrupted"}')).toEqual({ type: "interrupted" });
  });

  it("preserves unknown or incomplete shapes as parse errors", () => {
    expect(parseProbeEvent('{"type":"session"}')).toEqual({
      type: "parse_error",
      raw: '{"type":"session"}',
      reason: "unknown_shape"
    });
  });
});
