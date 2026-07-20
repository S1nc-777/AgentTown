import type { PtyOptions, RunResult } from "./pty.js";
import { runProcessWithDependencies } from "./process-internals.js";

export function runProcess(options: PtyOptions): Promise<RunResult> {
  return runProcessWithDependencies(options);
}
