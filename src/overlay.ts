import {
  type Component,
  Editor,
  Ellipsis,
  matchesKey,
  replaceTabs,
  ScrollView,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { type KeybindingsManager, type Theme } from "@oh-my-pi/pi-coding-agent";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getEditorCommand, openInEditor } from "./external-editor";
import { openFileInTmux } from "./tmux";
import {
  bottomBorder,
  divider,
  dividerSplit,
  fit,
  row,
  splitBodyWidth,
  splitRow,
  topBorder,
  topBorderSplit,
} from "./overlay-box";
import type {
  CodeReviewAnnotation,
  CodeReviewOverlayResult,
  ReviewDiffFile,
  ReviewDiffRow,
  ReviewSourceRow,
} from "./types";

export const CONTINUE_CODE_REVIEW_ACTION = "Continue with LLM review";
export const PASTE_CODE_REVIEW_ACTION = "Paste annotations into prompt";

export interface CodeReviewOverlayCallbacks {
  onComplete(result: CodeReviewOverlayResult | undefined): void;
  onWarning?(message: string): void;
  cwd?: string;
}

type AnnotationScope = CodeReviewAnnotation["scope"];
type DiffColor = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";

interface AnnotationChooser {
  entries: number[];
  selected: number;
}

interface CommittedAnnotation {
  fileIndex: number;
  sourceIndex: number;
  annotation: CodeReviewAnnotation;
}
interface RenderedDiffBody {
  lines: string[];
  renderedRowBySource: number[];
  selectedSourceLines: string[];
}

interface RenderedBody {
  lines: string[];
  renderedRowBySource: number[];
}

type FocusRegion = "files" | "diff" | "actions";

const SOURCE_SELECTION_GUTTER_WIDTH = 2;

const OVERLAY_TITLE = "Code Review";
const MIN_BODY_ROWS = 3;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;
const MAX_ANNOTATION_EDITOR_ROWS = 6;
const ACTIONS = [
  CONTINUE_CODE_REVIEW_ACTION,
  PASTE_CODE_REVIEW_ACTION,
] as const;

function isSourceRow(row: ReviewDiffRow): row is ReviewSourceRow {
  return (
    row.kind === "context" || row.kind === "added" || row.kind === "removed"
  );
}

function displayFileLabel(file: ReviewDiffFile): string {
  return file.occurrence > 1 ? `${file.path} (${file.occurrence})` : file.path;
}

