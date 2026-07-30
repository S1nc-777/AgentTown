import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentMessage,
  GitTaskSubmission,
  GitWorkspaceRecord,
  ReviewDecision,
  ReviewPackageRecord,
  ValidationCommand,
  ValidationCommandGrant,
  ValidationRunRecord
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitWorkflowCoordinator
} from "../src/git/git-workflow-coordinator.js";
import type { ValidatedSubmission } from "../src/git/submission-validator.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import { companyDefinitionFixture } from "./helpers.js";

const stores: CoreStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function action(input: {
  type: ActionProposal["type"];
  actor: string;
  taskId: string;
  payload: Record<string, unknown>;
}): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: randomUUID(),
    type: input.type,
    actorEmployeeId: input.actor,
    taskId: input.taskId,
    payload: input.payload,
    reason: "Task 7 workflow test",
    causationEventId: null
  };
}

function submission(commandIds: string[] = []): GitTaskSubmission {
  return {
    schemaVersion: 1,
    headCommit: "2".repeat(40),
    commits: ["2".repeat(40)],
    changeSummary: "Implement Task 7",
    validationCommandIds: commandIds,
    suggestedValidationCommands: [],
    reportedResults: commandIds.map((commandId) => ({
      commandId,
      outcome: "failed",
      summary: "This declaration is deliberately non-authoritative."
    })),
    knownRisks: []
  };
}

