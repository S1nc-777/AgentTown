import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  CompanyDefinition,
  GitSubmissionRecord,
  IntegrationAttemptRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictService } from "../src/index.js";
import { GitCommandRunner } from "../src/git/git-command.js";
import { IntegrationService } from "../src/git/integration-service.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import { WorkspaceManager } from "../src/git/workspace-manager.js";
import { companyDefinitionFixture } from "./helpers.js";
import {
  createGitFixture,
  type GitFixture
} from "./helpers/git-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function coreEvent(type: string, taskId: string | null) {
  return {
    id: randomUUID(),
    type,
    actorId: "core",
    taskId,
    causationEventId: null,
    payload: {}
  };
}

interface ConflictHarness {
  attempt: IntegrationAttemptRecord;
  company: CompanyDefinition;
  manager: WorkspaceManager;
  original: TaskRecord;
  repo: GitFixture;
  service: ConflictService;
  store: CoreStore;
}

async function reviewedResolution(
  harness: ConflictHarness,
  supersedes: GitSubmissionRecord["supersedes"] = {
    taskId: "task-a",
    revision: 1,
    attemptId: harness.attempt.attemptId
  }
): Promise<{
  approved: GitSubmissionRecord;
  conflict: TaskRecord;
  integration: IntegrationService;
}> {
  const conflict = await harness.service.createTask(harness.attempt);
  const workspace = await harness.service.prepareResolutionWorkspace({
    taskId: conflict.id,
    actorEmployeeId: "leader",
    employeeId: "developer"
  });
  const tasks = new TaskService(
    harness.store,
    "company-1",
    harness.company,
    "leader"
  );
  tasks.assign(conflict.id, "developer");
  tasks.transition(conflict.id, "running", "developer");
  await harness.repo.write(
    resolve(workspace.path, "shared.txt").slice(workspace.path.length + 1),
    "resolved\n"
  );
  await harness.repo.git(["-C", workspace.path, "add", "shared.txt"]);
  await harness.repo.git([
    "-C",
    workspace.path,
    "commit",
    "-m",
    "resolve reviewed conflict"
  ]);
  const head = (await harness.repo.git([
    "-C",
    workspace.path,
    "rev-parse",
    "HEAD"
  ])).stdout.trim();
  harness.store.putGitWorkspace({
    ...workspace,
    headCommit: head
  });
  const reviewedEvent = coreEvent("task.review_approved", conflict.id);
  harness.store.putTask("company-1", {
    ...tasks.get(conflict.id),
    status: "review",
    artifacts: ["resolution-manifest.json"],
    evidence: ["d".repeat(64)],
    updatedEventId: reviewedEvent.id
  }, [reviewedEvent]);
  const approved: GitSubmissionRecord = {
    runId: "run-1",
    taskId: conflict.id,
    revision: 1,
    submission: {
      schemaVersion: 1,
      headCommit: head,
      commits: [head],
      changeSummary: "Resolve the reviewed conflict",
      validationCommandIds: [],
      suggestedValidationCommands: [],
      reportedResults: [],
      knownRisks: []
    },
    status: "approved",
    supersedes
  };
  harness.store.putGitSubmission(approved);
  harness.store.putReviewPackage({
    runId: "run-1",
    taskId: conflict.id,
    revision: 1,
    manifestPath: resolve(harness.repo.root, "resolution-manifest.json"),
    manifestHash: "d".repeat(64),
    totalBytes: 1,
    status: "created"
  });
  harness.store.putReviewDecision({
    runId: "run-1",
    taskId: conflict.id,
    revision: 1,
    decision: {
      schemaVersion: 1,
      decision: "approve",
      findings: [],
      coverageGaps: [],
      summary: "Resolution ready",
      reviewedManifestHash: "d".repeat(64)
    }
  });
  const integration = new IntegrationService({
    store: harness.store,
    companyId: "company-1",
    company: harness.company,
    runId: "run-1",
    workspaceManager: harness.manager,
    validationRunner: {
      run: async () => {
        throw new Error("no integration commands are configured");
      }
    },
    conflictService: harness.service
  });
  return { approved, conflict, integration };
}

