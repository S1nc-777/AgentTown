import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage } from "./layout.js";

/**
 * TUI chat sessions live in a local JSON file (.agenttown/tui-sessions.json)
 * so conversations survive terminal restarts, like session lists in other
 * agent CLIs. Sessions are pure UI state — company/task history stays in the
 * core's SQLite fact store.
 */
export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export const MAX_SESSIONS = 20;
const TITLE_MAX_CHARS = 24;

export function sessionTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((message) => message.kind === "user");
  const text = (firstUser?.text ?? "（空对话）").trim();
  const chars = Array.from(text);
  return chars.length > TITLE_MAX_CHARS
    ? `${chars.slice(0, TITLE_MAX_CHARS).join("")}…`
    : text;
}

export function createSession(): StoredSession {
  const now = new Date().toISOString();
  return { id: randomUUID(), title: "（空对话）", createdAt: now, updatedAt: now, messages: [] };
}

export function loadSessions(filePath: string): StoredSession[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredSession).slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

export function saveSessions(filePath: string, sessions: readonly StoredSession[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(sessions.slice(0, MAX_SESSIONS)), "utf8");
}

export function appendMessages(session: StoredSession, messages: readonly ChatMessage[]): void {
  for (const message of messages) session.messages.push(message);
  session.updatedAt = new Date().toISOString();
  session.title = sessionTitle(session.messages);
}

export function removeSession(sessions: StoredSession[], sessionId: string): StoredSession[] {
  return sessions.filter((session) => session.id !== sessionId);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return typeof session.id === "string"
    && typeof session.title === "string"
    && Array.isArray(session.messages);
}
