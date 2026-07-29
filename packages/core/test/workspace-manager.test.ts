import {
  access,
  mkdir,
  rm,
  symlink
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitCommandRunner,
  type GitCommandOptions,
  type GitCommandResult
} from "../src/git/git-command.js";
import {
  WorkspaceManager,
  candidateRef,
  integrationRef,
  taskRef
} from "../src/git/workspace-manager.js";
import { RepositoryPreflight, type RepositoryBaseline } from "../src/git/repository-preflight.js";
import { CoreStore } from "../src/storage/core-store.js";
import { companyDefinitionFixture } from "./helpers.js";
import {
  createGitFixture,
  type GitFixture
} from "./helpers/git-fixture.js";

const fixtures: GitFixture[] = [];
const GIT_TEST_TIMEOUT_MS = 20_000;
let store: CoreStore;
let repo: GitFixture;
let baseline: RepositoryBaseline;
let manager: WorkspaceManager;

async function setupRepository(usePreflight = false): Promise<void> {
  repo = await createGitFixture();
  fixtures.push(repo);
  baseline = usePreflight
    ? await new RepositoryPreflight().inspect(repo.root)
    : {
        projectRoot: repo.root,
        gitCommonDir: (await repo.git([
          "rev-parse",
          "--git-common-dir"
        ])).stdout.trim(),
        originalBranch: "main",
        baseCommit: await head(),
        objectIdLength: 40
      };
}

