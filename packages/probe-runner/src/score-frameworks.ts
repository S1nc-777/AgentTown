import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFrameworkTable, summarizeFrameworks, type FrameworkArtifact } from "./framework-summary.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const artifactRoot = resolve(argument("--artifact-root") ?? fileURLToPath(new URL("../../../artifacts/feasibility/", import.meta.url)));
const artifacts = await Promise.all(["electron", "tauri"].map(async (name) =>
  JSON.parse(await readFile(join(artifactRoot, `framework-${name}.json`), "utf8")) as FrameworkArtifact
));
const frameworks = summarizeFrameworks(artifacts);
process.stdout.write(`${renderFrameworkTable(frameworks)}\n`);
const output = argument("--json-output");
if (output !== undefined) {
  await writeFile(resolve(output), `${JSON.stringify({ frameworks }, null, 2)}\n`, "utf8");
}
if (frameworks.some((row) => !row.eligible || !row.measurementEligible)) process.exitCode = 1;
