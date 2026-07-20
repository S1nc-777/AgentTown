import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/adapters/codex.js";

const fixturePath = fileURLToPath(new URL("./fixtures/codex-success.jsonl", import.meta.url));

describe("parseCodexLine", () => {
  it("extracts session, output, and token usage", () => {
    const lines = readFileSync(fixturePath, "utf8").trim().split(/\r?\n/u);
    const events = lines.flatMap(parseCodexLine);

    expect(events).toContainEqual({ type: "session", sessionId: "codex-session-1" });
    expect(events).toContainEqual({ type: "output", text: "AGENTTOWN_PROBE_OK" });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 9
    });
  });

  it("preserves invalid JSON as parse-error evidence", () => {
    expect(parseCodexLine("not-json")).toEqual([
      { type: "parse_error", raw: "not-json", reason: "invalid_json" }
    ]);
  });

  it("ignores unknown valid Codex events without calling them parse errors", () => {
    expect(parseCodexLine('{"type":"item.started","item":{"type":"command_execution"}}')).toEqual([]);
  });

  it.each([
    ['{"type":"turn.failed","error":{"message":"authentication required"}}', "authentication required"],
    ['{"type":"error","message":"transport failed"}', "transport failed"]
  ])("normalizes Codex failure text from %s", (line, message) => {
    expect(parseCodexLine(line)).toEqual([{ type: "output", text: message }]);
  });
});
