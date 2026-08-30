import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseCompanyYaml,
  type AgentAdapter,
  type AgentMessage,
  type CompanyDefinition,
  type GitRunRecord
} from "@agenttown/runtime-contract";
import { CodexAgentAdapter } from "./agents/codex-adapter.js";
import { ClaudeAgentAdapter } from "./agents/claude-adapter.js";
import { FakeAgentAdapter } from "./agents/fake-adapter.js";
import { OpenCodeAgentAdapter } from "./agents/opencode-adapter.js";
import { SessionManager } from "./agents/session-manager.js";
import {
  CompanyOrchestrator,
  GitTaskWorkflow
} from "./company/orchestrator.js";
import { CoreServer } from "./ipc/core-server.js";
import { LeaseRegistry } from "./ipc/lease-registry.js";
import { CheckpointService } from "./lifecycle/checkpoint-service.js";
import { ActionPolicy } from "./policy/action-policy.js";
import { CoreStore } from "./storage/core-store.js";
import { TaskService } from "./tasks/task-service.js";
import { CleanupService } from "./git/cleanup-service.js";
import { ConflictService } from "./git/conflict-service.js";
import { EvidencePackageBuilder } from "./git/evidence-package.js";
import { GitLifecycleHooks } from "./git/git-lifecycle-hooks.js";
import { GitReconciler } from "./git/git-reconciler.js";
import { GitWorkflowCoordinator } from "./git/git-workflow-coordinator.js";
import { IntegrationService } from "./git/integration-service.js";
import { RepositoryPreflight } from "./git/repository-preflight.js";
import { ReviewService } from "./git/review-service.js";
import { SubmissionValidator } from "./git/submission-validator.js";
import { ValidationRunner } from "./git/validation-runner.js";
import { WorkspaceManager } from "./git/workspace-manager.js";

export const DEFAULT_COMPANY_ID = "company";
const PIPE_PATTERN = /^agenttown-[a-f0-9]{24}$/u;
const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Deterministic Git fixture scenarios supported by the Fake Agent. When any
 * employee is started with one of these scenarios the Core enables the P1B Git
 * collaboration workflow (preflight, active run, Git services, GitTaskWorkflow)
 * for the company. P1B is Fake-only: no real Agent can be launched.
 */
const GIT_FIXTURE_SCENARIOS = new Set([
  "git-developer-a",
  "git-developer-b",
  "git-review-approve",
  "git-review-reject",
  "git-conflict",
  "git-conflict-resolve"
]);

/**
 * Default startup scenario for employees backed by a real Agent (Codex,
 * Claude, OpenCode). `scenario` is embedded verbatim in the adapter's initial
 * prompt, so this is a full role instruction rather than a fixture id.
 */
const REAL_AGENT_LEADER_PROMPT = [
  "You are the company leader agent.",
  "Direct the developers and reviewer, propose and assign tasks, and drive the mission to completion."
].join(" ");

/**
 * Startup scenario for real-agent developer employees. `scenario` is embedded
 * verbatim in the adapter's initial prompt. The per-task message (which
 * includes the git worktree task context JSON) tells the developer where to
 * work; this prompt teaches the submission protocol.
 */
const REAL_AGENT_DEVELOPER_PROMPT = [
  "You are a developer employee in the AgentTown company.",
  "You implement tasks inside a dedicated git worktree; the task message includes its workspace root path.",
  "Implement the task in that workspace root: write the required files, then git add and git commit your changes there.",
  "When your work is committed, emit a task.submit action whose payload.submission is a git submission object:",
  '{ "schemaVersion": 1, "headCommit": "<latest commit sha of your worktree branch, from `git rev-parse HEAD`>", "commits": ["<your commit shas, oldest first, from `git log --format=%H`>"], "changeSummary": "<short description>", "validationCommandIds": ["git-clean"], "suggestedValidationCommands": [], "reportedResults": [], "knownRisks": [] }',
  "Only emit task.submit after your changes are committed in the worktree."
].join("\n");

