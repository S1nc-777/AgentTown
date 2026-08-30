// Direct ClaudeAgentAdapter start probe for Task 6 debugging.
// Run from the worktree: node --import tsx probe-claude-start.mjs <projectRoot>
import { ClaudeAgentAdapter } from "./packages/core/src/agents/claude-adapter.js";

const projectRoot = process.argv[2];
const adapter = new ClaudeAgentAdapter({
  forbidRealProbes: false,
  ...(process.env.AGENTTOWN_CLAUDE_EXECUTABLE
    ? { executable: process.env.AGENTTOWN_CLAUDE_EXECUTABLE }
    : {})
});

try {
  const handle = await adapter.start({
    employeeId: "leader",
    role: "Product Lead",
    projectRoot,
    scenario: "You are the company leader agent.\nMission: 用 Node.js 实现一个命令行待办应用"
  });
  console.log("START OK:", JSON.stringify(handle));
  const events = [];
  for await (const event of adapter.send(handle, {
    messageId: "m1",
    employeeId: "leader",
    taskId: null,
    text: "Please begin by proposing the first task.",
    actionRequest: null,
    taskContext: null
  })) {
    events.push(event.type);
    if (event.type === "output.completed") {
      console.log("OUTPUT:", JSON.stringify(event.text).slice(0, 1500));
    }
    if (event.type === "action.proposed") {
      console.log("ACTION:", JSON.stringify(event.action));
    }
  }
  console.log("EVENTS:", events.join(","));
  console.log("USAGE:", JSON.stringify(await adapter.usage(handle)));
  await adapter.stop(handle);
} catch (error) {
  console.error("FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
