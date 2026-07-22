import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Electron process boundary", () => {
  it("keeps Agent spawning out of Electron main", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).not.toContain("runPty");
    expect(source).not.toContain("fake-agent");
  });

  it("exposes only the five approved preload methods", () => {
    const source = readFileSync(new URL("../src/preload.ts", import.meta.url), "utf8");
    const exposedKeys = [...source.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((match) => match[1]);
    expect(exposedKeys).toEqual(["health", "startFake", "sendInput", "resize", "subscribeOutput"]);
  });

  it("renders untrusted terminal output without innerHTML", () => {
    const source = readFileSync(new URL("../src/renderer.ts", import.meta.url), "utf8");
    expect(source).toContain("textContent");
    expect(source).not.toContain("innerHTML");
  });
});
