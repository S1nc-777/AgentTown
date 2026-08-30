import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, lstat, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  CompanyDefinition,
  ValidationCommand,
  ValidationCommandGrant,
  ValidationRunRecord
} from "@agenttown/runtime-contract";
import type { NewEvent } from "../storage/core-store.js";
import { CoreStore } from "../storage/core-store.js";

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PROC_STAT_BYTES = 64 * 1024;

export interface ValidationScope {
  runId: string;
  taskId: string | null;
  integrationAttemptId: string | null;
  workspaceId: string;
  workspaceRoot: string;
}

export interface ValidationRunnerOptions {
  store: CoreStore;
  companyId: string;
  company: CompanyDefinition;
  actorId?: string;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessIdentity {
  pid: number;
  started: string;
}

interface ProcessTreeController {
  snapshot(rootPid: number): Promise<ProcessIdentity[]>;
  query(identity: ProcessIdentity): Promise<"same" | "absent" | "reused" | "query_error">;
  terminate(
    child: ChildProcess,
    members: readonly ProcessIdentity[],
    deadlineAt: number
  ): Promise<void>;
}

interface ValidationRunnerDependencies {
  beforeSpawn?: () => Promise<void>;
  beforeEvidenceOpen?: () => Promise<void>;
  beforeEvidenceRename?: () => Promise<void>;
  processTree?: ProcessTreeController;
}

const injectedDependencies = new WeakMap<ValidationRunner, ValidationRunnerDependencies>();

export function createInjectedValidationRunner(
  options: ValidationRunnerOptions,
  dependencies: ValidationRunnerDependencies
): ValidationRunner {
  const runner = new ValidationRunner(options);
  injectedDependencies.set(runner, dependencies);
  return runner;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
}

function assertCommand(command: ValidationCommand): void {
  if (command.id.trim().length === 0 || command.executable.trim().length === 0) {
    throw new TypeError("validation command id and executable are required");
  }
  if (command.args.some((argument) => argument.length === 0)) {
    throw new TypeError("validation command args cannot contain empty values");
  }
  if (!Number.isSafeInteger(command.timeoutSeconds)
    || command.timeoutSeconds < 1 || command.timeoutSeconds > 3600) {
    throw new TypeError("validation command timeoutSeconds must be between 1 and 3600");
  }
}

function isSensitiveKey(value: string): boolean {
  return /(?:token|secret|password|api[-_]?key|authorization)/iu.test(value);
}

function assertGrantContainsNoObviousSecret(command: ValidationCommand): void {
  const fields = [command.executable, command.cwd, ...command.args];
  const assignment = /(?:^|[^A-Za-z0-9_])(?:--?)?[A-Za-z0-9_-]*(?:token|secret|password|api[-_]?key)[A-Za-z0-9_-]*\s*(?:=|:)\s*\S+/iu;
  const bearer = /\b(?:authorization\s*[:=]?\s*)?bearer\s+\S+/iu;
  if (fields.some((value) => assignment.test(value) || bearer.test(value))) {
    throw new TypeError("suggested validation command contains an obvious sensitive literal");
  }
  for (let index = 0; index + 1 < command.args.length; index += 1) {
    const flag = command.args[index]!;
    if (/^--?[A-Za-z0-9_-]+$/u.test(flag)
      && isSensitiveKey(flag.replace(/^--?/u, ""))
      && command.args[index + 1]!.length > 0) {
      throw new TypeError("suggested validation command contains an obvious sensitive literal");
    }
  }
}

function sameCommand(left: ValidationCommand, right: ValidationCommand): boolean {
  return left.id === right.id
    && left.executable === right.executable
    && left.cwd === right.cwd
    && left.timeoutSeconds === right.timeoutSeconds
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index]);
}

function fingerprint(command: ValidationCommand, workspaceId: string): string {
  return createHash("sha256").update(JSON.stringify({
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    timeoutSeconds: command.timeoutSeconds,
    workspaceId
  })).digest("hex");
}

function truncateUtf8(value: Buffer, maxBytes: number): Buffer {
  if (value.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (value[end]! & 0xc0) === 0x80) end -= 1;
  return value.subarray(0, end);
}

function isLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function redact(value: string, secretValues: readonly string[]): string {
  let result = value;
  for (const secret of secretValues) {
    if (secret.length > 0) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result
    .replace(/\b(Bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_]*)\s*=\s*[^\s"']+/giu, "$1=[REDACTED]");
}

interface RedactionRange {
  start: number;
  end: number;
  replacement: string;
}

function redactionRanges(value: string, secretValues: readonly string[]): RedactionRange[] {
  const candidates: RedactionRange[] = [];
  for (const secret of secretValues) {
    if (secret.length === 0) continue;
    let start = 0;
    while ((start = value.indexOf(secret, start)) >= 0) {
      candidates.push({ start, end: start + secret.length, replacement: "[REDACTED]" });
      start += secret.length;
    }
  }
  for (const match of value.matchAll(/\bBearer\s+[^\s"']+/giu)) {
    const prefix = /^Bearer\s+/iu.exec(match[0])?.[0] ?? "Bearer ";
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: `${prefix}[REDACTED]`
    });
  }
  for (const match of value.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_]*\s*=\s*[^\s"']+/giu
  )) {
    const equals = match[0].indexOf("=");
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: `${match[0].slice(0, equals)}=[REDACTED]`
    });
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const selected: RedactionRange[] = [];
  for (const candidate of candidates) {
    const previous = selected.at(-1);
    if (previous !== undefined && candidate.start < previous.end) continue;
    selected.push(candidate);
  }
  return selected;
}

function redactChunkSequence(
  chunks: ReadonlyArray<{ sequence: number; stream: "stdout" | "stderr"; value: string }>,
  secretValues: readonly string[]
): Map<number, string> {
  const result = new Map<number, string>();
  for (const stream of ["stdout", "stderr"] as const) {
    const streamChunks = chunks.filter((chunk) => chunk.stream === stream);
    const combined = streamChunks.map(({ value }) => value).join("");
    const ranges = redactionRanges(combined, secretValues);
    let streamOffset = 0;
    let coveredUntil = 0;
    let rangeIndex = 0;
    for (const chunk of streamChunks) {
      const chunkStart = streamOffset;
      const chunkEnd = chunkStart + chunk.value.length;
      let cursor = Math.max(chunkStart, coveredUntil);
      let output = "";
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= chunkStart) {
        rangeIndex += 1;
      }
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.start < chunkEnd) {
        const range = ranges[rangeIndex]!;
        if (range.start >= cursor) {
          output += combined.slice(cursor, range.start);
          output += range.replacement;
        }
        coveredUntil = Math.max(coveredUntil, range.end);
        cursor = Math.max(cursor, range.end);
        rangeIndex += 1;
      }
      if (cursor < chunkEnd) output += combined.slice(cursor, chunkEnd);
      result.set(chunk.sequence, output);
      streamOffset = chunkEnd;
    }
  }
  return result;
}

function redactedCommand(command: ValidationCommand, secretValues: readonly string[]): ValidationCommand {
  return {
    ...command,
    executable: redact(command.executable, secretValues),
    args: command.args.map((argument) => redact(argument, secretValues)),
    cwd: redact(command.cwd, secretValues)
  };
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL"
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (!allowed.has(normalized)) continue;
    if (/^AGENTTOWN_(?:.*_)?(?:SECRET|TOKEN|PASSWORD|API_KEY|KEY)$/u.test(normalized)) continue;
    environment[key] = value;
  }
  return environment;
}

async function assertSafeDirectory(root: string, target: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error("cwd outside workspace");
  }
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("workspace root contains a symbolic link or reparse point");
  }
  const rootRealPath = await realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedTarget).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory()) throw new Error("cwd contains a non-directory component");
    if (metadata.isSymbolicLink()) {
      throw new Error("cwd contains a symbolic link or reparse point");
    }
    if (!isWithin(rootRealPath, await realpath(current))) {
      throw new Error("cwd contains a reparse escape");
    }
  }
  return resolvedTarget;
}

async function inspectSafeDirectory(root: string, target: string): Promise<DirectoryIdentity> {
  const path = await assertSafeDirectory(root, target);
  const metadata = await stat(path);
  return {
    path,
    realPath: await realpath(path),
    device: metadata.dev,
    inode: metadata.ino
  };
}

async function assertSameDirectory(
  expected: DirectoryIdentity,
  actual: DirectoryIdentity
): Promise<void> {
  if (pathKey(expected.realPath) !== pathKey(actual.realPath)
    || expected.device !== actual.device || expected.inode !== actual.inode) {
    throw new Error("directory identity changed during validation setup");
  }
}

