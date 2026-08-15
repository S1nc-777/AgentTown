import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CleanupService,
  CoreStore,
  WorkspaceManager,
  createInjectedCleanupService
} from "../src/index.js";
import type { ValidationRunRecord } from "@agenttown/runtime-contract";
import { companyDefinitionFixture } from "./helpers.js";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
const stores: CoreStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness(): Promise<{
  repo: GitFixture;
  store: CoreStore;
  manager: WorkspaceManager;
  service: CleanupService;
  baseCommit: string;
}> {
  const repo = await createGitFixture();
  cleanups.push(repo.cleanup);
  const store = new CoreStore(join(dirname(repo.root), "core.sqlite"));
  stores.push(store);
  store.initialize();
  store.createCompany({
    id: "company-1",
    definition: companyDefinitionFixture(),
    event: {
      id: randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: {}
    }
  });
  const baseCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  const manager = new WorkspaceManager({ store, companyId: "company-1" });
  await manager.createRun("run-1", {
    projectRoot: repo.root,
    originalBranch: "main",
    baseCommit,
    objectIdLength: baseCommit.length === 40 ? 40 : 64,
    gitCommonDir: await repo.gitPath(".")
  });
  const service = new CleanupService({
    store,
    companyId: "company-1",
    workspaceManager: manager
  });
  return { repo, store, manager, service, baseCommit };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function validationRecord(
  projectRoot: string,
  validationId: string,
  logHash: string
): ValidationRunRecord {
  return {
    validationId,
    runId: "run-1",
    taskId: "task-a",
    integrationAttemptId: null,
    command: {
      id: validationId,
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    },
    workspaceId: "run-1:integration",
    outcome: "passed",
    exitCode: 0,
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    logPath: join(
      projectRoot,
      ".agenttown",
      "runs",
      "run-1",
      "validation",
      `${validationId}.log`
    ),
    logHash
  };
}

async function createReviewEvidence(
  store: CoreStore,
  validation: ValidationRunRecord
): Promise<{ evidenceRoot: string; manifestPath: string }> {
  const run = store.getGitRun("run-1")!;
  const evidenceRoot = join(
    run.projectRoot,
    ".agenttown",
    "runs",
    "run-1",
    "reviews",
    "task-a",
    "1"
  );
  const validationDirectory = join(evidenceRoot, "validation");
  await mkdir(validationDirectory, { recursive: true });
  const taskBytes = Buffer.from("{}", "utf8");
  const validationBytes = Buffer.from(`${JSON.stringify(validation)}\n`, "utf8");
  const logBytes = await readFile(validation.logPath);
  const files = {
    "task.json": {
      sha256: createHash("sha256").update(taskBytes).digest("hex"),
      size: taskBytes.length
    },
    [`validation/${validation.command.id}.json`]: {
      sha256: createHash("sha256").update(validationBytes).digest("hex"),
      size: validationBytes.length
    },
    [`validation/${validation.command.id}.log`]: {
      sha256: createHash("sha256").update(logBytes).digest("hex"),
      size: logBytes.length
    }
  };
  await writeFile(join(evidenceRoot, "task.json"), taskBytes);
  await writeFile(
    join(validationDirectory, `${validation.command.id}.json`),
    validationBytes
  );
  await writeFile(
    join(validationDirectory, `${validation.command.id}.log`),
    logBytes
  );
  const payloadBytes = Object.values(files)
    .reduce((total, file) => total + file.size, 0);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-a",
    employeeId: "developer",
    revision: 1,
    baseCommit: run.baseCommit,
    headCommit: run.integrationCommit,
    commits: [run.integrationCommit],
    generatedAt: "2026-07-30T00:00:02.000Z",
    files,
    totalFiles: Object.keys(files).length,
    totalBytes: payloadBytes
  }), "utf8");
  const manifestPath = join(evidenceRoot, "manifest.json");
  await writeFile(manifestPath, manifest);
  store.putReviewPackage({
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    manifestPath,
    manifestHash: createHash("sha256").update(manifest).digest("hex"),
    totalBytes: payloadBytes + manifest.length,
    status: "verified"
  });
  return { evidenceRoot, manifestPath };
}

