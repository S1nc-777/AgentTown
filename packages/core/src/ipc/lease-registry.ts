import { AsyncLocalStorage } from "node:async_hooks";
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
  readonly #callbackContext = new AsyncLocalStorage<boolean>();

  constructor(
    private readonly store: CoreStore,
    private readonly options: LeaseRegistryOptions
  ) {}

  initialize(): void {
    this.store.clearLeases();
  }

  get isInsideLastClientCallback(): boolean {
    return this.#callbackContext.getStore() === true;
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
      .then(() => this.#callbackContext.run(
        true,
        () => this.options.onLastClientExpired()
      ))
      .catch((error: unknown) => {
        this.#pauseTriggered = false;
        throw error;
      })
      .finally(() => {
        if (this.#triggerInFlight === trigger) this.#triggerInFlight = null;
      });
    this.#triggerInFlight = trigger;
    return trigger;
  }
}