async function conflictHarness(): Promise<ConflictHarness> {
  const repo = await createGitFixture();
  cleanups.push(repo.cleanup);
  const store = new CoreStore(resolve(repo.root, "core.sqlite"));
  store.initialize();
  cleanups.push(async () => store.close());
  const company = companyDefinitionFixture();
  store.createCompany({
    id: "company-1",
    definition: company,
    event: coreEvent("company.created", null)
  });

  await repo.write("shared.txt", "base\n");
  await repo.git(["add", "shared.txt"]);
  await repo.git(["commit", "-m", "shared base"]);
  await repo.git(["checkout", "-b", "reviewed-source"]);
  await repo.write("shared.txt", "reviewed\n");
  await repo.git(["commit", "-am", "reviewed change"]);
  const reviewedCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  await repo.git(["checkout", "main"]);
  await repo.write("shared.txt", "formal\n");
  await repo.git(["commit", "-am", "formal change"]);
  const integrationCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();

  const manager = new WorkspaceManager({
    store,
    companyId: "company-1"
  });
  await manager.createRun("run-1", {
    projectRoot: repo.root,
    originalBranch: "main",
    baseCommit: integrationCommit,
    gitCommonDir: resolve(repo.root, ".git"),
    objectIdLength: 40
  });

  const tasks = new TaskService(store, "company-1", company, "leader");
  const completedDependency = tasks.create({
    id: "dependency",
    title: "Dependency",
    objective: "Already integrated",
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: ["Done"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    conflictForTaskId: null
  });
  store.putTask("company-1", {
    ...completedDependency,
    status: "completed"
  }, [coreEvent("task.completed", "dependency")]);
  const created = tasks.create({
    id: "task-a",
    title: "Task A",
    objective: "Integrate the reviewed change",
    ownerEmployeeId: null,
    dependencies: ["dependency"],
    acceptanceCriteria: ["Integrated"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    conflictForTaskId: null
  });
  const reviewEvent = coreEvent("task.review_approved", "task-a");
  const original: TaskRecord = {
    ...created,
    ownerEmployeeId: "developer",
    status: "review",
    artifacts: ["manifest.json"],
    evidence: ["c".repeat(64)],
    updatedEventId: reviewEvent.id
  };
  store.putTask("company-1", original, [reviewEvent]);
  const approved: GitSubmissionRecord = {
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    submission: {
      schemaVersion: 1,
      headCommit: reviewedCommit,
      commits: [reviewedCommit],
      changeSummary: "Reviewed conflict",
      validationCommandIds: [],
      suggestedValidationCommands: [],
      reportedResults: [],
      knownRisks: []
    },
    status: "approved",
    supersedes: null
  };
  store.putGitSubmission(approved);
  store.putReviewPackage({
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    manifestPath: resolve(repo.root, "manifest.json"),
    manifestHash: "c".repeat(64),
    totalBytes: 1,
    status: "created"
  });
  store.putReviewDecision({
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    decision: {
      schemaVersion: 1,
      decision: "approve",
      findings: [],
      coverageGaps: [],
      summary: "Ready",
      reviewedManifestHash: "c".repeat(64)
    }
  });
  const integration = new IntegrationService({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    workspaceManager: manager,
    validationRunner: {
      run: async () => {
        throw new Error("conflict must happen before validation");
      }
    }
  });
  const result = await integration.integrate(approved);
  if (result.kind !== "conflicted") {
    throw new Error(`expected conflict, received ${result.kind}`);
  }
  const service = new ConflictService({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    workspaceManager: manager
  });
  return {
    attempt: result.attempt,
    company,
    manager,
    original,
    repo,
    service,
    store
  };
}

describe("ConflictService", () => {
  it("atomically creates one deterministic unassigned conflict task without a cycle", async () => {
    const harness = await conflictHarness();
    const beforeEvents = harness.store.listEvents(0).length;

    const conflict = await harness.service.createTask(harness.attempt);
    const replay = await harness.service.createTask(harness.attempt);

    expect(conflict).toEqual(replay);
    expect(conflict).toMatchObject({
      id: "conflict-task-a-1",
      ownerEmployeeId: null,
      dependencies: ["dependency"],
      status: "draft",
      conflictForTaskId: "task-a",
      artifacts: ["conflict-file:shared.txt"],
      evidence: [
        `integration-attempt:${harness.attempt.attemptId}`,
        "submission-revision:1"
      ]
    });
    expect(conflict.dependencies).not.toContain("task-a");
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("blocked");
    expect(harness.store.listTasks("company-1").filter(
      ({ conflictForTaskId }) => conflictForTaskId === "task-a"
    )).toHaveLength(1);
    expect(harness.store.listEvents(0)).toHaveLength(beforeEvents + 2);
  }, 20_000);

  it("rejects stale conflict facts before creating tasks or events", async () => {
    const harness = await conflictHarness();
    const beforeTasks = harness.store.listTasks("company-1");
    const beforeEvents = harness.store.listEvents(0);

    await expect(harness.service.createTask({
      ...harness.attempt,
      conflictFiles: ["forged.txt"]
    })).rejects.toThrow(/stale|mismatch|conflict/u);

    expect(harness.store.listTasks("company-1")).toEqual(beforeTasks);
    expect(harness.store.listEvents(0)).toEqual(beforeEvents);
  }, 20_000);

  it("isolates listener failures after the conflict facts commit", async () => {
    const harness = await conflictHarness();
    const listener = vi.fn(() => {
      throw new Error("listener failed");
    });
    harness.store.subscribeEvents(listener);
    await expect(harness.service.createTask(harness.attempt))
      .resolves.toMatchObject({ id: "conflict-task-a-1" });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("blocked");
  }, 20_000);

  it("prepares one fresh current-integration worktree with the exact reviewed conflict", async () => {
    const harness = await conflictHarness();
    const conflict = await harness.service.createTask(harness.attempt);

    const workspace = await harness.service.prepareResolutionWorkspace({
      taskId: conflict.id,
      actorEmployeeId: "leader",
      employeeId: "developer"
    });
    const replay = await harness.service.prepareResolutionWorkspace({
      taskId: conflict.id,
      actorEmployeeId: "leader",
      employeeId: "developer"
    });

    expect(replay).toEqual(workspace);
    expect(workspace).toMatchObject({
      runId: "run-1",
      taskId: conflict.id,
      employeeId: "developer",
      kind: "task",
      baseCommit: harness.store.getGitRun("run-1")?.integrationCommit,
      headCommit: harness.store.getGitRun("run-1")?.integrationCommit,
      status: "active"
    });
    const status = await harness.repo.git([
      "-C",
      workspace.path,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all"
    ]);
    expect(status.stdout).toContain("shared.txt");
  }, 20_000);

  it("fails closed and requests user review when reproduced conflict scope changes", async () => {
    const harness = await conflictHarness();
    const conflict = await harness.service.createTask(harness.attempt);
    const baseGit = new GitCommandRunner();
    const changedScope = new ConflictService({
      store: harness.store,
      companyId: "company-1",
      company: harness.company,
      runId: "run-1",
      workspaceManager: harness.manager,
      git: {
        run: async (args, options) => {
          const result = await baseGit.run(args, options);
          return args[0] === "status" && args.includes("-z")
            ? { ...result, stdout: result.stdout.replaceAll("shared.txt", "other.txt") }
            : result;
        }
      }
    });

    await expect(changedScope.prepareResolutionWorkspace({
      taskId: conflict.id,
      actorEmployeeId: "leader",
      employeeId: "developer"
    })).rejects.toThrow(/user review|scope/u);

    expect(harness.store.listPendingApprovals("company-1")).toEqual([
      expect.objectContaining({
        taskId: conflict.id,
        request: expect.objectContaining({
          reason: "conflict_scope_changed",
          expectedFiles: ["shared.txt"],
          actualFiles: ["other.txt"]
        })
      })
    ]);
    expect(harness.store.getTask("company-1", conflict.id)).toMatchObject({
      ownerEmployeeId: null,
      status: "draft"
    });
  }, 20_000);

  it("rejects unauthorized or non-writable resolution assignment before workspace creation", async () => {
    const harness = await conflictHarness();
    const conflict = await harness.service.createTask(harness.attempt);
    const before = harness.store.listGitWorkspaces("run-1");

    await expect(harness.service.prepareResolutionWorkspace({
      taskId: conflict.id,
      actorEmployeeId: "developer",
      employeeId: "developer"
    })).rejects.toThrow("leader");
    await expect(harness.service.prepareResolutionWorkspace({
      taskId: conflict.id,
      actorEmployeeId: "leader",
      employeeId: "reviewer"
    })).rejects.toThrow("git_worktree");

    expect(harness.store.listGitWorkspaces("run-1")).toEqual(before);
  }, 20_000);

  it("atomically integrates a reviewed resolution and completes both tasks", async () => {
    const harness = await conflictHarness();
    const { approved, conflict, integration } = await reviewedResolution(harness);
    const listener = vi.fn(() => {
      throw new Error("listener failed");
    });
    harness.store.subscribeEvents(listener);

    const result = await integration.integrate(approved);

    expect(result).toMatchObject({
      kind: "integrated",
      attempt: {
        taskId: conflict.id,
        status: "committed"
      }
    });
    expect(harness.store.getTask("company-1", conflict.id)?.status)
      .toBe("completed");
    expect(harness.store.getTask("company-1", "task-a")?.status)
      .toBe("completed");
    expect(harness.store.getGitSubmission(
      "run-1",
      conflict.id,
      1
    )?.status).toBe("integrated");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("superseded");
    expect(harness.store.listEvents(0).filter(
      ({ type }) => type === "task.completed"
    ).map(({ taskId }) => taskId)).toEqual(expect.arrayContaining([
      conflict.id,
      "task-a"
    ]));
    expect(listener).toHaveBeenCalled();
  }, 30_000);

  it("replays a completed resolution without re-executing the terminal conflict attempt", async () => {
    const harness = await conflictHarness();
    const { approved, integration } = await reviewedResolution(harness);
    const first = await integration.integrate(approved);
    const beforeAttempts = harness.store.listIntegrationAttempts("run-1");
    const beforeEvents = harness.store.listEvents(0);

    const replay = await integration.integrate(approved);

    expect(replay).toEqual(first);
    expect(harness.store.listIntegrationAttempts("run-1"))
      .toEqual(beforeAttempts);
    expect(harness.store.listEvents(0)).toEqual(beforeEvents);
    expect(harness.store.getIntegrationAttempt(harness.attempt.attemptId))
      .toEqual(harness.attempt);
  }, 30_000);

  it("rejects a completed-resolution replay when superseded facts became stale", async () => {
    const harness = await conflictHarness();
    const { approved, integration } = await reviewedResolution(harness);
    await integration.integrate(approved);
    const originalSubmission = harness.store.getGitSubmission(
      "run-1",
      "task-a",
      1
    );
    if (originalSubmission === null) throw new Error("missing original submission");
    harness.store.putGitSubmission({
      ...originalSubmission,
      status: "queued"
    });
    const beforeAttempts = harness.store.listIntegrationAttempts("run-1");
    const beforeEvents = harness.store.listEvents(0);

    await expect(integration.integrate(approved))
      .rejects.toThrow(/stale|mismatch|supersed/u);

    expect(harness.store.listIntegrationAttempts("run-1"))
      .toEqual(beforeAttempts);
    expect(harness.store.listEvents(0)).toEqual(beforeEvents);
  }, 30_000);

  it("rolls back every supersession fact when the atomic event insert fails", async () => {
    const harness = await conflictHarness();
    const { approved, conflict, integration } = await reviewedResolution(harness);
    const beforeRun = harness.store.getGitRun("run-1")!;
    const beforeWorkspace = harness.store.getGitWorkspace("run-1:integration")!;
    const beforeConflict = harness.store.getTask("company-1", conflict.id)!;
    const beforeOriginal = harness.store.getTask("company-1", "task-a")!;
    const result = await integration.integrate(approved);
    if (result.kind !== "integrated") throw new Error("resolution did not integrate");
    const committedAttempt = harness.store.getIntegrationAttempt(
      result.attempt.attemptId
    )!;
    const integratedSubmission = harness.store.getGitSubmission(
      "run-1",
      conflict.id,
      1
    )!;
    const completedConflict = harness.store.getTask("company-1", conflict.id)!;
    const completedOriginal = harness.store.getTask("company-1", "task-a")!;
    const advancedRun = harness.store.getGitRun("run-1")!;
    const advancedWorkspace = harness.store.getGitWorkspace("run-1:integration")!;
    const originalAttempt = harness.store.getIntegrationAttempt(
      harness.attempt.attemptId
    )!;
    const supersededSubmission = harness.store.getGitSubmission(
      "run-1",
      "task-a",
      1
    )!;
    const committedEvent = harness.store.listEvents(0).find((event) =>
      event.type === "git.integration.committed"
      && event.payload.attemptId === committedAttempt.attemptId
    )!;
    const conflictCompletedEvent = harness.store.listEvents(0).find(
      ({ id }) => id === completedConflict.updatedEventId
    )!;
    const originalCompletedEvent = harness.store.listEvents(0).find(
      ({ id }) => id === completedOriginal.updatedEventId
    )!;
    harness.store.putGitRun(beforeRun);
    harness.store.putGitWorkspace(beforeWorkspace);
    harness.store.putIntegrationAttempt({
      ...committedAttempt,
      status: "prepared"
    });
    harness.store.putGitSubmission({
      ...integratedSubmission,
      status: "queued"
    });
    harness.store.putGitSubmission({
      ...supersededSubmission,
      status: "queued"
    });
    harness.store.putTask("company-1", beforeConflict, [
      coreEvent("fixture.conflict_restored", conflict.id)
    ]);
    harness.store.putTask("company-1", beforeOriginal, [
      coreEvent("fixture.original_restored", "task-a")
    ]);
    const candidateId = `run-1:candidate:${committedAttempt.attemptId}`;
    harness.store.putGitWorkspace({
      ...harness.store.getGitWorkspace(candidateId)!,
      status: "active",
      headCommit: committedAttempt.candidateCommit!
    });
    const beforeEvents = harness.store.listEvents(0);

    expect(() => harness.store.commitResolvedConflict({
      companyId: "company-1",
      attempt: committedAttempt,
      submission: integratedSubmission,
      conflictTask: completedConflict,
      originalAttempt,
      originalSubmission: supersededSubmission,
      originalTask: completedOriginal,
      run: advancedRun,
      integrationWorkspace: advancedWorkspace,
      events: [committedEvent, conflictCompletedEvent, originalCompletedEvent]
    })).toThrow();

    expect(harness.store.getGitRun("run-1")).toEqual(beforeRun);
    expect(harness.store.getGitWorkspace("run-1:integration"))
      .toEqual(beforeWorkspace);
    expect(harness.store.getIntegrationAttempt(committedAttempt.attemptId))
      .toMatchObject({ status: "prepared" });
    expect(harness.store.getGitSubmission("run-1", conflict.id, 1))
      .toMatchObject({ status: "queued" });
    expect(harness.store.getGitSubmission("run-1", "task-a", 1))
      .toMatchObject({ status: "queued" });
    expect(harness.store.getTask("company-1", conflict.id))
      .toEqual(beforeConflict);
    expect(harness.store.getTask("company-1", "task-a"))
      .toEqual(beforeOriginal);
    expect(harness.store.listEvents(0)).toEqual(beforeEvents);
  }, 30_000);

  it("rejects forged resolution supersession before candidate Git mutation", async () => {
    const harness = await conflictHarness();
    const { approved, integration } = await reviewedResolution(harness, {
      taskId: "task-a",
      revision: 99,
      attemptId: harness.attempt.attemptId
    });
    const before = harness.store.listGitWorkspaces("run-1");

    await expect(integration.integrate(approved))
      .rejects.toThrow(/supersession|revision|mismatch/u);

    expect(harness.store.listGitWorkspaces("run-1")).toEqual(before);
    expect(harness.store.listIntegrationAttempts(
      "run-1",
      approved.taskId
    )).toEqual([]);
    expect(harness.store.getTask("company-1", "task-a")?.status)
      .toBe("blocked");
  }, 30_000);
});
