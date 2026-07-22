import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({ entryPoints: ["src/core.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: "dist/core.mjs" });
await build({ entryPoints: ["../../packages/fake-agent/src/cli.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: "dist/fake-agent.mjs" });
await build({ entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: "dist/main.cjs" });
await build({ entryPoints: ["src/preload.ts"], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: "dist/preload.cjs" });
await build({ entryPoints: ["src/renderer.ts"], bundle: true, platform: "browser", format: "iife", outfile: "dist/renderer.js" });
await copyFile("src/index.html", "dist/index.html");
await copyFile(process.execPath, "dist/node.exe");
