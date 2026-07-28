import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  isAbsolute,
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
  const databasePath = assertCorePathWithinProject(
    projectRoot,
    requiredValue(values, "--database"),
    "--database"
  );
  const companyPath = assertCorePathWithinProject(
    projectRoot,
    requiredValue(values, "--company"),
    "--company"
  );
  const pipeName = requiredValue(values, "--pipe-name");
  if (!PIPE_PATTERN.test(pipeName)) throw new Error("--pipe-name is invalid");
  const leaseText = requiredValue(values, "--lease-ttl-ms");
  const leaseTtlMs = Number(leaseText);
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("--lease-ttl-ms must be a positive integer");
  }
  return { projectRoot, databasePath, companyPath, pipeName, leaseTtlMs };
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

export async function runCore(argv: readonly string[]): Promise<void> {
  // Parsing and lexical boundary validation intentionally happen before SQLite opens.
  const args = parseCoreArguments(argv);
  const company = parseCompanyYaml(await readFile(args.companyPath, "utf8"));
  if (company.employees.some(({ agent }) => agent !== "fake")) {
    throw new Error("P1A Core accepts only the fake adapter");
  }
  const { leaderId, reviewerId } = employeeIds(company);
  const store = new CoreStore(args.databasePath);
  let server: CoreServer | undefined;
  let shutdownStarted = false;
  let signalCount = 0;
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

    const shutdown = (signal: NodeJS.Signals): void => {
      signalCount += 1;
      if (signalCount > 1) {
        process.exit(130);
      }
      if (shutdownStarted) return;
      shutdownStarted = true;
      const work = (async () => {
        await lifecycle.pause("shutdown");
        await server?.close();
        store.close();
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Core shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`)),
            SHUTDOWN_TIMEOUT_MS
          );
        })
      ]).then(
        () => process.exit(0),
        (error: unknown) => {
          process.stderr.write(
            `Core ${signal} shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
          void server?.close().finally(() => process.exit(1));
        }
      ).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

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
