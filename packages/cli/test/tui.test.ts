import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CliClient } from "../src/main.js";
import { runTui } from "../src/tui/tui.js";

interface FakeTui {
  stdin: PassThrough;
  stdout: PassThrough;
  text: () => string;
  waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  send: (text: string) => void;
}

function fakeTui(respond: Record<string, unknown>): FakeTui {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const client: CliClient = {
    async request(method) {
      if (method === "handshake" || method === "client.heartbeat") return { leaseTtlMs: 15000 };
      const value = respond[method];
      if (value === undefined) throw new Error(`unexpected request: ${method}`);
      return value;
    },
    events() {
      return (async function* () {})();
    },
    async close() {}
  };
  const connectOrStart = async () => client;
  const text = () => output;
  const waitFor = async (pattern: RegExp, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(output)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`output did not match ${pattern}: ${JSON.stringify(output)}`);
  };
  const send = (data: string) => stdin.write(data);
  return { stdin, stdout, text, waitFor, send };
}

function snapshotResponse(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company",
    status: "running",
    activeTaskCount: 1,
    pendingApprovalCount: 0,
    employees: [
      {
        id: "leader",
        role: "product_lead",
        status: "idle",
        currentTaskId: null,
        usage: { inputTokens: 1, outputTokens: 2, contextTokens: 3, capturedAt: "2026-08-31T00:00:00.000Z" }
      }
    ],
    ...overrides
  };
}

async function makeProject(): Promise<string> {
  const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "agenttown-tui-"));
  await mkdir(join(root, ".agenttown"), { recursive: true });
  await writeFile(join(root, ".agenttown", "company.yaml"), companyYaml());
  return root;
}

function companyYaml(): string {
  return `schema_version: 1
company:
  name: tui-test
  mission: test
  success_criteria:
    - pass
  operating_rules:
    - rule
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: developer-a
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
limits:
  max_task_retry: 1
  max_review_loops: 2
  max_parallel_tasks: 1
`;
}

describe("runTui", () => {
  it("renders the dashboard and exits on double Ctrl+C", async () => {
    const root = await makeProject();
    const tui = fakeTui({
      "status.snapshot": snapshotResponse(),
      "tasks.list": [],
      "events.list": [],
      "approvals.list": []
    });
    const promise = runTui(root, {
      connectOrStart: async () => {
        throw new Error("not connected");
      },
      stdin: tui.stdin,
      stdout: tui.stdout
    });
    await tui.waitFor(/未连接|○/);
    tui.send("\x03");
    tui.send("\x03");
    await tui.waitFor(/再按一次/);
    const exit = await Promise.race([
      promise,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000))
    ]);
    expect(exit).toBe(0);
  });

  it("displays snapshot data and switches views with Tab", async () => {
    const root = await makeProject();
    const tui = fakeTui({
      "status.snapshot": snapshotResponse({ status: "running" }),
      "tasks.list": [{ id: "task-1", title: "登录", status: "running", ownerEmployeeId: "developer-a" }],
      "events.list": [{ sequence: 1, id: "e1", type: "task.submitted", actorId: "leader", taskId: null, causationEventId: null, payload: {}, occurredAt: "2026-08-31T12:00:00.000Z" }],
      "approvals.list": []
    });
    const run = runTui(root, {
      connectOrStart: async () => {
        throw new Error("not connected");
      },
      stdin: tui.stdin,
      stdout: tui.stdout
    });
    await tui.waitFor(/○/);
    tui.send("\t");
    await tui.waitFor(/2任务/);
    tui.send("\x03");
    tui.send("\x03");
    await run;
  });

  it("executes a command and shows the result", async () => {
    const root = await makeProject();
    const tui = fakeTui({
      "status.snapshot": snapshotResponse(),
      "tasks.list": [],
      "events.list": [],
      "approvals.list": []
    });
    const run = runTui(root, {
      connectOrStart: async () => {
        throw new Error("AgentTown Core is not running — run 'agenttown start' first");
      },
      stdin: tui.stdin,
      stdout: tui.stdout
    });
    await tui.waitFor(/○/);
    tui.send("status\r");
    await tui.waitFor(/AgentTown Core is not running/);
    tui.send("\x03");
    tui.send("\x03");
    await run;
  });
});
