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
const SENSITIVE_JSON_KEY_SUFFIXES = new Set([
  "API_KEY",
  "ACCESS_TOKEN",
  "AUTH_TOKEN",
  "REFRESH_TOKEN",
  "ID_TOKEN",
  "BEARER_TOKEN",
  "CLIENT_SECRET",
  "PRIVATE_KEY",
  "PASSWORD",
  "PASSWD",
  "SECRET",
  "AUTHORIZATION",
  "CREDENTIAL",
  "CREDENTIALS",
  "SECRET_ACCESS_KEY",
  "TOKEN"
]);
const PORTABLE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const JSON_STRING_PROPERTY = /"([^"\r\n]+)"(\s*:\s*)"[^"\r\n]*"/gu;

export function redactOutput(output: string): string {
  return output.replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function isSensitiveJsonKey(key: string): boolean {
  const normalizedKey = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
  const sensitive = [...SENSITIVE_JSON_KEY_SUFFIXES].some(
    (suffix) => normalizedKey === suffix || normalizedKey.endsWith(`_${suffix}`)
  );
  return sensitive;
}

function redactJsonValue(key: string, value: unknown): unknown {
  return isSensitiveJsonKey(key) ? "[REDACTED]" : value;
}

function redactMalformedJsonStrings(line: string): string {
  return line.replace(JSON_STRING_PROPERTY, (property, key: string, separator: string) =>
    isSensitiveJsonKey(key) ? `"${key}"${separator}"[REDACTED]"` : property
  );
}

function serializeRedactedJson(value: unknown, space?: number): string {
  return redactOutput(JSON.stringify(value, redactJsonValue, space));
}

export function redactJsonlLine(line: string): string {
  try {
    return serializeRedactedJson(JSON.parse(line));
  } catch {
    return redactOutput(redactMalformedJsonStrings(line));
  }
}

export function redactJsonlOutput(output: string): string {
  return output.split(/(\r?\n)/u).map((part) =>
    /^\r?\n$/u.test(part) ? part : redactJsonlLine(part)
  ).join("");
}

function resolveRunDirectory(rootDir: string, runId: string): string {
  if (
    !PORTABLE_RUN_ID.test(runId)
    || WINDOWS_RESERVED_NAME.test(runId)
    || isAbsolute(runId)
    || win32.isAbsolute(runId)
  ) {
    throw new Error("runId must be a portable 1-64 character path segment");
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
    writeFile(rawLogPath, redactJsonlOutput(input.run.rawOutput), "utf8"),
    writeFile(eventsPath, eventsWithFinalNewline, "utf8"),
    writeFile(reportPath, `${serializeRedactedJson(input.report, 2)}\n`, "utf8")
  ]);

  return { directory, rawLogPath, eventsPath, reportPath };
}
