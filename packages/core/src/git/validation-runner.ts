import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, lstat } from "node:fs/promises";
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

export interface ValidationScope {
  runId: string;
  taskId: string | null;
  integrationAttemptId: string | null;
  workspaceId: string;
  workspaceRoot: string;
}

export interface ValidationRunnerOptions {
  store: CoreStore;
  company: CompanyDefinition;
  actorId?: string;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
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

function cleanupReserve(totalBudgetMs: number): number {
  return Math.min(1_000, Math.max(25, Math.floor(totalBudgetMs * (2 / 3))), totalBudgetMs - 1);
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

async function makeSafeDirectory(root: string, target: string): Promise<void> {
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
  readonly #company: CompanyDefinition;
  readonly #actorId: string;

  constructor(options: ValidationRunnerOptions) {
    this.#store = options.store;
    this.#company = options.company;
    this.#actorId = options.actorId ?? "core";
  }

  async requestGrant(command: ValidationCommand, scope: ValidationScope): Promise<ValidationCommandGrant> {
    assertCommand(command);
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
    const context = await this.#resolveScope(command, scope);
    this.#authorize(command, scope);
    const secretValues = options.secretValues ?? [];
    const validationId = randomUUID();
    const logDirectory = resolve(context.projectRoot, ".agenttown", "runs", scope.runId, "validation");
    await makeSafeDirectory(context.projectRoot, logDirectory);
    const logPath = resolve(logDirectory, `${validationId}.log`);
    const temporaryPath = resolve(logDirectory, `.${validationId}.tmp`);
    const startedAt = new Date().toISOString();
    const handle = await open(temporaryPath, "wx");
    let sequence = 0;
    let bytesWritten = 0;
    let writeChain: Promise<void> = Promise.resolve();
    let writeError: unknown;
    let overflow = false;
    let resolveStop: (reason: "overflow") => void = () => undefined;
    const stopRequested = new Promise<"overflow">((resolvePromise) => { resolveStop = resolvePromise; });
    const writeChunk = (stream: "stdout" | "stderr", value: Buffer | string): void => {
      if (overflow) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const label = `[${String(++sequence).padStart(6, "0")}] ${stream}: `;
      const available = MAX_LOG_BYTES - bytesWritten - Buffer.byteLength(label) - 1;
      const body = available > 0 ? truncateUtf8(chunk, available) : Buffer.alloc(0);
      bytesWritten += Buffer.byteLength(label) + body.length + 1;
      writeChain = writeChain.then(async () => {
        await handle.write(label);
        await handle.write(body);
        await handle.write("\n");
      }).catch((error: unknown) => { writeError ??= error; });
      if (body.length !== chunk.length || bytesWritten >= MAX_LOG_BYTES) {
        overflow = true;
        resolveStop("overflow");
      }
    };

    const ownsProcessGroup = process.platform !== "win32";
    const child = spawn(command.executable, [...command.args], {
      cwd: context.cwd, env: minimalEnvironment(), shell: false, detached: ownsProcessGroup,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    const closed = new Promise<ProcessExit>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    const startFailed = new Promise<Error>((_resolve, reject) => child.once("error", reject));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer | string) => writeChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => writeChunk("stderr", chunk));

    const timeoutMs = command.timeoutSeconds * 1_000;
    const deadlineAt = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed_out">((resolvePromise) => {
      timer = setTimeout(() => resolvePromise("timed_out"), Math.max(0, deadlineAt - cleanupReserve(timeoutMs) - Date.now()));
    });
    let outcome: ProcessExit | "timed_out" | "overflow" | "start_failed";
    try {
      outcome = await Promise.race([closed, timedOut, stopRequested, startFailed.then(() => "start_failed" as const)]);
    } catch {
      outcome = "start_failed";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    let cleanupFailed = false;
    if (typeof outcome === "string" && outcome !== "start_failed") {
      try {
        await terminateProcessTree(child, closed, deadlineAt);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
    } else {
      try {
        await waitForCloseUntil(closed, "validation process", deadlineAt);
      } catch {
        cleanupFailed = true;
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
      }
    }
    await writeChain;
    if (writeError !== undefined) cleanupFailed = true;
    await handle.close();
    const redactedLog = redact(await readFile(temporaryPath, "utf8"), secretValues);
    const finalLog = truncateUtf8(Buffer.from(redactedLog), MAX_LOG_BYTES);
    const finalHandle = await open(temporaryPath, "w");
    try {
      await finalHandle.writeFile(finalLog);
    } finally {
      await finalHandle.close();
    }
    await rename(temporaryPath, logPath);
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
    this.#commitRunDurably(record, event);
    if (record.outcome === "cleanup_failed") this.#pauseRun(scope.runId);
    return record;
  }

  async #resolveScope(command: ValidationCommand, scope: ValidationScope): Promise<{ projectRoot: string; cwd: string }> {
    assertIdentifier(scope.runId, "run id");
    const run = this.#store.getGitRun(scope.runId);
    const workspace = this.#store.getGitWorkspace(scope.workspaceId);
    if (run === null || workspace === null || workspace.runId !== scope.runId
      || workspace.taskId !== scope.taskId || pathKey(workspace.path) !== pathKey(scope.workspaceRoot)) {
      throw new Error("validation scope workspace is not registered");
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
    return { projectRoot: resolve(run.projectRoot), cwd: await assertSafeDirectory(scope.workspaceRoot, cwd) };
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

  #commitRunDurably(validation: ValidationRunRecord, event: NewEvent): void {
    try { this.#store.commitValidationRun({ validation, event }); } catch (error) {
      const durable = this.#store.getValidationRun(validation.validationId);
      if (durable?.validationId === validation.validationId && this.#store.listEvents(0).some(({ id }) => id === event.id)) return;
      throw error;
    }
  }

  #pauseRun(runId: string): void {
    const run = this.#store.getGitRun(runId);
    if (run === null || run.status !== "active") return;
    const workspaces = this.#store.listGitWorkspaces(runId).map((workspace) =>
      workspace.status === "active" ? { ...workspace, status: "paused" as const } : workspace
    );
    const event = this.#event("git.run.paused", null, { runId, reason: "validation_cleanup_failed" });
    try {
      this.#store.commitGitRunPause({ run: { ...run, status: "paused", updatedAt: new Date().toISOString() }, workspaces, event });
    } catch (error) {
      if (this.#store.getGitRun(runId)?.status === "paused"
        && this.#store.listEvents(0).some(({ id }) => id === event.id)) return;
      throw error;
    }
  }
}
