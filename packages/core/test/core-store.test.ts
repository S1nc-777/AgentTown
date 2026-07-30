import { afterEach, describe, expect, it } from "vitest";
import { CoreStore } from "../src/storage/core-store.js";
import { companyDefinitionFixture, createTemporaryProject } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CoreStore", () => {
  it("commits events when one listener throws and still notifies later listeners", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();
    const received: string[] = [];
    store.subscribeEvents(() => { throw new Error("listener failure"); });
    store.subscribeEvents((event) => { received.push(event.id); });

    expect(() => store.insertEvent({
      id: "event-1", type: "validation.completed", actorId: "core", taskId: null,
      causationEventId: null, payload: {}
    })).not.toThrow();
    expect(store.listEvents(0).map(({ id }) => id)).toEqual(["event-1"]);
    expect(received).toEqual(["event-1"]);
    store.close();
  });

  it("persists atomic mutation request claims across reopen", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const first = new CoreStore(project.databasePath);
    first.initialize();
    try {
      expect(first.claimMutationRequest("client-a", "request-1", "fingerprint-a"))
        .toBe("claimed");
      expect(first.claimMutationRequest("client-a", "request-1", "fingerprint-a"))
        .toBe("duplicate");
      expect(first.claimMutationRequest("client-a", "request-1", "fingerprint-b"))
        .toBe("conflict");
    } finally {
      first.close();
    }

    const reopened = new CoreStore(project.databasePath);
    reopened.initialize();
    try {
      expect(reopened.claimMutationRequest(
        "client-a",
        "request-1",
        "fingerprint-a"
      )).toBe("duplicate");
      expect(reopened.claimMutationRequest(
        "client-b",
        "request-1",
        "fingerprint-a"
      )).toBe("claimed");
    } finally {
      reopened.close();
    }
  });

  it("persists a fact and its event in one transaction", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();

    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: {
        id: "event-1",
        type: "company.created",
        actorId: "owner",
        payload: { companyId: "company-1" },
        causationEventId: null,
        taskId: null
      }
    });

    expect(store.getCompany("company-1")?.id).toBe("company-1");
    expect(store.listEvents(0).map((event) => event.type)).toEqual(["company.created"]);
    store.close();
  });

  it("rolls back both fact and event when mutation fails", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();

    const event = {
      id: "duplicate-event",
      type: "company.created",
      actorId: "owner",
      payload: {},
      causationEventId: null,
      taskId: null
    };
    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event
    });

    expect(() => store.createCompany({
      id: "company-2",
      definition: companyDefinitionFixture(),
      event
    })).toThrow();

    expect(store.getCompany("company-2")).toBeNull();
    expect(store.listEvents(0)).toHaveLength(1);
    store.close();
  });

  it("atomically rolls back checkpoint and paused status when either pause event fails", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();
    const duplicateEvent = {
      id: "pause-duplicate",
      type: "company.created",
      actorId: "owner",
      payload: {},
      causationEventId: null,
      taskId: null
    };
    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: duplicateEvent
    });

    expect(() => store.commitPauseFacts(
      {
        id: "checkpoint-1",
        companyId: "company-1",
        createdAt: new Date().toISOString(),
        payload: { companyId: "company-1" }
      },
      {
        ...duplicateEvent,
        id: "checkpoint-event",
        type: "company.checkpointed"
      },
      {
        ...duplicateEvent,
        type: "company.paused"
      }
    )).toThrow();

    expect(store.latestCheckpoint("company-1")).toBeNull();
    expect(store.getCompany("company-1")?.status).toBe("active");
    expect(store.listEvents(0)).toHaveLength(1);
    store.close();
  });

  it("atomically rolls back a lifecycle status bundle when a later event fails", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();
    const companyEvent = {
      id: "company-event",
      type: "company.created",
      actorId: "owner",
      payload: {},
      causationEventId: null,
      taskId: null
    };
    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: companyEvent
    });

    expect(() => store.commitCompanyStatusWithEvents("company-1", "blocked", [
      {
        ...companyEvent,
        id: "first-failure-event",
        type: "company.recovery_blocked"
      },
      {
        ...companyEvent,
        type: "user.approval.requested"
      }
    ])).toThrow();

    expect(store.getCompany("company-1")?.status).toBe("active");
    expect(store.listEvents(0).map(({ id }) => id)).toEqual(["company-event"]);
    store.close();
  });

  it("reads the latest event sequence without loading event history", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();
    expect(store.getLatestEventSequence()).toBe(0);
    store.insertEvent({
      id: "event-sequence-1",
      type: "test.one",
      actorId: "test",
      payload: {},
      causationEventId: null,
      taskId: null
    });
    store.insertEvent({
      id: "event-sequence-2",
      type: "test.two",
      actorId: "test",
      payload: {},
      causationEventId: null,
      taskId: null
    });
    expect(store.getLatestEventSequence()).toBe(2);
    store.close();
  });

  it("rejects status changes for a missing company without publishing an event", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();
    const publishedEventIds: string[] = [];
    store.subscribeEvents((event) => {
      publishedEventIds.push(event.id);
    });

    try {
      expect(() => store.setCompanyStatus("missing-company", "paused", {
        id: "event-for-missing-company",
        type: "company.paused",
        actorId: "owner",
        payload: {},
        causationEventId: null,
        taskId: null
      })).toThrow("company not found");

      expect(store.listEvents(0)).toEqual([]);
      expect(publishedEventIds).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back a session fact when its event insert fails", async () => {
    const project = await createTemporaryProject();
    cleanups.push(project.cleanup);
    const store = new CoreStore(project.databasePath);
    store.initialize();
    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: {
        id: "company-created",
        type: "company.created",
        actorId: "owner",
        payload: {},
        causationEventId: null,
        taskId: null
      }
    });
    const handle = {
      employeeId: "developer",
      adapter: "fake",
      internalSessionId: "session-1",
      nativeSessionId: "native-1"
    };
    const sessionEvent = {
      id: "duplicate-session-event",
      type: "session.started",
      actorId: "developer",
      payload: { handle },
      causationEventId: null,
      taskId: null
    };

    store.putSession("company-1", "developer", handle, "running", sessionEvent);
    expect(() => store.putSession(
      "company-1",
      "developer",
      handle,
      "error",
      sessionEvent
    )).toThrow();

    expect(store.listSessions("company-1")).toEqual([{
      employeeId: "developer",
      handle,
      status: "running"
    }]);
    expect(store.listEvents(0).map((event) => event.type)).toEqual([
      "company.created",
      "session.started"
    ]);
    store.close();
  });
});
