import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCore } from "../src/core-process.js";
import {
  pipeNameForProject,
  resolveAgentTownPaths
} from "../src/paths.js";
import { templateYaml } from "../src/templates.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("Core process launcher", () => {
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
