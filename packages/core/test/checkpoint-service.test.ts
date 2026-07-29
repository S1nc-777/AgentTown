import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentAdapter,
  AgentCapabilities,
  CompanyDefinition
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgentAdapter } from "../src/agents/fake-adapter.js";
import { SessionManager } from "../src/agents/session-manager.js";
import { CompanyOrchestrator } from "../src/company/orchestrator.js";
import {
  CheckpointService,
  type CheckpointServiceOptions
} from "../src/lifecycle/checkpoint-service.js";
import { RecoveryBlockedError } from "../src/lifecycle/checkpoint-service.js";
import { ActionPolicy } from "../src/policy/action-policy.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import { companyDefinitionFixture, createTemporaryProject } from "./helpers.js";

const fakeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../fake-agent");
const companyId = "company-1";

function adapterWithNativeResume(
  adapter: FakeAgentAdapter,
  nativeResume: AgentCapabilities["nativeResume"]
): AgentAdapter {
  return {
    detect: () => adapter.detect(),
    capabilities: async () => ({
      ...await adapter.capabilities(),
      nativeResume
    }),
    start: (input) => adapter.start(input),
    send: (session, message) => adapter.send(session, message),
    interrupt: (session) => adapter.interrupt(session),
    resume: (input) => adapter.resume(input),
    stop: (session) => adapter.stop(session),
    forceStop: (session) => adapter.forceStop(session),
    usage: (session) => adapter.usage(session)
  };
}

interface Harness {
  project: Awaited<ReturnType<typeof createTemporaryProject>>;
  company: CompanyDefinition;
  store: CoreStore;
  sessions: SessionManager;
  orchestrator: CompanyOrchestrator;
  lifecycle: CheckpointService;
  cleanupAdapter: FakeAgentAdapter;
}

const harnesses: Harness[] = [];

class PauseCommitFailureStore extends CoreStore {
  override commitPauseFacts(): void {
    throw new Error("injected pause commit failure");
  }
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await Promise.race([
      harness.sessions.stopAll().catch(() => undefined),
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50))
    ]);
    for (const { handle } of harness.store.listSessions(companyId)) {
      await harness.cleanupAdapter.forceStop(handle).catch(() => undefined);
    }
    harness.store.close();
    await harness.project.cleanup();
  }
});

