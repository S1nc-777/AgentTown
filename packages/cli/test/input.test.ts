import { describe, expect, it } from "vitest";
import { KeyParser, applyEditorKey, createEditor } from "../src/tui/input.js";

describe("KeyParser", () => {
  const parser = () => new KeyParser();

  it("parses plain characters", () => {
    expect(parser().feed("ab")).toEqual([
      { type: "char", value: "a" },
      { type: "char", value: "b" }
    ]);
  });

  it("parses control keys", () => {
    expect(parser().feed("\r")).toEqual([{ type: "enter" }]);
    expect(parser().feed("\x7f")).toEqual([{ type: "backspace" }]);
    expect(parser().feed("\t")).toEqual([{ type: "tab" }]);
    expect(parser().feed("\x03")).toEqual([{ type: "ctrl-c" }]);
    expect(parser().feed("\x0c")).toEqual([{ type: "ctrl-l" }]);
  });

  it("parses escape sequences split across chunks", () => {
    const p = parser();
    expect(p.feed("\x1b")).toEqual([]);
    expect(p.feed("[")).toEqual([]);
    expect(p.feed("A")).toEqual([{ type: "up" }]);
    expect(p.feed("\x1b[B")).toEqual([{ type: "down" }]);
    expect(p.feed("\x1b[C")).toEqual([{ type: "right" }]);
    expect(p.feed("\x1b[D")).toEqual([{ type: "left" }]);
    expect(p.feed("\x1b[H")).toEqual([{ type: "home" }]);
    expect(p.feed("\x1b[F")).toEqual([{ type: "end" }]);
    expect(p.feed("\x1b[1~")).toEqual([{ type: "home" }]);
    expect(p.feed("\x1b[4~")).toEqual([{ type: "end" }]);
  });

  it("parses Chinese characters", () => {
    expect(parser().feed("暂停")).toEqual([
      { type: "char", value: "暂" },
      { type: "char", value: "停" }
    ]);
  });
});

describe("applyEditorKey", () => {
  it("inserts characters at the cursor", () => {
    let editor = createEditor();
    editor = applyEditorKey(editor, { type: "char", value: "a" }).editor;
    editor = applyEditorKey(editor, { type: "char", value: "b" }).editor;
    expect(editor.text).toBe("ab");
    expect(editor.cursor).toBe(2);
  });

  it("backspaces before the cursor", () => {
    let editor = createEditor();
    editor = applyEditorKey(editor, { type: "char", value: "a" }).editor;
    editor = applyEditorKey(editor, { type: "char", value: "b" }).editor;
    editor = applyEditorKey(editor, { type: "left" }).editor;
    const result = applyEditorKey(editor, { type: "backspace" });
    expect(result.editor.text).toBe("b");
    expect(result.editor.cursor).toBe(0);
  });

  it("moves the cursor", () => {
    let editor = createEditor();
    for (const ch of "abc") {
      editor = applyEditorKey(editor, { type: "char", value: ch }).editor;
    }
    editor = applyEditorKey(editor, { type: "left" }).editor;
    expect(editor.cursor).toBe(2);
    editor = applyEditorKey(editor, { type: "home" }).editor;
    expect(editor.cursor).toBe(0);
    editor = applyEditorKey(editor, { type: "end" }).editor;
    expect(editor.cursor).toBe(3);
  });

  it("walks history with up/down", () => {
    let editor = createEditor(["pause", "status"]);
    editor = applyEditorKey(editor, { type: "up" }).editor;
    expect(editor.text).toBe("pause");
    editor = applyEditorKey(editor, { type: "up" }).editor;
    expect(editor.text).toBe("status");
    editor = applyEditorKey(editor, { type: "down" }).editor;
    expect(editor.text).toBe("pause");
    editor = applyEditorKey(editor, { type: "down" }).editor;
    expect(editor.text).toBe("");
  });

  it("submits on enter", () => {
    let editor = createEditor();
    editor = applyEditorKey(editor, { type: "char", value: "x" }).editor;
    const result = applyEditorKey(editor, { type: "enter" });
    expect(result.effect).toEqual({ type: "submit", text: "x" });
  });

  it("clears input on ctrl-c when non-empty, no-op when empty", () => {
    let editor = createEditor();
    editor = applyEditorKey(editor, { type: "char", value: "x" }).editor;
    const cleared = applyEditorKey(editor, { type: "ctrl-c" });
    expect(cleared.effect).toEqual({ type: "clear-input" });
    expect(cleared.editor.text).toBe("");
    const empty = applyEditorKey(createEditor(), { type: "ctrl-c" });
    expect(empty.effect).toEqual({ type: "none" });
  });
});
