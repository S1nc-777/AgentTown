import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/main.js";

const roots: string[] = [];

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

  it("requires --yes for noninteractive stop before attempting IPC", async () => {
    if (process.stdin.isTTY) return;
    await expect(runCli(["stop"], process.cwd()))
      .rejects.toThrow("requires --yes");
  });
});