/**
 * Per-employee startup scenarios owned by the Core. Real-agent employees
 * (codex, claude, opencode) get the leader prompt with the company mission
 * injected, because `scenario` is embedded verbatim in the adapter's initial
 * prompt; fake employees get deterministic fixture ids. The same scenarios
 * feed CheckpointService recovery, so the mission text is also present when a
 * leader session is resumed or rebuilt from a checkpoint.
 */
export function coreStartupScenarios(
  company: CompanyDefinition
): Readonly<Record<string, string>> {
  const gitCollaboration = company.employees.some(({ agent }) => agent !== "fake");
  let gitDeveloperIndex = 0;
  return Object.fromEntries(company.employees.map((employee) => {
    if (employee.agent !== "fake") {
      const rolePrompt = employee.role === "developer"
        ? REAL_AGENT_DEVELOPER_PROMPT
        : employee.role === "reviewer"
          ? "You are the reviewer employee in the AgentTown company. Review the review package for the task and emit task.approve or task.reject with findings."
          : REAL_AGENT_LEADER_PROMPT;
      const missionLine = employee.role === "product_lead"
        ? `\nMission: ${company.company.mission}`
        : "";
      return [
        employee.id,
        `${rolePrompt}${missionLine}`
      ];
    }
    if (gitCollaboration) {
      // Real-agent companies drive Git collaboration: fake developers must
      // run Git fixture scenarios (they submit through git worktrees) and the
      // reviewer approves via the Git review path.
      if (employee.role === "reviewer") {
        return [employee.id, "git-review-approve"];
      }
      if (employee.role === "developer") {
        const scenario = gitDeveloperIndex === 0
          ? "git-developer-a"
          : "git-developer-b";
        gitDeveloperIndex += 1;
        return [employee.id, scenario];
      }
      return [employee.id, "idle"];
    }
    return [
      employee.id,
      employee.role === "reviewer"
        ? "review-approve"
        : employee.role === "developer"
          ? "complete"
          : "idle"
    ];
  }));
}

/**
 * Real Codex launches require explicit opt-in: `AGENTTOWN_REAL_CODEX` must be
 * "1" and `AGENTTOWN_FORBID_REAL_PROBES` must not be "1". This mirrors the
 * probe-runner convention so tests and CLI-launched cores never spawn Codex
 * unless the operator opts in for manual validation.
 */
function allowRealCodexProbes(env: NodeJS.ProcessEnv): boolean {
  return env.AGENTTOWN_FORBID_REAL_PROBES !== "1"
    && env.AGENTTOWN_REAL_CODEX === "1";
}

/**
 * Real Claude launches require explicit opt-in: `AGENTTOWN_REAL_CLAUDE` must
 * be "1" and `AGENTTOWN_FORBID_REAL_PROBES` must not be "1". Same convention
 * as Codex so tests never spawn Claude unless the operator opts in.
 */
function allowRealClaudeProbes(env: NodeJS.ProcessEnv): boolean {
  return env.AGENTTOWN_FORBID_REAL_PROBES !== "1"
    && env.AGENTTOWN_REAL_CLAUDE === "1";
}

/**
 * Real OpenCode launches require explicit opt-in: `AGENTTOWN_REAL_OPENCODE`
 * must be "1" and `AGENTTOWN_FORBID_REAL_PROBES` must not be "1". Same
 * convention as Codex so tests never spawn OpenCode unless the operator opts
 * in.
 */
function allowRealOpenCodeProbes(env: NodeJS.ProcessEnv): boolean {
  return env.AGENTTOWN_FORBID_REAL_PROBES !== "1"
    && env.AGENTTOWN_REAL_OPENCODE === "1";
}

export interface AdapterMap {
  adapterFor: (agent: string) => AgentAdapter;
  hasRealAgents: boolean;
}

/**
 * Builds the per-company adapter factory: one shared FakeAgentAdapter for all
 * fake employees, plus one adapter per real-agent type (codex, claude,
 * opencode) when the company contains employees of that type. Real launches
 * stay forbidden unless the operator opts in via
 * `AGENTTOWN_FORBID_REAL_PROBES !== "1"` together with the matching
 * `AGENTTOWN_REAL_<TYPE> === "1"`. Custom CLI locations are honored through
 * `AGENTTOWN_CLAUDE_EXECUTABLE`, `AGENTTOWN_OPENCODE_EXECUTABLE` and
 * `AGENTTOWN_OPENCODE_SCRIPT` (a `#!/usr/bin/env node` script run via
 * `process.execPath`); OpenCode additionally honors `AGENTTOWN_OPENCODE_MODEL`
 * when set.
 */