function sanitizeStatusText(text: string): string {
  return sanitizeText(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** A fullscreen, annotated diff picker that only relies on public OMP APIs. */
export class CodeReviewOverlay implements Component {
  #scrollView: ScrollView;
  #editor: Editor;
  #focus: FocusRegion = "files";
  #fileIndex = 0;
  #sourceIndex = 0;
  #actionIndex = 0;
  #bodyHeight = MIN_BODY_ROWS;
  #sidebarShown = false;
  #annotating = false;
  #annotationScope: AnnotationScope = "line";
  #editingAnnotationIndex: number | undefined;
  #annotationChooser: AnnotationChooser | undefined;
  #externalOperation = false;
  #finished = false;
  #annotations: CommittedAnnotation[] = [];
  #staticRenderedDiffBodies = new WeakMap<ReviewDiffFile, RenderedDiffBody>();
  #externalEditorLabel: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly files: readonly ReviewDiffFile[],
    private readonly mode: string,
    private readonly callbacks: CodeReviewOverlayCallbacks,
  ) {
    const symbols = {
      cursor: theme.nav.cursor,
      inputCursor: theme.nav.cursor,
      boxRound: {
        topLeft: theme.boxRound.topLeft,
        topRight: theme.boxRound.topRight,
        bottomLeft: theme.boxRound.bottomLeft,
        bottomRight: theme.boxRound.bottomRight,
        horizontal: theme.boxRound.horizontal,
        vertical: theme.boxRound.vertical,
      },
      boxSharp: theme.boxSharp,
      table: theme.boxSharp,
      quoteBorder: theme.md.quoteBorder,
      hrChar: theme.md.hrChar,
      colorSwatch: theme.md.colorSwatch,
      spinnerFrames: theme.spinnerFrames,
    };
    this.#editor = new Editor({
      borderColor: (text) => theme.fg("border", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.bold(theme.fg("accent", text)),
        description: (text) => theme.fg("dim", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("dim", text),
        symbols,
      },
      symbols,
      hintStyle: (text) => theme.fg("dim", text),
    });
    this.#scrollView = new ScrollView([], {
      height: MIN_BODY_ROWS,
      scrollbar: "auto",
      ellipsis: Ellipsis.Omit,
      theme: {
        track: (text) => theme.fg("dim", text),
        thumb: (text) => theme.fg("accent", text),
      },
    });
    this.#editor.setBorderVisible(false);
    this.#editor.setPromptGutter("> ");
    this.#editor.setUseTerminalCursor(false);
    // Keep the editor's CURSOR_MARKER for correct terminal placement, but
    // replace its visible end-of-input caret with a stable blank cell.
    this.#editor.cursorOverride = " ";
    this.#editor.cursorOverrideWidth = 1;
    this.#editor.setScrollbarVisible(true);
    this.#editor.onSubmit = (value) => this.#commitAnnotation(value);
    this.#externalEditorLabel = keybindings.getDisplayString(
      "app.editor.external",
    );
    this.#resetSourceCursor();
  }

  invalidate(): void {
    this.#staticRenderedDiffBodies = new WeakMap();
  }

  dispose(): void {
    this.#finished = true;
  }

  getAnnotations(): CodeReviewAnnotation[] {
    return this.#annotations.map((entry) => ({ ...entry.annotation }));
  }

  handleInput(data: string): void {
    if (this.#finished || this.#externalOperation) return;
    if (this.#annotationChooser) {
      this.#handleAnnotationChooser(data);
      return;
    }
    if (this.#annotating) {
      if (
        matchesKey(data, "ctrl+g") ||
        this.keybindings.matches(data, "app.editor.external")
      ) {
        void this.#openAnnotationEditor();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.#cancelAnnotation();
        return;
      }
      this.#editor.handleInput(data);
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      void this.#openCurrentFileInTmux();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.#finish(undefined);
      return;
    }
    if (data === "A" && (this.#focus === "files" || this.#focus === "diff")) {
      this.#startAnnotation("file");
      return;
    }
    if (data === "[") {
      this.#selectRelativeFile(-1);
      return;
    }
    if (data === "]") {
      this.#selectRelativeFile(1);
      return;
    }
    if (data === "u") {
      this.#undoAnnotation();
      return;
    }
    if (data === "e") {
      this.#editCurrentAnnotation();
      return;
    }
    if (matchesKey(data, "tab") || data === "\t") {
      this.#cycleFocus(1);
      return;
    }
    if (matchesKey(data, "shift+tab") || data === "\x1b[Z") {
      this.#cycleFocus(-1);
      return;
    }
    if (this.#focus === "files") this.#handleFiles(data);
    else if (this.#focus === "diff") this.#handleDiff(data);
    else this.#handleActions(data);
  }

  #finish(result: CodeReviewOverlayResult | undefined): void {
    if (this.#finished) return;
    this.#finished = true;
    this.callbacks.onComplete(result);
  }

  #cycleFocus(direction: number): void {
    const regions: FocusRegion[] = this.#sidebarShown
      ? ["files", "diff", "actions"]
      : ["diff", "actions"];
    const current = regions.indexOf(this.#focus);
    const index = current < 0 ? regions.length - 1 : current;
    this.#focus =
      regions[(index + direction + regions.length) % regions.length]!;
  }

  #handleFiles(data: string): void {
    if (data === "a") {
      this.#startAnnotation("file");
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "k")
    ) {
      this.#selectFile(Math.max(0, this.#fileIndex - 1));
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "j")
    ) {
      this.#selectFile(Math.min(this.files.length - 1, this.#fileIndex + 1));
      return;
    }
    if (
      matchesKey(data, "right") ||
      matchesKey(data, "l") ||
      this.keybindings.matches(data, "tui.select.confirm")
    ) {
      this.#focus = "diff";
    }
  }

  #handleDiff(data: string): void {
    if (data === "a") {
      this.#startAnnotation("line");
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      if (this.#sidebarShown) this.#focus = "files";
      return;
    }
    if (
      matchesKey(data, "right") ||
      matchesKey(data, "l") ||
      this.keybindings.matches(data, "tui.select.confirm")
    ) {
      this.#focus = "actions";
      return;
    }
    if (matchesKey(data, "shift+up")) {
      this.#moveSourceCursor(-5);
      return;
    }
    if (matchesKey(data, "shift+down")) {
      this.#moveSourceCursor(5);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "k")
    ) {
      this.#moveSourceCursor(-1);
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "j")
    ) {
      this.#moveSourceCursor(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.#moveSourceCursor(-Math.max(1, this.#bodyHeight - 1));
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.#moveSourceCursor(Math.max(1, this.#bodyHeight - 1));
      return;
    }
    if (data === "g" || matchesKey(data, "home")) this.#sourceIndex = 0;
    else if (data === "G" || matchesKey(data, "end"))
      this.#sourceIndex = Math.max(0, this.#currentSourceRows().length - 1);
  }

  #handleActions(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "k")
    ) {
      this.#actionIndex = 0;
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "j")
    ) {
      if (this.#annotations.length > 0) this.#actionIndex = 1;
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.#actionIndex === 1 && this.#annotations.length === 0) return;
      this.#finish({
        action: this.#actionIndex === 0 ? "review" : "paste",
        annotations: this.getAnnotations(),
      });
    }
  }

  #selectFile(index: number): void {
    if (this.files.length === 0) return;
    this.#fileIndex = Math.max(0, Math.min(this.files.length - 1, index));
    this.#resetSourceCursor();
    this.#scrollView.scrollToTop();
  }

  #selectRelativeFile(delta: number): void {
    if (this.files.length === 0) return;
    this.#selectFile(
      (this.#fileIndex + delta + this.files.length) % this.files.length,
    );
  }

  #resetSourceCursor(): void {
    this.#sourceIndex = 0;
  }

  #currentFile(): ReviewDiffFile | undefined {
    return this.files[this.#fileIndex];
  }

  #currentSourceRows(): ReviewSourceRow[] {
    const file = this.#currentFile();
    return file ? file.rows.filter(isSourceRow) : [];
  }

  #moveSourceCursor(delta: number): void {
    const rows = this.#currentSourceRows();
    if (rows.length === 0) return;
    this.#sourceIndex = Math.max(
      0,
      Math.min(rows.length - 1, this.#sourceIndex + delta),
    );
  }

  #startAnnotation(scope: AnnotationScope, existingIndex?: number): void {
    const file = this.#currentFile();
    const source = this.#currentSourceRows()[this.#sourceIndex];
    if (!file || (scope === "line" && (file.isBinary || !source))) {
      this.callbacks.onWarning?.("This file has no annotatable diff rows");
      return;
    }
    const existing =
      existingIndex === undefined
        ? undefined
        : this.#annotations[existingIndex];
    if (
      existing &&
      (existing.fileIndex !== this.#fileIndex ||
        existing.annotation.scope !== scope)
    ) {
      return;
    }
    this.#annotationScope = scope;
    this.#editingAnnotationIndex = existingIndex;
    this.#annotating = true;
    this.#editor.setText(existing?.annotation.note ?? "");
  }

  #cancelAnnotation(): void {
    this.#annotating = false;
    this.#editingAnnotationIndex = undefined;
    this.#editor.setText("");
  }

  #commitAnnotation(value: string): void {
    const note = value.trim();
    const file = this.#currentFile();
    const source = this.#currentSourceRows()[this.#sourceIndex];
    const editingIndex = this.#editingAnnotationIndex;
    const scope = this.#annotationScope;
    this.#annotating = false;
    this.#editingAnnotationIndex = undefined;
    this.#editor.setText("");

    // Empty submissions never erase an existing note. The user can cancel
    // explicitly, and a blank new draft should not create a no-op annotation.
    if (!note) return;
    if (editingIndex !== undefined) {
      const existing = this.#annotations[editingIndex];
      if (existing) {
        this.#annotations[editingIndex] = {
          ...existing,
          annotation: { ...existing.annotation, note },
        };
      }
      return;
    }
    if (!file || (scope === "line" && !source)) return;

    const common = {
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      ...(file.newPath === undefined ? {} : { newPath: file.newPath }),
      occurrence: file.occurrence,
      note,
    };
    const annotation: CodeReviewAnnotation =
      scope === "file"
        ? { ...common, scope: "file" }
        : {
            ...common,
            scope: "line",
            hunkHeader: source!.hunkHeader,
            ...(source!.oldLine === undefined
              ? {}
              : { oldLine: source!.oldLine }),
            ...(source!.newLine === undefined
              ? {}
              : { newLine: source!.newLine }),
            rawLine: source!.raw,
          };
    this.#annotations.push({
      fileIndex: this.#fileIndex,
      sourceIndex: scope === "line" ? this.#sourceIndex : -1,
      annotation,
    });
  }

  #annotationCandidates(): number[] {
    if (this.#focus !== "files" && this.#focus !== "diff") return [];
    const lineEntries: number[] = [];
    const fileEntries: number[] = [];
    for (const [index, entry] of this.#annotations.entries()) {
      if (entry.fileIndex !== this.#fileIndex) continue;
      if (entry.annotation.scope === "file") {
        fileEntries.push(index);
      } else if (
        this.#focus === "diff" &&
        entry.sourceIndex === this.#sourceIndex
      ) {
        lineEntries.push(index);
      }
    }
    return this.#focus === "files"
      ? fileEntries
      : [...lineEntries, ...fileEntries];
  }

  #editCurrentAnnotation(): void {
    const entries = this.#annotationCandidates();
    if (entries.length === 0) return;
    if (entries.length === 1) {
      const index = entries[0]!;
      this.#startAnnotation(this.#annotations[index]!.annotation.scope, index);
      return;
    }
    this.#annotationChooser = { entries, selected: 0 };
  }

  #handleAnnotationChooser(data: string): void {
    const chooser = this.#annotationChooser;
    if (!chooser) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.#annotationChooser = undefined;
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "up") ||
      matchesKey(data, "k")
    ) {
      chooser.selected =
        (chooser.selected - 1 + chooser.entries.length) %
        chooser.entries.length;
      return;
    }
    if (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "down") ||
      matchesKey(data, "j")
    ) {
      chooser.selected = (chooser.selected + 1) % chooser.entries.length;
      return;
    }
    if (!this.keybindings.matches(data, "tui.select.confirm")) return;
    const index = chooser.entries[chooser.selected];
    this.#annotationChooser = undefined;
    if (index === undefined) return;
    const entry = this.#annotations[index];
    if (entry) this.#startAnnotation(entry.annotation.scope, index);
  }

  #annotationLocation(entry: CommittedAnnotation): string {
    if (entry.annotation.scope === "file")
      return `${displayFileLabel(this.files[entry.fileIndex]!)} · file`;
    return `${displayFileLabel(this.files[entry.fileIndex]!)} · ${entry.annotation.oldLine ?? "-"}/${entry.annotation.newLine ?? "-"}`;
  }

  #undoAnnotation(): void {
    this.#annotations.pop();
    if (this.#annotations.length === 0 && this.#actionIndex === 1)
      this.#actionIndex = 0;
  }

  async #openAnnotationEditor(): Promise<void> {
    if (this.#externalOperation || !this.#annotating) return;
    const editorCommand = getEditorCommand();
    if (!editorCommand) {
      this.callbacks.onWarning?.(
        "No editor configured. Set $VISUAL or $EDITOR environment variable.",
      );
      return;
    }
    const draft = this.#editor.getExpandedText();
    this.#externalOperation = true;
    let stopped = false;
    try {
      this.tui.stop();
      stopped = true;
      const result = await openInEditor(editorCommand, draft, {
        extension: ".md",
      });
      if (result !== null) this.#editor.setText(result);
    } catch (error) {
      this.callbacks.onWarning?.(
        `Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        if (stopped) this.tui.start();
      } finally {
        this.#externalOperation = false;
        this.tui.requestRender(true);
      }
    }
  }
  async #openCurrentFileInTmux(): Promise<void> {
    if (this.#externalOperation) return;
    const file = this.#currentFile();
    if (!file) return;
    this.#externalOperation = true;
    try {
      await openFileInTmux(
        file.newPath ?? file.path,
        this.callbacks.cwd ?? process.cwd(),
      );
    } catch (error) {
      this.callbacks.onWarning?.(
        `Failed to open file in tmux: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#externalOperation = false;
      this.tui.requestRender(true);
    }
  }

  #annotationCount(fileIndex: number): number {
    let count = 0;
    for (const entry of this.#annotations)
      if (entry.fileIndex === fileIndex) count++;
    return count;
  }

  #renderBody(contentWidth: number): RenderedBody {
    const file = this.#currentFile();
    if (!file)
      return {
        lines: [this.theme.fg("dim", "No reviewable files")],
        renderedRowBySource: [],
      };
    const staticBody = this.#getStaticRenderedBody(file);
    const lines: string[] = [];
    const renderedRowBySource: number[] = [];

    // File notes describe the whole change, so keep them above headers and
    // status rows (including binary and rename-only files).
    for (const entry of this.#annotations) {
      if (
        entry.fileIndex === this.#fileIndex &&
        entry.annotation.scope === "file"
      ) {
        this.#appendAnnotationCallout(
          lines,
          entry.annotation.note,
          contentWidth,
          "file note",
        );
      }
    }

    let sourceIndex = 0;
    for (let staticRow = 0; staticRow < staticBody.lines.length; staticRow++) {
      const currentSourceIndex =
        staticBody.renderedRowBySource[sourceIndex] === staticRow
          ? sourceIndex++
          : undefined;
      let renderedLine = staticBody.lines[staticRow] ?? "";
      if (currentSourceIndex !== undefined) {
        // Line notes belong immediately before their source row. This keeps
        // the selected row and all notes in a stable, readable order.
        for (const entry of this.#annotations) {
          if (
            entry.fileIndex === this.#fileIndex &&
            entry.sourceIndex === currentSourceIndex &&
            entry.annotation.scope === "line"
          ) {
            this.#appendAnnotationCallout(
              lines,
              entry.annotation.note,
              contentWidth,
            );
          }
        }
        renderedRowBySource[currentSourceIndex] = lines.length;
        if (
          this.#focus === "diff" &&
          currentSourceIndex === this.#sourceIndex
        ) {
          renderedLine = this.theme.bg(
            "selectedBg",
            fit(
              staticBody.selectedSourceLines[currentSourceIndex] ?? "",
              contentWidth,
            ),
          );
        }
      }
      lines.push(truncateToWidth(renderedLine, contentWidth));
    }
    return { lines, renderedRowBySource };
  }

  #getStaticRenderedBody(file: ReviewDiffFile): RenderedDiffBody {
    const cached = this.#staticRenderedDiffBodies.get(file);
    if (cached) return cached;
    const lines: string[] = [];
    const renderedRowBySource: number[] = [];
    const selectedSourceLines: string[] = [];
    if (file.isBinary) {
      lines.push(
        this.theme.fg("dim", "Binary diff; no annotatable source rows"),
      );
    } else if (file.rows.length === 0) {
      lines.push(
        this.theme.fg("dim", "No diff hunks; this may be a rename-only change"),
      );
    } else {
      let sourceIndex = 0;
      for (const diffRow of file.rows) {
        if (!isSourceRow(diffRow)) {
          lines.push(
            this.theme.fg(
              diffRow.kind === "hunk" ? "accent" : "dim",
              replaceTabs(sanitizeText(diffRow.raw)),
            ),
          );
          continue;
        }
        renderedRowBySource[sourceIndex] = lines.length;
        const marker =
          diffRow.kind === "added"
            ? "+"
            : diffRow.kind === "removed"
              ? "-"
              : " ";
        const lineNumber =
          diffRow.kind === "removed"
            ? diffRow.oldLine
            : (diffRow.newLine ?? diffRow.oldLine);
        const suffix = `${marker}${String(lineNumber ?? "").padStart(4)} ${replaceTabs(sanitizeText(diffRow.content))}`;
        const color: DiffColor =
          diffRow.kind === "added"
            ? "toolDiffAdded"
            : diffRow.kind === "removed"
              ? "toolDiffRemoved"
              : "toolDiffContext";
        const coloredSuffix = this.theme.fg(color, suffix);
        const gutter = " ".repeat(SOURCE_SELECTION_GUTTER_WIDTH);
        selectedSourceLines[sourceIndex] = `${fit(
          `${this.theme.nav.cursor} `,
          SOURCE_SELECTION_GUTTER_WIDTH,
        )}${coloredSuffix}`;
        lines.push(`${gutter}${coloredSuffix}`);
        sourceIndex++;
      }
    }
    const body = { lines, renderedRowBySource, selectedSourceLines };
    this.#staticRenderedDiffBodies.set(file, body);
    return body;
  }

  #appendAnnotationCallout(
    lines: string[],
    note: string,
    width: number,
    label = "note",
  ): void {
    const gutter = this.theme.fg("warning", "▎ ");
    const labelText = this.theme.fg("dim", `${label}: `);
    const continuation = `${gutter}${" ".repeat(visibleWidth(labelText))}`;
    for (const [index, noteLine] of note.split(/\r?\n/).entries()) {
      const prefix = index === 0 ? `${gutter}${labelText}` : continuation;
      const available = Math.max(0, width - visibleWidth(prefix));
      const content = truncateToWidth(
        replaceTabs(sanitizeText(noteLine)),
        available,
        Ellipsis.Unicode,
      );
      lines.push(
        truncateToWidth(`${prefix}${this.theme.fg("accent", content)}`, width),
      );
    }
  }

  #ensureCursorVisible(renderedRowBySource: readonly number[]): void {
    const rowIndex = renderedRowBySource[this.#sourceIndex];
    if (rowIndex === undefined) return;
    const offset = this.#scrollView.getScrollOffset();
    if (rowIndex < offset) this.#scrollView.setScrollOffset(rowIndex);
    else if (rowIndex >= offset + this.#bodyHeight)
      this.#scrollView.setScrollOffset(rowIndex - this.#bodyHeight + 1);
  }

  #sidebarWidth(width: number): number {
    return Math.max(18, Math.min(32, Math.round(width * 0.28)));
  }

  #canShowSidebar(width: number): boolean {
    return (
      width >= SIDEBAR_MIN_TOTAL_WIDTH &&
      splitBodyWidth(width, this.#sidebarWidth(width)) >= SIDEBAR_MIN_BODY_WIDTH
    );
  }

  #renderSidebar(rows: number, width: number): string[] {
    const start = Math.max(
      0,
      Math.min(
        this.#fileIndex - Math.floor(rows / 2),
        Math.max(0, this.files.length - rows),
      ),
    );
    return Array.from({ length: rows }, (_, rowIndex) => {
      const index = start + rowIndex;
      const file = this.files[index];
      if (!file) return "";
      const selected = index === this.#fileIndex;
      const count = this.#annotationCount(index);
      const badge = `${this.theme.fg("dim", ` +${file.linesAdded}/-${file.linesRemoved}`)}${count ? this.theme.fg("warning", ` ✎${count}`) : ""}`;
      const available = Math.max(0, width - visibleWidth(badge) - 2);
      const label = truncateToWidth(
        sanitizeStatusText(displayFileLabel(file)),
        available,
        Ellipsis.Unicode,
      );
      const cursor = selected ? (this.#focus === "files" ? "› " : "▎ ") : "  ";
      const line = fit(`${cursor}${label}${badge}`, width);
      return selected && this.#focus === "files"
        ? this.theme.bg("selectedBg", this.theme.bold(line))
        : this.theme.fg(selected ? "accent" : "muted", line);
    });
  }

  #renderCurrentFileHeader(width: number): string {
    const file = this.#currentFile();
    if (!file) return this.theme.fg("dim", "No reviewable files");
    const count = this.#annotationCount(this.#fileIndex);
    const suffix = `  +${file.linesAdded}/-${file.linesRemoved}${count ? `  ✎${count}` : ""}`;
    return truncateToWidth(
      `${this.theme.bold(sanitizeStatusText(displayFileLabel(file)))}${this.theme.fg("dim", suffix)}`,
      width,
      Ellipsis.Unicode,
    );
  }

  #renderActions(): string[] {
    return ACTIONS.map((label, index) => {
      const disabled = index === 1 && this.#annotations.length === 0;
      const selected = index === this.#actionIndex;
      const cursor = selected ? `${this.theme.nav.cursor} ` : "  ";
      const text = disabled
        ? this.theme.fg("dim", label)
        : selected && this.#focus === "actions"
          ? this.theme.bold(this.theme.fg("accent", label))
          : this.theme.fg("text", label);
      return cursor + text;
    });
  }

  #renderAnnotationChooser(width: number): string[] {
    const chooser = this.#annotationChooser;
    if (!chooser) return [];
    const options = chooser.entries.map((index, optionIndex) => {
      const entry = this.#annotations[index];
      if (!entry) return "";
      const marker =
        optionIndex === chooser.selected ? `${this.theme.nav.cursor} ` : "  ";
      const location = this.#annotationLocation(entry);
      const note = sanitizeStatusText(
        entry.annotation.note.split(/\r?\n/, 1)[0] ?? "",
      );
      return fit(`${marker}${location} · ${note}`, width);
    });
    return [
      this.theme.fg(
        "dim",
        "Edit annotation · ↑↓ choose · enter edit · esc cancel",
      ),
      ...options,
    ];
  }

  #renderFooter(width: number): string[] {
    if (this.#annotationChooser) {
      return this.#renderAnnotationChooser(width);
    }
    if (this.#annotating) {
      const file = this.#currentFile();
      const source = this.#currentSourceRows()[this.#sourceIndex];
      const location =
        this.#annotationScope === "file"
          ? file
            ? `${displayFileLabel(file)} · file`
            : "file"
          : source && file
            ? `${displayFileLabel(file)} · ${source.oldLine ?? "-"}/${source.newLine ?? "-"}`
            : "diff row";
      const action =
        this.#editingAnnotationIndex === undefined
          ? this.#annotationScope === "file"
            ? "Annotate file"
            : "Annotate line"
          : "Edit annotation";
      const caption = truncateToWidth(
        `${this.theme.fg("dim", action)} ${this.theme.fg("accent", sanitizeStatusText(location))}`,
        width,
        Ellipsis.Unicode,
      );
      const hints = ["enter save", "shift+enter newline", "esc cancel"];
      hints.push("ctrl+g editor");
      if (
        this.#externalEditorLabel &&
        this.#externalEditorLabel.toLowerCase() !== "ctrl+g"
      )
        hints.push(`${this.#externalEditorLabel} editor`);
      this.#editor.focused = true;
      return [
        caption,
        ...this.#editor.render(width),
        this.theme.fg("dim", hints.join(" · ")),
      ];
    }
    const focusHelp =
      this.#focus === "files"
        ? "↑↓ file · ⏎ diff · a/A file note · e edit note"
        : this.#focus === "diff"
          ? "↑↓ line · ⇧ faster · pgup/pgdn · g/G ends · a line note · A file note · e edit note"
          : "↑↓ select · ⏎ confirm";
    return [
      this.theme.fg(
        "dim",
        `${focusHelp} · ctrl+o open file · [/] file · u undo · tab regions · esc cancel`,
      ),
    ];
  }

  render(width: number): readonly string[] {
    const terminalHeight = process.stdout.rows || 40;
    this.#sidebarShown = this.#canShowSidebar(width);
    if (!this.#sidebarShown && this.#focus === "files") this.#focus = "diff";
    const sidebarWidth = this.#sidebarShown ? this.#sidebarWidth(width) : 0;
    const innerWidth = Math.max(1, width - 4);
    const bodyWidth = this.#sidebarShown
      ? splitBodyWidth(width, sidebarWidth)
      : innerWidth;
    this.#editor.setMaxHeight(
      Math.max(1, Math.min(MAX_ANNOTATION_EDITOR_ROWS, terminalHeight - 12)),
    );
    this.#editor.focused = this.#annotating;
    const footer = this.#renderFooter(innerWidth);
    const chromeRows = 4 + 1 + ACTIONS.length + footer.length + 1;
    this.#bodyHeight = Math.max(MIN_BODY_ROWS, terminalHeight - chromeRows);
    const renderedBody = this.#renderBody(bodyWidth);
    this.#scrollView.setLines(renderedBody.lines);
    this.#scrollView.setHeight(this.#bodyHeight);
    this.#ensureCursorVisible(renderedBody.renderedRowBySource);
    const body = this.#scrollView.render(bodyWidth);
    const output: string[] = [];
    if (this.#sidebarShown) {
      const sidebar = this.#renderSidebar(this.#bodyHeight + 1, sidebarWidth);
      output.push(
        topBorderSplit(this.theme, width, OVERLAY_TITLE, sidebarWidth),
      );
      output.push(
        splitRow(
          this.theme,
          sidebar[0] ?? "",
          this.#renderCurrentFileHeader(bodyWidth),
          width,
          sidebarWidth,
        ),
      );
      for (let index = 0; index < this.#bodyHeight; index++) {
        output.push(
          splitRow(
            this.theme,
            sidebar[index + 1] ?? "",
            body[index] ?? "",
            width,
            sidebarWidth,
          ),
        );
      }
      output.push(dividerSplit(this.theme, width, sidebarWidth));
    } else {
      output.push(topBorder(this.theme, width, OVERLAY_TITLE));
      output.push(
        row(this.theme, this.#renderCurrentFileHeader(innerWidth), width),
      );
      for (const bodyLine of body)
        output.push(row(this.theme, bodyLine, width));
      output.push(divider(this.theme, width));
    }
    output.push(
      row(
        this.theme,
        this.theme.bold(this.theme.fg("accent", sanitizeStatusText(this.mode))),
        width,
      ),
    );
    for (const action of this.#renderActions())
      output.push(row(this.theme, action, width));
    output.push(divider(this.theme, width));
    for (const footerLine of footer)
      output.push(row(this.theme, footerLine, width));
    output.push(bottomBorder(this.theme, width));
    return output;
  }
}
