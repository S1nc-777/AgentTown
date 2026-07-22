import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  probeRemainingAgentCapabilities,
  type RemainingCapabilitiesOutcome
} from "./real-capabilities.js";

export interface RealCapabilitiesMainOptions {
  artifactRootDir: string;
  outputPath: string;
  timeoutMs: number;
}

export interface RealCapabilitiesMainDependencies {
  probe(
    agent: "codex" | "claude",
    options: { artifactRootDir: string; timeoutMs: number }
  ): Promise<RemainingCapabilitiesOutcome>;
  exit(code: number): void;
}

const defaultDependencies: RealCapabilitiesMainDependencies = {
  probe: probeRemainingAgentCapabilities,
  exit: (code) => process.exit(code)
};

async function writeSummaryAtomically(
  outputPath: string,
  outcomes: RemainingCapabilitiesOutcome[]
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ outcomes }, null, 2)}\n`, "utf8");
  try {
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function runRealCapabilitiesMain(
  options: RealCapabilitiesMainOptions,
  dependencies: Pick<RealCapabilitiesMainDependencies, "probe"> = defaultDependencies
): Promise<{ outcomes: RemainingCapabilitiesOutcome[]; exitCode: number }> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }
  const outcomes: RemainingCapabilitiesOutcome[] = [];
  for (const agent of ["codex", "claude"] as const) {
    try {
      outcomes.push(await dependencies.probe(agent, {
        artifactRootDir: options.artifactRootDir,
        timeoutMs: options.timeoutMs
      }));
    } catch (error) {
      outcomes.push({
        agent,
        attempted: true,
        interrupt: false,
        parallelThree: false,
        blockers: [`capability_execution_exception:${error instanceof Error ? error.name : "Unknown"}`],
        orphanPids: []
      });
    }
  }
  await writeSummaryAtomically(options.outputPath, outcomes);
  const exitCode = outcomes.some(({ blockers, orphanPids }) => blockers.length > 0 || orphanPids.length > 0) ? 1 : 0;
  return { outcomes, exitCode };
}

export async function runRealCapabilitiesCli(
  options: RealCapabilitiesMainOptions,
  dependencies: RealCapabilitiesMainDependencies = defaultDependencies
): Promise<void> {
  const { exitCode } = await runRealCapabilitiesMain(options, dependencies);
  dependencies.exit(exitCode);
}
