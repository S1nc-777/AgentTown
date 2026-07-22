import { packager } from "@electron/packager";
import { rm } from "node:fs/promises";

await rm("out", { recursive: true, force: true });
await packager({
  dir: ".",
  name: "AgentTownElectronSpike",
  platform: "win32",
  arch: "x64",
  out: "out",
  overwrite: true,
  prune: false,
  asar: false,
  ignore: [
    /^\/src($|\/)/,
    /^\/test($|\/)/,
    /^\/scripts($|\/)/,
    /^\/out($|\/)/,
    /^\/node_modules\/(?:@electron|electron|esbuild|\.bin|\.vite)($|\/)/
  ]
});