export function buildAdapterMap(
  company: CompanyDefinition,
  env: NodeJS.ProcessEnv
): AdapterMap {
  const fakeRoot = fileURLToPath(new URL("../../fake-agent/", import.meta.url));
  const fakeAdapter = new FakeAgentAdapter({
    executable: process.execPath,
    packageRoot: fakeRoot,
    allowedEmployeeIds: new Set(company.employees.map(({ id }) => id))
  });
  const hasRealAgents = company.employees.some(({ agent }) =>
    agent === "codex" || agent === "claude" || agent === "opencode"
  );
  const codexAdapter = company.employees.some(({ agent }) => agent === "codex")
    ? new CodexAgentAdapter({
        ...(allowRealCodexProbes(env)
          ? { forbidRealProbes: false }
          : {})
      })
    : undefined;
  const claudeAdapter = company.employees.some(({ agent }) => agent === "claude")
    ? new ClaudeAgentAdapter({
        executable: env.AGENTTOWN_CLAUDE_EXECUTABLE ?? "claude",
        ...(allowRealClaudeProbes(env)
          ? {
              forbidRealProbes: false,
              // "plan" is read-only (no Bash/write tools), matching the
              // leader's read_only workspace; override via env if needed.
              permissionMode: env.AGENTTOWN_CLAUDE_PERMISSION_MODE ?? "plan",
              ...(env.AGENTTOWN_CLAUDE_MODEL
                ? { model: env.AGENTTOWN_CLAUDE_MODEL }
                : {}),
              // Claude Code defaults to max effort on this machine, which
              // pushes real turns past 150s; explicit effort override lets
              // operators trade reasoning depth for latency.
              ...(env.AGENTTOWN_CLAUDE_EFFORT
                ? { effort: env.AGENTTOWN_CLAUDE_EFFORT }
                : {})
            }
          : {})
      })
    : undefined;
  const opencodeAdapter = company.employees.some(({ agent }) => agent === "opencode")
    ? new OpenCodeAgentAdapter({
        executable: env.AGENTTOWN_OPENCODE_EXECUTABLE ?? "opencode",
        ...(allowRealOpenCodeProbes(env)
          ? {
              forbidRealProbes: false,
              ...(env.AGENTTOWN_OPENCODE_MODEL
                ? { model: env.AGENTTOWN_OPENCODE_MODEL }
                : {})
            }
          : {}),
        ...(env.AGENTTOWN_OPENCODE_SCRIPT
          ? { scriptEntry: env.AGENTTOWN_OPENCODE_SCRIPT }
          : {})
      })
    : undefined;
  const adapterFor = (agent: string): AgentAdapter => {
    switch (agent) {
      case "fake":
        return fakeAdapter;
      case "codex":
        if (codexAdapter === undefined) {
          throw new Error(`agent adapter is not configured: ${agent}`);
        }
        return codexAdapter;
      case "claude":
        if (claudeAdapter === undefined) {
          throw new Error(`agent adapter is not configured: ${agent}`);
        }
        return claudeAdapter;
      case "opencode":
        if (opencodeAdapter === undefined) {
          throw new Error(`agent adapter is not configured: ${agent}`);
        }
        return opencodeAdapter;
      default:
        throw new Error(`unsupported agent adapter: ${agent}`);
    }
  };
  return { adapterFor, hasRealAgents };
}

export interface CoreArguments {
  projectRoot: string;
  databasePath: string;
  companyPath: string;
  pipeName: string;
  leaseTtlMs: number;
}

export interface ShutdownCoordinator {
  handleSignal(signal: NodeJS.Signals): void;
}

export interface CoreRunHooks {
  afterInitialValidation?(): Promise<void>;
  beforeStoreOpen?(): Promise<void>;
}

