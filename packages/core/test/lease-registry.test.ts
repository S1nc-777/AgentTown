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
  it("fires last-client callback once after the final lease expires", async () => {
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
    await leases.sweep();
    await leases.sweep();

    expect(pauses).toBe(1);
  });

  it("does not pause when another lease remains valid", async () => {
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
    await leases.sweep();

    expect(pauses).toBe(0);
  });

  it("returns an awaitable for last-client callback completion", async () => {
    const store = createInitializedMemoryStore();
    let now = 0;
    let release: () => void = () => undefined;
    const callbackFinished = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const leases = new LeaseRegistry(store, {
      ttlMs: 5_000,
      now: () => now,
      onLastClientExpired: () => callbackFinished
    });
    leases.heartbeat("client-a");
    now = 10_000;

    const sweeping = leases.sweep();
    expect(sweeping).toBeInstanceOf(Promise);
    release();
    await sweeping;
  });

  it("reports callback rejection and allows a later retry", async () => {
    const store = createInitializedMemoryStore();
    let now = 0;
    let attempts = 0;
    const leases = new LeaseRegistry(store, {
      ttlMs: 5_000,
      now: () => now,
      onLastClientExpired: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("pause failed");
      }
    });
    leases.heartbeat("client-a");
    now = 10_000;

    await expect(leases.sweep()).rejects.toThrow("pause failed");
    await expect(leases.sweep()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
