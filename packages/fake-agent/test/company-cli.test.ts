import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_TIMEOUT_MS = 5_000;
const children = new Set<ChildProcessWithoutNullStreams>();
type CloseResult = [number | null, NodeJS.Signals | null];
const closes = new Map<ChildProcessWithoutNullStreams, Promise<CloseResult>>();

interface RunningCompany {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<CloseResult>;
  lines: string[];
  waitForLineCount(count: number): Promise<void>;
  stop(): Promise<number | null>;
}

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    const closed = closes.get(child) ?? once(child, "close") as Promise<CloseResult>;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
    children.delete(child);
    closes.delete(child);
  }));
});

function startCompany(
  scenario: string,
  options: { employeeId?: string; resume?: string } = {}
): RunningCompany {
  const args = [
    "--import",
    "tsx",
    "src/company-cli.ts",
    "--employee-id",
    options.employeeId ?? "developer",
    "--scenario",
    scenario
  ];
  if (options.resume !== undefined) {
    args.push("--resume", options.resume);
  }

  const child = spawn(process.execPath, args, {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  const closed = once(child, "close") as Promise<CloseResult>;
  closes.set(child, closed);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const lines: string[] = [];
  let stdoutBuffer = "";
  let stderr = "";
  const lineWaiters = new Set<() => void>();
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) lines.push(line);
    }
    for (const notify of lineWaiters) notify();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const waitForLineCount = async (count: number): Promise<void> => {
    if (lines.length >= count) return;
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${count} lines; stderr: ${stderr}`));
      }, PROCESS_TIMEOUT_MS);
      const onClose = () => {
        cleanup();
        reject(new Error(`company process closed before ${count} lines; stderr: ${stderr}`));
      };
      const onLines = () => {
        if (lines.length < count) return;
        cleanup();
        resolvePromise();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        child.off("close", onClose);
        lineWaiters.delete(onLines);
      };
      child.once("close", onClose);
      lineWaiters.add(onLines);
      onLines();
    });
  };

  return {
    child,
    closed,
    lines,
    waitForLineCount,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
      }
      const [code] = await closed;
      children.delete(child);
      closes.delete(child);
      return code;
    }
  };
}

function sendMessage(
  company: RunningCompany,
  messageId: string,
  taskId = "task-1"
): void {
  company.child.stdin.write(`${JSON.stringify({
    type: "message",
    messageId,
    taskId,
    text: "implement"
  })}\n`);
}

function parsedJsonLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("company Fake Agent process", () => {
  it("emits an ordered completion proposal and usage", async () => {
    const company = startCompany("complete");
    await company.waitForLineCount(1);
    sendMessage(company, "m1");
    await company.waitForLineCount(4);

    const events = parsedJsonLines(company.lines);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "output.completed",
      "action.proposed",
      "usage.updated"
    ]);
    expect(events[2]).toMatchObject({
      action: {
        type: "task.submit",
        actorEmployeeId: "developer",
        taskId: "task-1",
        payload: {
          artifacts: ["artifact:task-1"],
          evidence: ["fake:test:pass"]
        }
      }
    });
    expect(await company.stop()).toBe(0);
  });

  it("keeps idle messages free of management actions", async () => {
    const company = startCompany("idle");
    await company.waitForLineCount(1);
    sendMessage(company, "m1");
    await company.waitForLineCount(3);

    const events = parsedJsonLines(company.lines);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "output.completed",
      "usage.updated"
    ]);
    expect(await company.stop()).toBe(0);
  });

  it("proposes reviewer approval", async () => {
    const company = startCompany("review-approve", { employeeId: "reviewer" });
    await company.waitForLineCount(1);
    sendMessage(company, "m1");
    await company.waitForLineCount(4);

    const events = parsedJsonLines(company.lines);
    expect(events[2]).toMatchObject({
      type: "action.proposed",
      action: {
        type: "task.approve",
        actorEmployeeId: "reviewer",
        taskId: "task-1"
      }
    });
    expect(await company.stop()).toBe(0);
  });

  it("proposes rejection for two review messages", async () => {
    const company = startCompany("review-reject-twice", { employeeId: "reviewer" });
    await company.waitForLineCount(1);
    sendMessage(company, "m1");
    sendMessage(company, "m2");
    await company.waitForLineCount(7);

    const events = parsedJsonLines(company.lines);
    const actions = events.filter((event) => event.type === "action.proposed");
    expect(actions).toHaveLength(2);
    expect(actions).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({ type: "task.reject", taskId: "task-1" })
      }),
      expect.objectContaining({
        action: expect.objectContaining({ type: "task.reject", taskId: "task-1" })
      })
    ]);
    expect(await company.stop()).toBe(0);
  });

  it("emits malformed output once and handles the next message", async () => {
    const company = startCompany("malformed-once");
    await company.waitForLineCount(1);
    sendMessage(company, "m1");
    await company.waitForLineCount(2);
    expect(company.lines[1]).toBe("not-json");

    sendMessage(company, "m2");
    await company.waitForLineCount(5);
    const validEvents = parsedJsonLines([company.lines[0]!, ...company.lines.slice(2)]);
    expect(validEvents.map((event) => event.type)).toEqual([
      "session.started",
      "output.completed",
      "action.proposed",
      "usage.updated"
    ]);
    expect(await company.stop()).toBe(0);
  });

  it("keeps silent mode alive without responding to messages", async () => {
    const company = startCompany("silent");
    await company.waitForLineCount(1);
    sendMessage(company, "m1");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));

    expect(parsedJsonLines(company.lines).map((event) => event.type)).toEqual([
      "session.started"
    ]);
    expect(await company.stop()).toBe(0);
  });

  it("exits with code 23 after starting the crash scenario", async () => {
    const company = startCompany("crash");
    const [code] = await company.closed;
    children.delete(company.child);
    closes.delete(company.child);

    expect(code).toBe(23);
    expect(parsedJsonLines(company.lines).map((event) => event.type)).toEqual([
      "session.started"
    ]);
  });

  it("reuses the requested native session ID", async () => {
    const company = startCompany("silent", { resume: "native-session-7" });
    await company.waitForLineCount(1);

    expect(parsedJsonLines(company.lines)[0]).toMatchObject({
      type: "session.started",
      handle: {
        employeeId: "developer",
        adapter: "fake",
        nativeSessionId: "native-session-7"
      }
    });
    expect(await company.stop()).toBe(0);
  });
});
