import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendMessages,
  createSession,
  loadSessions,
  removeSession,
  saveSessions,
  sessionTitle
} from "../src/tui/sessions.js";

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function sessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agenttown-sessions-"));
  cleanups.push(dir);
  return join(dir, "tui-sessions.json");
}

describe("sessions", () => {
  it("round-trips sessions through the file", () => {
    const file = sessionFile();
    const session = createSession();
    appendMessages(session, [
      { kind: "user", text: "帮我写一个笑话" },
      { kind: "system", text: "✔ 任务已创建" }
    ]);
    saveSessions(file, [session]);

    const loaded = loadSessions(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.messages.map((m) => m.text)).toEqual(["帮我写一个笑话", "✔ 任务已创建"]);
    expect(loaded[0]!.title).toBe("帮我写一个笑话");
  });

  it("derives the title from the first user message", () => {
    expect(sessionTitle([
      { kind: "system", text: "欢迎" },
      { kind: "user", text: "做一个计算器" }
    ])).toBe("做一个计算器");
    expect(sessionTitle([])).toBe("（空对话）");
    expect(sessionTitle([{ kind: "user", text: "一二三四五六七八九十一二三四五六七八九十再多写几个字让它超长" }]))
      .toContain("…");
  });

  it("removes sessions by id", () => {
    const a = createSession();
    const b = createSession();
    expect(removeSession([a, b], a.id)).toEqual([b]);
  });

  it("tolerates a missing or corrupt file", () => {
    expect(loadSessions(join("Z:\\nonexistent", "x.json"))).toEqual([]);
    const file = sessionFile();
    saveSessions(file, []);
    writeFileSync(file, "not-json{", "utf8");
    expect(loadSessions(file)).toEqual([]);
  });
});
