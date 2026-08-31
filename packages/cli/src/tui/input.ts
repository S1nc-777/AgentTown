export type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "tab" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "ctrl-c" }
  | { type: "ctrl-l" }
  | { type: "escape" };

/**
 * Converts a raw-mode byte stream into keys. Escape sequences may arrive
 * split across chunks (e.g. "\x1b", then "[", then "A"), so incomplete
 * sequences are buffered until the final byte arrives.
 */
export class KeyParser {
  #pending = "";

  feed(chunk: string): Key[] {
    const keys: Key[] = [];
    const input = this.#pending + chunk;
    this.#pending = "";
    let index = 0;
    while (index < input.length) {
      const ch = input[index]!;
      if (ch === "\x1b") {
        const rest = input.slice(index + 1);
        if (rest.length === 0) {
          this.#pending = "\x1b";
          break;
        }
        if (rest[0] === "[" || rest[0] === "O") {
          const finalIndex = rest.slice(1).search(/[\x40-\x7e]/u);
          if (finalIndex < 0) {
            this.#pending = input.slice(index);
            break;
          }
          const seq = rest.slice(0, finalIndex + 2);
          keys.push(mapSequence("\x1b" + seq));
          index += 1 + seq.length;
        } else {
          keys.push({ type: "escape" });
          index += 1;
        }
        continue;
      }
      switch (ch) {
        case "\r":
        case "\n":
          keys.push({ type: "enter" });
          break;
        case "\x7f":
        case "\b":
          keys.push({ type: "backspace" });
          break;
        case "\t":
          keys.push({ type: "tab" });
          break;
        case "\x03":
          keys.push({ type: "ctrl-c" });
          break;
        case "\x0c":
          keys.push({ type: "ctrl-l" });
          break;
        case "\x01":
          keys.push({ type: "home" });
          break;
        case "\x05":
          keys.push({ type: "end" });
          break;
        default:
          keys.push({ type: "char", value: ch });
      }
      index += 1;
    }
    return keys;
  }
}

function mapSequence(seq: string): Key {
  switch (seq) {
    case "\x1b[A":
    case "\x1bOA":
      return { type: "up" };
    case "\x1b[B":
    case "\x1bOB":
      return { type: "down" };
    case "\x1b[C":
    case "\x1bOC":
      return { type: "right" };
    case "\x1b[D":
    case "\x1bOD":
      return { type: "left" };
    case "\x1b[H":
    case "\x1bOH":
    case "\x1b[1~":
      return { type: "home" };
    case "\x1b[F":
    case "\x1bOF":
    case "\x1b[4~":
      return { type: "end" };
    default:
      return { type: "escape" };
  }
}

export interface InputEditor {
  text: string;
  /** Code-unit index; always kept on a character boundary. */
  cursor: number;
  /** Most recent first. */
  history: string[];
  /** -1 = editing a fresh line, 0..length-1 = viewing history entry. */
  historyIndex: number;
}

export function createEditor(history: string[] = []): InputEditor {
  return { text: "", cursor: 0, history, historyIndex: -1 };
}

export type EditorEffect =
  | { type: "none" }
  | { type: "submit"; text: string }
  | { type: "clear-input" };

const MAX_HISTORY = 50;

export function applyEditorKey(
  editor: InputEditor,
  key: Key
): { editor: InputEditor; effect: EditorEffect } {
  switch (key.type) {
    case "char": {
      const text = editor.text.slice(0, editor.cursor)
        + key.value
        + editor.text.slice(editor.cursor);
      return { editor: { ...editor, text, cursor: editor.cursor + key.value.length }, effect: { type: "none" } };
    }
    case "backspace": {
      const before = charBefore(editor.text, editor.cursor);
      if (before === null) return { editor, effect: { type: "none" } };
      const text = editor.text.slice(0, before.index)
        + editor.text.slice(before.index + before.char.length);
      return { editor: { ...editor, text, cursor: before.index }, effect: { type: "none" } };
    }
    case "left": {
      const before = charBefore(editor.text, editor.cursor);
      return { editor: { ...editor, cursor: before?.index ?? 0 }, effect: { type: "none" } };
    }
    case "right": {
      const after = charAfter(editor.text, editor.cursor);
      return { editor: { ...editor, cursor: after?.end ?? editor.text.length }, effect: { type: "none" } };
    }
    case "home":
      return { editor: { ...editor, cursor: 0 }, effect: { type: "none" } };
    case "end":
      return { editor: { ...editor, cursor: editor.text.length }, effect: { type: "none" } };
    case "up": {
      if (editor.historyIndex + 1 >= editor.history.length) return { editor, effect: { type: "none" } };
      const historyIndex = editor.historyIndex + 1;
      const text = editor.history[historyIndex] ?? "";
      return { editor: { ...editor, text, cursor: text.length, historyIndex }, effect: { type: "none" } };
    }
    case "down": {
      if (editor.historyIndex < 0) return { editor, effect: { type: "none" } };
      const historyIndex = editor.historyIndex - 1;
      if (historyIndex < 0) {
        return { editor: { ...editor, text: "", cursor: 0, historyIndex: -1 }, effect: { type: "none" } };
      }
      const text = editor.history[historyIndex] ?? "";
      return { editor: { ...editor, text, cursor: text.length, historyIndex }, effect: { type: "none" } };
    }
    case "enter":
      return { editor, effect: { type: "submit", text: editor.text } };
    case "ctrl-c": {
      if (editor.text.length === 0) return { editor, effect: { type: "none" } };
      return { editor: { ...editor, text: "", cursor: 0 }, effect: { type: "clear-input" } };
    }
    case "tab":
    case "ctrl-l":
    case "escape":
      return { editor, effect: { type: "none" } };
  }
}

/** Push a submitted line into history (deduped, capped). Used by tui.ts. */
export function rememberHistory(history: string[], line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return history;
  const without = history.filter((entry) => entry !== trimmed);
  return [trimmed, ...without].slice(0, MAX_HISTORY);
}

function charBefore(
  text: string,
  cursor: number
): { char: string; index: number } | null {
  let position = 0;
  for (const ch of text) {
    if (position + ch.length === cursor) return { char: ch, index: position };
    position += ch.length;
  }
  return null;
}

function charAfter(
  text: string,
  cursor: number
): { char: string; end: number } | null {
  let position = 0;
  for (const ch of text) {
    if (position >= cursor) return { char: ch, end: position + ch.length };
    position += ch.length;
  }
  return null;
}
