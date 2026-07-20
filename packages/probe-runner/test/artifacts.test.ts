import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

  it.each(["", ".", "..", "nested/run", "nested\\run"])(
    "rejects unsafe run id %j without writing outside its run directory",
    async (runId) => {
      const boundaryDir = await mkdtemp(join(tmpdir(), "agenttown-artifacts-boundary-"));
      const rootDir = join(boundaryDir, "root");
      await mkdir(rootDir);
      temporaryDirectories.push(boundaryDir);
      const escapedRawLog = resolve(rootDir, runId, "raw.log");

      await expect(writeProbeArtifacts({
        rootDir,
        runId,
        run: {
          command: ["agent"],
          startedAt: "2026-07-20T00:00:00.000Z",
          durationMs: 1,
          exitCode: 0,
          rawOutput: "should-not-be-written",
          timedOut: false
        },
        events: [],
        report: {}
      })).rejects.toThrow(/runId/u);

      if (dirname(escapedRawLog) !== rootDir) {
        await expect(access(escapedRawLog)).rejects.toThrow();
      }
    }
  );

  it("rejects an absolute run id without writing to that location", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenttown-artifacts-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "agenttown-artifacts-outside-"));
    temporaryDirectories.push(rootDir, outsideDir);
    const outsideRawLog = join(outsideDir, "raw.log");

    await expect(writeProbeArtifacts({
      rootDir,
      runId: outsideDir,
      run: {
        command: ["agent"],
        startedAt: "2026-07-20T00:00:00.000Z",
        durationMs: 1,
        exitCode: 0,
        rawOutput: "should-not-be-written",
        timedOut: false
      },
      events: [],
      report: {}
    })).rejects.toThrow(/runId/u);

    await expect(access(outsideRawLog)).rejects.toThrow();
  });

  it("redacts sensitive JSON keys recursively without mutating inputs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agenttown-artifacts-"));
    temporaryDirectories.push(rootDir);
    const events = [{
      type: "output",
      text: "TOKEN=embedded-event-secret",
      metadata: {
        OPENAI_API_KEY: "natural-event-secret",
        nested: [{ access_token: "array-event-secret" }]
      }
    }];
    const report = {
      credentials: [{ password: "report-password" }, { privateKey: "report-private-key" }],
      note: "CLIENT_SECRET=embedded-report-secret"
    };
    const originalEvents = structuredClone(events);
    const originalReport = structuredClone(report);

    const paths = await writeProbeArtifacts({
      rootDir,
      runId: "nested-secrets",
      run: {
        command: ["agent"],
        startedAt: "2026-07-20T00:00:00.000Z",
        durationMs: 1,
        exitCode: 0,
        rawOutput: "",
        timedOut: false
      },
      events: events as never,
      report
    });

    const persisted = `${await readFile(paths.eventsPath, "utf8")}${await readFile(paths.reportPath, "utf8")}`;
    expect(persisted).not.toContain("natural-event-secret");
    expect(persisted).not.toContain("array-event-secret");
    expect(persisted).not.toContain("report-password");
    expect(persisted).not.toContain("report-private-key");
    expect(persisted).not.toContain("embedded-event-secret");
    expect(persisted).not.toContain("embedded-report-secret");
    expect(persisted.match(/\[REDACTED\]/gu)?.length).toBe(6);
    expect(events).toEqual(originalEvents);
    expect(report).toEqual(originalReport);
  });
});
