import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
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
const SENSITIVE_JSON_KEY = /(?:APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATEKEY)/u;

export function redactOutput(output: string): string {
  return output.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function redactJsonValue(key: string, value: unknown): unknown {
  const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toUpperCase();
  return SENSITIVE_JSON_KEY.test(normalizedKey) ? "[REDACTED]" : value;
}

function serializeRedactedJson(value: unknown, space?: number): string {
  return redactOutput(JSON.stringify(value, redactJsonValue, space));
}

function resolveRunDirectory(rootDir: string, runId: string): string {
  if (
    runId.length === 0
    || runId === "."
    || runId === ".."
    || /[\\/]/u.test(runId)
    || isAbsolute(runId)
    || win32.isAbsolute(runId)
  ) {
    throw new Error("runId must be a single safe path segment");
  }

  const root = resolve(rootDir);
  const directory = resolve(root, runId);
  const childPath = relative(root, directory);
  if (childPath.length === 0 || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw new Error("runId must resolve strictly inside rootDir");
  }
  return directory;
}

export async function writeProbeArtifacts(input: ProbeArtifactInput): Promise<ProbeArtifactPaths> {
  const directory = resolveRunDirectory(input.rootDir, input.runId);
  const rawLogPath = join(directory, "raw.log");
  const eventsPath = join(directory, "events.jsonl");
  const reportPath = join(directory, "report.json");
  await mkdir(directory, { recursive: true });

  const events = input.events.map((event) => serializeRedactedJson(event)).join("\n");
  const eventsWithFinalNewline = events.length === 0 ? "" : `${events}\n`;
  await Promise.all([
    writeFile(rawLogPath, redactOutput(input.run.rawOutput), "utf8"),
    writeFile(eventsPath, eventsWithFinalNewline, "utf8"),
    writeFile(reportPath, `${serializeRedactedJson(input.report, 2)}\n`, "utf8")
  ]);

  return { directory, rawLogPath, eventsPath, reportPath };
}
