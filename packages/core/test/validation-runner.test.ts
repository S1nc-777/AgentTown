import { mkdir, readFile, readdir, rename, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompanyDefinition, ValidationCommand } from "@agenttown/runtime-contract";
import { CoreStore, ValidationRunner, type ValidationScope } from "../src/index.js";
import {
  createInjectedValidationRunner,
  createInjectedLinuxProcessTreeController,
  parseLinuxProcStatStarttime
} from "../src/git/validation-runner.js";
import { companyDefinitionFixture, createTemporaryProject } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

function command(source: string, overrides: Partial<ValidationCommand> = {}): ValidationCommand {
  return {
    id: "node-check",
    executable: process.execPath,
    args: ["-e", source],
    cwd: ".",
    timeoutSeconds: 5,
    ...overrides
  };
}

function configuredCompany(commands: ValidationCommand[]): CompanyDefinition {
  const company = companyDefinitionFixture();
  return { ...company, validation: { commands, integrationCommandIds: [] } };
}

async function createRunner(
  commands: ValidationCommand[] = [],
  runnerOverrides: Record<string, unknown> = {}
) {
  const project = await createTemporaryProject();
  cleanups.push(project.cleanup);
  const store = new CoreStore(project.databasePath);
  store.initialize();
  const company = configuredCompany(commands);
  store.createCompany({
    id: "company-1",
    definition: company,
    event: {
      id: "company-created",
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: { companyId: "company-1" }
    }
  });
  store.putGitRun({
    runId: "run-1",
    companyId: "company-1",
    projectRoot: project.root,
    originalBranch: "main",
    baseCommit: "a".repeat(40),
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: "a".repeat(40),
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z"
  });
  store.putGitWorkspace({
    workspaceId: "workspace-1",
    runId: "run-1",
    taskId: "task-1",
    employeeId: "developer",
    kind: "task",
    path: project.root,
    branchRef: "refs/heads/agenttown/run-1/task-1",
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    status: "active"
  });
  const scope: ValidationScope = {
    runId: "run-1",
    taskId: "task-1",
    integrationAttemptId: null,
    workspaceId: "workspace-1",
    workspaceRoot: project.root
  };
  const {
    dependencies,
    ...optionOverrides
  } = runnerOverrides;
  return {
    project,
    store,
    scope,
    runner: dependencies === undefined
      ? new ValidationRunner({
          store,
          companyId: "company-1",
          company,
          ...optionOverrides
        })
      : createInjectedValidationRunner({
          store,
          companyId: "company-1",
          company,
          ...optionOverrides
        }, dependencies as Parameters<typeof createInjectedValidationRunner>[1])
  };
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return !(error instanceof Error)
      || !("code" in error)
      || (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

describe("ValidationRunner", () => {
  it("runs an exact configured executable without a shell and records ordered output", async () => {
    const executable = command("process.stdout.write('out'); process.stderr.write('err')");
    const { runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope);

    expect(result).toMatchObject({ outcome: "passed", exitCode: 0 });
    expect(await readFile(result.logPath, "utf8")).toMatch(/\[000001\] (stdout|stderr):/u);
    expect(await readFile(result.logPath, "utf8")).toContain("out");
    expect(store.getValidationRun(result.validationId)).toEqual(result);
    expect(store.listEvents(0).at(-1)?.type).toBe("validation.completed");
    store.close();
  });

  it("rejects a cwd outside the registered worktree", async () => {
    const executable = command("process.exit(0)", { cwd: ".." });
    const { runner, scope, store } = await createRunner([executable]);

    await expect(runner.run(executable, scope)).rejects.toThrow("outside workspace");
    store.close();
  });

  it("rejects a mismatched integration attempt before executing", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const markerPath = join(project.root, "validation-executed.txt");
    const executable = command(
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed')`
    );
    const { runner, scope, store } = await createRunner([executable]);

    await expect(runner.run(executable, {
      ...scope,
      integrationAttemptId: "missing-attempt"
    })).rejects.toThrow("integration attempt");
    store.close();
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out and reaps the command process tree", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const pidsPath = join(project.root, "validation-pids.txt");
    const executable = command([
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid]));`,
      "setInterval(() => {}, 1000);"
    ].join(""), { timeoutSeconds: 1 });
    const { runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope);
    const pids = JSON.parse(await readFile(pidsPath, "utf8")) as number[];

    expect(result.outcome).toBe("timed_out");
    expect(pids).toHaveLength(2);
    expect(pids.every(isProcessGone)).toBe(true);
    store.close();
  }, 10_000);

  it("aborts every active validation within the caller absolute deadline", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const pidPath = join(project.root, "active-validation.txt");
    const executable = command([
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);"
    ].join(""));
    const { runner, scope, store } = await createRunner([executable]);
    const running = runner.run(executable, scope);
    const observed = running.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    );
    let pid: number | null = null;
    while (pid === null) {
      try {
        pid = Number(await readFile(pidPath, "utf8"));
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)
          || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
    }
    const deadlineAt = Date.now() + 5_000;

    await runner.abortActive(deadlineAt);
    const result = await observed;
    const validationRuns = store.listValidationRuns(scope.runId);
    const evidenceFiles = await readdir(join(
      scope.workspaceRoot,
      ".agenttown",
      "runs",
      scope.runId,
      "validation"
    ));
    store.close();

    expect(Date.now()).toBeLessThanOrEqual(deadlineAt);
    expect(isProcessGone(pid)).toBe(true);
    expect(result).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringMatching(/aborted/u) })
    });
    expect(validationRuns).toEqual([]);
    expect(evidenceFiles).toEqual([]);
  }, 10_000);

  it("redacts configured secret values before persistence", async () => {
    const executable = command("process.stdout.write('secret-value')");
    const { runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope, { secretValues: ["secret-value"] });

    expect(await readFile(result.logPath, "utf8")).not.toContain("secret-value");
    expect(await readFile(result.logPath, "utf8")).toContain("[REDACTED]");
    store.close();
  });

  it("redacts same-stream secrets across chunks before any disk persistence", async () => {
    const executable = command([
      "process.stdout.write('secret-');",
      "process.stderr.write('interleaved');",
      "setTimeout(() => { process.stdout.write('value'); process.stderr.write(' API_TOKEN=to'); }, 30);",
      "setTimeout(() => { process.stderr.write('ken'); }, 60);"
    ].join(""));
    const { project, runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope, {
      secretValues: ["secret-value", "token"]
    });
    const evidenceDirectory = join(project.root, ".agenttown", "runs", scope.runId, "validation");
    const persisted = await Promise.all(
      (await readdir(evidenceDirectory)).map(async (name) =>
        await readFile(join(evidenceDirectory, name), "utf8"))
    );

    expect(persisted.join("\n")).not.toContain("secret-value");
    expect(persisted.join("\n")).not.toContain("API_TOKEN=token");
    expect(await readFile(result.logPath, "utf8")).toContain("[REDACTED]");
    store.close();
  });

  it("never leaves plaintext in a temporary log when evidence finalization fails", async () => {
    const executable = command("process.stdout.write('secret-value')");
    const { project, runner, scope, store } = await createRunner([executable], {
      dependencies: {
        beforeEvidenceRename: async () => {
          throw new Error("injected rename failure");
        }
      }
    });

    await expect(runner.run(executable, scope, {
      secretValues: ["secret-value"]
    })).rejects.toThrow("injected rename failure");
    const evidenceDirectory = join(project.root, ".agenttown", "runs", scope.runId, "validation");
    const persisted = await Promise.all(
      (await readdir(evidenceDirectory)).map(async (name) =>
        await readFile(join(evidenceDirectory, name), "utf8"))
    );

    expect(persisted.join("\n")).not.toContain("secret-value");
    store.close();
  });

  it("fails closed when the ordinary evidence directory is renamed and recreated before open", async () => {
    const executable = command("process.stdout.write('evidence')");
    let replaceEvidenceDirectory: () => Promise<void> = async () => undefined;
    const { project, runner, scope, store } = await createRunner([executable], {
      dependencies: {
        beforeEvidenceOpen: async () => await replaceEvidenceDirectory()
      }
    });
    const evidenceDirectory = join(project.root, ".agenttown", "runs", scope.runId, "validation");
    const originalEvidenceDirectory = `${evidenceDirectory}-original`;
    replaceEvidenceDirectory = async () => {
      await rename(evidenceDirectory, originalEvidenceDirectory);
      await mkdir(evidenceDirectory);
    };

    await expect(runner.run(executable, scope)).rejects.toThrow("directory identity changed");

    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(await readdir(originalEvidenceDirectory)).toEqual([]);
    store.close();
  });

  it("rejects commands for a run owned by another company before executing", async () => {
    const markerProject = await createTemporaryProject();
    cleanups.push(markerProject.cleanup);
    const markerPath = join(markerProject.root, "wrong-company.txt");
    const executable = command(
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'executed')`
    );
    const companyB = configuredCompany([executable]);
    const { runner, scope, store } = await createRunner([], {
      companyId: "company-b",
      company: companyB
    });
    store.createCompany({
      id: "company-b",
      definition: companyB,
      event: {
        id: "company-b-created", type: "company.created", actorId: "owner",
        taskId: null, causationEventId: null, payload: { companyId: "company-b" }
      }
    });

    await expect(runner.run(executable, scope)).rejects.toThrow("company ownership");
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    store.close();
  });

  it("rejects deciding another company's validation grant", async () => {
    const suggested = command("process.exit(0)", { id: "suggested" });
    const { runner, scope, store } = await createRunner();
    const pending = await runner.requestGrant(suggested, scope);
    const companyB = configuredCompany([]);
    store.createCompany({
      id: "company-b",
      definition: companyB,
      event: {
        id: "company-b-created", type: "company.created", actorId: "owner",
        taskId: null, causationEventId: null, payload: { companyId: "company-b" }
      }
    });
    const runnerB = new ValidationRunner({
      store,
      companyId: "company-b",
      company: companyB
    });

    await expect(runnerB.decideGrant(pending.grantId, "approved", "cross-company"))
      .rejects.toThrow("company ownership");
    expect(store.getValidationCommandGrant(pending.grantId)?.status).toBe("pending");
    store.close();
  });

  it("rejects a paused run and workspace before executing", async () => {
    const executable = command("process.exit(0)");
    const { runner, scope, store } = await createRunner([executable]);
    const run = store.getGitRun(scope.runId)!;
    const workspace = store.getGitWorkspace(scope.workspaceId)!;
    store.putGitRun({ ...run, status: "paused" });
    store.putGitWorkspace({ ...workspace, status: "paused" });

    await expect(runner.run(executable, scope)).rejects.toThrow("not active");
    store.close();
  });

  it("uses timeoutSeconds as the full command execution budget", async () => {
    const quick = command("setTimeout(() => process.exit(0), 500)", {
      id: "quick",
      timeoutSeconds: 1
    });
    const slow = command("setTimeout(() => process.exit(0), 1300)", {
      id: "slow",
      timeoutSeconds: 1
    });
    const { runner, scope, store } = await createRunner([quick, slow]);

    const quickStarted = Date.now();
    const quickResult = await runner.run(quick, scope);
    const quickElapsed = Date.now() - quickStarted;
    const slowStarted = Date.now();
    const slowResult = await runner.run(slow, scope);
    const slowElapsed = Date.now() - slowStarted;

    expect(quickResult.outcome).toBe("passed");
    expect(quickElapsed).toBeGreaterThanOrEqual(450);
    expect(quickElapsed).toBeLessThan(1_500);
    expect(slowResult.outcome).toBe("timed_out");
    expect(slowElapsed).toBeGreaterThanOrEqual(900);
    store.close();
  }, 10_000);

  it.each(["query_error", "reused"] as const)(
    "fails closed on process identity status %s and atomically pauses",
    async (terminalIdentityStatus) => {
    const executable = command("setInterval(() => {}, 1000)", { timeoutSeconds: 1 });
    let queryCount = 0;
    const { runner, scope, store } = await createRunner([executable], {
      dependencies: {
        processTree: {
          snapshot: async (pid: number) => [{ pid, started: "root-start" }],
          query: async () => (++queryCount === 1 ? "same" : terminalIdentityStatus),
          terminate: async (child: { kill: (signal?: NodeJS.Signals) => boolean }) => {
            child.kill("SIGKILL");
          }
        }
      }
    });

    const result = await runner.run(executable, scope);

    expect(result.outcome).toBe("cleanup_failed");
    expect(store.getValidationRun(result.validationId)).toEqual(result);
    expect(store.getGitRun(scope.runId)?.status).toBe("paused");
    expect(store.getGitWorkspace(scope.workspaceId)?.status).toBe("paused");
    expect(store.listEvents(0).slice(-2).map(({ type }) => type))
      .toEqual(["validation.completed", "git.run.paused"]);
    store.close();
    },
    10_000
  );

  it("does not terminate a process whose same-second POSIX identity has different proc starttime ticks", async () => {
    const sameSecondLstart = "Thu Jul 30 12:34:56 2026";
    const procStat = (pid: number, starttime: string): string =>
      `${pid} (command (with spaces)) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(" ")} ${starttime} 99`;
    const observations = [
      { lstart: sameSecondLstart, starttime: "100" },
      { lstart: sameSecondLstart, starttime: "101" }
    ];
    let terminateCalled = false;
    let capturedPid: number | undefined;
    cleanups.push(async () => {
      if (capturedPid !== undefined && !isProcessGone(capturedPid)) {
        process.kill(capturedPid, "SIGKILL");
        const deadlineAt = Date.now() + 2_000;
        while (!isProcessGone(capturedPid) && Date.now() < deadlineAt) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        }
      }
    });
    const executable = command("setTimeout(() => process.exit(0), 1600)", { timeoutSeconds: 1 });
    let identityReadCount = 0;
    const processTree = createInjectedLinuxProcessTreeController({
      snapshotRelationships: async (rootPid: number) => {
        capturedPid = rootPid;
        return [{ pid: rootPid, parentPid: 0 }];
      },
      readStarttime: async (pid: number) => parseLinuxProcStatStarttime(
        procStat(pid, observations[identityReadCount++]!.starttime)
      ),
      terminate: async () => {
        terminateCalled = true;
      }
    });
    const { runner, scope, store } = await createRunner([executable], {
      dependencies: {
        processTree
      }
    });

    const result = await runner.run(executable, scope);

    expect(result.outcome).toBe("cleanup_failed");
    expect(new Set(observations.map(({ lstart }) => lstart))).toHaveLength(1);
    expect(identityReadCount).toBe(2);
    expect(terminateCalled).toBe(false);
    expect(store.getGitRun(scope.runId)?.status).toBe("paused");
    expect(capturedPid).toBeDefined();
    expect(isProcessGone(capturedPid!)).toBe(false);
    if (capturedPid !== undefined) {
      const deadlineAt = Date.now() + 3_000;
      while (!isProcessGone(capturedPid) && Date.now() < deadlineAt) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      expect(isProcessGone(capturedPid)).toBe(true);
    }
    capturedPid = undefined;
    store.close();
  }, 10_000);

  it("treats a captured escaped descendant as cleanup_failed", async () => {
    const executable = command("setInterval(() => {}, 1000)", { timeoutSeconds: 1 });
    let terminated = false;
    const { runner, scope, store } = await createRunner([executable], {
      dependencies: {
        processTree: {
          snapshot: async (pid: number) => [
            { pid, started: "root-start" },
            { pid: 999_999, started: "escaped-start" }
          ],
          query: async (identity: { pid: number }) =>
            identity.pid === 999_999 ? "same" : terminated ? "absent" : "same",
          terminate: async (child: { kill: (signal?: NodeJS.Signals) => boolean }) => {
            terminated = true;
            child.kill("SIGKILL");
          }
        }
      }
    });

    const result = await runner.run(executable, scope);

    expect(result.outcome).toBe("cleanup_failed");
    expect(store.getGitRun(scope.runId)?.status).toBe("paused");
    store.close();
  }, 10_000);

  it("rejects a cwd replaced by a junction between validation and spawn", async () => {
    const executable = command("process.exit(0)", { cwd: "work" });
    let race: () => Promise<void> = async () => undefined;
    const { project, runner, scope, store } = await createRunner([executable], {
      dependencies: { beforeSpawn: async () => await race() }
    });
    const outside = await createTemporaryProject();
    cleanups.push(outside.cleanup);
    const cwd = join(project.root, "work");
    await mkdir(cwd);
    race = async () => {
      await rename(cwd, join(project.root, "work-original"));
      await symlink(outside.root, cwd, process.platform === "win32" ? "junction" : "dir");
    };

    await expect(runner.run(executable, scope))
      .rejects.toThrow(/symbolic link|reparse|identity|non-directory/u);
    store.close();
  });

  it("fences a validation operation blocked before spawn when pause begins", async () => {
    const executable = command(
      "require('node:fs').writeFileSync('validation-spawned.txt', 'spawned')"
    );
    let enterFirst!: () => void;
    const firstEntered = new Promise<void>((resolvePromise) => {
      enterFirst = resolvePromise;
    });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let beforeSpawnCalls = 0;
    const { project, runner, scope, store } = await createRunner([executable], {
      dependencies: {
        beforeSpawn: async () => {
          beforeSpawnCalls += 1;
          if (beforeSpawnCalls === 1) {
            enterFirst();
            await firstRelease;
          }
        }
      }
    });

    const inFlight = runner.run(executable, scope);
    await firstEntered;
    const deadlineAt = Date.now() + 5_000;
    const aborting = runner.abortActive(deadlineAt);
    const late = runner.run(executable, scope);
    releaseFirst();

    const [inFlightResult, lateResult, abortResult] = await Promise.allSettled([
      inFlight,
      late,
      aborting
    ]);
    const markerMissing = await stat(join(project.root, "validation-spawned.txt"))
      .then(() => false, (error: unknown) => (
        error instanceof Error && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT"
      ));
    const validationRuns = store.listValidationRuns(scope.runId);
    const hasCompletedEvent = store.listEvents(0)
      .some(({ type }) => type === "validation.completed");
    store.close();

    expect(inFlightResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringMatching(/fenced|aborted/u) })
    });
    expect(lateResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringMatching(/fenced|aborted/u) })
    });
    expect(abortResult).toEqual({ status: "fulfilled", value: undefined });
    expect(beforeSpawnCalls).toBe(1);
    expect(markerMissing).toBe(true);
    expect(validationRuns).toEqual([]);
    expect(hasCompletedEvent).toBe(false);
  });

  it("keeps redacted evidence logs within the configured byte limit", async () => {
    const executable = command("process.stdout.write('a'.repeat(600000))");
    const { runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope, { secretValues: ["a"] });

    expect((await stat(result.logPath)).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(await readFile(result.logPath, "utf8")).not.toContain("a");
    store.close();
  });

  it("keeps multibyte redacted evidence logs within the configured byte limit", async () => {
    const executable = command("process.stdout.write('x' + 'é'.repeat(2097200))");
    const { runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope);

    expect((await stat(result.logPath)).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(await readFile(result.logPath, "utf8")).not.toContain("\uFFFD");
    store.close();
  });

  it("refuses a suggested command until an exact fingerprint is approved", async () => {
    const suggested = command("process.exit(0)", { id: "suggested" });
    const { runner, scope, store } = await createRunner();

    const pending = await runner.requestGrant(suggested, scope);
    await expect(runner.run(suggested, scope))
      .rejects.toThrow(`approval required: ${pending.grantId}`);
    await runner.decideGrant(pending.grantId, "approved", "Needed for acceptance");
    await expect(runner.run(suggested, scope))
      .resolves.toEqual(expect.objectContaining({ outcome: "passed" }));
    expect(store.listEvents(0).some(({ type }) => type === "user.approval.requested")).toBe(true);
    store.close();
  });

  it("rejects obvious grant secrets without persisting the literal in grants or events", async () => {
    const { runner, scope, store } = await createRunner();
    const secretCommands = [
      command("process.exit(0)", {
        id: "token-secret",
        args: ["--api-token=known-secret"]
      }),
      command("process.exit(0)", {
        id: "password-secret",
        args: ["--password", "known-password"]
      }),
      command("process.exit(0)", {
        id: "bearer-secret",
        args: ["Authorization: Bearer known-bearer"]
      })
    ];

    for (const secretCommand of secretCommands) {
      await expect(runner.requestGrant(secretCommand, scope))
        .rejects.toThrow("suggested validation command contains an obvious sensitive literal");
    }
    const persisted = JSON.stringify({
      grants: store.listValidationCommandGrants(scope.runId, scope.taskId!),
      events: store.listEvents(0)
    });
    expect(persisted).not.toContain("known-secret");
    expect(persisted).not.toContain("known-password");
    expect(persisted).not.toContain("known-bearer");

    await expect(runner.requestGrant(command("process.exit(0)", { id: "ordinary" }), scope))
      .resolves.toEqual(expect.objectContaining({ status: "pending" }));
    store.close();
  });

  it("does not let approval cover changed args, cwd, timeout, or workspace", async () => {
    const suggested = command("process.exit(0)", { id: "suggested" });
    const { project, runner, scope, store } = await createRunner();
    const pending = await runner.requestGrant(suggested, scope);
    await runner.decideGrant(pending.grantId, "approved", "Needed for acceptance");

    await expect(runner.run({ ...suggested, args: [...suggested.args, "--write"] }, scope))
      .rejects.toThrow("approval required");
    await mkdir(resolve(project.root, "subdir"));
    await expect(runner.run({ ...suggested, cwd: "subdir" }, scope))
      .rejects.toThrow("approval required");
    await expect(runner.run({ ...suggested, timeoutSeconds: 6 }, scope))
      .rejects.toThrow("approval required");

    const otherScope = { ...scope, workspaceId: "workspace-2", workspaceRoot: resolve(project.root, "other") };
    await mkdir(otherScope.workspaceRoot);
    store.putGitWorkspace({
      workspaceId: "workspace-2", runId: "run-1", taskId: "task-1", employeeId: "developer",
      kind: "task", path: otherScope.workspaceRoot,
      branchRef: "refs/heads/agenttown/run-1/task-2", baseCommit: "a".repeat(40),
      headCommit: "a".repeat(40), status: "active"
    });
    await expect(runner.run(suggested, otherScope)).rejects.toThrow("approval required");
    store.close();
  });
});
