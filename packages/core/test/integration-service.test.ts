import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  CompanyDefinition,
  GitSubmissionRecord,
  GitTaskSubmission,
  IntegrationAttemptRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommandRunner } from "../src/git/git-command.js";
import { GitWorkflowCoordinator } from "../src/git/git-workflow-coordinator.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import {
  IntegrationService,
  type IntegrationFaultHooks,
  orderIntegrations
} from "../src/git/integration-service.js";
import { ValidationRunner } from "../src/git/validation-runner.js";
import { WorkspaceManager } from "../src/git/workspace-manager.js";
import {
  companyDefinitionFixture,
  createTemporaryProject
} from "./helpers.js";
import {
  createGitFixture,
  type GitFixture
} from "./helpers/git-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function submission(head = "b".repeat(40)): GitTaskSubmission {
  return {
    schemaVersion: 1,
    headCommit: head,
    commits: [head],
    changeSummary: "Reviewed change",
    validationCommandIds: [],
    suggestedValidationCommands: [],
    reportedResults: [],
    knownRisks: []
  };
}

function event(type: string, taskId: string | null) {
  return {
    id: randomUUID(),
    type,
    actorId: "core",
    taskId,
    causationEventId: null,
    payload: {}
  };
}

async function queueHarness() {
  const project = await createTemporaryProject();
  cleanups.push(project.cleanup);
  const store = new CoreStore(project.databasePath);
  store.initialize();
  cleanups.push(async () => store.close());
  const company = companyDefinitionFixture();
  store.createCompany({
    id: "company-1",
    definition: company,
    event: event("company.created", null)
  });
  const now = "2026-07-30T00:00:00.000Z";
  store.putGitRun({
    runId: "run-1",
    companyId: "company-1",
    projectRoot: project.root,
    originalBranch: "main",
    baseCommit: "a".repeat(40),
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: "a".repeat(40),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  store.putGitWorkspace({
    workspaceId: "run-1:integration",
    runId: "run-1",
    taskId: null,
    employeeId: null,
    kind: "integration",
    path: `${project.root}\\integration`,
    branchRef: "refs/heads/agenttown/run-1/integration",
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    status: "active"
  });
  const tasks = new TaskService(store, "company-1", company, "leader");
  const createTask = (id: string, dependencies: string[] = []) => tasks.create({
    id,
    title: id,
    objective: `Complete ${id}`,
    ownerEmployeeId: null,
    dependencies,
    acceptanceCriteria: ["Integrated"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: []
  });
  const approve = (task: TaskRecord): GitSubmissionRecord => {
    const reviewed: TaskRecord = {
      ...task,
      ownerEmployeeId: "developer",
      status: "review",
      updatedEventId: randomUUID()
    };
    store.putTask("company-1", reviewed, [{
      ...event("task.review_approved", task.id),
      id: reviewed.updatedEventId
    }]);
    const approved: GitSubmissionRecord = {
      runId: "run-1",
      taskId: task.id,
      revision: 1,
      submission: submission(),
      status: "approved"
    };
    store.putGitSubmission(approved);
    store.putReviewPackage({
      runId: "run-1",
      taskId: task.id,
      revision: 1,
      manifestPath: `${project.root}\\${task.id}-manifest.json`,
      manifestHash: "c".repeat(64),
      totalBytes: 1,
      status: "created"
    });
    store.putReviewDecision({
      runId: "run-1",
      taskId: task.id,
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
    return approved;
  };
  const service = new IntegrationService({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    workspaceManager: {
      createCandidateWorkspace: async () => {
        throw new Error("candidate creation must not be reached");
      },
      removeVerifiedWorkspace: async () => undefined
    },
    validationRunner: {
      run: async () => {
        throw new Error("validation must not be reached");
      }
    }
  });
  return { approve, createTask, service, store };
}

interface RealHarnessOptions {
  conflict?: boolean;
  validationFails?: boolean;
  validationScripts?: string[];
  faultHooks?: IntegrationFaultHooks;
}

async function realHarness(
  options: RealHarnessOptions = {}
): Promise<{
  approved: GitSubmissionRecord;
  company: CompanyDefinition;
  integrationWorkspaceId: string;
  manager: WorkspaceManager;
  oldCommit: string;
  repo: GitFixture;
  service: IntegrationService;
  store: CoreStore;
  validationRunner: ValidationRunner;
}> {
  const repo = await createGitFixture();
  cleanups.push(repo.cleanup);
  const store = new CoreStore(resolve(repo.root, "core.sqlite"));
  store.initialize();
  cleanups.push(async () => store.close());
  const validationScripts = options.validationScripts ?? [
    options.validationFails === true
      ? "process.exit(17)"
      : "process.exit(0)"
  ];
  const commands = validationScripts.map((script, index) => ({
    id: validationScripts.length === 1
      ? "integration-check"
      : `integration-check-${index + 1}`,
    executable: process.execPath,
    args: ["-e", script],
    cwd: ".",
    timeoutSeconds: 10
  }));
  const company: CompanyDefinition = {
    ...companyDefinitionFixture(),
    validation: {
      commands,
      integrationCommandIds: commands.map(({ id }) => id)
    }
  };
  store.createCompany({
    id: "company-1",
    definition: company,
    event: event("company.created", null)
  });

  let candidateCommit: string;
  if (options.conflict === true) {
    await repo.write("shared.txt", "base\n");
    await repo.git(["add", "shared.txt"]);
    await repo.git(["commit", "-m", "shared base"]);
    await repo.git(["checkout", "-b", "candidate-source"]);
    await repo.write("shared.txt", "candidate\n");
    await repo.git(["commit", "-am", "candidate change"]);
    candidateCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
    await repo.git(["checkout", "main"]);
    await repo.write("shared.txt", "formal\n");
    await repo.git(["commit", "-am", "formal change"]);
  }

  const oldCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  const manager = new WorkspaceManager({
    store,
    companyId: "company-1"
  });
  await manager.createRun("run-1", {
    projectRoot: repo.root,
    originalBranch: "main",
    baseCommit: oldCommit,
    gitCommonDir: resolve(repo.root, ".git"),
    objectIdLength: 40
  });
  if (options.conflict !== true) {
    await repo.write("feature.txt", "candidate\n");
    await repo.git(["add", "feature.txt"]);
    await repo.git(["commit", "-m", "candidate change"]);
    candidateCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  const tasks = new TaskService(store, "company-1", company, "leader");
  const created = tasks.create({
    id: "task-a",
    title: "Task A",
    objective: "Integrate reviewed candidate",
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: ["Integration validation passes"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: []
  });
  const reviewedEvent = event("task.review_approved", "task-a");
  const reviewed: TaskRecord = {
    ...created,
    ownerEmployeeId: "developer",
    status: "review",
    artifacts: ["manifest.json"],
    evidence: ["c".repeat(64)],
    updatedEventId: reviewedEvent.id
  };
  store.putTask("company-1", reviewed, [reviewedEvent]);
  const approved: GitSubmissionRecord = {
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    submission: submission(candidateCommit!),
    status: "approved"
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
  const validationRunner = new ValidationRunner({
    store,
    companyId: "company-1",
    company
  });
  const service = new IntegrationService({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    workspaceManager: manager,
    validationRunner,
    ...(options.faultHooks === undefined
      ? {}
      : { faultHooks: options.faultHooks })
  });
  return {
    approved,
    company,
    integrationWorkspaceId: "run-1:integration",
    manager,
    oldCommit,
    repo,
    service,
    store,
    validationRunner
  };
}

describe("IntegrationService", () => {
  it("orders ready submissions by DAG layer, creation sequence, then task id", () => {
    expect(orderIntegrations([
      { taskId: "task-b", layer: 0, createdSequence: 12 },
      { taskId: "task-a", layer: 0, createdSequence: 11 },
      { taskId: "task-c", layer: 1, createdSequence: 5 }
    ]).map(({ taskId }) => taskId)).toEqual([
      "task-a",
      "task-b",
      "task-c"
    ]);
  });

  it("waits for an earlier same-layer task that is not approved", async () => {
    const harness = await queueHarness();
    harness.createTask("task-a");
    const approvedB = harness.approve(harness.createTask("task-b"));

    await harness.service.enqueue(approvedB);

    await expect(harness.service.drain()).resolves.toEqual({
      kind: "waiting",
      taskId: "task-a"
    });
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
  });

  it("rejects a persisted dependency cycle before selecting a candidate", async () => {
    const harness = await queueHarness();
    const taskA = harness.createTask("task-a");
    const taskB = harness.createTask("task-b", ["task-a"]);
    harness.store.putTask("company-1", {
      ...taskA,
      dependencies: ["task-b"]
    }, [event("task.dependencies_tampered", "task-a")]);
    const approvedB = harness.approve(taskB);

    await harness.service.enqueue(approvedB);

    await expect(harness.service.drain()).rejects.toThrow("dependency cycle");
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
  });

  it("advances the ref and exact integration worktree only after candidate validation", async () => {
    const harness = await realHarness();
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    harness.store.subscribeEvents(throwingListener);

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("integrated");
    const attempt = (result as {
      kind: "integrated";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    expect(attempt).toMatchObject({
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      status: "committed",
      expectedOldCommit: harness.oldCommit,
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect(attempt.candidateCommit).not.toBe(harness.oldCommit);
    expect(attempt.validationRunIds).toHaveLength(1);
    expect(attempt.orderKey).toMatch(
      /^00000000:\d{20}:task-a$/u
    );
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    );
    expect(integration).toMatchObject({
      status: "active",
      headCommit: attempt.candidateCommit
    });
    expect((await harness.repo.git([
      "-C",
      integration!.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    expect((await harness.repo.git([
      "-C",
      integration!.path,
      "symbolic-ref",
      "HEAD"
    ])).stdout.trim()).toBe(
      "refs/heads/agenttown/run-1/integration"
    );
    expect((await harness.repo.git([
      "-C",
      integration!.path,
      "status",
      "--porcelain=v2",
      "--untracked-files=all"
    ])).stdout).toBe("");
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(attempt.candidateCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status)
      .toBe("completed");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("integrated");
    expect(harness.store.getGitWorkspace(
      `run-1:candidate:${attempt.attemptId}`
    )?.status).toBe("missing");
    expect((await harness.repo.git([
      "rev-parse",
      "--verify",
      "--quiet",
      attempt.candidateRef
    ], [0, 1])).exitCode).toBe(1);
    expect(throwingListener).toHaveBeenCalled();
  }, 20_000);

  it("keeps the formal ref and worktree unchanged when candidate validation fails", async () => {
    const harness = await realHarness({ validationFails: true });
    const beforeWorkspace = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("validation_failed");
    const attempt = (result as {
      kind: "validation_failed";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    expect(attempt.status).toBe("validation_failed");
    expect(attempt.validationRunIds).toHaveLength(1);
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect((await harness.repo.git([
      "-C",
      beforeWorkspace.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("queued");
  }, 20_000);

  it("runs every configured integration command even after a non-passed result", async () => {
    const harness = await realHarness({
      validationScripts: ["process.exit(23)", "process.exit(0)"]
    });

    const result = await harness.service.integrate(harness.approved);

    expect(result).toMatchObject({
      kind: "validation_failed",
      attempt: {
        validationRunIds: expect.any(Array)
      }
    });
    expect(harness.store.listValidationRuns("run-1", "task-a")).toHaveLength(2);
    const attempt = (result as {
      kind: "validation_failed";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    expect(attempt.validationRunIds.map((validationId) => {
      const { command, outcome } = harness.store.getValidationRun(validationId)!;
      return [command.id, outcome];
    })).toEqual([
      ["integration-check-1", "failed"],
      ["integration-check-2", "passed"]
    ]);
  }, 20_000);

  it("captures conflicts from the candidate and leaves formal integration unchanged", async () => {
    const harness = await realHarness({ conflict: true });
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("conflicted");
    expect(result).toMatchObject({
      kind: "conflicted",
      files: ["shared.txt"],
      attempt: {
        status: "conflicted",
        conflictFiles: ["shared.txt"]
      }
    });
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect((await harness.repo.git([
      "-C",
      integration.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
  }, 20_000);

  it("does not retry a compare-and-swap mismatch and leaves a prepared recovery intent", async () => {
    const harness = await realHarness();
    const baseGit = new GitCommandRunner();
    let casCalls = 0;
    const service = new IntegrationService({
      store: harness.store,
      companyId: "company-1",
      company: harness.company,
      runId: "run-1",
      workspaceManager: harness.manager,
      validationRunner: harness.validationRunner,
      git: {
        run: async (args, commandOptions) => {
          if (args[0] === "update-ref"
            && args[1] === "refs/heads/agenttown/run-1/integration") {
            casCalls += 1;
            await harness.repo.git([
              "update-ref",
              "refs/heads/agenttown/run-1/integration",
              harness.approved.submission.headCommit,
              harness.oldCommit
            ]);
          }
          return await baseGit.run(args, commandOptions);
        }
      }
    });

    const result = await service.integrate(harness.approved);

    expect(result.kind).toBe("reconciliation_required");
    expect(casCalls).toBe(1);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    expect(attempt).toMatchObject({
      status: "prepared",
      expectedOldCommit: harness.oldCommit,
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
  }, 20_000);

  it("rolls back every SQLite fact when the final fact transaction fails", async () => {
    const harness = await realHarness();
    const commit = harness.store.commitIntegratedTask.bind(harness.store);
    vi.spyOn(harness.store, "commitIntegratedTask").mockImplementation((input) => {
      commit({
        ...input,
        events: [
          ...input.events,
          { ...input.events[0]!, type: "duplicate.event" }
        ]
      });
    });

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("reconciliation_required");
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    expect(attempt.status).toBe("prepared");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("queued");
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )?.headCommit).toBe(harness.oldCommit);
    expect(harness.store.listEvents(0).some(
      ({ type }) => type === "git.integration.committed"
        || type === "task.completed"
    )).toBe(false);
  }, 20_000);

  it("persists prepared intent before any candidate mutation and survives afterPrepared", async () => {
    const stop = new Error("afterPrepared crash");
    const harness = await realHarness({
      faultHooks: {
        afterPrepared: () => {
          expect(harness.store.listIntegrationAttempts("run-1")[0]).toMatchObject({
            status: "prepared",
            candidateCommit: null
          });
          expect(harness.store.listGitWorkspaces("run-1").filter(
            ({ kind }) => kind === "candidate"
          )).toEqual([]);
          throw stop;
        }
      }
    });

    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect(harness.service.recoverPrepared()).toEqual([{
      kind: "reconciliation_required",
      attemptId: harness.store.listIntegrationAttempts("run-1")[0]!.attemptId
    }]);
  }, 20_000);

  it("leaves old durable facts and a new ref when afterRefUpdated crashes", async () => {
    const stop = new Error("afterRefUpdated crash");
    let harness!: Awaited<ReturnType<typeof realHarness>>;
    harness = await realHarness({
      faultHooks: { afterRefUpdated: () => { throw stop; } }
    });

    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    expect(attempt).toMatchObject({
      status: "prepared",
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
  }, 20_000);

  it("leaves exact new Git state and old durable facts when beforeFactsCommitted crashes", async () => {
    const stop = new Error("beforeFactsCommitted crash");
    let harness!: Awaited<ReturnType<typeof realHarness>>;
    harness = await realHarness({
      faultHooks: { beforeFactsCommitted: () => { throw stop; } }
    });

    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;
    expect(attempt.status).toBe("prepared");
    expect((await harness.repo.git([
      "-C",
      integration.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    expect((await harness.repo.git([
      "-C",
      integration.path,
      "symbolic-ref",
      "HEAD"
    ])).stdout.trim()).toBe(
      "refs/heads/agenttown/run-1/integration"
    );
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(integration.headCommit).toBe(harness.oldCommit);
  }, 20_000);

  it("sets GIT_EDITOR=true for every cherry-pick mutation", async () => {
    const harness = await realHarness();
    const baseGit = new GitCommandRunner();
    let picks = 0;
    const service = new IntegrationService({
      store: harness.store,
      companyId: "company-1",
      company: harness.company,
      runId: "run-1",
      workspaceManager: harness.manager,
      validationRunner: harness.validationRunner,
      git: {
        run: async (args, commandOptions) => {
          if (args[0] === "cherry-pick") {
            picks += 1;
            expect(commandOptions.gitEditor).toBe(true);
          }
          return await baseGit.run(args, commandOptions);
        }
      }
    });

    await expect(service.integrate(harness.approved)).resolves.toMatchObject({
      kind: "integrated"
    });
    expect(picks).toBe(1);
  }, 20_000);

  it("rejects stale or foreign facts before preparing or mutating a candidate", async () => {
    const harness = await realHarness();
    await expect(harness.service.enqueue({
      ...harness.approved,
      runId: "run-foreign"
    })).rejects.toThrow("not approved for this run");
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;
    harness.store.putGitWorkspace({
      ...integration,
      headCommit: harness.approved.submission.headCommit
    });

    await expect(harness.service.integrate(harness.approved))
      .rejects.toThrow("workspace head is stale");
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
    expect(harness.store.listGitWorkspaces("run-1").filter(
      ({ kind }) => kind === "candidate"
    )).toEqual([]);
  }, 20_000);

  it("drains an approved coordinator review through IntegrationService", async () => {
    const harness = await queueHarness();
    const created = harness.createTask("task-a");
    const approved = harness.approve(created);
    const enqueue = vi.fn(async () => undefined);
    const drain = vi.fn(async () => ({ kind: "waiting" as const, taskId: "task-a" }));
    const coordinator = new GitWorkflowCoordinator({
      store: harness.store,
      companyId: "company-1",
      company: companyDefinitionFixture(),
      runId: "run-1",
      tasks: new TaskService(
        harness.store,
        "company-1",
        companyDefinitionFixture(),
        "leader"
      ),
      workspaceManager: {
        createTaskWorkspace: async () => {
          throw new Error("not reached");
        }
      },
      submissionValidator: {
        validate: async () => {
          throw new Error("not reached");
        }
      },
      validationRunner: {
        requestGrant: async () => {
          throw new Error("not reached");
        },
        run: async () => {
          throw new Error("not reached");
        }
      },
      evidenceBuilder: {
        create: async () => {
          throw new Error("not reached");
        },
        verify: async (record) => record
      },
      reviewService: {
        recordDecision: async () => ({
          kind: "approved",
          submission: approved
        })
      },
      integrationService: { enqueue, drain },
      reviewerIds: new Set(["reviewer"]),
      sendMessage: async () => undefined
    });

    await coordinator.recordReview({
      schemaVersion: 1,
      actionId: randomUUID(),
      type: "task.approve",
      actorEmployeeId: "reviewer",
      taskId: "task-a",
      payload: {
        revision: 1,
        decision: {
          schemaVersion: 1,
          decision: "approve",
          findings: [],
          coverageGaps: [],
          summary: "Ready",
          reviewedManifestHash: "c".repeat(64)
        }
      },
      reason: "Reviewed immutable evidence",
      causationEventId: null
    });

    expect(enqueue).toHaveBeenCalledWith(approved);
    expect(drain).toHaveBeenCalledOnce();
  });
});