async function prepareEvidenceHarness() {
  const harness = await createHarness();
  await harness.manager.pauseRun("run-1");
  const validationRoot = join(
    harness.store.getGitRun("run-1")!.projectRoot,
    ".agenttown",
    "runs",
    "run-1",
    "validation"
  );
  await mkdir(validationRoot, { recursive: true });
  const log = Buffer.from("tests passed\n", "utf8");
  const validation = validationRecord(
    harness.store.getGitRun("run-1")!.projectRoot,
    "validation-1",
    createHash("sha256").update(log).digest("hex")
  );
  await writeFile(validation.logPath, log);
  harness.store.putValidationRun(validation);
  const evidence = await createReviewEvidence(harness.store, validation);
  return { ...harness, validation, ...evidence };
}

describe("CleanupService", () => {
  it("previews and removes only verified paused worktrees by default", async () => {
    const { repo, store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const workspace = store.getGitWorkspace("run-1:integration")!;

    const preview = await service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    });
    expect(preview.workspaces).toEqual([{
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      branchRef: workspace.branchRef,
      headCommit: workspace.headCommit
    }]);
    expect(preview.branchRefs).toEqual([]);

    await expect(service.execute({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false,
      fingerprint: preview.fingerprint
    })).resolves.toEqual({
      removedWorkspaces: 1,
      removedBranches: 0,
      removedEvidenceRoots: 0
    });
    expect(await exists(workspace.path)).toBe(false);
    expect((await repo.git(["show-ref", "--verify", "--hash", workspace.branchRef])).stdout.trim())
      .toBe(workspace.headCommit);
  });

  it("removes stored branch refs only with the explicit branch flag", async () => {
    const { repo, store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const workspace = store.getGitWorkspace("run-1:integration")!;
    const worktreePreview = await service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    });
    await service.execute({ ...worktreePreview });

    const branchPreview = await service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: true,
      removeEvidence: false
    });
    expect(branchPreview.branchRefs).toEqual([{
      ref: workspace.branchRef,
      headCommit: workspace.headCommit
    }]);
    await service.execute({ ...branchPreview });

    expect((await repo.git(
      ["show-ref", "--verify", "--hash", workspace.branchRef],
      [0, 1, 128]
    )).exitCode).not.toBe(0);
  });

  it("invalidates a preview when durable facts change", async () => {
    const { store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const preview = await service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    });
    const workspace = store.getGitWorkspace("run-1:integration")!;
    store.putGitWorkspace({ ...workspace, status: "tampered" });

    await expect(service.execute({ ...preview }))
      .rejects.toThrow(/changed|fingerprint|tampered/iu);
    expect(await exists(workspace.path)).toBe(true);
  });

  it("refuses dirty worktrees without removing them", async () => {
    const { store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const workspace = store.getGitWorkspace("run-1:integration")!;
    await writeFile(join(workspace.path, "dirty.txt"), "dirty\n", "utf8");

    await expect(service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    })).rejects.toThrow("uncommitted changes");
    expect(await readFile(join(workspace.path, "dirty.txt"), "utf8")).toBe("dirty\n");
  });

  it("refuses a registered worktree whose stored branch ref disappeared", async () => {
    const { repo, store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const workspace = store.getGitWorkspace("run-1:integration")!;
    await repo.git(["update-ref", "-d", workspace.branchRef, workspace.headCommit]);

    await expect(service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    })).rejects.toThrow("mismatch");
    expect(await exists(workspace.path)).toBe(true);
  });

  it("refuses a foreign registered worktree inside the exact run namespace", async () => {
    const { repo, store, manager, service, baseCommit } = await createHarness();
    await manager.pauseRun("run-1");
    const foreignPath = join(
      store.getGitRun("run-1")!.projectRoot,
      ".agenttown",
      "worktrees",
      "run-1",
      "foreign"
    );
    await repo.git([
      "worktree",
      "add",
      "-b",
      "agenttown/run-1/foreign",
      foreignPath,
      baseCommit
    ]);

    await expect(service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    })).rejects.toThrow(/foreign|inventory|durable/iu);
    expect(await exists(foreignPath)).toBe(true);
  });

  it("refuses a foreign ref inside the exact run branch namespace", async () => {
    const { repo, manager, service, baseCommit } = await createHarness();
    await manager.pauseRun("run-1");
    await repo.git([
      "update-ref",
      "refs/heads/agenttown/run-1/foreign",
      baseCommit
    ]);

    await expect(service.preview({
      runId: "run-1",
      removeWorktrees: true,
      removeBranches: false,
      removeEvidence: false
    })).rejects.toThrow(/foreign|inventory|durable/iu);
  });

  it("removes only stored run evidence roots and marks packages deleted", async () => {
    const { store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const validationRoot = join(
      store.getGitRun("run-1")!.projectRoot,
      ".agenttown",
      "runs",
      "run-1",
      "validation"
    );
    await mkdir(validationRoot, { recursive: true });
    const logPath = join(validationRoot, "validation-1.log");
    const log = Buffer.from("tests passed\n", "utf8");
    await writeFile(logPath, log);
    const validation = validationRecord(
      store.getGitRun("run-1")!.projectRoot,
      "validation-1",
      createHash("sha256").update(log).digest("hex")
    );
    store.putValidationRun(validation);
    const { evidenceRoot } = await createReviewEvidence(store, validation);

    const unrelatedLog = Buffer.from("unrelated\n", "utf8");
    const unrelated = validationRecord(
      store.getGitRun("run-1")!.projectRoot,
      "validation-unrelated",
      createHash("sha256").update(unrelatedLog).digest("hex")
    );
    await writeFile(unrelated.logPath, unrelatedLog);
    store.putValidationRun(unrelated);

    const preview = await service.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });
    expect(preview.evidenceRoots).toEqual([evidenceRoot, logPath].sort());
    await service.execute({ ...preview });

    expect(await exists(evidenceRoot)).toBe(false);
    expect(await exists(logPath)).toBe(false);
    expect(store.getReviewPackage("run-1", "task-a", 1)?.status).toBe("deleted");
    expect(store.getValidationRun("validation-1")).toBeNull();
    expect(store.getValidationRun("validation-unrelated")).toEqual(unrelated);
    expect(await exists(unrelated.logPath)).toBe(true);
  });

  it("refuses evidence packages with files outside the exact manifest inventory", async () => {
    const { store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const validationRoot = join(
      store.getGitRun("run-1")!.projectRoot,
      ".agenttown",
      "runs",
      "run-1",
      "validation"
    );
    await mkdir(validationRoot, { recursive: true });
    const log = Buffer.from("tests passed\n", "utf8");
    const validation = validationRecord(
      store.getGitRun("run-1")!.projectRoot,
      "validation-1",
      createHash("sha256").update(log).digest("hex")
    );
    await writeFile(validation.logPath, log);
    store.putValidationRun(validation);
    const { evidenceRoot } = await createReviewEvidence(store, validation);
    await writeFile(join(evidenceRoot, "foreign.txt"), "not in manifest\n", "utf8");

    await expect(service.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    })).rejects.toThrow(/inventory|manifest|foreign|path set/iu);
    expect(await exists(evidenceRoot)).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "refuses a review root redirected through a junction",
    async () => {
      const { store, manager, service } = await createHarness();
      await manager.pauseRun("run-1");
      const runRoot = join(
        store.getGitRun("run-1")!.projectRoot,
        ".agenttown",
        "runs",
        "run-1"
      );
      const outside = join(dirname(store.getGitRun("run-1")!.projectRoot), "outside-evidence");
      await mkdir(outside, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await symlink(outside, join(runRoot, "reviews"), "junction");
      const manifestPath = join(runRoot, "reviews", "task-a", "1", "manifest.json");
      await mkdir(dirname(manifestPath), { recursive: true });
      const manifest = Buffer.from("{}", "utf8");
      await writeFile(manifestPath, manifest);
      store.putReviewPackage({
        runId: "run-1",
        taskId: "task-a",
        revision: 1,
        manifestPath,
        manifestHash: createHash("sha256").update(manifest).digest("hex"),
        totalBytes: manifest.length,
        status: "verified"
      });

      await expect(service.preview({
        runId: "run-1",
        removeWorktrees: false,
        removeBranches: false,
        removeEvidence: true
      })).rejects.toThrow(/redirect|reparse|junction|outside/iu);
      expect(await exists(manifestPath)).toBe(true);
    }
  );

  it("binds the cleanup fingerprint to complete durable validation facts", async () => {
    const { store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const validationRoot = join(
      store.getGitRun("run-1")!.projectRoot,
      ".agenttown",
      "runs",
      "run-1",
      "validation"
    );
    await mkdir(validationRoot, { recursive: true });
    const log = Buffer.from("tests passed\n", "utf8");
    const validation = validationRecord(
      store.getGitRun("run-1")!.projectRoot,
      "validation-1",
      createHash("sha256").update(log).digest("hex")
    );
    await writeFile(validation.logPath, log);
    store.putValidationRun(validation);
    await createReviewEvidence(store, validation);
    const preview = await service.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });
    store.putValidationRun({
      ...validation,
      command: { ...validation.command, args: ["test", "--changed"] }
    });

    await expect(service.execute({ ...preview }))
      .rejects.toThrow(/changed|fingerprint|validation/iu);
    expect(await exists(validation.logPath)).toBe(true);
  });

  it("rolls back quarantined evidence after a crash before the database commit", async () => {
    const harness = await prepareEvidenceHarness();
    const crashed = createInjectedCleanupService({
      store: harness.store,
      companyId: "company-1",
      workspaceManager: harness.manager
    }, {
      afterEvidencePrepared: async () => {
        throw new Error("simulated crash after evidence prepare");
      }
    });
    const preview = await crashed.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });

    await expect(crashed.execute({ ...preview }))
      .rejects.toThrow("simulated crash");
    expect(await exists(harness.evidenceRoot)).toBe(false);
    expect(harness.store.getReviewPackage("run-1", "task-a", 1)).not.toBeNull();

    const recovered = new CleanupService({
      store: harness.store,
      companyId: "company-1",
      workspaceManager: harness.manager
    });
    await recovered.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });
    expect(await exists(harness.evidenceRoot)).toBe(true);
    expect(await exists(harness.validation.logPath)).toBe(true);
    expect(harness.store.listEvents(0).map(({ type }) => type))
      .toContain("git.cleanup.rolled_back");
  });

  it("replays finalization after a crash following the atomic database commit", async () => {
    const harness = await prepareEvidenceHarness();
    const crashed = createInjectedCleanupService({
      store: harness.store,
      companyId: "company-1",
      workspaceManager: harness.manager
    }, {
      afterDatabaseCommitted: async () => {
        throw new Error("simulated crash after database commit");
      }
    });
    const preview = await crashed.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });

    await expect(crashed.execute({ ...preview }))
      .rejects.toThrow("simulated crash");
    expect(harness.store.getReviewPackage("run-1", "task-a", 1)?.status)
      .toBe("deleted");
    expect(harness.store.getValidationRun(harness.validation.validationId)).toBeNull();

    const recovered = new CleanupService({
      store: harness.store,
      companyId: "company-1",
      workspaceManager: harness.manager
    });
    await recovered.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });
    expect(await exists(harness.evidenceRoot)).toBe(false);
    expect(await exists(harness.validation.logPath)).toBe(false);
    expect(harness.store.listEvents(0).map(({ type }) => type))
      .toContain("git.cleanup.completed");
  });

  it("rolls back prepared evidence after an injected database failure", async () => {
    const harness = await prepareEvidenceHarness();
    const failed = createInjectedCleanupService({
      store: harness.store,
      companyId: "company-1",
      workspaceManager: harness.manager
    }, {
      commitCleanup: () => {
        throw new Error("simulated database failure");
      }
    });
    const preview = await failed.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });

    await expect(failed.execute({ ...preview }))
      .rejects.toThrow("simulated database failure");
    expect(await exists(harness.evidenceRoot)).toBe(false);

    const recovered = new CleanupService({
      store: harness.store,
      companyId: "company-1",
      workspaceManager: harness.manager
    });
    await recovered.preview({
      runId: "run-1",
      removeWorktrees: false,
      removeBranches: false,
      removeEvidence: true
    });
    expect(await exists(harness.evidenceRoot)).toBe(true);
    expect(harness.store.getReviewPackage("run-1", "task-a", 1)?.status)
      .toBe("verified");
  });
});
