// Direct company.start driver for acceptance runs (bypasses CLI connection race).
// Usage: node --import tsx probe-drive.mjs <projectRoot> <pipeName>
import { AgentTownClient } from "./packages/cli/src/client.js";

const projectRoot = process.argv[2];
const pipeName = process.argv[3];
const client = await AgentTownClient.connect(pipeName, `probe-${Date.now()}`, 0);
try {
  const result = await client.request("company.start", {});
  console.log("START RESULT:", JSON.stringify(result));
} catch (error) {
  console.error("START FAILED:", error instanceof Error ? error.message : String(error));
}
for await (const event of client.events()) {
  console.log(`${event.sequence}\t${event.type}\t${event.actorId}`);
}