async function makeSafeDirectory(root: string, target: string): Promise<DirectoryIdentity> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) throw new Error("validation log path escaped project root");
  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedTarget).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    await mkdir(current).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("validation log path contains a symbolic link or reparse point");
    }
  }
  return await inspectSafeDirectory(resolvedRoot, resolvedTarget);
}

async function waitForCloseUntil(
  closed: Promise<ProcessExit>,
  label: string,
  deadlineAt: number
): Promise<ProcessExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded cleanup deadline`)), Math.max(0, deadlineAt - Date.now()));
    })
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  label: string,
  deadlineAt: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded cleanup deadline`)),
        Math.max(0, deadlineAt - Date.now())
      );
    })
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function captureCommand(
  executable: string,
  args: string[],
  deadlineAt: number
): Promise<string> {
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => { stdout += value; });
  child.stderr.on("data", (value: string) => { stderr += value; });
  let result: ProcessExit;
  try {
    result = await waitForCloseUntil(new Promise<ProcessExit>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    }), "process identity query", deadlineAt);
  } finally {
    if (isLive(child)) child.kill("SIGKILL");
  }
  if (result.code !== 0) throw new Error(`process identity query failed: ${stderr}`);
  return stdout;
}

async function snapshotWindows(deadlineAt: number): Promise<Array<ProcessIdentity & { parentPid: number }>> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=Get-CimInstance Win32_Process | ForEach-Object {",
    "  [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().Ticks.ToString()}",
    "}",
    "ConvertTo-Json -Compress -InputObject @($rows)"
  ].join(";");
  const output = await captureCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    deadlineAt
  );
  return JSON.parse(output) as Array<ProcessIdentity & { parentPid: number }>;
}

function posixRelationships(output: string): Array<{ pid: number; parentPid: number }> {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    return match === null ? [] : [{
      pid: Number(match[1]),
      parentPid: Number(match[2])
    }];
  });
}

function treeProcessIds(
  rows: ReadonlyArray<{ pid: number; parentPid: number }>,
  rootPid: number
): Set<number> {
  const selected = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.parentPid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return selected;
}

