import { afterEach, describe, expect, it } from "vitest";
import { CoreStore } from "../src/storage/core-store.js";
import { companyDefinitionFixture, createTemporaryProject } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("CoreStore", () => {
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
});
