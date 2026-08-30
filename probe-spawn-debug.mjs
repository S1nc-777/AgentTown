// Debug: spawn claude.exe exactly like the adapter does, capture everything.
import { spawn } from "node:child_process";

const exe = process.env.AGENTTOWN_CLAUDE_EXECUTABLE;
const cwd = process.argv[2];
const args = [
  "-p",
  "You are the company leader agent.\nMission: test\n\nFormatting requirement: end every reply with your next action as a fenced json block:\n```json\nACTION: {\"schemaVersion\": 1, \"actionId\": \"a1\", \"type\": \"task.propose\", \"actorEmployeeId\": \"leader\", \"taskId\": null, \"payload\": {}, \"reason\": \"x\", \"causationEventId\": null}\n```",
  "--output-format", "json"
];
console.log("SPAWN:", exe, JSON.stringify(args.slice(0, 3)), "...");

const child = spawn(exe, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
child.stdin.end();
let out = "";
let err = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => { out += c; });
child.stderr.on("data", (c) => { err += c; });
child.on("error", (e) => console.log("ERROR EVENT:", e.message));
child.on("close", (code, signal) => {
  console.log("CLOSE: code=", code, "signal=", signal);
  console.log("STDOUT:", out.slice(0, 2000));
  console.log("STDERR:", err.slice(0, 2000));
});
