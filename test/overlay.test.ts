import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  getThemeByName,
  KeybindingsManager,
  type Theme,
} from "@oh-my-pi/pi-coding-agent";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { parseReviewDiffSnapshot } from "../src/diff";
import {
  CodeReviewOverlay,
  CONTINUE_CODE_REVIEW_ACTION,
  PASTE_CODE_REVIEW_ACTION,
} from "../src/overlay";
import type { CodeReviewOverlayResult, ReviewDiffFile } from "../src/types";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_ENTER = "\x1b[13;2~";
const ESC = "\x1b";

let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager | undefined;

function theme(): Theme {
  if (!darkTheme) throw new Error("The public dark theme is unavailable");
  return darkTheme;
}

function renderLines(component: CodeReviewOverlay, width = 90): string[] {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function render(component: CodeReviewOverlay, width = 90): string {
  return renderLines(component, width).join("\n");
}

function makeOverlay(
  diff: string,
  options: {
    onComplete?: (result: CodeReviewOverlayResult | undefined) => void;
    onWarning?: (message: string) => void;
    tui?: TUI;
    keybindings?: KeybindingsManager;
    files?: readonly ReviewDiffFile[];
  } = {},
): CodeReviewOverlay {
  return new CodeReviewOverlay(
    options.tui ?? ({} as TUI),
    theme(),
    options.keybindings ?? KeybindingsManager.inMemory(),
    options.files ?? parseReviewDiffSnapshot(diff).files,
    "Reviewing changes",
    {
      onComplete: options.onComplete ?? (() => {}),
      onWarning: options.onWarning,
    },
  );
}

const oneLineDiff =
  "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+new";

describe("CodeReviewOverlay", () => {
  beforeAll(async () => {
    darkTheme = await getThemeByName("dark");
  });

  beforeEach(() => {
    previousKeybindings = getKeybindings() as KeybindingsManager;
    setKeybindings(KeybindingsManager.inMemory());
  });

  afterEach(() => {
    if (previousKeybindings) setKeybindings(previousKeybindings);
    vi.restoreAllMocks();
  });

  it("renders changed files, their diff, actions, and a full nested path", () => {
    const nestedPath =
      "packages/coding-agent/src/modes/components/deep/code-review-pane.ts";
    const overlay = makeOverlay(`diff --git a/${nestedPath} b/${nestedPath}
--- a/${nestedPath}
+++ b/${nestedPath}
@@ -1 +1 @@
-old
+new
diff --git a/src/beta.ts b/src/beta.ts
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -0,0 +1 @@
+beta`);

    const out = render(overlay, 120);
    expect(out).toContain("Code Review");
    expect(out).toContain(nestedPath);
    expect(out).toContain("new");
    expect(out).toContain("src/beta.ts");
    expect(out).toContain(CONTINUE_CODE_REVIEW_ACTION);
    expect(out).toContain(PASTE_CODE_REVIEW_ACTION);

    overlay.handleInput(DOWN);
    expect(render(overlay)).toContain("beta");
    overlay.handleInput(TAB);
    expect(render(overlay)).toContain("↑↓ line");
  });

  it("anchors a scrolled annotation to its exact source row", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) => ` context-row-${String(index).padStart(3, "0")}`,
    );
    const completed: Array<CodeReviewOverlayResult | undefined> = [];
    const overlay = makeOverlay(
      `diff --git a/src/long.ts b/src/long.ts\n--- a/src/long.ts\n+++ b/src/long.ts\n@@ -1,80 +1,80 @@\n${rows.join("\n")}`,
      { onComplete: (result) => completed.push(result) },
    );

    render(overlay);
    overlay.handleInput(TAB);
    for (let index = 0; index < 12; index++) overlay.handleInput(DOWN);
    overlay.handleInput("a");
    for (const character of "check this guard") overlay.handleInput(character);
    overlay.handleInput(ENTER);

    expect(overlay.getAnnotations()).toEqual([
      expect.objectContaining({
        path: "src/long.ts",
        oldLine: 13,
        newLine: 13,
        rawLine: " context-row-012",
        note: "check this guard",
      }),
    ]);
    expect(render(overlay)).toContain("check this guard");

    overlay.handleInput(TAB);
    overlay.handleInput(ENTER);
    expect(completed).toEqual([
      expect.objectContaining({
        action: "review",
        annotations: overlay.getAnnotations(),
      }),
    ]);
  });

  it("saves a multiline Shift+Enter annotation", () => {
    const overlay = makeOverlay(oneLineDiff);

    render(overlay);
    overlay.handleInput(TAB);
    overlay.handleInput("a");
    overlay.handleInput("first line");
    overlay.handleInput(SHIFT_ENTER);
    overlay.handleInput("second line");
    expect(render(overlay)).toContain("shift+enter newline");
    overlay.handleInput(ENTER);

    expect(overlay.getAnnotations()).toEqual([
      expect.objectContaining({ newLine: 1, note: "first line\nsecond line" }),
    ]);
    const out = render(overlay);
    expect(out).toContain("first line");
    expect(out).toContain("second line");
  });

  it("caches static diff rendering through navigation, annotations, and width changes", () => {
    const trailingRows = Array.from(
      { length: 40 },
      (_, index) => ` context-tail-${String(index).padStart(3, "0")}`,
    ).join("\n");
    const longContent = `long-${"x".repeat(56)}`;
    const color = vi.spyOn(theme(), "fg");
    const overlay = makeOverlay(`diff --git a/src/alpha.ts b/src/alpha.ts
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,41 +1,42 @@
 context-first
+${longContent}
${trailingRows}
diff --git a/src/beta.ts b/src/beta.ts
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -0,0 +1 @@
+beta`);
    const staticDiffCalls = () =>
      color.mock.calls.filter(
        (call) =>
          call[0] === "toolDiffAdded" ||
          call[0] === "toolDiffContext" ||
          call[0] === "toolDiffRemoved",
      ).length;

    expect(render(overlay, 120)).toContain(longContent);
    const firstFileCalls = staticDiffCalls();
    expect(firstFileCalls).toBeGreaterThan(0);

    overlay.handleInput(TAB);
    overlay.handleInput(DOWN);
    expect(render(overlay, 120)).toContain(longContent);
    expect(staticDiffCalls()).toBe(firstFileCalls);

    overlay.handleInput("a");
    overlay.handleInput("cached annotation");
    overlay.handleInput(ENTER);
    expect(render(overlay, 120)).toContain("cached annotation");
    expect(staticDiffCalls()).toBe(firstFileCalls);

    const narrow = renderLines(overlay, 45);
    expect(narrow.join("\n")).not.toContain(longContent);
    expect(narrow.join("\n")).toContain("long-");
    expect(narrow.every((line) => Bun.stringWidth(line) <= 45)).toBe(true);
    expect(staticDiffCalls()).toBe(firstFileCalls);

    for (let index = 0; index < 40; index++) overlay.handleInput(DOWN);
    expect(render(overlay, 120)).toContain("context-tail-039");
    expect(staticDiffCalls()).toBe(firstFileCalls);

    overlay.handleInput("]");
    expect(render(overlay, 120)).toContain("beta");
    expect(staticDiffCalls()).toBe(firstFileCalls + 1);
    overlay.handleInput("[");
    expect(render(overlay, 120)).toContain("cached annotation");
    expect(staticDiffCalls()).toBe(firstFileCalls + 1);
  });

  it("keeps paste disabled until a note exists and undo disables it again", () => {
    const disabledCompletions: Array<CodeReviewOverlayResult | undefined> = [];
    const disabled = makeOverlay(oneLineDiff, {
      onComplete: (result) => disabledCompletions.push(result),
    });
    render(disabled);
    disabled.handleInput(TAB);
    disabled.handleInput(TAB);
    disabled.handleInput(DOWN);
    disabled.handleInput(ENTER);
    expect(disabledCompletions).toEqual([
      { action: "review", annotations: [] },
    ]);

    const enabledCompletions: Array<CodeReviewOverlayResult | undefined> = [];
    const enabled = makeOverlay(oneLineDiff, {
      onComplete: (result) => enabledCompletions.push(result),
    });
    render(enabled);
    enabled.handleInput(TAB);
    enabled.handleInput("a");
    enabled.handleInput("note");
    enabled.handleInput(ENTER);
    enabled.handleInput(TAB);
    enabled.handleInput(DOWN);
    enabled.handleInput(ENTER);
    expect(enabledCompletions).toEqual([
      expect.objectContaining({ action: "paste" }),
    ]);

    const undo = makeOverlay(oneLineDiff);
    render(undo);
    undo.handleInput(TAB);
    undo.handleInput("a");
    undo.handleInput("note");
    undo.handleInput(ENTER);
    expect(undo.getAnnotations()).toHaveLength(1);
    undo.handleInput("u");
    expect(undo.getAnnotations()).toEqual([]);
  });

  it("uses a configured external editor and cleans up its temporary file", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "omp-code-review-editor-"),
    );
    const editorPath = path.join(temporaryDirectory, "editor.sh");
    const observedFilePath = path.join(temporaryDirectory, "opened-file");
    const previousEditor = Bun.env.EDITOR;
    const previousVisual = Bun.env.VISUAL;
    const previousBindings = getKeybindings();
    const editorApplied = Promise.withResolvers<void>();
    const stop = vi.fn();
    const start = vi.fn();
    const tui = {
      stop,
      start,
      requestRender: (_force?: boolean) => editorApplied.resolve(),
    } as unknown as TUI;

    try {
      await Bun.write(
        editorPath,
        '#!/bin/sh\nprintf "%s" "$2" > "$1"\nprintf "%s" "edited annotation" > "$2"\n',
      );
      await fs.chmod(editorPath, 0o755);
      Bun.env.EDITOR = `${editorPath} ${observedFilePath}`;
      delete Bun.env.VISUAL;
      const keybindings = KeybindingsManager.inMemory({
        "app.editor.external": "ctrl+e",
      });
      setKeybindings(keybindings);
      const overlay = makeOverlay(oneLineDiff, { tui, keybindings });

      render(overlay);
      overlay.handleInput(TAB);
      overlay.handleInput("a");
      overlay.handleInput("draft");
      overlay.handleInput("\x05");
      await editorApplied.promise;

      expect(overlay.getAnnotations()).toEqual([
        expect.objectContaining({ newLine: 1, note: "edited annotation" }),
      ]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      const temporaryFile = (await Bun.file(observedFilePath).text()).trim();
      expect(await Bun.file(temporaryFile).exists()).toBe(false);
    } finally {
      if (previousEditor === undefined) delete Bun.env.EDITOR;
      else Bun.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete Bun.env.VISUAL;
      else Bun.env.VISUAL = previousVisual;
      setKeybindings(previousBindings);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("uses the compact file header in a narrow layout", () => {
    const overlay = makeOverlay(`diff --git a/src/alpha.ts b/src/alpha.ts
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -0,0 +1 @@
+new
diff --git a/src/beta.ts b/src/beta.ts
--- a/src/beta.ts
+++ b/src/beta.ts
@@ -0,0 +1 @@
+after`);

    expect(render(overlay, 55)).toContain("src/alpha.ts");
    overlay.handleInput("]");
    const out = render(overlay, 55);
    expect(out).toContain("src/beta.ts");
    expect(out).toContain("after");
  });

  it("does not annotate binary or rename-only files", () => {
    const warnings: string[] = [];
    const overlay = makeOverlay(
      `diff --git a/assets/blob.bin b/assets/blob.bin
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/assets/blob.bin differ
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts`,
      {
        onWarning: (message) => warnings.push(message),
      },
    );

    expect(render(overlay)).toContain(
      "Binary diff; no annotatable source rows",
    );
    overlay.handleInput(TAB);
    overlay.handleInput("a");
    overlay.handleInput("]");
    expect(render(overlay)).toContain(
      "No diff hunks; this may be a rename-only change",
    );
    overlay.handleInput("a");

    expect(overlay.getAnnotations()).toEqual([]);
    expect(warnings).toEqual([
      "This file has no annotatable diff rows",
      "This file has no annotatable diff rows",
    ]);
  });

  it("cancels with Escape without producing a review result", () => {
    const completed: Array<CodeReviewOverlayResult | undefined> = [];
    const overlay = makeOverlay(oneLineDiff, {
      onComplete: (result) => completed.push(result),
    });

    overlay.handleInput(ESC);
    expect(completed).toEqual([undefined]);
  });
});