export function parseE2EStartupScenarios(
  company: CompanyDefinition,
  env: NodeJS.ProcessEnv
): Readonly<Record<string, string>> {
  const raw = env.AGENTTOWN_E2E_STARTUP_SCENARIOS;
  if (raw === undefined) return {};
  if (
    env.AGENTTOWN_E2E_MODE !== "1"
    || env.AGENTTOWN_FORBID_REAL_PROBES !== "1"
  ) {
    throw new Error(
      "AGENTTOWN_E2E_STARTUP_SCENARIOS requires fake-only E2E mode"
    );
  }
  if (company.employees.some(({ agent }) => agent !== "fake")) {
    throw new Error("E2E startup scenarios require an all-fake company");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("AGENTTOWN_E2E_STARTUP_SCENARIOS must be valid JSON", {
      cause: error
    });
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    throw new Error("AGENTTOWN_E2E_STARTUP_SCENARIOS must be an object");
  }
  const roster = new Set(company.employees.map(({ id }) => id));
  const scenarios: Record<string, string> = {};
  for (const [employeeId, scenario] of Object.entries(parsed)) {
    if (!roster.has(employeeId)) {
      throw new Error(`E2E startup scenario references unknown employee: ${employeeId}`);
    }
    if (typeof scenario !== "string" || scenario.length === 0) {
      throw new Error(`E2E startup scenario must be a non-empty string: ${employeeId}`);
    }
    scenarios[employeeId] = scenario;
  }
  return scenarios;
}

export function createShutdownCoordinator(options: {
  timeoutMs: number;
  pause: () => Promise<void>;
  closeGracefully: () => Promise<void>;
  closeTransportNow: () => void;
  closeStore: () => void;
  exit: (code: number) => void;
  reportError: (message: string) => void;
}): ShutdownCoordinator {
  let signalCount = 0;
  let started = false;
  let finished = false;
  return {
    handleSignal(signal) {
      signalCount += 1;
      if (signalCount > 1) {
        if (!finished) {
          finished = true;
          options.closeTransportNow();
          options.exit(130);
        }
        return;
      }
      if (started) return;
      started = true;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        options.reportError(
          `Core ${signal} shutdown timed out after ${options.timeoutMs}ms`
        );
        options.closeTransportNow();
        options.exit(1);
      }, options.timeoutMs);
      void Promise.resolve()
        .then(() => options.pause())
        .then(() => options.closeGracefully())
        .then(() => options.closeStore())
        .then(() => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          options.exit(0);
        })
        .catch((error: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          options.reportError(
            `Core ${signal} shutdown failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          options.closeTransportNow();
          options.exit(1);
        });
    }
  };
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required argument: ${key}`);
  }
  return value;
}

export function assertCorePathWithinProject(
  projectRoot: string,
  candidate: string,
  label: string
): string {
  if (!isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  const root = resolve(projectRoot);
  const target = resolve(candidate);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} is outside project: ${target}`);
  }
  return target;
}

export function parseCoreArguments(argv: readonly string[]): CoreArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Core arguments must be --name value pairs");
    }
    if (values.has(key)) throw new Error(`duplicate argument: ${key}`);
    values.set(key, value);
  }
  const allowed = new Set([
    "--project-root",
    "--database",
    "--company",
    "--pipe-name",
    "--lease-ttl-ms"
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
  }
  const projectInput = requiredValue(values, "--project-root");
  if (!isAbsolute(projectInput)) {
    throw new Error("--project-root must be an absolute path");
  }
  const projectRoot = resolve(projectInput);
  const stateDir = join(projectRoot, ".agenttown");
  let databasePath: string;
  let companyPath: string;
  try {
    databasePath = assertCorePathWithinProject(
      stateDir,
      requiredValue(values, "--database"),
      "--database"
    );
    companyPath = assertCorePathWithinProject(
      stateDir,
      requiredValue(values, "--company"),
      "--company"
    );
  } catch (error) {
    throw new Error(
      `Core state paths must remain within project .agenttown: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
  const pipeName = requiredValue(values, "--pipe-name");
  if (!PIPE_PATTERN.test(pipeName)) throw new Error("--pipe-name is invalid");
  const leaseText = requiredValue(values, "--lease-ttl-ms");
  const leaseTtlMs = Number(leaseText);
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("--lease-ttl-ms must be a positive integer");
  }
  return { projectRoot, databasePath, companyPath, pipeName, leaseTtlMs };
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (
      childRelative !== ".."
      && !childRelative.startsWith(`..${sep}`)
      && !isAbsolute(childRelative)
    );
}