export function parseLinuxProcStatStarttime(value: string): string {
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("invalid Linux process stat");
  const prefix = value.slice(0, close + 1);
  if (!/^\d+\s+\(/u.test(prefix)) throw new Error("invalid Linux process stat");
  const fields = value.slice(close + 1).trim().split(/\s+/u);
  const starttime = fields[19];
  if (starttime === undefined || !/^\d+$/u.test(starttime)) {
    throw new Error("invalid Linux process stat starttime");
  }
  return starttime;
}

async function readLinuxProcStatStarttime(pid: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(`/proc/${String(pid)}/stat`, "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const buffer = Buffer.allocUnsafe(MAX_PROC_STAT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PROC_STAT_BYTES) throw new Error("Linux process stat exceeded size limit");
    return parseLinuxProcStatStarttime(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

interface LinuxProcessTreeDependencies {
  snapshotRelationships(
    rootPid: number,
    deadlineAt: number
  ): Promise<Array<{ pid: number; parentPid: number }>>;
  readStarttime(pid: number): Promise<string | null>;
  terminate?(
    child: ChildProcess,
    members: readonly ProcessIdentity[],
    deadlineAt: number
  ): Promise<void>;
}

export function createInjectedLinuxProcessTreeController(
  dependencies: LinuxProcessTreeDependencies
): ProcessTreeController {
  return {
    async snapshot(rootPid) {
      const deadlineAt = Date.now() + 5_000;
      const rows = await dependencies.snapshotRelationships(rootPid, deadlineAt);
      const selected = treeProcessIds(rows, rootPid);
      const members: ProcessIdentity[] = [];
      for (const pid of selected) {
        const started = await beforeDeadline(
          dependencies.readStarttime(pid),
          "Linux process identity read",
          deadlineAt
        );
        if (started !== null) members.push({ pid, started });
      }
      return members;
    },
    async query(identity) {
      try {
        const current = await beforeDeadline(
          dependencies.readStarttime(identity.pid),
          "Linux process identity read",
          Date.now() + 5_000
        );
        if (current === null) return "absent";
        return current === identity.started ? "same" : "reused";
      } catch {
        return "query_error";
      }
    },
    async terminate(child, members, deadlineAt) {
      if (dependencies.terminate !== undefined) {
        await dependencies.terminate(child, members, deadlineAt);
        return;
      }
      const closed = new Promise<ProcessExit>((resolvePromise) => {
        if (!isLive(child)) {
          resolvePromise({ code: child.exitCode, signal: child.signalCode });
        } else {
          child.once("close", (code, signal) => resolvePromise({ code, signal }));
        }
      });
      await terminateProcessTree(child, closed, deadlineAt);
    }
  };
}

function treeMembers(
  rows: ReadonlyArray<ProcessIdentity & { parentPid: number }>,
  rootPid: number
): ProcessIdentity[] {
  const selected = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.parentPid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(({ pid }) => selected.has(pid)).map(({ pid, started }) => ({ pid, started }));
}

const linuxProcessTree = createInjectedLinuxProcessTreeController({
  async snapshotRelationships(_rootPid, deadlineAt) {
    const output = await captureCommand("ps", ["-eo", "pid=,ppid="], deadlineAt);
    return posixRelationships(output);
  },
  readStarttime: readLinuxProcStatStarttime
});

const defaultProcessTree: ProcessTreeController = {
  async snapshot(rootPid) {
    const deadlineAt = Date.now() + 5_000;
    if (process.platform === "win32") {
      return treeMembers(await snapshotWindows(deadlineAt), rootPid);
    }
    if (process.platform === "linux") return await linuxProcessTree.snapshot(rootPid);
    throw new Error("process identity cannot be verified on this POSIX platform");
  },
  async query(identity) {
    try {
      if (process.platform === "win32") {
        const current = (await snapshotWindows(Date.now() + 5_000))
          .find(({ pid }) => pid === identity.pid);
        if (current === undefined) return "absent";
        return current.started === identity.started ? "same" : "reused";
      }
      if (process.platform === "linux") return await linuxProcessTree.query(identity);
      return "query_error";
    } catch {
      return "query_error";
    }
  },
  async terminate(child, _members, deadlineAt) {
    const closed = new Promise<ProcessExit>((resolvePromise) => {
      if (!isLive(child)) {
        resolvePromise({ code: child.exitCode, signal: child.signalCode });
      } else {
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      }
    });
    await terminateProcessTree(child, closed, deadlineAt);
  }
};

async function terminateVerifiedProcessTree(
  controller: ProcessTreeController,
  child: ChildProcess,
  closed: Promise<ProcessExit>,
  deadlineAt: number
): Promise<void> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
    throw new Error("live validation process has no valid PID");
  }
  const members = await beforeDeadline(
    controller.snapshot(pid as number),
    "process tree snapshot",
    deadlineAt
  );
  const root = members.find((member) => member.pid === pid);
  if (root === undefined) {
    await waitForCloseUntil(closed, "validation process identity", deadlineAt);
    if (!isLive(child)) return;
    throw new Error("validation process identity could not be verified before cleanup: missing");
  }
  const rootStatus = await beforeDeadline(
    controller.query(root),
    "process identity query",
    deadlineAt
  );
  if (rootStatus !== "same") {
    throw new Error(`validation process identity could not be verified before cleanup: ${rootStatus}`);
  }
  await beforeDeadline(
    controller.terminate(child, members, deadlineAt),
    "process tree termination",
    deadlineAt
  );
  await waitForCloseUntil(closed, "validation process tree", deadlineAt);
  const finalStatuses = await beforeDeadline(
    Promise.all(members.map(async (member) => await controller.query(member))),
    "process identity verification",
    deadlineAt
  );
  for (const status of finalStatuses) {
    if (status !== "absent") {
      throw new Error("validation process tree cleanup could not be verified");
    }
  }
}

async function terminateProcessTree(
  child: ChildProcess,
  closed: Promise<ProcessExit>,
  deadlineAt: number
): Promise<void> {
  if (!isLive(child)) return;
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) throw new Error("live validation process has no valid PID");
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    taskkill.stdout?.resume();
    taskkill.stderr?.resume();
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (isLive(taskkill)) taskkill.kill("SIGKILL");
        reject(new Error("taskkill exceeded cleanup deadline"));
      }, Math.max(0, deadlineAt - Date.now()));
      taskkill.once("error", (error) => { clearTimeout(timer); reject(error); });
      taskkill.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 && isLive(child)) reject(new Error(`taskkill failed with code ${String(code)}`));
        else resolvePromise();
      });
    });
  } else {
    try {
      process.kill(-(pid as number), "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (isLive(child)) await waitForCloseUntil(closed, "validation process tree", deadlineAt);
  if (isLive(child)) throw new Error("validation process tree remains live after cleanup");
}

export class ValidationRunner {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #actorId: string;
  readonly #active = new Set<{
    abort(deadlineAt: number): Promise<void>;
    settled: Promise<void>;
  }>();
  #acceptingRuns = true;

  constructor(options: ValidationRunnerOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#actorId = options.actorId ?? "core";
  }

  async abortActive(deadlineAt: number): Promise<void> {
    this.#acceptingRuns = false;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) {
      throw new Error("validation abort deadline has expired");
    }
    const active = [...this.#active];
    await Promise.all(active.map((entry) => entry.abort(deadlineAt)));
    await Promise.all(active.map((entry) => beforeDeadline(
      entry.settled,
      "active validation settlement",
      deadlineAt
    )));
  }

  /**
   * Re-opens validation dispatch after a failed pause attempt: abortActive
   * fenced #acceptingRuns and the fence must not persist once the company
   * is running again, or submissions die with "validation dispatch is
   * fenced" mid-integration.
   */
  resumeActive(): void {
    this.#acceptingRuns = true;
  }

  async requestGrant(command: ValidationCommand, scope: ValidationScope): Promise<ValidationCommandGrant> {
    assertCommand(command);
    assertGrantContainsNoObviousSecret(command);
    await this.#resolveScope(command, scope);
    if (scope.taskId === null) throw new Error("validation command grants require a task scope");
    const hash = fingerprint(command, scope.workspaceId);
    const existing = this.#store.listValidationCommandGrants(scope.runId, scope.taskId)
      .find((grant) => grant.workspaceId === scope.workspaceId && fingerprint(grant.command, grant.workspaceId) === hash);
    if (existing !== undefined) return existing;
    const grant: ValidationCommandGrant = {
      grantId: randomUUID(), runId: scope.runId, taskId: scope.taskId,
      workspaceId: scope.workspaceId, command, status: "pending", decisionReason: null
    };
    const event = this.#event("user.approval.requested", scope.taskId, {
      grantId: grant.grantId, runId: scope.runId, workspaceId: scope.workspaceId,
      fingerprint: hash, reason: "suggested_validation_command"
    });
    this.#commitGrantDurably(grant, event);
    return grant;
  }

  async decideGrant(
    grantId: string,
    decision: "approved" | "rejected",
    reason: string
  ): Promise<ValidationCommandGrant> {
    const current = this.#store.getValidationCommandGrant(grantId);
    if (current === null) throw new Error(`validation command grant not found: ${grantId}`);
    this.#assertCompanyBinding(current.runId);
    const event = this.#event("user.approval.decided", current.taskId, {
      grantId, decision, reason
    });
    try {
      return this.#store.commitValidationCommandGrantDecision({ grantId, decision, reason, event });
    } catch (error) {
      const durable = this.#store.getValidationCommandGrant(grantId);
      if (durable?.status === decision && durable.decisionReason === reason
        && this.#store.listEvents(0).some(({ id }) => id === event.id)) return durable;
      throw error;
    }
  }

  async run(
    command: ValidationCommand,
    scope: ValidationScope,
    options: { secretValues?: readonly string[] } = {}
  ): Promise<ValidationRunRecord> {
    assertCommand(command);
    if (!this.#acceptingRuns) throw new Error("validation dispatch is fenced");
    const dependencies = injectedDependencies.get(this) ?? {};
    let child: ChildProcess | null = null;
    let closed: Promise<ProcessExit> | null = null;
    let abortRequested = false;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      resolveSettled = resolvePromise;
    });
    let abortPromise: Promise<void> | null = null;
    const active = {
      settled,
      abort: (deadlineAt: number): Promise<void> => {
        abortRequested = true;
        if (abortPromise !== null) return abortPromise;
        const currentChild = child;
        const currentClosed = closed;
        abortPromise = currentChild !== null && currentClosed !== null && isLive(currentChild)
          ? terminateVerifiedProcessTree(
              dependencies.processTree ?? defaultProcessTree,
              currentChild,
              currentClosed,
              deadlineAt
            )
          : Promise.resolve();
        return abortPromise;
      }
    };
    this.#active.add(active);
    let temporaryPath: string | null = null;
    let logPath: string | null = null;
    const assertNotAborted = (): void => {
      if (abortRequested) throw new Error("validation operation was aborted by pause fence");
    };
    try {
      assertNotAborted();
      const context = await this.#resolveScope(command, scope);
      assertNotAborted();
      this.#authorize(command, scope);
      const secretValues = options.secretValues ?? [];
      const validationId = randomUUID();
      const logDirectory = resolve(context.projectRoot, ".agenttown", "runs", scope.runId, "validation");
      const logDirectoryIdentity = await makeSafeDirectory(context.projectRoot, logDirectory);
      assertNotAborted();
      logPath = resolve(logDirectory, `${validationId}.log`);
      temporaryPath = resolve(logDirectory, `.${validationId}.tmp`);
      const startedAt = new Date().toISOString();
      let sequence = 0;
      let bytesWritten = 0;
      let overflow = false;
      let resolveStop: (reason: "overflow") => void = () => undefined;
      const stopRequested = new Promise<"overflow">((resolvePromise) => { resolveStop = resolvePromise; });
      const chunks: Array<{ sequence: number; stream: "stdout" | "stderr"; value: string }> = [];
      const writeChunk = (stream: "stdout" | "stderr", value: Buffer | string): void => {
        if (overflow) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const available = MAX_LOG_BYTES - bytesWritten;
        const body = available > 0 ? truncateUtf8(chunk, available) : Buffer.alloc(0);
        bytesWritten += body.length;
        chunks.push({ sequence: ++sequence, stream, value: body.toString("utf8") });
        if (body.length !== chunk.length || bytesWritten >= MAX_LOG_BYTES) {
          overflow = true;
          resolveStop("overflow");
        }
      };

      await dependencies.beforeSpawn?.();
      assertNotAborted();
      await assertSameDirectory(
        context.cwdIdentity,
        await inspectSafeDirectory(scope.workspaceRoot, context.cwd)
      );
      assertNotAborted();
      const ownsProcessGroup = process.platform !== "win32";
      child = spawn(command.executable, [...command.args], {
        cwd: context.cwd, env: minimalEnvironment(), shell: false, detached: ownsProcessGroup,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      const runningChild = child;
      closed = new Promise<ProcessExit>((resolvePromise) => {
        runningChild.once("close", (code, signal) => resolvePromise({ code, signal }));
      });
      const runningClosed = closed;
      const startFailed = new Promise<Error>((_resolve, reject) => runningChild.once("error", reject));
      runningChild.stdout!.setEncoding("utf8");
      runningChild.stderr!.setEncoding("utf8");
      runningChild.stdout!.on("data", (chunk: Buffer | string) => writeChunk("stdout", chunk));
      runningChild.stderr!.on("data", (chunk: Buffer | string) => writeChunk("stderr", chunk));

      const timeoutMs = command.timeoutSeconds * 1_000;
      const commandDeadlineAt = Date.now() + timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timed_out">((resolvePromise) => {
        timer = setTimeout(() => resolvePromise("timed_out"), Math.max(0, commandDeadlineAt - Date.now()));
      });
      let outcome: ProcessExit | "timed_out" | "overflow" | "start_failed";
      try {
        outcome = await Promise.race([
          runningClosed,
          timedOut,
          stopRequested,
          startFailed.then(() => "start_failed" as const)
        ]);
      } catch {
        outcome = "start_failed";
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      let cleanupFailed = false;
      const cleanupDeadlineAt = Date.now() + 5_000;
      if (typeof outcome === "string" && outcome !== "start_failed") {
        try {
          await terminateVerifiedProcessTree(
            dependencies.processTree ?? defaultProcessTree,
            runningChild,
            runningClosed,
            cleanupDeadlineAt
          );
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        runningChild.stdout?.removeAllListeners("data");
        runningChild.stderr?.removeAllListeners("data");
      } else {
        try {
          await waitForCloseUntil(runningClosed, "validation process", cleanupDeadlineAt);
        } catch {
          cleanupFailed = true;
          runningChild.stdout?.removeAllListeners("data");
          runningChild.stderr?.removeAllListeners("data");
        }
      }
      assertNotAborted();
      const redactedChunks = redactChunkSequence(chunks, secretValues);
      const redactedLog = chunks.map((chunk) => {
        const label = `[${String(chunk.sequence).padStart(6, "0")}] ${chunk.stream}: `;
        return `${label}${redactedChunks.get(chunk.sequence) ?? ""}\n`;
      }).join("");
      const finalLog = truncateUtf8(Buffer.from(redactedLog), MAX_LOG_BYTES);
      await dependencies.beforeEvidenceOpen?.();
      assertNotAborted();
      await assertSameDirectory(
        logDirectoryIdentity,
        await inspectSafeDirectory(context.projectRoot, logDirectory)
      );
      assertNotAborted();
      const finalHandle = await open(temporaryPath, "wx", 0o600);
      try {
        assertNotAborted();
        await finalHandle.writeFile(finalLog);
        assertNotAborted();
      } finally {
        await finalHandle.close();
      }
      assertNotAborted();
      await assertSameDirectory(
        logDirectoryIdentity,
        await inspectSafeDirectory(context.projectRoot, logDirectory)
      );
      assertNotAborted();
      await dependencies.beforeEvidenceRename?.();
      assertNotAborted();
      await assertSameDirectory(
        logDirectoryIdentity,
        await inspectSafeDirectory(context.projectRoot, logDirectory)
      );
      assertNotAborted();
      await rename(temporaryPath, logPath);
      assertNotAborted();
      await assertSameDirectory(
        logDirectoryIdentity,
        await inspectSafeDirectory(context.projectRoot, logDirectory)
      );
      assertNotAborted();
      const completedAt = new Date().toISOString();
      const record: ValidationRunRecord = {
      validationId, runId: scope.runId, taskId: scope.taskId,
      integrationAttemptId: scope.integrationAttemptId, command: redactedCommand(command, secretValues),
      workspaceId: scope.workspaceId,
      outcome: cleanupFailed ? "cleanup_failed"
        : outcome === "timed_out" ? "timed_out"
        : outcome === "start_failed" ? "start_failed"
        : overflow || outcome === "overflow"
          || (typeof outcome === "object" && outcome.code !== 0) ? "failed" : "passed",
      exitCode: typeof outcome === "object" ? outcome.code : null,
      startedAt, completedAt, logPath,
      logHash: createHash("sha256").update(finalLog).digest("hex")
    };
      const event = this.#event("validation.completed", scope.taskId, {
      validationId, runId: scope.runId, workspaceId: scope.workspaceId,
      outcome: record.outcome, exitCode: record.exitCode, logPath, logHash: record.logHash
    });
      const run = this.#store.getGitRun(scope.runId);
      const pause = record.outcome === "cleanup_failed" && run?.status === "active"
      ? {
          run: { ...run, status: "paused" as const, updatedAt: new Date().toISOString() },
          workspaces: this.#store.listGitWorkspaces(scope.runId).map((workspace) =>
            workspace.status === "active" ? { ...workspace, status: "paused" as const } : workspace
          ),
          event: this.#event("git.run.paused", null, {
            runId: scope.runId,
            reason: "validation_cleanup_failed"
          })
        }
      : undefined;
      assertNotAborted();
      this.#store.commitValidationRunCompletion({
        validation: record,
        completedEvent: event,
        ...(pause === undefined ? {} : { pause })
      });
      return record;
    } finally {
      try {
        if (abortRequested) {
          for (const path of [temporaryPath, logPath]) {
            if (path !== null) {
              await unlink(path).catch((error: unknown) => {
                if (!isMissing(error)) throw error;
              });
            }
          }
        }
      } finally {
        this.#active.delete(active);
        resolveSettled();
      }
    }
  }

  async #resolveScope(command: ValidationCommand, scope: ValidationScope): Promise<{
    projectRoot: string;
    cwd: string;
    cwdIdentity: DirectoryIdentity;
  }> {
    assertIdentifier(scope.runId, "run id");
    const run = this.#store.getGitRun(scope.runId);
    const workspace = this.#store.getGitWorkspace(scope.workspaceId);
    if (run === null || workspace === null || workspace.runId !== scope.runId
      || pathKey(workspace.path) !== pathKey(scope.workspaceRoot)) {
      throw new Error("validation scope workspace is not registered");
    }
    if (scope.integrationAttemptId === null) {
      if (workspace.taskId !== scope.taskId) {
        throw new Error("validation scope workspace is not registered");
      }
    } else {
      const attempt = this.#store.getIntegrationAttempt(scope.integrationAttemptId);
      if (attempt === null
        || attempt.runId !== scope.runId
        || attempt.taskId !== scope.taskId) {
        throw new Error("validation scope integration attempt ownership does not match");
      }
      const expectedHead = attempt.candidateCommit
        ?? attempt.expectedOldCommit;
      const exactCandidates = this.#store.listGitWorkspaces(scope.runId).filter(
        (candidate) => candidate.kind === "candidate"
          && candidate.runId === attempt.runId
          && candidate.taskId === null
          && candidate.employeeId === null
          && candidate.status === "active"
          && candidate.branchRef === attempt.candidateRef
          && candidate.baseCommit === attempt.expectedOldCommit
          && candidate.headCommit === expectedHead
      );
      if (exactCandidates.length !== 1
        || exactCandidates[0]?.workspaceId !== workspace.workspaceId
        || workspace.kind !== "candidate"
        || workspace.taskId !== null
        || workspace.employeeId !== null
        || workspace.status !== "active"
        || workspace.branchRef !== attempt.candidateRef
        || workspace.baseCommit !== attempt.expectedOldCommit
        || workspace.headCommit !== expectedHead) {
        throw new Error(
          "integration validation candidate workspace does not match attempt"
        );
      }
    }
    this.#assertCompanyBinding(scope.runId);
    if (run.status !== "active" || workspace.status !== "active") {
      throw new Error("validation run or workspace is not active");
    }
    if (scope.integrationAttemptId !== null) {
      const attempt = this.#store.getIntegrationAttempt(scope.integrationAttemptId);
      if (attempt === null || attempt.runId !== scope.runId || attempt.taskId !== scope.taskId) {
        throw new Error("validation scope integration attempt ownership does not match");
      }
    }
    const relativeCwd = command.cwd;
    if (isAbsolute(relativeCwd)) throw new Error("cwd outside workspace");
    const cwd = resolve(scope.workspaceRoot, relativeCwd);
    return {
      projectRoot: resolve(run.projectRoot),
      cwd,
      cwdIdentity: await inspectSafeDirectory(scope.workspaceRoot, cwd)
    };
  }

  #authorize(command: ValidationCommand, scope: ValidationScope): void {
    if (this.#company.validation.commands.some((configured) => sameCommand(configured, command))) return;
    const grants = scope.taskId === null ? [] : this.#store.listValidationCommandGrants(scope.runId, scope.taskId);
    const exact = grants.find((grant) => grant.workspaceId === scope.workspaceId
      && fingerprint(grant.command, grant.workspaceId) === fingerprint(command, scope.workspaceId));
    if (exact?.status === "approved") return;
    if (exact?.status === "rejected") {
      throw new Error(`approval rejected: ${exact.grantId}: ${exact.decisionReason ?? "no reason"}`);
    }
    if (exact !== undefined) throw new Error(`approval required: ${exact.grantId}`);
    throw new Error("approval required");
  }

  #assertCompanyBinding(runId: string): void {
    const run = this.#store.getGitRun(runId);
    if (run === null || run.companyId !== this.#companyId) {
      throw new Error("validation company ownership does not match run");
    }
    const persistedCompany = this.#store.getCompany(this.#companyId);
    if (persistedCompany === null
      || persistedCompany.definitionJson !== JSON.stringify(this.#company)) {
      throw new Error("validation company definition is not bound to company");
    }
  }

  #event(type: string, taskId: string | null, payload: Record<string, unknown>): NewEvent {
    return { id: randomUUID(), type, actorId: this.#actorId, taskId, causationEventId: null, payload };
  }

  #commitGrantDurably(grant: ValidationCommandGrant, event: NewEvent): void {
    try { this.#store.commitValidationCommandGrant({ grant, event }); } catch (error) {
      const durable = this.#store.getValidationCommandGrant(grant.grantId);
      if (durable?.grantId === grant.grantId && this.#store.listEvents(0).some(({ id }) => id === event.id)) return;
      throw error;
    }
  }

}
