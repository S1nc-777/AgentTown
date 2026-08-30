import { CoreStore } from "../storage/core-store.js";

export interface LeaseRegistryOptions {
  ttlMs: number;
  now: () => number;
  onLastClientExpired: () => void | Promise<void>;
}

export class LeaseRegistry {
  #hadLease = false;
  #pauseTriggered = false;
  #triggerInFlight: Promise<void> | null = null;

  constructor(
    private readonly store: CoreStore,
    private readonly options: LeaseRegistryOptions
  ) {}

  get ttlMs(): number {
    return this.options.ttlMs;
  }

  initialize(): void {
    this.store.clearLeases();
  }

  heartbeat(clientId: string): void {
    this.store.upsertLease(
      clientId,
      this.options.now() + this.options.ttlMs
    );
    this.#hadLease = true;
    this.#pauseTriggered = false;
  }

  async disconnect(clientId: string): Promise<void> {
    this.store.deleteLease(clientId);
    await this.#triggerIfEmpty();
  }

  async sweep(): Promise<void> {
    this.store.deleteExpiredLeases(this.options.now());
    await this.#triggerIfEmpty();
  }

  #triggerIfEmpty(): Promise<void> {
    if (this.#triggerInFlight !== null) {
      return this.#triggerInFlight.then(() => this.#triggerIfEmpty());
    }
    if (
      !this.#hadLease ||
      this.#pauseTriggered ||
      this.store.countLeases() !== 0
    ) {
      return Promise.resolve();
    }
    this.#pauseTriggered = true;
    const trigger = Promise.resolve()
      .then(() => this.options.onLastClientExpired())
      .catch((error: unknown) => {
        // Keep #pauseTriggered set on failure: a failed pause (e.g. the
        // company is still starting its sessions) must not re-fire on every
        // sweep, which previously produced a 1-second pause_failed storm.
        // A new client heartbeat resets the flag so a later disconnect can
        // trigger pause again.
        throw error;
      })
      .finally(() => {
        if (this.#triggerInFlight === trigger) this.#triggerInFlight = null;
      });
    this.#triggerInFlight = trigger;
    return trigger;
  }
}
