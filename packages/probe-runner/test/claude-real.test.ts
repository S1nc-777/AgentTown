import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeClaude } from "../src/adapters/claude.js";

const artifactRootDir = fileURLToPath(new URL("../../../artifacts/feasibility", import.meta.url));
const knownBlockers = new Set([
  "blocker:authentication",
  "blocker:executable_not_found",
  "blocker:launch_failed",
  "blocker:parse_failure",
  "blocker:probe_response_missing",
  "blocker:resume_failed",
  "blocker:session_id_missing",
  "blocker:temporary_repo_init_failed",
  "blocker:timeout",
  "blocker:token_usage_missing"
]);

describe.runIf(process.env.AGENTTOWN_REAL_CLAUDE === "1")("Claude real probe", () => {
  it("records either verified capabilities or one explicit evidenced blocker", async () => {
    const report = await probeClaude({
      timeoutMs: 180_000,
      artifactRootDir,
      runId: "claude-real",
      ...(process.env.AGENTTOWN_CLAUDE_EXECUTABLE === undefined
        ? {}
        : { executable: process.env.AGENTTOWN_CLAUDE_EXECUTABLE })
    });
    const blockers = report.notes.filter((note) => note.startsWith("blocker:"));

    expect(report.agent).toBe("claude");
    expect(report.command).toContain("--permission-mode plan");
    expect(report.command).not.toContain("--dangerously-skip-permissions");
    expect(report.rawLogPath).toMatch(/raw\.log$/u);
    if (blockers.length > 0) {
      expect(blockers).toHaveLength(1);
      expect(blockers.every((blocker) => knownBlockers.has(blocker))).toBe(true);
      return;
    }

    expect(report.launch).toBe(true);
    expect(report.streamOutput).toBe(true);
    expect(report.sessionId).toBe(true);
    expect(report.resume).toBe(true);
    expect(report.tokenUsage).toBe(true);
    expect(report.nonInteractive).toBe(true);
  }, 240_000);
});
