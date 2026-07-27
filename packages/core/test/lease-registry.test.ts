import { afterEach, describe, expect, it } from "vitest";
import { LeaseRegistry } from "../src/ipc/lease-registry.js";
import { CoreStore } from "../src/storage/core-store.js";

const stores: CoreStore[] = [];

function createInitializedMemoryStore(): CoreStore {
  const store = new CoreStore(":memory:");
  store.initialize();
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("LeaseRegistry", () => {
  it("fires last-client callback once after the final lease expires", () => {
    const store = createInitializedMemoryStore();
    let now = 1_000;
    let pauses = 0;
    const leases = new LeaseRegistry(store, {
      ttlMs: 5_000,
      now: () => now,
      onLastClientExpired: () => {
        pauses += 1;
      }
    });
    leases.heartbeat("client-a");
    leases.heartbeat("client-b");

    now = 7_000;
    leases.sweep();
    leases.sweep();

    expect(pauses).toBe(1);
  });

  it("does not pause when another lease remains valid", () => {
    const store = createInitializedMemoryStore();
    let now = 1_000;
    let pauses = 0;
    const leases = new LeaseRegistry(store, {
      ttlMs: 5_000,
      now: () => now,
      onLastClientExpired: () => {
        pauses += 1;
      }
    });
    leases.heartbeat("client-a");
    now = 4_000;
    leases.heartbeat("client-b");

    now = 7_000;
    leases.sweep();

    expect(pauses).toBe(0);
  });
});
