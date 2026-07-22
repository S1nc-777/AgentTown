import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runRealCapabilitiesCli } from "./run-real-capabilities-main.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.env.AGENTTOWN_FORBID_REAL_PROBES === "1") {
    process.stderr.write("real_probe_execution_disabled\n");
    process.exit(1);
  }
  const artifactRootDir = resolve(argument("--artifact-root") ?? "artifacts/feasibility");
  const timeoutMs = Number.parseInt(argument("--timeout-ms") ?? "180000", 10);
  const outputPath = resolve(argument("--output") ?? `${artifactRootDir}/capabilities-summary.json`);
  await runRealCapabilitiesCli({ artifactRootDir, outputPath, timeoutMs });
}

const entryPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