function createHarness(options: {
  commands?: ValidationCommand[];
  sendMessage?: (employeeId: string, message: AgentMessage) => Promise<void>;
  requestGrant?: (command: ValidationCommand) => Promise<ValidationCommandGrant>;
  runValidation?: (command: ValidationCommand) => Promise<ValidationRunRecord>;
  validateSubmission?: (
    workspace: GitWorkspaceRecord,
    submission: GitTaskSubmission
  ) => Promise<ValidatedSubmission>;
} = {}) {
  const company = companyDefinitionFixture();
  company.validation.commands = options.commands ?? [];
  const store = new CoreStore(":memory:");
  stores.push(store);
  store.initialize();
  store.createCompany({
    id: "company-1",
    definition: company,
    event: {
      id: randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: {}
    }
  });
  store.putGitRun({
    runId: "run-1",
    companyId: "company-1",
    projectRoot: process.cwd(),
    originalBranch: "main",
    baseCommit: "1".repeat(40),
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: "1".repeat(40),
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z"
  });
  const tasks = new TaskService(store, "company-1", company, "leader");
  tasks.create({
    id: "task-a",
    title: "Task A",
    objective: "Complete Task A",
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: ["Task 7 tests pass"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: []
  });
  const workspace: GitWorkspaceRecord = {
    workspaceId: "run-1:task:developer:task-a",
    runId: "run-1",
    taskId: "task-a",
    employeeId: "developer",
    kind: "task",
    path: "C:\\worktrees\\run-1\\developer\\task-a",
    branchRef: "refs/heads/agenttown/run-1/developer/task-a",
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    status: "active"
  };
  const createTaskWorkspace = vi.fn(async () => {
    store.putGitWorkspace(workspace);
    return workspace;
  });
  const defaultValidate = async (
    _workspace: GitWorkspaceRecord,
    parsed: GitTaskSubmission
  ) => ({
    schemaVersion: 1 as const,
    submission: parsed,
    runId: "run-1",
    taskId: "task-a",
    workspaceId: workspace.workspaceId,
    employeeId: "developer",
    branchRef: workspace.branchRef,
    baseCommit: workspace.baseCommit,
    headCommit: workspace.headCommit,
    commits: [],
    files: [],
    patch: "diff --git a/a b/a\n",
    patchBytes: 20,
    warnings: [],
    changeSummary: parsed.changeSummary,
    knownRisks: parsed.knownRisks,
    reportedResults: parsed.reportedResults,
    validations: []
  });
  const validate = vi.fn(options.validateSubmission ?? defaultValidate);
  const requestGrant = vi.fn(options.requestGrant ?? (async (command) => ({
    grantId: `grant-${command.id}`,
    runId: "run-1",
    taskId: "task-a",
    workspaceId: workspace.workspaceId,
    command,
    status: "pending",
    decisionReason: null
  })));
  const run = vi.fn(options.runValidation ?? (async (command) => ({
    validationId: randomUUID(),
    runId: "run-1",
    taskId: "task-a",
    integrationAttemptId: null,
    command,
    workspaceId: workspace.workspaceId,
    outcome: "passed",
    exitCode: 0,
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    logPath: `C:\\logs\\${command.id}.log`,
    logHash: "c".repeat(64)
  })));
  const packageRecord: ReviewPackageRecord = {
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    manifestPath: "C:\\reviews\\task-a\\1\\manifest.json",
    manifestHash: "d".repeat(64),
    totalBytes: 100,
    status: "created"
  };
  const create = vi.fn(async () => {
    store.putReviewPackage(packageRecord);
    return packageRecord;
  });
  const verify = vi.fn(async (record: ReviewPackageRecord) => record);
  const recordDecision = vi.fn(async () => ({
    kind: "approved" as const,
    submission: {
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      submission: submission(),
      status: "approved" as const
    }
  }));
  const messages: Array<{ employeeId: string; message: AgentMessage }> = [];
  const sendMessage = vi.fn(options.sendMessage ?? (async (employeeId, message) => {
    messages.push({ employeeId, message });
  }));
  const coordinator = new GitWorkflowCoordinator({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    tasks,
    workspaceManager: { createTaskWorkspace },
    submissionValidator: { validate },
    validationRunner: { requestGrant, run },
    evidenceBuilder: { create, verify },
    reviewService: { recordDecision },
    reviewerIds: new Set(["reviewer"]),
    sendMessage
  });
  return {
    company,
    coordinator,
    create,
    createTaskWorkspace,
    messages,
    packageRecord,
    recordDecision,
    requestGrant,
    run,
    sendMessage,
    store,
    tasks,
    validate,
    verify,
    workspace
  };
}

describe("GitWorkflowCoordinator", () => {
  it("claims an active Git owner's submission even when its workspace is missing", async () => {
    const harness = createHarness();
    harness.tasks.assign("task-a", "developer");
    harness.tasks.transition("task-a", "running", "developer");
    const submit = action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: { submission: submission() }
    });

    expect(harness.coordinator.handles(submit)).toBe(true);
    await expect(harness.coordinator.submitTask(submit))
      .rejects.toThrow("workspace");
    expect(harness.tasks.get("task-a").status).toBe("running");
  });

  it("claims an active Git owner's approval without a workspace so Fake completion is unreachable", async () => {
    const harness = createHarness();
    harness.tasks.assign("task-a", "developer");
    harness.tasks.transition("task-a", "running", "developer");
    harness.tasks.submit("task-a", "developer", ["legacy.patch"], ["legacy evidence"]);
    const approve = action({
      type: "task.approve",
      actor: "reviewer",
      taskId: "task-a",
      payload: {
        revision: 1,
        decision: {
          schemaVersion: 1,
          decision: "approve",
          findings: [],
          coverageGaps: [],
          summary: "Ready",
          reviewedManifestHash: "d".repeat(64)
        }
      }
    });

    expect(harness.coordinator.handles(approve)).toBe(true);
    await harness.coordinator.recordReview(approve);
    expect(harness.tasks.get("task-a").status).toBe("review");
    expect(harness.recordDecision).toHaveBeenCalledOnce();
  });

  it("persists the task worktree before sending exact WritableTaskContext", async () => {
    const order: string[] = [];
    const harness = createHarness({
      sendMessage: async (_employeeId, message) => {
        order.push("send");
        expect(harness.store.getGitWorkspace(
          "run-1:task:developer:task-a"
        )?.status).toBe("active");
        expect(harness.tasks.get("task-a")).toMatchObject({
          ownerEmployeeId: "developer",
          status: "ready"
        });
        expect(message.taskContext).toEqual({
          kind: "git_worktree",
          runId: "run-1",
          taskId: "task-a",
          employeeId: "developer",
          workspaceRoot: harness.workspace.path,
          branch: harness.workspace.branchRef,
          baseCommit: harness.workspace.baseCommit,
          approvedValidationCommandIds: []
        });
      }
    });
    harness.createTaskWorkspace.mockImplementationOnce(async () => {
      order.push("workspace");
      harness.store.putGitWorkspace(harness.workspace);
      return harness.workspace;
    });

    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));

    expect(order).toEqual(["workspace", "send"]);
    expect(harness.tasks.get("task-a").status).toBe("running");
  });

  it("does not send or assign when worktree creation fails and leaves a send failure recoverable", async () => {
    const failedWorkspace = createHarness();
    failedWorkspace.createTaskWorkspace.mockRejectedValueOnce(new Error("git failed"));
    await expect(failedWorkspace.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }))).rejects.toThrow("git failed");
    expect(failedWorkspace.sendMessage).not.toHaveBeenCalled();
    expect(failedWorkspace.tasks.get("task-a")).toMatchObject({
      ownerEmployeeId: null,
      status: "draft"
    });

    const failedSend = createHarness({
      sendMessage: async () => {
        throw new Error("delivery failed");
      }
    });
    await expect(failedSend.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }))).rejects.toThrow("delivery failed");
    expect(failedSend.tasks.get("task-a")).toMatchObject({
      ownerEmployeeId: "developer",
      status: "ready"
    });
    expect(failedSend.store.getGitWorkspace(failedSend.workspace.workspaceId)?.status)
      .toBe("active");
  });

  it("requests one idempotent grant and pauses before validation or package creation", async () => {
    const suggested: ValidationCommand = {
      id: "custom-check",
      executable: "node",
      args: ["custom-check.mjs"],
      cwd: ".",
      timeoutSeconds: 60
    };
    const harness = createHarness();
    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));
    const structured = {
      ...submission(["custom-check"]),
      suggestedValidationCommands: [suggested]
    };

    const first = await harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: { submission: structured }
    }));
    const second = await harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: { submission: structured }
    }));

    expect(first.kind).toBe("pending_approval");
    expect(second.kind).toBe("pending_approval");
    expect(harness.requestGrant).toHaveBeenCalledTimes(2);
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.validate).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.store.listGitSubmissions("run-1", "task-a")).toHaveLength(0);
    expect(harness.tasks.get("task-a").status).toBe("running");
  });

  it("never executes a rejected suggested command and returns it to the owner", async () => {
    const suggested: ValidationCommand = {
      id: "custom-check",
      executable: "node",
      args: ["custom-check.mjs"],
      cwd: ".",
      timeoutSeconds: 60
    };
    const harness = createHarness({
      requestGrant: async (command) => ({
        grantId: "grant-custom-check",
        runId: "run-1",
        taskId: "task-a",
        workspaceId: "run-1:task:developer:task-a",
        command,
        status: "rejected",
        decisionReason: "Do not run downloaded code"
      })
    });
    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));

    const result = await harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: {
        submission: {
          ...submission(["custom-check"]),
          suggestedValidationCommands: [suggested]
        }
      }
    }));

    expect(result).toMatchObject({
      kind: "grant_rejected",
      ownerEmployeeId: "developer",
      reason: "Do not run downloaded code"
    });
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.tasks.get("task-a").status).toBe("running");
  });

  it("rejects a suggested command that aliases a configured id with different arguments", async () => {
    const configured: ValidationCommand = {
      id: "core-test",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    };
    const harness = createHarness({
      commands: [configured],
      requestGrant: async (command) => ({
        grantId: "grant-conflict",
        runId: "run-1",
        taskId: "task-a",
        workspaceId: "run-1:task:developer:task-a",
        command,
        status: "approved",
        decisionReason: "approved"
      })
    });
    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));

    await expect(harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: {
        submission: {
          ...submission(["core-test"]),
          suggestedValidationCommands: [{
            ...configured,
            args: ["test", "--unsafe-alias"]
          }]
        }
      }
    }))).rejects.toThrow(/conflict|configured/u);

    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("runs authoritative validation, persists an immutable revision, verifies evidence, and sends ReviewTaskContext", async () => {
    const configured: ValidationCommand = {
      id: "core-test",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    };
    const harness = createHarness({ commands: [configured] });
    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));
    harness.messages.splice(0);

    const outcome = await harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: { submission: submission(["core-test"]) }
    }));

    expect(outcome).toMatchObject({
      kind: "in_review",
      revision: 1,
      reviewPackage: harness.packageRecord
    });
    expect(harness.run).toHaveBeenCalledWith(
      configured,
      expect.objectContaining({
        runId: "run-1",
        taskId: "task-a",
        workspaceId: harness.workspace.workspaceId,
        workspaceRoot: harness.workspace.path,
        integrationAttemptId: null
      })
    );
    expect(harness.validate).toHaveBeenCalledTimes(2);
    expect(harness.validate.mock.calls[0]?.[1]).toMatchObject({
      validationCommandIds: []
    });
    expect(harness.validate.mock.calls[1]?.[1]).toMatchObject({
      validationCommandIds: ["core-test"]
    });
    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 1 })
    );
    expect(harness.verify).toHaveBeenCalledWith(harness.packageRecord);
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("in_review");
    expect(harness.tasks.get("task-a")).toMatchObject({
      status: "review",
      artifacts: [harness.packageRecord.manifestPath],
      evidence: [harness.packageRecord.manifestHash]
    });
    expect(harness.messages).toEqual([{
      employeeId: "reviewer",
      message: expect.objectContaining({
        employeeId: "reviewer",
        taskId: "task-a",
        taskContext: {
          kind: "review_package",
          runId: "run-1",
          taskId: "task-a",
          revision: 1,
          manifestPath: harness.packageRecord.manifestPath,
          manifestHash: harness.packageRecord.manifestHash
        }
      })
    }]);
  });

  it("rejects non-passed validation without trusting reported results or creating a revision", async () => {
    const configured: ValidationCommand = {
      id: "core-test",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    };
    const harness = createHarness({
      commands: [configured],
      runValidation: async (command) => ({
        validationId: randomUUID(),
        runId: "run-1",
        taskId: "task-a",
        integrationAttemptId: null,
        command,
        workspaceId: "run-1:task:developer:task-a",
        outcome: "failed",
        exitCode: 1,
        startedAt: "2026-07-30T00:00:00.000Z",
        completedAt: "2026-07-30T00:00:01.000Z",
        logPath: "C:\\logs\\failed.log",
        logHash: "e".repeat(64)
      })
    });
    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));

    await expect(harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: { submission: submission(["core-test"]) }
    }))).rejects.toThrow("validation failed");

    expect(harness.validate).toHaveBeenCalledOnce();
    expect(harness.validate.mock.calls[0]?.[1]).toMatchObject({
      validationCommandIds: []
    });
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.store.listGitSubmissions("run-1", "task-a")).toHaveLength(0);
    expect(harness.tasks.get("task-a").status).toBe("running");
  });

  it("validates authoritative Git facts before running validation commands", async () => {
    const configured: ValidationCommand = {
      id: "core-test",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    };
    const order: string[] = [];
    const harness = createHarness({
      commands: [configured],
      validateSubmission: async () => {
        order.push("validate");
        throw new Error("authoritative Git facts rejected");
      },
      runValidation: async (command) => {
        order.push("run");
        return {
          validationId: randomUUID(),
          runId: "run-1",
          taskId: "task-a",
          integrationAttemptId: null,
          command,
          workspaceId: "run-1:task:developer:task-a",
          outcome: "passed",
          exitCode: 0,
          startedAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:00:01.000Z",
          logPath: "C:\\logs\\passed.log",
          logHash: "f".repeat(64)
        };
      }
    });
    await harness.coordinator.assignTask(action({
      type: "task.assign",
      actor: "leader",
      taskId: "task-a",
      payload: { assignee: "developer" }
    }));

    await expect(harness.coordinator.submitTask(action({
      type: "task.submit",
      actor: "developer",
      taskId: "task-a",
      payload: { submission: submission(["core-test"]) }
    }))).rejects.toThrow("authoritative Git facts rejected");

    expect(order).toEqual(["validate"]);
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.store.listGitSubmissions("run-1", "task-a")).toHaveLength(0);
  });

  it("delegates a parsed review decision with bound task and revision", async () => {
    const harness = createHarness();
    const review: ReviewDecision = {
      schemaVersion: 1,
      decision: "approve",
      findings: [],
      coverageGaps: [],
      summary: "Ready",
      reviewedManifestHash: "d".repeat(64)
    };

    await harness.coordinator.recordReview(action({
      type: "task.approve",
      actor: "reviewer",
      taskId: "task-a",
      payload: { revision: 1, decision: review }
    }));

    expect(harness.recordDecision).toHaveBeenCalledWith({
      runId: "run-1",
      task: harness.tasks.get("task-a"),
      reviewerId: "reviewer",
      revision: 1,
      decision: review
    });
  });

  it("prevents direct TaskService completion from bypassing Git integration", () => {
    const harness = createHarness();
    harness.store.putGitWorkspace(harness.workspace);
    harness.tasks.assign("task-a", "developer");
    harness.tasks.transition("task-a", "running", "developer");
    harness.tasks.submit("task-a", "developer", ["manifest.json"], ["hash"]);
    harness.store.putGitSubmission({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      submission: submission(),
      status: "approved"
    });

    expect(() => harness.tasks.transition("task-a", "completed", "reviewer"))
      .toThrow("integration");
    expect(harness.tasks.get("task-a").status).toBe("review");
  });
});
