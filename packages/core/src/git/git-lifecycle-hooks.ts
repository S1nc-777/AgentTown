import type { GitCheckpoint, ReconciliationResult } from "@agenttown/runtime-contract";
import type { GitReconciler } from "./git-reconciler.js";
import type { GitWorkflowCoordinator } from "./git-workflow-coordinator.js";
import type { IntegrationService } from "./integration-service.js";
import type { ValidationRunner } from "./validation-runner.js";

export interface GitLifecycleHooksOptions {
  runId: string;
  coordinator: Pick<GitWorkflowCoordinator, "stopNewActions" | "resumeNewActions">;
  validationRunner: Pick<ValidationRunner, "abortActive">;
  integrationService: Pick<IntegrationService, "settleIntegrationIntent" | "resumeIntegrationDispatch">;
  reconciler: Pick<GitReconciler, "snapshot" | "reconcile">;
}

export class GitLifecycleHooks {
  readonly #runId: string;
  readonly #coordinator: GitLifecycleHooksOptions["coordinator"];
  readonly #validationRunner: GitLifecycleHooksOptions["validationRunner"];
  readonly #integrationService: GitLifecycleHooksOptions["integrationService"];
  readonly #reconciler: GitLifecycleHooksOptions["reconciler"];

  constructor(options: GitLifecycleHooksOptions) {
    this.#runId = options.runId;
    this.#coordinator = options.coordinator;
    this.#validationRunner = options.validationRunner;
    this.#integrationService = options.integrationService;
    this.#reconciler = options.reconciler;
  }

  resumeNewActions(): void {
    this.#coordinator.resumeNewActions();
    this.#integrationService.resumeIntegrationDispatch();
  }

  async abortValidations(signal: AbortSignal, deadlineAt: number): Promise<void> {
    this.#coordinator.stopNewActions();
    await this.#validationRunner.abortActive(deadlineAt);
    signal.throwIfAborted();
  }

  async settleIntegrationIntent(signal: AbortSignal, deadlineAt: number): Promise<void> {
    signal.throwIfAborted();
    this.#coordinator.stopNewActions();
    await this.#integrationService.settleIntegrationIntent(deadlineAt);
  }

  snapshot(): Promise<GitCheckpoint> {
    return this.#reconciler.snapshot(this.#runId);
  }

  reconcile(runId: string): Promise<ReconciliationResult> {
    if (runId !== this.#runId) {
      return Promise.reject(new Error(`Git lifecycle run mismatch: ${runId}`));
    }
    return this.#reconciler.reconcile(runId);
  }
}
