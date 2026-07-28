import {
  mkdtemp,
  lstat,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcEvent, TaskRecord } from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CliClient,
  type CliRuntime,
  runCli,
  writeWithBackpressure
} from "../src/main.js";

const roots: string[] = [];

function task(id = "task-1"): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    objective: "finish",
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: [],
    status: "running",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    createdEventId: "created",
    updatedEventId: "updated"
  };
}

function event(type = "user.approval.requested") {
  return {
    sequence: 1,
    id: "event-1",
    type,
    actorId: "core",
    taskId: null,
    causationEventId: null,
    payload: {},
    occurredAt: "2026-07-27T00:00:00.000Z"
  };
}

function fakeRuntime(
  respond: (method: string) => unknown,
  streamedEvents: IpcEvent[] = []
): {
  runtime: CliRuntime;
  output: string[];
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  starts: boolean[];
  closed: number[];
} {
  const output: string[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const starts: boolean[] = [];
  const closed: number[] = [];
  const client: CliClient = {
    async request(method, params) {
      calls.push({ method, params });
      return respond(method);
    },
    events() {
      return (async function* () {
        yield* streamedEvents;
      })();
    },
    async close() {
      closed.push(1);
    }
  };
  return {
    runtime: {
      async connectOrStart(_root, startIfMissing) {
        starts.push(startIfMissing);
        return client;
      },
      stdout: {
        write(text) {
          output.push(text);
          return true;
        },
        once() {
          throw new Error("unexpected drain");
        }
      }
    },
    output,
    calls,
    starts,
    closed
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("thin CLI commands", () => {
  it("initializes a valid template exclusively and never overwrites it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-cli-"));
    roots.push(root);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(runCli(["init", "--template", "parallel-software"], root))
      .resolves.toBe(0);
    const first = await readFile(join(root, ".agenttown", "company.yaml"), "utf8");
    expect(first).toContain("name: parallel-software");
    await expect(runCli(["init"], root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, ".agenttown", "company.yaml"), "utf8"))
      .toBe(first);
  });

  it("detects a state-directory swap after creation before any outside write", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-cli-race-"));
    const outside = await mkdtemp(join(tmpdir(), "agenttown-cli-race-outside-"));
    roots.push(root, outside);
    const fake = fakeRuntime(() => undefined);
    try {
      await expect(runCli(["init"], root, {
        ...fake.runtime,
        initializationHooks: {
          async afterStateDirectoryReady(paths) {
            await rmdir(paths.stateDir);
            await symlink(
              outside,
              paths.stateDir,
              process.platform === "win32" ? "junction" : "dir"
            );
          }
        }
      })).rejects.toThrow(/symbolic|junction/u);
      await expect(readFile(join(outside, "company.yaml"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        return;
      }
      throw error;
    } finally {
      const stateDir = join(root, ".agenttown");
      try {
        const stat = await lstat(stateDir);
        if (stat.isSymbolicLink()) await unlink(stateDir);
        else await rm(stateDir, { recursive: true, force: true });
      } catch (error) {
        if (
          !(error instanceof Error)
          || !("code" in error)
          || (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  });

  it("requires --yes for noninteractive stop before attempting IPC", async () => {
    if (process.stdin.isTTY) return;
    await expect(runCli(["stop"], process.cwd()))
      .rejects.toThrow("requires --yes");
  });

  it("rejects an explicitly supplied template for non-init commands", async () => {
    await expect(runCli(["doctor", "--template", "minimal"], process.cwd()))
      .rejects.toThrow("valid only with init");
  });

  it("waits for stdout drain when a write applies backpressure", async () => {
    let drain: (() => void) | undefined;
    const stream = {
      write: () => false,
      once: (event: string, listener: () => void) => {
        expect(event).toBe("drain");
        drain = listener;
        return stream;
      }
    };
    let completed = false;
    const writing = writeWithBackpressure(stream, "status\n").then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    drain?.();
    await writing;
    expect(completed).toBe(true);
  });

  it("runs doctor without connecting to an Agent", async () => {
    const fake = fakeRuntime(() => {
      throw new Error("doctor must not connect");
    });
    await expect(runCli(["doctor"], process.cwd(), fake.runtime))
      .resolves.toBe(0);
    expect(fake.starts).toEqual([]);
    expect(fake.output.join("")).toContain("fake-agent");
  });

  it("executes status, tasks and timeline through an injected client", async () => {
    const responses: Record<string, unknown> = {
      "status.snapshot": {
        companyId: "company",
        status: "running",
        activeTaskCount: 1,
        pendingApprovalCount: 1,
        employees: [
          {
            id: "leader",
            role: "product_lead",
            status: "running",
            currentTaskId: null,
            usage: {
              inputTokens: null,
              outputTokens: null,
              contextTokens: null,
              capturedAt: "1970-01-01T00:00:00.000Z"
            }
          }
        ]
      },
      "tasks.list": [task()],
      "events.list": [event()]
    };
    for (const command of ["status", "tasks", "timeline"] as const) {
      const fake = fakeRuntime((method) => responses[method]);
      await expect(runCli([command], process.cwd(), fake.runtime))
        .resolves.toBe(0);
      expect(fake.starts).toEqual([false]);
      expect(fake.closed).toEqual([1]);
      expect(fake.output.join("")).not.toBe("");
      if (command === "status") {
        expect(fake.calls).toEqual([{
          method: "status.snapshot",
          params: { companyId: "company" }
        }]);
        expect(fake.output.join("")).toContain("leader (product_lead)");
        expect(fake.output.join("")).toContain("context=unknown");
      }
    }
  });

  it("executes pause, resume and confirmed stop with correct startup semantics", async () => {
    const cases = [
      {
        command: ["pause"],
        method: "company.pause",
        result: { status: "paused" },
        starts: false
      },
      {
        command: ["resume"],
        method: "company.resume",
        result: {
          decisions: [{
            employeeId: "leader",
            mode: "native",
            previousSessionId: "session-1",
            sessionId: "session-1"
          }]
        },
        starts: true
      },
      {
        command: ["stop", "--yes"],
        method: "company.stop",
        result: { status: "stopped" },
        starts: false
      }
    ] as const;
    for (const testCase of cases) {
      const fake = fakeRuntime((method) => {
        expect(method).toBe(testCase.method);
        return testCase.result;
      });
      await expect(runCli(testCase.command, process.cwd(), fake.runtime))
        .resolves.toBe(0);
      expect(fake.starts).toEqual([testCase.starts]);
      expect(fake.closed).toEqual([1]);
    }
  });

  it("starts a configured company and streams events using only an injected client", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-cli-start-"));
    roots.push(root);
    const setup = fakeRuntime(() => undefined);
    await runCli(["init"], root, setup.runtime);
    const streamedEvent: IpcEvent = {
      protocolVersion: 1,
      kind: "event",
      sequence: 7,
      type: "task.progress",
      payload: {}
    };
    const fake = fakeRuntime(
      (method) => {
        expect(method).toBe("company.start");
        return { status: "running" };
      },
      [streamedEvent]
    );

    await expect(runCli(["start"], root, fake.runtime)).resolves.toBe(0);

    expect(fake.starts).toEqual([true]);
    expect(fake.calls).toEqual([{ method: "company.start", params: {} }]);
    expect(fake.output.join("")).toContain("7\ttask.progress");
    expect(fake.closed).toEqual([1]);
  });
});
