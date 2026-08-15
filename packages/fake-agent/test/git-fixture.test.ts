import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReviewTaskContext, WritableTaskContext } from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it } from "vitest";
import { runGitFixture } from "../src/git-fixture.js";

const TIMEOUT_MS = 15_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0]
): Promise<GitResult> {
  const child = spawn("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C"
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? -1));
  });
  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(`git ${args[0] ?? "<missing>"} failed (${exitCode}): ${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

async function gitStatus(root: string): Promise<string> {
  return (await git(root, ["status", "--porcelain"])).stdout.trim();
}

async function gitLog(root: string): Promise<string> {
  return (await git(root, ["log", "--format=%s"])).stdout;
}

async function createHarness(): Promise<{
  userRoot: string;
  workspaceRoot: string;
  writableContext: WritableTaskContext;
  outside: string;
}> {
  const container = await mkdtemp(join(tmpdir(), "agenttown-fixture-"));
  cleanups.push(() => rm(container, { recursive: true, force: true }));
  const userRoot = join(container, "user");
  await mkdir(userRoot, { recursive: true });
  await git(userRoot, ["init", "-b", "main"]);
  await git(userRoot, ["config", "user.name", "AgentTown Fixture"]);
  await git(userRoot, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(userRoot, "README.md"), "initial\n", "utf8");
  await git(userRoot, ["add", "README.md"]);
  await git(userRoot, ["commit", "-m", "initial"]);
  const baseCommit = (await git(userRoot, ["rev-parse", "HEAD"])).stdout.trim();
  // RepositoryPreflight adds this local exclude before any Git run is created.
  await writeFile(join(userRoot, ".git", "info", "exclude"), "/.agenttown/\n", "utf8");

  const runRoot = join(userRoot, ".agenttown", "worktrees", "run-1");
  const workspaceRoot = join(runRoot, "developer-a", "task-a");
  await mkdir(runRoot, { recursive: true });
  await git(userRoot, [
    "worktree",
    "add",
    "-b",
    "agenttown/run-1/developer-a/task-a",
    "--",
    workspaceRoot,
    baseCommit
  ]);

  const outside = join(container, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "README.md"), "outside\n", "utf8");

  const writableContext: WritableTaskContext = {
    kind: "git_worktree",
    runId: "run-1",
    taskId: "task-a",
    employeeId: "developer-a",
    workspaceRoot,
    branch: "refs/heads/agenttown/run-1/developer-a/task-a",
    baseCommit,
    approvedValidationCommandIds: []
  };
  return { userRoot, workspaceRoot, writableContext, outside };
}

describe("deterministic Git fixture", () => {
  it(
    "writes and commits only inside the supplied task worktree",
    async () => {
      const { userRoot, workspaceRoot, writableContext } = await createHarness();
      const result = await runGitFixture({
        context: writableContext,
        scenario: "git-developer-a"
      });

      expect(result.action.type).toBe("task.submit");
      expect(result.action.taskId).toBe("task-a");
      expect(result.action.actorEmployeeId).toBe("developer-a");
      expect(await gitStatus(userRoot)).toBe("");
      expect(await gitLog(workspaceRoot)).toContain("fake: task-a");
      const submitted = result.action.payload.submission as {
        headCommit: string;
        commits: string[];
        changeSummary: string;
      };
      const actualHead = (await git(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
      expect(submitted.headCommit).toBe(actualHead);
      expect(submitted.commits).toEqual([actualHead]);
      expect(submitted.changeSummary).toBe("fake: add feature-a.txt");
    },
    TIMEOUT_MS
  );

  it("rejects review scenarios with a writable context", async () => {
    const { writableContext } = await createHarness();
    await expect(runGitFixture({
      context: writableContext,
      scenario: "git-review-approve"
    })).rejects.toThrow("review package");
  });

  it("refuses a workspace path outside the registered project root", async () => {
    const { outside, writableContext } = await createHarness();
    await expect(runGitFixture({
      context: { ...writableContext, workspaceRoot: outside },
      scenario: "git-developer-a"
    })).rejects.toThrow("workspace");
  });

  it("approves a review package only after verifying its exact manifest hash", async () => {
    const container = await mkdtemp(join(tmpdir(), "agenttown-review-"));
    cleanups.push(() => rm(container, { recursive: true, force: true }));
    const userRoot = join(container, "user");
    await mkdir(userRoot, { recursive: true });
    await git(userRoot, ["init", "-b", "main"]);
    await git(userRoot, ["config", "user.name", "AgentTown Fixture"]);
    await git(userRoot, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(userRoot, "README.md"), "initial\n", "utf8");
    await git(userRoot, ["add", "README.md"]);
    await git(userRoot, ["commit", "-m", "initial"]);

    const manifestPath = join(
      userRoot,
      ".agenttown",
      "runs",
      "run-1",
      "reviews",
      "task-a",
      "1",
      "manifest.json"
    );
    await mkdir(join(manifestPath, ".."), { recursive: true });
    const manifest = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      files: {},
      totalFiles: 0,
      totalBytes: 0
    }, null, 2);
    await writeFile(manifestPath, manifest, "utf8");
    const manifestHash = createHash("sha256").update(manifest).digest("hex");

    const reviewContext: ReviewTaskContext = {
      kind: "review_package",
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      manifestPath,
      manifestHash
    };
    const result = await runGitFixture({
      context: reviewContext,
      scenario: "git-review-approve"
    });
    expect(result.action.type).toBe("task.approve");
    const decision = result.action.payload.decision as {
      decision: string;
      reviewedManifestHash: string;
    };
    expect(decision.decision).toBe("approve");
    expect(decision.reviewedManifestHash).toBe(manifestHash);
  });

  it("rejects a review package whose manifest hash does not match", async () => {
    const container = await mkdtemp(join(tmpdir(), "agenttown-review-bad-"));
    cleanups.push(() => rm(container, { recursive: true, force: true }));
    const userRoot = join(container, "user");
    await mkdir(userRoot, { recursive: true });
    await git(userRoot, ["init", "-b", "main"]);
    await git(userRoot, ["config", "user.name", "AgentTown Fixture"]);
    await git(userRoot, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(userRoot, "README.md"), "initial\n", "utf8");
    await git(userRoot, ["add", "README.md"]);
    await git(userRoot, ["commit", "-m", "initial"]);

    const manifestPath = join(userRoot, ".agenttown", "runs", "run-1", "reviews", "task-a", "1", "manifest.json");
    await mkdir(join(manifestPath, ".."), { recursive: true });
    await writeFile(manifestPath, "not the recorded manifest\n", "utf8");
    const wrongHash = "0".repeat(64);

    await expect(runGitFixture({
      context: {
        kind: "review_package",
        runId: "run-1",
        taskId: "task-a",
        revision: 1,
        manifestPath,
        manifestHash: wrongHash
      },
      scenario: "git-review-approve"
    })).rejects.toThrow("hash");
  });

  it("proposes rejection with a blocking finding and required change", async () => {
    const container = await mkdtemp(join(tmpdir(), "agenttown-review-reject-"));
    cleanups.push(() => rm(container, { recursive: true, force: true }));
    const userRoot = join(container, "user");
    await mkdir(userRoot, { recursive: true });
    await git(userRoot, ["init", "-b", "main"]);
    await git(userRoot, ["config", "user.name", "AgentTown Fixture"]);
    await git(userRoot, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(userRoot, "README.md"), "initial\n", "utf8");
    await git(userRoot, ["add", "README.md"]);
    await git(userRoot, ["commit", "-m", "initial"]);

    const manifestPath = join(userRoot, ".agenttown", "runs", "run-1", "reviews", "task-a", "1", "manifest.json");
    await mkdir(join(manifestPath, ".."), { recursive: true });
    const manifest = "review payload\n";
    await writeFile(manifestPath, manifest, "utf8");
    const manifestHash = createHash("sha256").update(manifest).digest("hex");

    const result = await runGitFixture({
      context: {
        kind: "review_package",
        runId: "run-1",
        taskId: "task-a",
        revision: 1,
        manifestPath,
        manifestHash
      },
      scenario: "git-review-reject"
    });
    expect(result.action.type).toBe("task.reject");
    const decision = result.action.payload.decision as {
      decision: string;
      findings: Array<{ severity: string; requiredChange: string | null }>;
    };
    expect(decision.decision).toBe("reject");
    expect(decision.findings.some(({ severity, requiredChange }) =>
      severity === "blocking" && requiredChange !== null
    )).toBe(true);
  });

  it("edits a deterministic shared line for the conflict scenario", async () => {
    const { workspaceRoot, writableContext } = await createHarness();
    const result = await runGitFixture({
      context: writableContext,
      scenario: "git-conflict"
    });
    expect(result.action.type).toBe("task.submit");
    const content = await readFile(join(workspaceRoot, "shared.txt"), "utf8");
    expect(content).toBe("conflict-developer-a\n");
    expect(await gitStatus(workspaceRoot)).toBe("");
  });
});