export async function validateCoreStateLayout(args: CoreArguments): Promise<void> {
  const stateDir = join(args.projectRoot, ".agenttown");
  const stateStat = await optionalLstat(stateDir);
  if (stateStat?.isSymbolicLink() === true) {
    throw new Error(".agenttown must not be a symbolic link or junction");
  }
  const projectReal = await realpath(args.projectRoot);
  if (stateStat !== null) {
    const stateReal = await realpath(stateDir);
    if (!isWithin(projectReal, stateReal)) {
      throw new Error(".agenttown resolves outside project");
    }
  }
  for (const target of [
    args.databasePath,
    args.companyPath,
    join(stateDir, "logs")
  ]) {
    let current = target;
    while (isWithin(stateDir, current)) {
      const currentStat = await optionalLstat(current);
      if (currentStat?.isSymbolicLink() === true) {
        throw new Error(`Core state path is a symbolic link or junction: ${current}`);
      }
      if (currentStat !== null) {
        const currentReal = await realpath(current);
        const stateReal = stateStat === null ? stateDir : await realpath(stateDir);
        if (!isWithin(stateReal, currentReal)) {
          throw new Error(`Core state path resolves outside .agenttown: ${current}`);
        }
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

function employeeIds(company: CompanyDefinition): {
  leaderId: string;
  reviewerId: string;
} {
  const leader = company.employees.find((employee) =>
    employee.reportsTo === "owner"
    || employee.role.toLocaleLowerCase("en-US").includes("lead")
  );
  const reviewer = company.employees.find((employee) =>
    employee.role.toLocaleLowerCase("en-US").includes("review")
  );
  if (leader === undefined) throw new Error("company requires a leader employee");
  if (reviewer === undefined) throw new Error("company requires a reviewer employee");
  return { leaderId: leader.id, reviewerId: reviewer.id };
}

function gitEnabledFor(
  company: CompanyDefinition,
  startupScenarios: Readonly<Record<string, string>>
): boolean {
  return company.employees.some((employee) => {
    const scenario = startupScenarios[employee.id];
    return scenario !== undefined && GIT_FIXTURE_SCENARIOS.has(scenario);
  });
}

interface GitWiring {
  workflow: GitTaskWorkflow;
  coordinator: GitWorkflowCoordinator;
  gitLifecycle: NonNullable<ConstructorParameters<typeof CheckpointService>[0]["gitLifecycle"]>;
  runId: string;
}

/**
 * Wires the P1B Git collaboration stack for one company. Order is fixed:
 * 1. repository preflight establishes the baseline;
 * 2. the active Git run is created or reused from durable state;
 * 3. Git services and the GitTaskWorkflow are constructed;
 * 4. an existing paused run is reconciled and only then reactivated, so no
 *    session can start against a repository whose facts no longer hold.
 */
async function setupGitWiring(options: {
  projectRoot: string;
  company: CompanyDefinition;
  companyId: string;
  store: CoreStore;
  tasks: TaskService;
  leaderId: string;
  reviewerId: string;
  drive: (employeeId: string, message: AgentMessage) => Promise<void>;
}): Promise<GitWiring> {
  const preflight = new RepositoryPreflight();
  const baseline = await preflight.inspect(options.projectRoot);
  const workspaceManager = new WorkspaceManager({
    store: options.store,
    companyId: options.companyId
  });
  const existingRuns = options.store.listGitRuns(options.companyId);
  let run: GitRunRecord;
  if (existingRuns.length === 0) {
    const runId = `run-${randomUUID().replaceAll("-", "")}`;
    run = await workspaceManager.createRun(runId, baseline);
  } else if (existingRuns.length === 1) {
    run = existingRuns[0]!;
    if (
      resolve(run.projectRoot) !== resolve(baseline.projectRoot)
      || run.baseCommit !== baseline.baseCommit
    ) {
      throw new Error(
        "existing Git run baseline does not match the current repository"
      );
    }
  } else {
    throw new Error(
      `multiple Git runs exist for company ${options.companyId}; cleanup is required`
    );
  }
  const runId = run.runId;
  const reviewerIds = new Set([options.reviewerId]);
  const validationRunner = new ValidationRunner({
    store: options.store,
    companyId: options.companyId,
    company: options.company
  });
  const submissionValidator = new SubmissionValidator({
    store: options.store,
    companyId: options.companyId
  });
  const evidenceBuilder = new EvidencePackageBuilder({
    store: options.store,
    companyId: options.companyId
  });
  const conflictService = new ConflictService({
    store: options.store,
    companyId: options.companyId,
    company: options.company,
    runId,
    workspaceManager
  });
  const integrationService = new IntegrationService({
    store: options.store,
    companyId: options.companyId,
    company: options.company,
    runId,
    workspaceManager,
    validationRunner,
    conflictService
  });
  const reviewService = new ReviewService({
    store: options.store,
    companyId: options.companyId,
    company: options.company,
    evidenceBuilder,
    reviewerIds
  });
  const cleanupService = new CleanupService({
    store: options.store,
    companyId: options.companyId,
    workspaceManager
  });
  const reconciler = new GitReconciler({
    store: options.store,
    companyId: options.companyId,
    workspaceManager,
    evidenceBuilder,
    conflictService
  });

  const coordinator = new GitWorkflowCoordinator({
    store: options.store,
    companyId: options.companyId,
    company: options.company,
    runId,
    tasks: options.tasks,
    workspaceManager,
    submissionValidator,
    validationRunner,
    evidenceBuilder,
    reviewService,
    integrationService,
    conflictService,
    cleanupService,
    reviewerIds,
    sendMessage: (employeeId, message) => {
      void options.drive(employeeId, message);
      return Promise.resolve();
    },
    leaderId: options.leaderId
  });
  const hooks = new GitLifecycleHooks({
    runId,
    coordinator,
    validationRunner,
    integrationService,
    reconciler
  });
  const gitLifecycle = {
    abortValidations: (signal: AbortSignal, deadlineAt: number) =>
      hooks.abortValidations(signal, deadlineAt),
    settleIntegrationIntent: (signal: AbortSignal, deadlineAt: number) =>
      hooks.settleIntegrationIntent(signal, deadlineAt),
    snapshot: async () => {
      await workspaceManager.pauseRun(runId);
      return hooks.snapshot();
    },
    reconcile: async (reconciledRunId: string) => {
      const result = await hooks.reconcile(reconciledRunId);
      if (
        result.classification !== "tampered"
        && result.classification !== "missing"
      ) {
        await workspaceManager.reactivateRun(reconciledRunId);
      }
      return result;
    },
    reactivate: async () => {
      // Re-open the coordinator's action gate first: a pause attempt closed
      // it via stopNewActions, and without this every subsequent action
      // silently falls back to the non-Git workflow.
      hooks.resumeNewActions();
      await workspaceManager.reactivateRun(runId);
    }
  };

  if (existingRuns.length === 1) {
    const reconciliation = await hooks.reconcile(runId);
    if (
      reconciliation.classification === "tampered"
      || reconciliation.classification === "missing"
    ) {
      throw new Error(
        "Git run reconciliation blocked at startup: "
        + JSON.stringify(reconciliation.discrepancies)
      );
    }
    // The run and its workspaces stay paused here: the pause checkpoint stores
    // the paused statuses, and company.resume validates that checkpoint before
    // the reconcile wrapper reactivates the run.
  }

  const workflow = new GitTaskWorkflow(coordinator);
  return {
    workflow,
    coordinator,
    gitLifecycle,
    runId
  };
}
export async function runCore(
  argv: readonly string[],
  hooks: CoreRunHooks = {}
): Promise<void> {
  // Parsing and lexical boundary validation intentionally happen before SQLite opens.
  const args = parseCoreArguments(argv);
  await validateCoreStateLayout(args);
  await hooks.afterInitialValidation?.();
  await validateCoreStateLayout(args);
  const company = parseCompanyYaml(await readFile(args.companyPath, "utf8"));
  const unsupportedAgent = company.employees.find(({ agent }) =>
    agent !== "fake"
    && agent !== "codex"
    && agent !== "claude"
    && agent !== "opencode"
  );
  if (unsupportedAgent !== undefined) {
    throw new Error(`unsupported agent adapter: ${unsupportedAgent.agent}`);
  }
  const { leaderId, reviewerId } = employeeIds(company);
  await hooks.beforeStoreOpen?.();
  await validateCoreStateLayout(args);
  const store = new CoreStore(args.databasePath);
  let server: CoreServer | undefined;
  try {
    store.initialize();
    if (store.getCompany(DEFAULT_COMPANY_ID) === null) {
      store.createCompany({
        id: DEFAULT_COMPANY_ID,
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
    }
    const { adapterFor, hasRealAgents } = buildAdapterMap(
      company,
      process.env
    );
    const sessions = new SessionManager(
      adapterFor,
      store,
      DEFAULT_COMPANY_ID,
      args.projectRoot
    );
    const tasks = new TaskService(store, DEFAULT_COMPANY_ID, company, leaderId);
    const scenarios = coreStartupScenarios(company);
    const startupScenarios = {
      ...scenarios,
      ...parseE2EStartupScenarios(company, process.env)
    };
    const gitEnabled = hasRealAgents
      || gitEnabledFor(company, startupScenarios);
    const policy = new ActionPolicy(company, leaderId, new Set([reviewerId]));
    const orchestrator = new CompanyOrchestrator(
      DEFAULT_COMPANY_ID,
      company,
      store,
      tasks,
      policy,
      sessions,
      leaderId,
      reviewerId
    );
    let gitWiring: GitWiring | undefined;
    if (gitEnabled) {
      gitWiring = await setupGitWiring({
        projectRoot: args.projectRoot,
        company,
        companyId: DEFAULT_COMPANY_ID,
        store,
        tasks,
        leaderId,
        reviewerId,
        drive: (employeeId, message) =>
          orchestrator.driveGitMessage(employeeId, message)
      });
      orchestrator.attachGitWorkflow(gitWiring.workflow);
    }
    const lifecycle = new CheckpointService({
      companyId: DEFAULT_COMPANY_ID,
      company,
      store,
      orchestrator,
      sessions,
      adapterFor,
      scenarios: startupScenarios,
      ...(gitWiring === undefined
        ? {}
        : { gitLifecycle: gitWiring.gitLifecycle })
    });
    const leases = new LeaseRegistry(store, {
      ttlMs: args.leaseTtlMs,
      now: Date.now,
      onLastClientExpired: async () => {
        await lifecycle.pause("last_client_exited");
        await server?.closeTransportAfterResponses();
      }
    });
    server = new CoreServer({
      pipeName: args.pipeName,
      store,
      orchestrator: {
        dispatch: (action) => orchestrator.dispatch(action),
        start: () => orchestrator.start(startupScenarios),
        stopDispatching: () => orchestrator.stopDispatching()
      },
      leases,
      lifecycle,
      ...(gitWiring === undefined
        ? {}
        : { gitWorkflow: gitWiring.coordinator }),
      onBackgroundError: (error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
      }
    });

    const shutdown = createShutdownCoordinator({
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      pause: () => lifecycle.pause("shutdown").then(() => undefined),
      closeGracefully: () => server?.close() ?? Promise.resolve(),
      closeTransportNow: () => {
        server?.forceCloseTransport();
      },
      closeStore: () => store.close(),
      exit: (code) => process.exit(code),
      reportError: (message) => process.stderr.write(`${message}\n`)
    });
    process.on("SIGINT", shutdown.handleSignal);
    process.on("SIGTERM", shutdown.handleSignal);

    await server.listen();
    process.stdout.write(`${JSON.stringify({
      type: "core.ready",
      protocolVersion: 1,
      pipeName: args.pipeName
    })}\n`);
  } catch (error) {
    await server?.close().catch(() => undefined);
    store.close();
    throw error;
  }
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  return script !== undefined
    && pathToFileURL(resolve(script)).href === import.meta.url;
}

if (isEntrypoint()) {
  void runCore(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
