import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

describe("runProcess", () => {
  it("captures a completed process without printing environment values", async () => {
    const result = await runProcess({
      file: process.execPath,
      args: ["-e", "process.stdout.write('ordinary-output')"],
      cwd: process.cwd(),
      env: { AGENTTOWN_PROCESS_TEST: "not-emitted" },
      timeoutMs: 2_000
    });

    expect(result.command).toEqual([process.execPath, "-e", "process.stdout.write('ordinary-output')"]);
    expect(result.rawOutput).toBe("ordinary-output");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.rawOutput).not.toContain("not-emitted");
  });
});
