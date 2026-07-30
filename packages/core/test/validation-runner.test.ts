import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompanyDefinition, ValidationCommand } from "@agenttown/runtime-contract";
import { CoreStore, ValidationRunner, type ValidationScope } from "../src/index.js";
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

async function createRunner(commands: ValidationCommand[] = []) {
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
  return {
    project,
    store,
    scope,
    runner: new ValidationRunner({ store, company })
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

  it("redacts configured secret values before persistence", async () => {
    const executable = command("process.stdout.write('secret-value')");
    const { runner, scope, store } = await createRunner([executable]);

    const result = await runner.run(executable, scope, { secretValues: ["secret-value"] });

    expect(await readFile(result.logPath, "utf8")).not.toContain("secret-value");
    expect(await readFile(result.logPath, "utf8")).toContain("[REDACTED]");
    store.close();
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