async function head(cwd = repo.root): Promise<string> {
  return (await repo.git(["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
}

async function currentBranch(cwd = repo.root): Promise<string> {
  return (await repo.git(["-C", cwd, "branch", "--show-current"])).stdout.trim();
}

async function status(cwd = repo.root): Promise<string> {
  return (await repo.git([
    "-C",
    cwd,
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ])).stdout;
}

async function refExists(ref: string): Promise<boolean> {
  return (await repo.git(
    ["show-ref", "--verify", "--quiet", ref],
    [0, 1]
  )).exitCode === 0;
}

async function createTaskWorkspace() {
  const run = await manager.createRun("run-1", baseline);
  return manager.createTaskWorkspace({
    runId: run.runId,
    employeeId: "developer-a",
    taskId: "task-a",
    baseCommit: run.integrationCommit
  });
}

beforeEach(async () => {
  store = new CoreStore(":memory:");
  store.initialize();
  store.createCompany({
    id: "company",
    definition: companyDefinitionFixture(),
    event: {
      id: crypto.randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: { companyId: "company" }
    }
  });
  manager = new WorkspaceManager({
    store,
    companyId: "company"
  });
});

afterEach(async () => {
  store.close();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("workspace ref builders", () => {
  it("builds refs only from independently validated identifier segments", () => {
    expect(integrationRef("run-1"))
      .toBe("refs/heads/agenttown/run-1/integration");
    expect(taskRef("run-1", "developer-a", "task-a"))
      .toBe("refs/heads/agenttown/run-1/developer-a/task-a");
    expect(candidateRef("run-1", "attempt-a"))
      .toBe("refs/heads/agenttown/run-1/candidate/attempt-a");

    expect(() => integrationRef("../escape")).toThrow("run id");
    expect(() => taskRef("run-1", "../escape", "task-a")).toThrow("employee id");
    expect(() => candidateRef("run-1", "refs/heads/main")).toThrow("attempt id");
  });
});

describe("WorkspaceManager", () => {
  it("creates integration and task worktrees without moving the user branch", async () => {
    await setupRepository(true);
    const beforeHead = await head();
    const beforeBranch = await currentBranch();
    const beforeStatus = await status();

    const run = await manager.createRun("run-1", baseline);
    const task = await manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "developer-a",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    });

    expect(await head()).toBe(beforeHead);
    expect(await currentBranch()).toBe(beforeBranch);
    expect(await status()).toBe(beforeStatus);
    expect(task.branchRef)
      .toBe("refs/heads/agenttown/run-1/developer-a/task-a");
    expect(await head(task.path)).toBe(beforeHead);
    expect(store.getGitRun("run-1")).toEqual(run);
    expect(store.getGitWorkspace(task.workspaceId)).toEqual(task);
    expect(store.listEvents(0).at(-1)?.type).toBe("git.workspace.created");
  }, GIT_TEST_TIMEOUT_MS);

  it("creates a candidate worktree from a validated attempt id", async () => {
    await setupRepository();
    const run = await manager.createRun("run-1", baseline);

    const candidate = await manager.createCandidateWorkspace({
      runId: run.runId,
      attemptId: "attempt-a",
      baseCommit: run.integrationCommit
    });

    expect(candidate.kind).toBe("candidate");
    expect(candidate.branchRef)
      .toBe("refs/heads/agenttown/run-1/candidate/attempt-a");
    expect(await head(candidate.path)).toBe(run.integrationCommit);
    await expect(manager.createCandidateWorkspace({
      runId: run.runId,
      attemptId: "../escape",
      baseCommit: run.integrationCommit
    })).rejects.toThrow("attempt id");
  }, GIT_TEST_TIMEOUT_MS);

  it("rejects a task path that resolves outside the run root", async () => {
    await expect(manager.createTaskWorkspace({
      runId: "run-1",
      employeeId: "developer-a",
      taskId: "../escape",
      baseCommit: "a".repeat(40)
    })).rejects.toThrow("task id");
  });

  it("rejects a run root that is redirected outside the project", async () => {
    await setupRepository();
    const outside = join(dirname(repo.root), "outside");
    await symlink(outside, join(repo.root, ".agenttown"), "junction");

    await expect(manager.createRun("run-1", baseline))
      .rejects.toThrow(/symbolic link|reparse/u);
    expect(store.getGitRun("run-1")?.status).toBe("tampered");
  }, GIT_TEST_TIMEOUT_MS);

  it("preserves worktrees on pause and removes only a verified worktree", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");

    await expect(access(task.path)).resolves.toBeUndefined();
    expect(store.getGitRun("run-1")?.status).toBe("paused");
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("paused");

    await manager.removeVerifiedWorkspace(task.workspaceId);

    await expect(access(task.path)).rejects.toThrow();
    expect(await refExists(task.branchRef)).toBe(true);
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("missing");
  }, GIT_TEST_TIMEOUT_MS);

  it("refuses cleanup while active or when the verified worktree is dirty", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/completed or paused/u);

    await manager.pauseRun("run-1");
    await repo.write(
      join(".agenttown", "worktrees", "run-1", "task-developer-a-task-a", "dirty.txt"),
      "dirty\n"
    );

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow("uncommitted changes");
    await expect(access(task.path)).resolves.toBeUndefined();
  }, GIT_TEST_TIMEOUT_MS);

  it("persists tampered when cleanup verification finds a changed branch ref", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    const tree = (await repo.git([
      "rev-parse",
      `${task.headCommit}^{tree}`
    ])).stdout.trim();
    const changedHead = (await repo.git([
      "commit-tree",
      tree,
      "-p",
      task.headCommit,
      "-m",
      "external ref change"
    ])).stdout.trim();
    await repo.git(["update-ref", task.branchRef, changedHead]);

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/ref or head|branch ref|recorded head/u);

    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("tampered");
    await expect(access(task.path)).resolves.toBeUndefined();
  }, GIT_TEST_TIMEOUT_MS);

  it("never removes a pre-existing exact worktree during failed creation", async () => {
    await setupRepository();
    const path = join(
      repo.root,
      ".agenttown",
      "worktrees",
      "run-1",
      "integration"
    );
    const ref = integrationRef("run-1");
    await mkdir(dirname(path), { recursive: true });
    await repo.git([
      "worktree",
      "add",
      "-b",
      ref.slice("refs/heads/".length),
      path,
      baseline.baseCommit
    ]);

    await expect(manager.createRun("run-1", baseline))
      .rejects.toThrow("already exists");

    await expect(access(path)).resolves.toBeUndefined();
    expect(await refExists(ref)).toBe(true);
    expect(store.getGitRun("run-1")?.status).toBe("tampered");
  }, GIT_TEST_TIMEOUT_MS);

  it("preserves stale exact worktree metadata and ref as tampered", async () => {
    await setupRepository();
    const delegate = new GitCommandRunner();
    const disappearingGit = {
      async run(
        args: readonly string[],
        options: GitCommandOptions
      ): Promise<GitCommandResult> {
        const result = await delegate.run(args, options);
        if (args[0] === "worktree" && args[1] === "add") {
          const path = args[5];
          if (path === undefined) throw new Error("missing worktree path");
          await rm(path, { recursive: true, force: true });
        }
        return result;
      }
    };
    manager = new WorkspaceManager({
      store,
      companyId: "company",
      git: disappearingGit
    });

    await expect(manager.createRun("run-1", baseline)).rejects.toThrow();

    const run = store.getGitRun("run-1");
    expect(run?.status).toBe("tampered");
    expect(run === null ? false : await refExists(run.integrationRef)).toBe(true);
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .toContain("agenttown");
  }, GIT_TEST_TIMEOUT_MS);

  it("does not roll back Git after facts commit when event publication throws", async () => {
    await setupRepository();
    const unsubscribe = store.subscribeEvents(() => {
      throw new Error("listener failure");
    });

    await expect(manager.createRun("run-1", baseline))
      .rejects.toThrow("listener failure");
    unsubscribe();

    const run = store.getGitRun("run-1");
    expect(run?.status).toBe("active");
    const integration = store.getGitWorkspace("run-1:integration");
    expect(integration?.status).toBe("active");
    await expect(access(integration?.path ?? "")).resolves.toBeUndefined();
    expect(store.listEvents(0).at(-1)?.type).toBe("git.run.created");
  }, GIT_TEST_TIMEOUT_MS);
});
