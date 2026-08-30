// Debug: spawn opencode exactly like the adapter (node + scriptEntry, stdin open), time first event.
import { spawn } from "node:child_process";

const script = process.env.AGENTTOWN_OPENCODE_SCRIPT;
const args = [
  script,
  "run", "--format", "json",
  "--model", process.env.AGENTTOWN_OPENCODE_MODEL,
  "--dir", process.argv[2],
  "You are the company leader agent. Mission: test. Please propose the first task."
];
const t0 = Date.now();
console.log("SPAWN node", JSON.stringify(args.slice(0, 5)), "...");
const child = spawn(process.execPath, args, { cwd: process.argv[2], stdio: ["pipe", "pipe", "pipe"] });
// NOTE: stdin intentionally left OPEN (not ended) — exactly like the adapter.
let out = "";
let err = "";
let firstEvent = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => {
  out += c;
  if (!firstEvent && out.includes("\n")) {
    firstEvent = true;
    console.log(`FIRST EVENT after ${Date.now() - t0}ms:`, out.split("\n")[0].slice(0, 200));
  }
});
child.stderr.on("data", (c) => { err += c; });
child.on("error", (e) => console.log("ERROR EVENT:", e.message));
child.on("close", (code, signal) => {
  console.log(`CLOSE after ${Date.now() - t0}ms: code=`, code, "signal=", signal);
  console.log("STDERR:", err.slice(0, 600));
});
setTimeout(() => {
  console.log(`TIMEOUT after ${Date.now() - t0}ms — no close yet; stdout so far:`, out.slice(0, 400));
  child.kill();
}, 30000);
