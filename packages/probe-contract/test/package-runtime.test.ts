import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("package runtime entrypoint", () => {
  it("emits an importable Node.js entrypoint", async () => {
    const command = process.platform === "win32"
      ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm run build"] }
      : { file: "pnpm", args: ["run", "build"] };
    execFileSync(command.file, command.args, { cwd: process.cwd(), stdio: "pipe" });

    const program = `import("@agenttown/probe-contract").then(({ parseProbeEvent }) => process.stdout.write(JSON.stringify(parseProbeEvent('{"type":"interrupted"}'))))`;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(JSON.parse(output)).toEqual({ type: "interrupted" });
  });
});
