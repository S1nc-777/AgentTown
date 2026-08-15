import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CleanupService,
  CoreStore,
  WorkspaceManager
} from "../src/index.js";
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

  it("removes only stored run evidence roots and marks packages deleted", async () => {
    const { store, manager, service } = await createHarness();
    await manager.pauseRun("run-1");
    const evidenceRoot = join(
      store.getGitRun("run-1")!.projectRoot,
      ".agenttown",
      "runs",
      "run-1",
      "reviews",
      "task-a",
      "1"
    );
    await mkdir(evidenceRoot, { recursive: true });
    const manifestPath = join(evidenceRoot, "manifest.json");
    const manifest = Buffer.from("{}\n", "utf8");
    await writeFile(manifestPath, manifest);
    store.putReviewPackage({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      manifestPath,
      manifestHash: createHash("sha256").update(manifest).digest("hex"),
      totalBytes: 3,
      status: "verified"
    });
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
    store.putValidationRun({
      validationId: "validation-1",
      runId: "run-1",
      taskId: "task-a",
      integrationAttemptId: null,
      command: {
        id: "unit",
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
      logPath,
      logHash: createHash("sha256").update(log).digest("hex")
    });

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
  });
});
