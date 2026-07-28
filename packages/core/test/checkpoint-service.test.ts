import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentAdapter,
  AgentCapabilities,
  CompanyDefinition
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../src/agents/fake-adapter.js";
import { SessionManager } from "../src/agents/session-manager.js";
import { CompanyOrchestrator } from "../src/company/orchestrator.js";
import { CheckpointService } from "../src/lifecycle/checkpoint-service.js";
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
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.sessions.stopAll().catch(() => undefined);
    harness.store.close();
    await harness.project.cleanup();
  }
});

async function createHarness(options: {
  reviewerNativeResume?: AgentCapabilities["nativeResume"];
  pauseTimeoutMs?: number;
  interrupt?: AgentAdapter["interrupt"];
  reviewerResume?: AgentAdapter["resume"];
} = {}): Promise<Harness> {
  const project = await createTemporaryProject();
  const base = companyDefinitionFixture();
  const company: CompanyDefinition = {
    ...base,
    employees: base.employees.map((employee) => ({
      ...employee,
      agent: employee.id === "reviewer" ? "fake-reviewer" : "fake"
    }))
  };
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
  const normal = adapterWithNativeResume(baseAdapter, "supported");
  const reviewerBase = adapterWithNativeResume(
    baseAdapter,
    options.reviewerNativeResume ?? "supported"
  );
  const reviewer: AgentAdapter = options.reviewerResume === undefined
    ? reviewerBase
    : { ...reviewerBase, resume: options.reviewerResume };
  const interrupted: AgentAdapter = options.interrupt === undefined
    ? normal
    : { ...normal, interrupt: options.interrupt };
  const adapterFor = (name: string): AgentAdapter =>
    name === "fake-reviewer" ? reviewer : interrupted;
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
  const harness = { project, company, store, sessions, orchestrator, lifecycle };
  harnesses.push(harness);
  await orchestrator.start({});
  return harness;
}

describe("CheckpointService", () => {
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
    expect(types.indexOf("company.checkpointed")).toBeLessThan(types.indexOf("company.paused"));
    expect(types.indexOf("company.paused")).toBeLessThan(types.indexOf("session.stopped"));
  });

  it("uses native resume only when declared and rebuilds the other real session", async () => {
    const { lifecycle, sessions, store } = await createHarness({
      reviewerNativeResume: "unsupported"
    });
    const checkpoint = await lifecycle.pause("last_client_exited");
    const oldHandles = new Map(
      checkpoint.sessions.map((session) => [session.employeeId, session.handle])
    );

    const { decisions } = await lifecycle.recoverLatest();

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
  });

  it("records an interrupt timeout and still leaves a stopped, paused company", async () => {
    const neverInterrupt: AgentAdapter["interrupt"] = async () =>
      await new Promise<never>(() => undefined);
    const { lifecycle, store } = await createHarness({
      interrupt: neverInterrupt,
      pauseTimeoutMs: 20
    });

    await lifecycle.pause("shutdown");

    expect(store.getCompany(companyId)?.status).toBe("paused");
    expect(store.listSessions(companyId).every(({ status }) => status === "stopped")).toBe(true);
    expect(store.listEvents(0).some(({ type }) => type === "company.pause_timeout")).toBe(true);
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
});
