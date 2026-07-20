import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactOutput, writeProbeArtifacts } from "../src/artifacts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("redactOutput", () => {
  it("redacts common secret assignments", () => {
    expect(redactOutput("OPENAI_API_KEY=secret-value\nhello")).toBe(
      "OPENAI_API_KEY=[REDACTED]\nhello"
    );
  });
});

describe("writeProbeArtifacts", () => {
  it("writes redacted UTF-8 raw, parsed-event, and report evidence", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenttown-artifacts-"));
    temporaryDirectories.push(rootDir);

    const paths = await writeProbeArtifacts({
      rootDir,
      runId: "run-1",
      run: {
        command: ["agent", "probe"],
        startedAt: "2026-07-20T00:00:00.000Z",
        durationMs: 12,
        exitCode: 0,
        rawOutput: "OPENAI_API_KEY=raw-secret\nnot-json\n",
        timedOut: false
      },
      events: [
        { type: "output", text: "TOKEN=event-secret" },
        { type: "parse_error", raw: "not-json", reason: "invalid_json" }
      ],
      report: { launch: true, notes: ["PASSWORD=report-secret"] }
    });

    expect(paths.directory).toBe(join(rootDir, "run-1"));
    const raw = await readFile(paths.rawLogPath, "utf8");
    const events = await readFile(paths.eventsPath, "utf8");
    const report = await readFile(paths.reportPath, "utf8");

    expect(raw).toBe("OPENAI_API_KEY=[REDACTED]\nnot-json\n");
    expect(events).toContain('"text":"TOKEN=[REDACTED]"');
    expect(events).toContain('"raw":"not-json"');
    expect(report).toContain('"PASSWORD=[REDACTED]"');
    expect(`${raw}${events}${report}`).not.toContain("raw-secret");
    expect(`${raw}${events}${report}`).not.toContain("event-secret");
    expect(`${raw}${events}${report}`).not.toContain("report-secret");
  });
});
