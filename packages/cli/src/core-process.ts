import { randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcess
} from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_ONLY_AFTER_SEQUENCE } from "@agenttown/runtime-contract";
import { AgentTownClient } from "./client.js";
import type { AgentTownPaths } from "./paths.js";

const READY_TIMEOUT_MS = 10_000;
const DETACH_READY_TIMEOUT_MS = 90_000;
const STDERR_LIMIT_BYTES = 8 * 1024;

interface ReadyLine {
  type: "core.ready";
  protocolVersion: 1;
  pipeName: string;
}

function parseReady(line: string, expectedPipe: string): ReadyLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (
    typeof value !== "object"
    || value === null
    || (value as Record<string, unknown>).type !== "core.ready"
    || (value as Record<string, unknown>).protocolVersion !== 1
    || (value as Record<string, unknown>).pipeName !== expectedPipe
  ) {
    return null;
  }
  return value as ReadyLine;
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>
): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= STDERR_LIMIT_BYTES
    ? combined
    : combined.subarray(combined.length - STDERR_LIMIT_BYTES);
}

export interface TerminableChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

async function waitForChildClose(
  child: TerminableChild,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("close", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
  });
}

export async function terminateChild(
  child: TerminableChild,
  waitMs = 500
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await waitForChildClose(child, waitMs);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForChildClose(child, waitMs);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Core child remained live after SIGKILL");
  }
}

function coreCommandLine(input: {
  projectRoot: string;
  paths: AgentTownPaths;
  pipeName: string;
  leaseTtlMs: number;
}): { coreMain: string; tsxImport: string; args: string[] } {
  const coreMain = fileURLToPath(new URL("../../core/src/main.ts", import.meta.url));
  const tsxImport = import.meta.resolve("tsx");
  return {
    coreMain,
    tsxImport,
    args: [
      "--import",
      tsxImport,
      coreMain,
      "--project-root",
      input.projectRoot,
      "--database",
      input.paths.databasePath,
      "--company",
      input.paths.companyPath,
      "--pipe-name",
      input.pipeName,
      "--lease-ttl-ms",
      String(input.leaseTtlMs)
    ]
  };
}

function coreEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTTOWN_FORBID_REAL_PROBES: process.env.AGENTTOWN_FORBID_REAL_PROBES ?? "1",
    AGENTTOWN_REAL_CODEX: process.env.AGENTTOWN_REAL_CODEX ?? "0",
    AGENTTOWN_REAL_CLAUDE: process.env.AGENTTOWN_REAL_CLAUDE ?? "0"
  };
}

export async function startCore(input: {
  projectRoot: string;
  paths: AgentTownPaths;
  pipeName: string;
  leaseTtlMs: number;
}): Promise<{ child: ChildProcess; client: AgentTownClient }> {
  const deadlineAt = Date.now() + READY_TIMEOUT_MS;
  const { args } = coreCommandLine(input);
  const child = spawn(process.execPath, args, {
    cwd: input.projectRoot,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Safe defaults for tests, but an operator who explicitly opts into real
    // agents (AGENTTOWN_FORBID_REAL_PROBES=0 + AGENTTOWN_REAL_*="1") must not
    // have their settings overridden — inherit them verbatim.
    env: coreEnv()
  });

  let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const onStderr = (chunk: Buffer<ArrayBufferLike>) => {
    stderrTail = appendTail(stderrTail, chunk);
  };
  child.stderr?.on("data", onStderr);
  try {
    const ready = await new Promise<ReadyLine>((resolvePromise, reject) => {
      let stdout = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Core readiness timed out after ${READY_TIMEOUT_MS}ms`));
      }, Math.max(0, deadlineAt - Date.now()));
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`Core exited before readiness (code=${String(code)}, signal=${String(signal)})`));
      };
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
          cleanup();
          reject(new Error("Core readiness output exceeded 64 KiB"));
          return;
        }
        while (true) {
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          const parsed = parseReady(line, input.pipeName);
          if (parsed !== null) {
            cleanup();
            resolvePromise(parsed);
            return;
          }
        }
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout?.on("data", onData);
    });
    if (ready.pipeName !== input.pipeName) throw new Error("Core readiness pipe mismatch");
    const connectBudgetMs = deadlineAt - Date.now();
    if (connectBudgetMs <= 0) {
      throw new Error(`Core startup timed out after ${READY_TIMEOUT_MS}ms`);
    }
    const client = await AgentTownClient.connect(
      input.pipeName,
      `cli-${randomUUID()}`,
      LIVE_ONLY_AFTER_SEQUENCE,
      connectBudgetMs
    );
    child.stderr?.off("data", onStderr);
    child.stdout?.resume();
    child.stderr?.resume();
    child.unref();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    return { child, client };
  } catch (error) {
    await terminateChild(child);
    const stderr = stderrTail.toString("utf8").trim();
    const detail = stderr.length === 0 ? "" : `\nCore stderr (tail):\n${stderr}`;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail}`,
      { cause: error }
    );
  } finally {
    child.stderr?.off("data", onStderr);
  }
}

/**
 * Starts Core fully detached (`agenttown start --detach`): the process is
 * spawned with stdout/stderr redirected to `.agenttown/core.log` and is
 * unref'd so the CLI returns immediately. The function polls the pipe until
 * Core becomes reachable and returns a short-lived client the caller uses
 * to issue `company.start` before closing.
 */
export async function spawnCoreDetached(input: {
  projectRoot: string;
  paths: AgentTownPaths;
  pipeName: string;
  leaseTtlMs: number;
}): Promise<AgentTownClient> {
  const { args } = coreCommandLine(input);
  const logFd = openSync(join(input.paths.stateDir, "core.log"), "a");
  const child = spawn(process.execPath, args, {
    cwd: input.projectRoot,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: coreEnv()
  });
  child.unref();
  const deadlineAt = Date.now() + DETACH_READY_TIMEOUT_MS;
  let lastError: unknown = new Error("Core did not become ready");
  while (Date.now() < deadlineAt) {
    try {
      return await AgentTownClient.connect(
        input.pipeName,
        `cli-${randomUUID()}`,
        LIVE_ONLY_AFTER_SEQUENCE,
        2_000
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 1_000);
    });
  }
  throw new Error(
    `Core did not become ready within ${DETACH_READY_TIMEOUT_MS}ms (see ${join(input.paths.stateDir, "core.log")})`,
    { cause: lastError }
  );
}
