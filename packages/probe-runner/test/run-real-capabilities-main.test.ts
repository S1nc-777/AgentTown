import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runRealCapabilitiesCli,
  type RealCapabilitiesMainDependencies
} from "../src/run-real-capabilities-main.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runRealCapabilitiesCli", () => {
  it("atomically writes judged orphan evidence before a bounded explicit exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-capabilities-main-test-"));
    temporaryDirectories.push(root);
    const outputPath = join(root, "capabilities-summary.json");
    let cleanupFinished = false;
    const exitCodes: number[] = [];
    const dependencies: RealCapabilitiesMainDependencies = {
      probe: async (agent) => {
        if (agent === "claude") cleanupFinished = true;
        return {
          agent,
          attempted: agent === "claude",
          interrupt: false,
          parallelThree: false,
          blockers: [agent === "codex" ? "capability_prerequisite_launch_failed" : "interrupt_session_not_observed"],
          orphanPids: []
        };
      },
      exit: (code) => {
        expect(cleanupFinished).toBe(true);
        const persisted = JSON.parse(readFileSync(outputPath, "utf8")) as {
          outcomes: Array<{ orphanPids: number[] }>;
        };
        expect(persisted.outcomes.every(({ orphanPids }) => orphanPids.length === 0)).toBe(true);
        exitCodes.push(code);
      }
    };

    await runRealCapabilitiesCli({ artifactRootDir: root, outputPath, timeoutMs: 100 }, dependencies);

    expect(exitCodes).toEqual([1]);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ outcomes: [{ agent: "codex" }, { agent: "claude" }] });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
