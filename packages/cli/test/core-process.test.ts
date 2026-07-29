import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCore, terminateChild } from "../src/core-process.js";
import {
  pipeNameForProject,
  resolveAgentTownPaths
} from "../src/paths.js";
import { templateYaml } from "../src/templates.js";
import { CoreStore } from "../../core/src/storage/core-store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Core process launcher", () => {
  it("connects live-only when persisted history exceeds replay limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-launch-history-"));
    roots.push(root);
    const paths = resolveAgentTownPaths(root);
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(paths.companyPath, templateYaml("minimal"), "utf8");
    const store = new CoreStore(paths.databasePath);
    store.initialize();
    for (let index = 0; index < 300; index += 1) {
      store.insertEvent({
        id: `history-${index}`,
        type: "history.large",
        actorId: "test",
        taskId: null,
        causationEventId: null,
        payload: { text: "x".repeat(16_000) }
      });
    }
    store.close();

    const { child, client } = await startCore({
      projectRoot: root,
      paths,
      pipeName: pipeNameForProject(root),
      leaseTtlMs: 2_000
    });
    try {
      const history: unknown[] = [];
      let afterSequence = 0;
      while (true) {
        const page = await client.request("events.list", {
          afterSequence,
          limit: 32
        }) as Array<{ sequence: number }>;
        history.push(...page);
        if (page.length < 32) break;
        afterSequence = page.at(-1)!.sequence;
      }
      expect(history.length).toBeGreaterThanOrEqual(300);
      await expect(client.request("status.snapshot", { companyId: "company" }))
        .resolves.toMatchObject({ companyId: "company" });
      await expect(client.request("tasks.list", { companyId: "company" }))
        .resolves.toEqual([]);
    } finally {
      await client.close();
      if (child.exitCode === null && child.signalCode === null) {
        await terminateChild(child);
      }
    }
  }, 30_000);

  it("waits boundedly after SIGKILL and surfaces a child that remains live", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill(signal?: NodeJS.Signals): boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    const signals: Array<NodeJS.Signals | undefined> = [];
    child.kill = (signal?: NodeJS.Signals) => {
      signals.push(signal);
      return true;
    };
    const startedAt = Date.now();

    await expect(terminateChild(child, 20))
      .rejects.toThrow("remained live after SIGKILL");

    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("fails boundedly and includes Core stderr when readiness cannot succeed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-launch-fail-"));
    roots.push(root);
    const paths = resolveAgentTownPaths(root);
    await mkdir(paths.stateDir, { recursive: true });
    const startedAt = Date.now();

    await expect(startCore({
      projectRoot: root,
      paths,
      pipeName: pipeNameForProject(root),
      leaseTtlMs: 500
    })).rejects.toThrow(/Core stderr|ENOENT/u);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("waits for readiness, connects, and stops without deleting state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenttown-launch-ok-"));
    roots.push(root);
    const paths = resolveAgentTownPaths(root);
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(paths.companyPath, templateYaml("minimal"), "utf8");
    const { child, client } = await startCore({
      projectRoot: root,
      paths,
      pipeName: pipeNameForProject(root),
      leaseTtlMs: 2_000
    });
    try {
      await expect(client.request("company.start", {}))
        .resolves.toEqual({ status: "running" });
      await expect(client.request("company.stop", {}))
        .resolves.toEqual({ status: "stopped" });
    } finally {
      await client.close();
    }
    if (child.exitCode === null && child.signalCode === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Core did not exit after stop")),
              5_000
            );
          })
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    await expect(readFile(paths.companyPath, "utf8"))
      .resolves.toContain("name: minimal");
  }, 20_000);
});
