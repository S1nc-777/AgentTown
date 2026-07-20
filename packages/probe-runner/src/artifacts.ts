import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProbeEvent } from "@agenttown/probe-contract";
import type { RunResult } from "./pty.js";

export interface ProbeArtifactInput {
  rootDir: string;
  runId: string;
  run: RunResult;
  events: ProbeEvent[];
  report: unknown;
}

export interface ProbeArtifactPaths {
  directory: string;
  rawLogPath: string;
  eventsPath: string;
  reportPath: string;
}

const SECRET_ASSIGNMENT = /(\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY)[A-Z0-9_]*\b\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`,;}\]]+)/giu;

export function redactOutput(output: string): string {
  return output.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

export async function writeProbeArtifacts(input: ProbeArtifactInput): Promise<ProbeArtifactPaths> {
  const directory = join(input.rootDir, input.runId);
  const rawLogPath = join(directory, "raw.log");
  const eventsPath = join(directory, "events.jsonl");
  const reportPath = join(directory, "report.json");
  await mkdir(directory, { recursive: true });

  const events = input.events.map((event) => JSON.stringify(event)).join("\n");
  const eventsWithFinalNewline = events.length === 0 ? "" : `${events}\n`;
  await Promise.all([
    writeFile(rawLogPath, redactOutput(input.run.rawOutput), "utf8"),
    writeFile(eventsPath, redactOutput(eventsWithFinalNewline), "utf8"),
    writeFile(reportPath, redactOutput(`${JSON.stringify(input.report, null, 2)}\n`), "utf8")
  ]);

  return { directory, rawLogPath, eventsPath, reportPath };
}
