import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaudeLine } from "../src/adapters/claude.js";

const fixturePath = fileURLToPath(new URL("./fixtures/claude-success.jsonl", import.meta.url));

describe("parseClaudeLine", () => {
  it("extracts init session, assistant text, and result usage", () => {
    const lines = readFileSync(fixturePath, "utf8").trim().split(/\r?\n/u);
    const events = lines.flatMap(parseClaudeLine);

    expect(events).toContainEqual({ type: "session", sessionId: "claude-session-1" });
    expect(events).toContainEqual({ type: "output", text: "AGENTTOWN_PROBE_OK" });
    expect(events).toContainEqual({ type: "usage", inputTokens: 90, outputTokens: 8 });
  });

  it("preserves invalid JSON as parse-error evidence", () => {
    expect(parseClaudeLine("not-json")).toEqual([
      { type: "parse_error", raw: "not-json", reason: "invalid_json" }
    ]);
  });

  it("ignores unknown valid Claude events without calling them parse errors", () => {
    expect(parseClaudeLine('{"type":"stream_event","event":{"type":"content_block_start"}}')).toEqual([]);
  });

  it.each([
    ['{"type":"error","error":{"message":"transport failed"}}', "transport failed"],
    ['{"type":"result","subtype":"error_during_execution","is_error":true,"result":"authentication required"}', "authentication required"]
  ])("normalizes Claude failure text from %s", (line, message) => {
    expect(parseClaudeLine(line)).toEqual([{ type: "output", text: message }]);
  });
});
