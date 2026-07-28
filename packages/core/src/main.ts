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
  type CompanyDefinition
} from "@agenttown/runtime-contract";
import { FakeAgentAdapter } from "./agents/fake-adapter.js";
import { SessionManager } from "./agents/session-manager.js";
import { CompanyOrchestrator } from "./company/orchestrator.js";
import { CoreServer } from "./ipc/core-server.js";
import { LeaseRegistry } from "./ipc/lease-registry.js";
import { CheckpointService } from "./lifecycle/checkpoint-service.js";
import { ActionPolicy } from "./policy/action-policy.js";
import { CoreStore } from "./storage/core-store.js";
import { TaskService } from "./tasks/task-service.js";

export const DEFAULT_COMPANY_ID = "company";
const PIPE_PATTERN = /^agenttown-[a-f0-9]{24}$/u;
const SHUTDOWN_TIMEOUT_MS = 15_000;

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
  if (company.employees.some(({ agent }) => agent !== "fake")) {
    throw new Error("P1A Core accepts only the fake adapter");
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
    const fakeRoot = fileURLToPath(new URL("../../fake-agent/", import.meta.url));
    const adapter = new FakeAgentAdapter({
      executable: process.execPath,
      packageRoot: fakeRoot,
      allowedEmployeeIds: new Set(company.employees.map(({ id }) => id))
    });
    const sessions = new SessionManager(
      () => adapter,
      store,
      DEFAULT_COMPANY_ID,
      args.projectRoot
    );
    const tasks = new TaskService(store, DEFAULT_COMPANY_ID, company, leaderId);
    const orchestrator = new CompanyOrchestrator(
      DEFAULT_COMPANY_ID,
      company,
      store,
      tasks,
      new ActionPolicy(company, leaderId, new Set([reviewerId])),
      sessions,
      leaderId,
      reviewerId
    );
    const lifecycle = new CheckpointService({
      companyId: DEFAULT_COMPANY_ID,
      company,
      store,
      orchestrator,
      sessions,
      adapterFor: () => adapter
    });
    const scenarios = Object.fromEntries(company.employees.map((employee) => [
      employee.id,
      employee.role === "reviewer"
        ? "review-approve"
        : employee.role === "developer"
          ? "complete"
          : "idle"
    ]));
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
        start: () => orchestrator.start(scenarios),
        stopDispatching: () => orchestrator.stopDispatching()
      },
      leases,
      lifecycle,
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