async function createHarness(options: {
  reviewerNativeResume?: AgentCapabilities["nativeResume"];
  pauseTimeoutMs?: number;
  interrupt?: AgentAdapter["interrupt"];
  reviewerResume?: AgentAdapter["resume"];
  scenarios?: Readonly<Record<string, string>>;
  stop?: AgentAdapter["stop"];
  forceStop?: NonNullable<AgentAdapter["forceStop"]>;
  forceStopDelayMs?: number;
  storeFactory?: (databasePath: string) => CoreStore;
} = {}): Promise<Harness> {
  const project = await createTemporaryProject();
  const company = companyDefinitionFixture();
  const store = options.storeFactory?.(project.databasePath)
    ?? new CoreStore(project.databasePath);
  store.initialize();
  store.createCompany({
    id: companyId,
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

  const baseAdapter = new FakeAgentAdapter({
    executable: process.execPath,
    packageRoot: fakeRoot,
    allowedEmployeeIds: new Set(company.employees.map(({ id }) => id))
  });
  const normal = adapterWithNativeResume(baseAdapter, "supported");
  const configured: AgentAdapter = {
    ...normal,
    ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
    ...(options.reviewerResume === undefined
      ? {}
      : {
          resume: (input) => input.employeeId === "reviewer"
            ? options.reviewerResume!(input)
            : normal.resume(input)
        }),
    ...(options.reviewerNativeResume === undefined
      ? {}
      : {
          capabilities: async () => ({
            ...await normal.capabilities(),
            nativeResume: options.reviewerNativeResume!
          })
        }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.forceStop === undefined ? {} : { forceStop: options.forceStop }),
    ...(options.forceStopDelayMs === undefined
      ? {}
      : {
          forceStop: async (session) => {
            await new Promise<void>((resolvePromise) => {
              setTimeout(resolvePromise, options.forceStopDelayMs);
            });
            await normal.forceStop?.(session);
          }
        })
  };
  const adapterFor = (): AgentAdapter => configured;
  const sessions = new SessionManager(adapterFor, store, companyId, project.root);
  const tasks = new TaskService(store, companyId, company, "leader");
  const orchestrator = new CompanyOrchestrator(
    companyId,
    company,
    store,
    tasks,
    new ActionPolicy(company, "leader", new Set(["reviewer"])),
    sessions,
    "leader",
    "reviewer"
  );
  const lifecycle = new CheckpointService({
    companyId,
    company,
    store,
    orchestrator,
    sessions,
    adapterFor,
    ...(options.pauseTimeoutMs === undefined
      ? {}
      : { pauseTimeoutMs: options.pauseTimeoutMs })
  });
  const harness = {
    project,
    company,
    store,
    sessions,
    orchestrator,
    lifecycle,
    cleanupAdapter: baseAdapter
  };
  harnesses.push(harness);
  await orchestrator.start(options.scenarios ?? {});
  return harness;
}

describe("CheckpointService", () => {
  it("stops running or paused companies as an explicit terminal state", async () => {
    const running = await createHarness();
    await running.lifecycle.stop();
    expect(running.store.getCompany(companyId)?.status).toBe("stopped");
    expect(running.store.listEvents(0).map(({ type }) => type))
      .toEqual(expect.arrayContaining([
        "company.stopping",
        "company.checkpointed",
        "company.stopped"
      ]));
    expect(running.store.listEvents(0).filter(({ type }) =>
      type === "company.paused"
    )).toHaveLength(0);

    const paused = await createHarness();
    await paused.lifecycle.pause("user_requested");
    await paused.lifecycle.stop();
    expect(paused.store.getCompany(companyId)?.status).toBe("stopped");
    await expect(paused.lifecycle.recoverLatest())
      .rejects.toThrow("not eligible for recovery: stopped");
    expect(() => paused.sessions.get("leader")).toThrow("session not started");
  });

  it("audits stop cleanup failure as stop_failed with stop-specific approval semantics", async () => {
    const { lifecycle, store } = await createHarness({
      pauseTimeoutMs: 30,
      stop: async () => await new Promise<never>(() => undefined),
      forceStop: async () => await new Promise<never>(() => undefined)
    });

    await expect(lifecycle.stop()).rejects.toThrow("pause failed");

    const events = store.listEvents(0);
    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(events.filter(({ type }) => type === "company.stop_failed")).toHaveLength(1);
    expect(events.filter(({ type }) => type === "company.pause_failed")).toHaveLength(0);
    expect(events.find(({ type }) => type === "user.approval.requested")?.payload)
      .toMatchObject({
        reason: "stop_cleanup_failed",
        operation: "complete company stop",
        options: ["retry_stop", "inspect_processes", "keep_blocked"]
      });
  });

  it("checkpoints active work before stopping real Fake Agent sessions", async () => {
    const { lifecycle, store, sessions, tasks } = await (async () => {
      const harness = await createHarness();
      return {
        ...harness,
        tasks: new TaskService(harness.store, companyId, harness.company, "leader")
      };
    })();
    tasks.create({
      id: "task-active",
      title: "Build lifecycle",
      objective: "Persist and recover active work",
      ownerEmployeeId: null,
      dependencies: [],
      acceptanceCriteria: ["Recovery is honest"],
      status: "draft",
      retryCount: 0,
      reviewLoopCount: 0,
      artifacts: [],
      evidence: []
    });
    tasks.assign("task-active", "developer");
    tasks.transition("task-active", "running", "developer");

    const checkpoint = await lifecycle.pause("user_requested");

    expect(checkpoint.reason).toBe("user_requested");
    expect(checkpoint.sessions).toHaveLength(3);
    expect(checkpoint.sessions.find(({ employeeId }) => employeeId === "developer"))
      .toMatchObject({
        activeTaskId: "task-active",
        handoff: expect.stringContaining("Persist and recover active work")
      });
    expect(store.getCompany(companyId)?.status).toBe("paused");
    expect(store.listSessions(companyId).every(({ status }) => status === "stopped")).toBe(true);
    expect(() => sessions.get("developer")).toThrow("session not started");

    const types = store.listEvents(0).map(({ type }) => type);
    expect(types.indexOf("company.pausing")).toBeLessThan(types.indexOf("company.checkpointed"));
    expect(types.indexOf("company.checkpointed")).toBeLessThan(types.indexOf("company.paused"));
    expect(types.indexOf("company.paused")).toBeLessThan(types.indexOf("session.stopped"));
  });

  it("uses cooperative stop under the default deadline without force escalation", async () => {
    let forceCalls = 0;
    const { lifecycle, store } = await createHarness({
      forceStop: async () => {
        forceCalls += 1;
      }
    });

    await lifecycle.pause("user_requested");

    expect(forceCalls).toBe(0);
    expect(store.getCompany(companyId)?.status).toBe("paused");
  });

  it("cleans sessions and atomically blocks when pause commit fails before checkpoint", async () => {
    const { lifecycle, store, sessions } = await createHarness({
      storeFactory: (databasePath) => new PauseCommitFailureStore(databasePath)
    });

    await expect(lifecycle.pause("user_requested"))
      .rejects.toThrow("injected pause commit failure");

    expect(store.latestCheckpoint(companyId)).toBeNull();
    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).toThrow("session not started");
    expect(store.listEvents(0).map(({ type }) => type)).toEqual(expect.arrayContaining([
      "company.pause_failed",
      "user.approval.requested"
    ]));
    expect(store.listEvents(0).find(({ type }) => type === "user.approval.requested")?.payload)
      .toMatchObject({ reason: "pause_failed" });
  });

  it("retains ownership when force-stop close is observed after the literal deadline", async () => {
    const { lifecycle, store, sessions } = await createHarness({
      stop: async () => await new Promise<never>(() => undefined),
      forceStopDelayMs: 60,
      pauseTimeoutMs: 30
    });

    await expect(lifecycle.pause("shutdown")).rejects.toThrow("pause failed");

    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).not.toThrow();
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 80));
    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).not.toThrow();
    expect(store.listSessions(companyId).every(({ status }) => status !== "stopped")).toBe(true);
    expect(store.listEvents(0).find(({ type }) => type === "user.approval.requested")?.payload)
      .toMatchObject({
        reason: "cleanup_failed",
        options: ["retry_cleanup", "inspect_processes", "keep_blocked"]
      });
  });

  it("takes an ownership snapshot at a one-millisecond deadline and retains live sessions", async () => {
    let stopCalls = 0;
    let forceCalls = 0;
    const { lifecycle, store, sessions } = await createHarness({
      pauseTimeoutMs: 1,
      interrupt: async () => await new Promise<never>(() => undefined),
      stop: async () => {
        stopCalls += 1;
      },
      forceStop: async () => {
        forceCalls += 1;
      }
    });

    await expect(lifecycle.pause("shutdown")).rejects.toThrow("pause failed");

    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(stopCalls).toBe(0);
    expect(forceCalls).toBe(0);
    expect(() => sessions.get("leader")).not.toThrow();
    expect(store.listEvents(0).find(({ type }) => type === "user.approval.requested")?.payload)
      .toMatchObject({
        reason: "cleanup_failed",
        options: ["retry_cleanup", "inspect_processes", "keep_blocked"]
      });
  });

  it("does not invoke synchronous stop when the global deadline expires before the attempt", async () => {
    let stopCalls = 0;
    const harness = await createHarness({
      pauseTimeoutMs: 100,
      stop: async () => {
        stopCalls += 1;
      }
    });
    const {
      company,
      store,
      sessions,
      orchestrator,
      cleanupAdapter
    } = harness;
    let now = 1_000;
    let ownershipSnapshots = 0;
    let cleanupClockReads = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      if (ownershipSnapshots < 2) return now;
      cleanupClockReads += 1;
      return cleanupClockReads <= 2 ? 1_099 : 1_101;
    });
    const lifecycleSessions: CheckpointServiceOptions["sessions"] = {
      interruptAll: (signal) => sessions.interruptAll(signal),
      stopAll: () => sessions.stopAll(),
      stopAllBounded: (_signal, force, deadlineAt) => sessions.stopAllBounded(
        new AbortController().signal,
        force,
        deadlineAt
      ),
      cleanupOwnershipSnapshot: () => {
        ownershipSnapshots += 1;
        return sessions.cleanupOwnershipSnapshot();
      },
      cancelPendingReplacements: () => sessions.cancelPendingReplacements(),
      resumeOne: (employee, checkpoint, signal) =>
        sessions.resumeOne(employee, checkpoint, signal),
      rebuildOne: (employee, handoff, signal) =>
        sessions.rebuildOne(employee, handoff, signal)
    };
    const lifecycle = new CheckpointService({
      companyId,
      company,
      store,
      orchestrator,
      sessions: lifecycleSessions,
      adapterFor: () => adapterWithNativeResume(cleanupAdapter, "supported"),
      pauseTimeoutMs: 100
    });

    try {
      await expect(lifecycle.pause("shutdown")).rejects.toThrow("pause failed");
    } finally {
      nowSpy.mockRestore();
    }

    expect(stopCalls).toBe(0);
    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).not.toThrow();
  });

  it("uses native resume only when declared and rebuilds the other real session", async () => {
    const { lifecycle, sessions, store } = await createHarness();
    const checkpoint = await lifecycle.pause("last_client_exited");
    const mixedCheckpoint = {
      ...checkpoint,
      sessions: checkpoint.sessions.map((session) => session.employeeId === "reviewer"
        ? { ...session, handle: { ...session.handle, nativeSessionId: null } }
        : session)
    };
    const oldHandles = new Map(
      checkpoint.sessions.map((session) => [session.employeeId, session.handle])
    );

    const { decisions } = await lifecycle.recover(mixedCheckpoint);

    expect(decisions).toEqual([
      { employeeId: "leader", mode: "native" },
      { employeeId: "developer", mode: "native" },
      { employeeId: "reviewer", mode: "rebuilt" }
    ]);
    expect(sessions.get("leader").nativeSessionId)
      .toBe(oldHandles.get("leader")?.nativeSessionId);
    expect(sessions.get("reviewer").nativeSessionId)
      .not.toBe(oldHandles.get("reviewer")?.nativeSessionId);
    expect(store.getCompany(companyId)?.status).toBe("running");
    const recoveryEvents = store.listEvents(0)
      .filter(({ type }) => type === "session.recovered" || type === "session.rebuilt");
    expect(recoveryEvents.map(({ type }) => type)).toEqual([
      "session.recovered",
      "session.recovered",
      "session.rebuilt"
    ]);
    expect(store.listEvents(0).map(({ type }) => type)).toContain("company.starting");
  });

  it("blocks within the total deadline when termination cannot be confirmed", async () => {
    const neverInterrupt: AgentAdapter["interrupt"] = async () =>
      await new Promise<never>(() => undefined);
    const { lifecycle, store, sessions } = await createHarness({
      interrupt: neverInterrupt,
      stop: async () => await new Promise<never>(() => undefined),
      forceStop: async () => await new Promise<never>(() => undefined),
      pauseTimeoutMs: 20
    });

    const startedAt = Date.now();
    await expect(lifecycle.pause("shutdown")).rejects.toThrow("pause failed");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThanOrEqual(120);
    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).not.toThrow();
    expect(store.listEvents(0).some(({ type }) => type === "company.pause_timeout")).toBe(true);
    expect(store.listEvents(0).map(({ type }) => type)).toEqual(expect.arrayContaining([
      "session.stop_failed",
      "company.pause_failed",
      "user.approval.requested"
    ]));
    expect(store.listEvents(0).find(({ type }) => type === "user.approval.requested")?.payload)
      .toMatchObject({
        reason: "cleanup_failed",
        options: ["retry_cleanup", "inspect_processes", "keep_blocked"]
      });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(store.getCompany(companyId)?.status).toBe("blocked");
  });

  it("records interrupt failure and continues the same checkpoint path", async () => {
    const { lifecycle, store } = await createHarness({
      interrupt: async () => {
        throw new Error("interrupt unavailable");
      }
    });

    await lifecycle.pause("user_requested");

    expect(store.getCompany(companyId)?.status).toBe("paused");
    expect(store.listEvents(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.interrupt_failed",
        payload: expect.objectContaining({ error: expect.stringContaining("interrupt unavailable") })
      })
    ]));
  });

  it("rebuilds when a supported adapter has no native session id", async () => {
    const { lifecycle, store } = await createHarness();
    const checkpoint = await lifecycle.pause("user_requested");
    const withoutNativeId = {
      ...checkpoint,
      sessions: checkpoint.sessions.map((session) =>
        session.employeeId === "reviewer"
          ? {
              ...session,
              handle: { ...session.handle, nativeSessionId: null }
            }
          : session
      )
    };

    const { decisions } = await lifecycle.recover(withoutNativeId);

    expect(decisions.at(-1)).toEqual({ employeeId: "reviewer", mode: "rebuilt" });
    expect(store.listEvents(0).at(-2)?.type).toBe("session.rebuilt");
  });

  it("stops already recovered sessions and blocks the company on recovery failure", async () => {
    const { lifecycle, store } = await createHarness({
      reviewerResume: async () => {
        throw new Error("native resume failed");
      }
    });
    const checkpoint = await lifecycle.pause("shutdown");

    await expect(lifecycle.recover(checkpoint)).rejects.toBeInstanceOf(
      RecoveryBlockedError
    );

    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(store.listSessions(companyId).every(({ status }) => status === "stopped")).toBe(true);
    expect(store.listEvents(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "company.recovery_blocked",
        payload: expect.objectContaining({
          employeeId: "reviewer",
          error: expect.stringContaining("native resume failed")
        })
      })
    ]));
  });

  it("returns the original checkpoint for sequential pause reasons", async () => {
    const { lifecycle, store } = await createHarness();

    const first = await lifecycle.pause("user_requested");
    const second = await lifecycle.pause("last_client_exited");

    expect(second).toEqual(first);
    expect(second.reason).toBe("user_requested");
    expect(store.listEvents(0).filter(({ type }) => type === "company.checkpointed"))
      .toHaveLength(1);
    expect(store.listEvents(0).filter(({ type }) => type === "company.paused"))
      .toHaveLength(1);
  });

  it("records interrupted false as employee-owned failure", async () => {
    const { lifecycle, store } = await createHarness({
      interrupt: async () => ({ interrupted: false })
    });

    await lifecycle.pause("user_requested");

    expect(store.listEvents(0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.interrupt_failed",
        actorId: "leader",
        payload: expect.objectContaining({ employeeId: "leader" })
      })
    ]));
  });

  it("blocks and requests approval when stop and force-stop cannot clean up", async () => {
    const project = await createTemporaryProject();
    const company = companyDefinitionFixture();
    const store = new CoreStore(project.databasePath);
    store.initialize();
    store.createCompany({
      id: companyId,
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
    const baseAdapter = new FakeAgentAdapter({
      executable: process.execPath,
      packageRoot: fakeRoot,
      allowedEmployeeIds: new Set(company.employees.map(({ id }) => id))
    });
    const unkillable: AgentAdapter = {
      ...adapterWithNativeResume(baseAdapter, "supported"),
      stop: async () => await new Promise<never>(() => undefined),
      forceStop: async () => await new Promise<never>(() => undefined)
    };
    const sessions = new SessionManager(() => unkillable, store, companyId, project.root);
    const tasks = new TaskService(store, companyId, company, "leader");
    const orchestrator = new CompanyOrchestrator(
      companyId,
      company,
      store,
      tasks,
      new ActionPolicy(company, "leader", new Set(["reviewer"])),
      sessions,
      "leader",
      "reviewer"
    );
    const lifecycle = new CheckpointService({
      companyId,
      company,
      store,
      orchestrator,
      sessions,
      adapterFor: () => unkillable,
      pauseTimeoutMs: 40
    });
    await orchestrator.start({});
    try {
      await expect(lifecycle.pause("shutdown")).rejects.toThrow("pause failed");

      expect(store.getCompany(companyId)?.status).toBe("blocked");
      expect(store.listEvents(0).map(({ type }) => type)).toEqual(expect.arrayContaining([
        "session.stop_failed",
        "company.pause_failed",
        "user.approval.requested"
      ]));
    } finally {
      for (const { handle } of store.listSessions(companyId)) {
        await baseAdapter.stop(handle).catch(() => undefined);
      }
      store.close();
      await project.cleanup();
    }
  });

  it("blocks corrupt persisted recovery before starting a process", async () => {
    const { lifecycle, store, sessions } = await createHarness();
    await lifecycle.pause("user_requested");
    const stored = store.latestCheckpoint(companyId);
    if (stored === null) throw new Error("checkpoint missing");
    store.putCheckpoint(
      {
        ...stored,
        id: randomUUID(),
        createdAt: new Date(Date.now() + 1_000).toISOString(),
        payload: { ...stored.payload, sessions: [{ employeeId: "intruder" }] }
      },
      {
        id: randomUUID(),
        type: "test.corrupt_checkpoint",
        actorId: "test",
        taskId: null,
        causationEventId: null,
        payload: {}
      }
    );

    await expect(lifecycle.recoverLatest()).rejects.toThrow();

    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).toThrow("session not started");
    expect(store.listEvents(0).map(({ type }) => type)).toEqual(expect.arrayContaining([
      "company.recovery_blocked",
      "user.approval.requested"
    ]));
    expect(store.listEvents(0).find(({ type }) => type === "user.approval.requested")?.payload)
      .toMatchObject({
        reason: "invalid_checkpoint",
        options: expect.arrayContaining(["repair_checkpoint", "select_checkpoint"])
      });
  });

  it("blocks semantic adapter mismatch before starting a recovery process", async () => {
    const { lifecycle, store, sessions } = await createHarness();
    const checkpoint = await lifecycle.pause("user_requested");
    const mismatched = {
      ...checkpoint,
      sessions: checkpoint.sessions.map((session, index) => index === 0
        ? { ...session, handle: { ...session.handle, adapter: "other-adapter" } }
        : session)
    };

    await expect(lifecycle.recover(mismatched)).rejects.toThrow("recovery blocked");

    expect(store.getCompany(companyId)?.status).toBe("blocked");
    expect(() => sessions.get("leader")).toThrow("session not started");
    expect(store.listEvents(0).map(({ type }) => type)).toEqual(expect.arrayContaining([
      "company.recovery_blocked",
      "user.approval.requested"
    ]));
  });

  it("fences late interrupt completion from writing session facts", async () => {
    let resolveInterrupt: ((value: { interrupted: boolean }) => void) | undefined;
    const lateInterrupt = new Promise<{ interrupted: boolean }>((resolvePromise) => {
      resolveInterrupt = resolvePromise;
    });
    const { lifecycle, store } = await createHarness({
      interrupt: async () => lateInterrupt,
      pauseTimeoutMs: 500
    });

    await lifecycle.pause("user_requested");
    const eventCount = store.listEvents(0).length;
    resolveInterrupt?.({ interrupted: true });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));

    expect(store.listEvents(0)).toHaveLength(eventCount);
    expect(store.listEvents(0).some(({ type }) => type === "session.interrupted")).toBe(false);
  });

  it("fences an in-flight Fake Agent continuation after checkpoint creation", async () => {
    const harness = await createHarness({
      scenarios: { developer: "silent" },
      pauseTimeoutMs: 500
    });
    const tasks = new TaskService(harness.store, companyId, harness.company, "leader");
    tasks.create({
      id: "task-fenced",
      title: "Fence late work",
      objective: "Do not mutate after pause",
      ownerEmployeeId: null,
      dependencies: [],
      acceptanceCriteria: ["No post-checkpoint task events"],
      status: "draft",
      retryCount: 0,
      reviewLoopCount: 0,
      artifacts: [],
      evidence: []
    });
    tasks.assign("task-fenced", "developer");
    tasks.transition("task-fenced", "running", "developer");
    const running = harness.orchestrator.sendTask("task-fenced");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));

    await harness.lifecycle.pause("user_requested");
    await running;

    const checkpointEvent = harness.store.listEvents(0)
      .find(({ type }) => type === "company.checkpointed");
    if (checkpointEvent === undefined) throw new Error("checkpoint event missing");
    expect(harness.store.listEvents(checkpointEvent.sequence)
      .filter(({ taskId }) => taskId === "task-fenced")).toEqual([]);
    expect(tasks.get("task-fenced").status).toBe("running");
  });

  it("singleflights concurrent recovery and rejects a repeat from running", async () => {
    const { lifecycle, store } = await createHarness();
    const checkpoint = await lifecycle.pause("user_requested");

    const first = lifecycle.recover(checkpoint);
    const second = lifecycle.recover(checkpoint);
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const recoveredCount = store.listEvents(0)
      .filter(({ type }) => type === "session.recovered").length;
    const startedCount = store.listEvents(0)
      .filter(({ type }) => type === "session.started").length;

    await expect(lifecycle.recover(checkpoint)).rejects.toThrow("not eligible");

    expect(store.listEvents(0).filter(({ type }) => type === "session.recovered"))
      .toHaveLength(recoveredCount);
    expect(store.listEvents(0).filter(({ type }) => type === "session.started"))
      .toHaveLength(startedCount);
  });
});
