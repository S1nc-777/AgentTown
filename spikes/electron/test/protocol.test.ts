import { describe, expect, it } from "vitest";
import { JsonLineDecoder, parseCoreRequest } from "../src/protocol.js";

describe("JsonLineDecoder", () => {
  it("preserves a message split across chunks", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"type":"hea')).toEqual([]);
    expect(decoder.push('lth"}\n')).toEqual([{ ok: true, value: { type: "health" } }]);
  });

  it("returns every complete message in one chunk", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('{"type":"health"}\n{"type":"shutdown"}\n')).toEqual([
      { ok: true, value: { type: "health" } },
      { ok: true, value: { type: "shutdown" } }
    ]);
  });

  it("reports malformed JSON and continues decoding", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.push('not-json\n{"type":"health"}\n')).toEqual([
      { ok: false, code: "malformed_json" },
      { ok: true, value: { type: "health" } }
    ]);
  });
});

describe("parseCoreRequest", () => {
  it("accepts only the frozen request union", () => {
    expect(parseCoreRequest({ type: "health" })).toEqual({ ok: true, value: { type: "health" } });
    expect(parseCoreRequest({ type: "start_fake", mode: "normal" })).toEqual({
      ok: true,
      value: { type: "start_fake", mode: "normal" }
    });
    expect(parseCoreRequest({ type: "input", text: "hello" })).toEqual({
      ok: true,
      value: { type: "input", text: "hello" }
    });
    expect(parseCoreRequest({ type: "resize", cols: 120, rows: 40 })).toEqual({
      ok: true,
      value: { type: "resize", cols: 120, rows: 40 }
    });
    expect(parseCoreRequest({ type: "shutdown" })).toEqual({ ok: true, value: { type: "shutdown" } });
  });

  it("rejects unknown and invalid requests deterministically", () => {
    expect(parseCoreRequest({ type: "launch_agent" })).toEqual({ ok: false, code: "unknown_request" });
    expect(parseCoreRequest({ type: "resize", cols: 0, rows: 40 })).toEqual({
      ok: false,
      code: "invalid_request"
    });
    expect(parseCoreRequest(null)).toEqual({ ok: false, code: "invalid_request" });
  });
});
