import {
  access,
  mkdir,
  rm,
  symlink,
  writeFile
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

function createCompany(target: CoreStore, id: string): void {
  target.createCompany({
    id,
    definition: companyDefinitionFixture(),
    event: {
      id: crypto.randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: { companyId: id }
    }
  });
}

class RemovalCompletionFaultStore extends CoreStore {
  failCompletion = false;
  failCreation = false;
  failRunCreation = false;

  override commitGitRunCreation(
    input: Parameters<CoreStore["commitGitRunCreation"]>[0]
  ): void {
    if (this.failRunCreation) {
      throw new Error("injected run creation commit failure");
    }
    super.commitGitRunCreation(input);
  }

  override commitGitWorkspace(
    input: Parameters<CoreStore["commitGitWorkspace"]>[0]
  ): void {
    if (
      this.failCompletion
      && input.event.type === "git.workspace.removed"
    ) {
      throw new Error("injected removal completion failure");
    }
    if (
      this.failCreation
      && input.event.type === "git.workspace.created"
    ) {
      throw new Error("injected workspace creation commit failure");
    }
    super.commitGitWorkspace(input);
  }
}

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
  createCompany(store, "company");
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
    expect(() => taskRef("run-1", "candidate", "task-a"))
      .toThrow(/reserved|employee/u);
    expect(() => taskRef("run-1", "integration", "task-a"))
      .toThrow(/reserved|employee/u);
    expect(() => candidateRef("run-1", "refs/heads/main")).toThrow("attempt id");
  });

  it("keeps the public task ref contract injective with reserved roots", () => {
    const taskLeft = taskRef("run-1", "a-b", "c");
    const taskRight = taskRef("run-1", "a", "b-c");
    expect(taskLeft).not.toBe(taskRight);
    expect(taskLeft).toBe("refs/heads/agenttown/run-1/a-b/c");
    expect(taskRight).toBe("refs/heads/agenttown/run-1/a/b-c");

    expect(() => taskRef("run-1", "candidate", "attempt-a")).toThrow();
    expect(() => taskRef("run-1", "integration", "task-a")).toThrow();
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

  it("adopts project-root commits when the task worktree has none", async () => {
    await setupRepository(true);
    const run = await manager.createRun("run-1", baseline);
    const task = await manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "developer-a",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    });
    expect(task.headCommit).toBe(run.integrationCommit);

    // Employee commits directly in the project root instead of the worktree.
    await writeFile(join(repo.root, "feature.txt"), "feature\n", "utf8");
    await repo.git(["add", "feature.txt"]);
    await repo.git(["commit", "-m", "feat: employee committed in project root"]);
    const adoptedHead = await head();

    const advanced = await manager.adoptProjectRootCommits(task, adoptedHead);
    expect(advanced.headCommit).toBe(adoptedHead);
    expect(await head(task.path)).toBe(adoptedHead);
    expect((await repo.git(["show-ref", "--verify", task.branchRef]))
      .stdout.trim().split(" ")[0]).toBe(adoptedHead);
    expect(store.getGitWorkspace(task.workspaceId)?.headCommit).toBe(adoptedHead);
    expect(store.listEvents(0).at(-1)?.type).toBe("git.workspace.advanced");
  }, GIT_TEST_TIMEOUT_MS);

  it("never overwrites a task worktree that already has its own commits", async () => {
    await setupRepository(true);
    const run = await manager.createRun("run-1", baseline);
    const task = await manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "developer-a",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    });
    await writeFile(join(task.path, "a.txt"), "a\n", "utf8");
    await repo.git(["-C", task.path, "add", "a.txt"]);
    await repo.git(["-C", task.path, "commit", "-m", "task work"]);
    const taskHead = await head(task.path);

    await writeFile(join(repo.root, "root.txt"), "r\n", "utf8");
    await repo.git(["add", "root.txt"]);
    await repo.git(["commit", "-m", "root work"]);
    const rootHead = await head();

    const advanced = await manager.adoptProjectRootCommits(task, rootHead);
    expect(advanced.headCommit).toBe(task.headCommit);
    expect(await head(task.path)).toBe(taskHead);
    expect(store.getGitWorkspace(task.workspaceId)?.headCommit).toBe(task.headCommit);
  }, GIT_TEST_TIMEOUT_MS);

  it("resolves the canonical task commit range base..head", async () => {
    await setupRepository(true);
    const run = await manager.createRun("run-1", baseline);
    const task = await manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "developer-a",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    });
    await writeFile(join(repo.root, "one.txt"), "1\n", "utf8");
    await repo.git(["add", "one.txt"]);
    await repo.git(["commit", "-m", "feat: one"]);
    const head1 = await head();
    await writeFile(join(repo.root, "two.txt"), "2\n", "utf8");
    await repo.git(["add", "two.txt"]);
    await repo.git(["commit", "-m", "feat: two"]);
    const head2 = await head();

    expect(await manager.resolveTaskCommitRange(task, head2))
      .toEqual([head1, head2]);
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

  it("creates distinct domain-separated worktree paths for lookalike ids", async () => {
    await setupRepository();
    const run = await manager.createRun("run-1", baseline);
    const workspaces = [
      await manager.createTaskWorkspace({
        runId: run.runId,
        employeeId: "a-b",
        taskId: "c",
        baseCommit: run.integrationCommit
      }),
      await manager.createTaskWorkspace({
        runId: run.runId,
        employeeId: "a",
        taskId: "b-c",
        baseCommit: run.integrationCommit
      }),
      await manager.createCandidateWorkspace({
        runId: run.runId,
        attemptId: "attempt-a",
        baseCommit: run.integrationCommit
      })
    ];

    expect(new Set(workspaces.map(({ path }) => path))).toHaveLength(3);
    expect(new Set(workspaces.map(({ branchRef }) => branchRef))).toHaveLength(3);
    expect(workspaces[0]?.path).toBe(join(
      repo.root,
      ".agenttown",
      "worktrees",
      "run-1",
      "a-b",
      "c"
    ));
    expect(workspaces[2]?.path).toBe(join(
      repo.root,
      ".agenttown",
      "worktrees",
      "run-1",
      "candidate",
      "attempt-a"
    ));
    await expect(manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "candidate",
      taskId: "attempt-a",
      baseCommit: run.integrationCommit
    })).rejects.toThrow(/reserved|employee/u);
    await expect(manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "integration",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    })).rejects.toThrow(/reserved|employee/u);
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
      join(
        ".agenttown",
        "worktrees",
        "run-1",
        "developer-a",
        "task-a",
        "dirty.txt"
      ),
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

  it("durably prepares removal before Git mutation and retries after Git failure", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    const delegate = new GitCommandRunner();
    let statusObservedByRemove: string | undefined;
    let preparedEventObserved = false;
    const failingGit = {
      async run(
        args: readonly string[],
        options: GitCommandOptions
      ): Promise<GitCommandResult> {
        if (args[0] === "worktree" && args[1] === "remove") {
          statusObservedByRemove =
            store.getGitWorkspace(task.workspaceId)?.status;
          preparedEventObserved = store.listEvents(0).some(
            ({ type }) => type === "git.workspace.removal_prepared"
          );
          throw new Error("injected worktree removal failure");
        }
        return delegate.run(args, options);
      }
    };
    manager = new WorkspaceManager({
      store,
      companyId: "company",
      git: failingGit
    });

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow("injected worktree removal failure");
    expect(statusObservedByRemove).toBe("removing");
    expect(preparedEventObserved).toBe(true);
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("removing");
    await expect(access(task.path)).resolves.toBeUndefined();

    manager = new WorkspaceManager({ store, companyId: "company" });
    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .resolves.toBeUndefined();
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("missing");
    await expect(access(task.path)).rejects.toThrow();
    expect(await refExists(task.branchRef)).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("recovers removing state after final store failure and clears stale metadata", async () => {
    store.close();
    const faultStore = new RemovalCompletionFaultStore(":memory:");
    store = faultStore;
    store.initialize();
    createCompany(store, "company");
    manager = new WorkspaceManager({ store, companyId: "company" });
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    faultStore.failCompletion = true;

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow("injected removal completion failure");
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("removing");
    await expect(access(task.path)).rejects.toThrow();
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .not.toContain(task.path);
    expect(await refExists(task.branchRef)).toBe(true);

    faultStore.failCompletion = false;
    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .resolves.toBeUndefined();
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("missing");
    expect(store.listEvents(0).at(-1)?.type).toBe("git.workspace.removed");
  }, GIT_TEST_TIMEOUT_MS);

  it("cleans exact stale worktree metadata when a registered path disappears", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    await rm(task.path, { recursive: true, force: true });
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .toContain(task.path.replaceAll("\\", "/"));

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .resolves.toBeUndefined();

    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("missing");
    expect(store.listEvents(0).at(-1)?.type).toBe("git.workspace.removed");
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .not.toContain(task.path);
    expect(await refExists(task.branchRef)).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("preserves a path reoccupied during stale metadata cleanup", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    await rm(task.path, { recursive: true, force: true });
    const delegate = new GitCommandRunner();
    let reoccupied = false;
    const racingGit = {
      async run(
        args: readonly string[],
        options: GitCommandOptions
      ): Promise<GitCommandResult> {
        const result = await delegate.run(args, options);
        if (
          !reoccupied
          && args[0] === "rev-parse"
          && args.includes(task.branchRef)
        ) {
          reoccupied = true;
          await mkdir(task.path, { recursive: true });
          await writeFile(join(task.path, "ordinary.txt"), "preserve\n");
        }
        return result;
      }
    };
    manager = new WorkspaceManager({
      store,
      companyId: "company",
      git: racingGit
    });

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/reappeared|tamper|occupied/u);

    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("tampered");
    await expect(access(join(task.path, "ordinary.txt")))
      .resolves.toBeUndefined();
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .toContain(task.path.replaceAll("\\", "/"));
    expect(await refExists(task.branchRef)).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("marks a missing registered path tampered when its ref ownership contradicts facts", async () => {
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
    await rm(task.path, { recursive: true, force: true });

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/branch ref|recorded head|persisted facts/u);

    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("tampered");
    expect(await refExists(task.branchRef)).toBe(true);
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .toContain(task.path.replaceAll("\\", "/"));
  }, GIT_TEST_TIMEOUT_MS);

  it("marks a missing recorded path tampered when its branch moved elsewhere", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    const movedPath = join(
      repo.root,
      ".agenttown",
      "worktrees",
      "run-1",
      "moved-task"
    );
    await repo.git(["worktree", "move", task.path, movedPath]);

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/another path|branch|persisted/u);

    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("tampered");
    await expect(access(movedPath)).resolves.toBeUndefined();
    expect(await refExists(task.branchRef)).toBe(true);
    expect((await repo.git(["worktree", "list", "--porcelain"])).stdout)
      .toContain(movedPath.replaceAll("\\", "/"));
  }, GIT_TEST_TIMEOUT_MS);

  it("rejects a missing persisted path outside the exact run root as tampered", async () => {
    await setupRepository();
    const task = await createTaskWorkspace();
    await manager.pauseRun("run-1");
    await rm(task.path, { recursive: true, force: true });
    store.putGitWorkspace({
      ...store.getGitWorkspace(task.workspaceId)!,
      path: join(dirname(repo.root), "outside", "missing")
    });

    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/escaped|run worktree root/u);

    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("tampered");
    expect(await refExists(task.branchRef)).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("enforces company ownership before every run workspace Git operation", async () => {
    await setupRepository();
    createCompany(store, "company-b");
    const task = await createTaskWorkspace();
    const otherCompanyManager = new WorkspaceManager({
      store,
      companyId: "company-b"
    });
    const gitBefore = async () => ({
      worktrees: (await repo.git(["worktree", "list", "--porcelain"])).stdout,
      refs: (await repo.git(["show-ref"])).stdout
    });
    const factsBefore = {
      run: store.getGitRun("run-1"),
      workspaces: store.listGitWorkspaces("run-1"),
      events: store.listEvents(0),
      git: await gitBefore()
    };

    await expect(otherCompanyManager.createTaskWorkspace({
      runId: "run-1",
      employeeId: "developer-b",
      taskId: "task-b",
      baseCommit: baseline.baseCommit
    })).rejects.toThrow(/company|ownership/u);
    await expect(otherCompanyManager.createCandidateWorkspace({
      runId: "run-1",
      attemptId: "attempt-b",
      baseCommit: baseline.baseCommit
    })).rejects.toThrow(/company|ownership/u);
    await expect(otherCompanyManager.pauseRun("run-1"))
      .rejects.toThrow(/company|ownership/u);
    await expect(otherCompanyManager.removeVerifiedWorkspace(task.workspaceId))
      .rejects.toThrow(/company|ownership/u);

    expect(store.getGitRun("run-1")).toEqual(factsBefore.run);
    expect(store.listGitWorkspaces("run-1")).toEqual(factsBefore.workspaces);
    expect(store.listEvents(0)).toEqual(factsBefore.events);
    expect(await gitBefore()).toEqual(factsBefore.git);
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

  it("does not clean a worktree when command completion ownership is unproven", async () => {
    await setupRepository();
    const delegate = new GitCommandRunner();
    let createdPath: string | undefined;
    let createdRef: string | undefined;
    const ambiguousGit = {
      async run(
        args: readonly string[],
        options: GitCommandOptions
      ): Promise<GitCommandResult> {
        const result = await delegate.run(args, options);
        if (args[0] === "worktree" && args[1] === "add") {
          createdPath = args[5];
          const name = args[3];
          createdRef = name === undefined ? undefined : `refs/heads/${name}`;
          throw new Error("transport failed after Git completed");
        }
        return result;
      }
    };
    manager = new WorkspaceManager({
      store,
      companyId: "company",
      git: ambiguousGit
    });

    await expect(manager.createRun("run-1", baseline))
      .rejects.toThrow("transport failed after Git completed");

    expect(createdPath).toBeDefined();
    await expect(access(createdPath ?? "")).resolves.toBeUndefined();
    expect(createdRef === undefined ? false : await refExists(createdRef))
      .toBe(true);
    expect(store.getGitRun("run-1")?.status).toBe("tampered");
  }, GIT_TEST_TIMEOUT_MS);

  it("durably records missing and removed after an owned creation rollback", async () => {
    store.close();
    const faultStore = new RemovalCompletionFaultStore(":memory:");
    store = faultStore;
    store.initialize();
    createCompany(store, "company");
    manager = new WorkspaceManager({ store, companyId: "company" });
    await setupRepository();
    const run = await manager.createRun("run-1", baseline);
    faultStore.failCreation = true;
    const expectedPath = join(
      repo.root,
      ".agenttown",
      "worktrees",
      "run-1",
      "developer-a",
      "task-a"
    );
    const expectedRef = taskRef("run-1", "developer-a", "task-a");

    await expect(manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "developer-a",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    })).rejects.toThrow("injected workspace creation commit failure");

    expect(store.getGitWorkspace(
      "run-1:task:developer-a:task-a"
    )?.status).toBe("missing");
    expect(store.listEvents(0).at(-1)?.type).toBe("git.workspace.removed");
    await expect(access(expectedPath)).rejects.toThrow();
    expect(await refExists(expectedRef)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("durably records a missing integration after an owned run rollback", async () => {
    store.close();
    const faultStore = new RemovalCompletionFaultStore(":memory:");
    store = faultStore;
    store.initialize();
    createCompany(store, "company");
    manager = new WorkspaceManager({ store, companyId: "company" });
    await setupRepository();
    faultStore.failRunCreation = true;
    const expectedPath = join(
      repo.root,
      ".agenttown",
      "worktrees",
      "run-1",
      "integration"
    );
    const expectedRef = integrationRef("run-1");

    await expect(manager.createRun("run-1", baseline))
      .rejects.toThrow("injected run creation commit failure");

    expect(store.getGitWorkspace("run-1:integration")?.status)
      .toBe("missing");
    expect(store.listEvents(0).at(-1)?.type).toBe("git.workspace.removed");
    await expect(access(expectedPath)).rejects.toThrow();
    expect(await refExists(expectedRef)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("treats exact durable lifecycle facts as success when publication throws", async () => {
    await setupRepository();
    const unsubscribe = store.subscribeEvents(() => {
      throw new Error("listener failure");
    });

    const run = await manager.createRun("run-1", baseline);
    const task = await manager.createTaskWorkspace({
      runId: run.runId,
      employeeId: "developer-a",
      taskId: "task-a",
      baseCommit: run.integrationCommit
    });
    const candidate = await manager.createCandidateWorkspace({
      runId: run.runId,
      attemptId: "attempt-a",
      baseCommit: run.integrationCommit
    });
    await expect(manager.pauseRun(run.runId)).resolves.toBeUndefined();
    await expect(manager.removeVerifiedWorkspace(task.workspaceId))
      .resolves.toBeUndefined();
    unsubscribe();

    expect(store.getGitRun("run-1")?.status).toBe("paused");
    const integration = store.getGitWorkspace("run-1:integration");
    expect(integration?.status).toBe("paused");
    await expect(access(integration?.path ?? "")).resolves.toBeUndefined();
    expect(store.getGitWorkspace(task.workspaceId)?.status).toBe("missing");
    expect(store.getGitWorkspace(candidate.workspaceId)?.status).toBe("paused");
    expect(store.listEvents(0).map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "git.run.created",
        "git.workspace.created",
        "git.run.paused",
        "git.workspace.removed"
      ])
    );
  }, GIT_TEST_TIMEOUT_MS);
});
