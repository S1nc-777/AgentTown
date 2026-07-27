import { CoreStore } from "../storage/core-store.js";

export interface LeaseRegistryOptions {
  ttlMs: number;
  now: () => number;
  onLastClientExpired: () => void | Promise<void>;
}

export class LeaseRegistry {
  #hadLease = false;
  #pauseTriggered = false;

  constructor(
    private readonly store: CoreStore,
    private readonly options: LeaseRegistryOptions
  ) {}

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

  disconnect(clientId: string): void {
    this.store.deleteLease(clientId);
    void this.#triggerIfEmpty();
  }

  sweep(): void {
    this.store.deleteExpiredLeases(this.options.now());
    void this.#triggerIfEmpty();
  }

  async #triggerIfEmpty(): Promise<void> {
    if (
      !this.#hadLease ||
      this.#pauseTriggered ||
      this.store.countLeases() !== 0
    ) {
      return;
    }
    this.#pauseTriggered = true;
    await this.options.onLastClientExpired();
  }
}
