import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { acquireClipboardText } from "./clipboard";
import { showCodeReviewOverlay, showTextReviewOverlay } from "./fullscreen";
import {
  buildHeadlessReviewPrompt,
  buildReviewPrompt,
  formatCodeReviewAnnotations,
} from "./prompt";
import {
  buildTextReviewPrompt,
  normalizeTextReviewContextSummary,
  shouldSummarizeTextReviewSource,
} from "./text-review";
import { generateTextReviewContextSummary } from "./text-summary";
import {
  createClipboardTextReviewSource,
  getLatestAssistantReply,
  selectSessionTextReviewSource,
  selectAnnotationSourceKind,
  type AnnotationSourceKind,
} from "./text-source";
import {
  resolveLocalReviewTarget,
  selectLocalReviewKind,
} from "./review-target";
import type { ReviewExecutionFacade, ReviewTargetUI } from "./review-target";
import type {
  CodeReviewOverlayResult,
  LocalReviewKind,
  ResolvedReviewTarget,
} from "./types";

import type { TextReviewSource } from "./text-types";
export interface CodeReviewDependencies {
  selectLocalReviewKind(
    ui: Pick<ReviewTargetUI, "select">,
  ): Promise<LocalReviewKind | undefined>;
  resolveLocalReviewTarget(
    kind: LocalReviewKind,
    execution: ReviewExecutionFacade,
    cwd: string,
    ui: ReviewTargetUI,
  ): Promise<ResolvedReviewTarget | undefined>;
  showCodeReviewOverlay(
    ctx: ExtensionCommandContext,
    target: ResolvedReviewTarget,
  ): Promise<CodeReviewOverlayResult | undefined>;
}

export const defaultCodeReviewDependencies: CodeReviewDependencies = {
  selectLocalReviewKind,
  resolveLocalReviewTarget,
  showCodeReviewOverlay,
};

export interface AnnotateDependencies {
  runCodeReviewCommand: typeof runCodeReviewCommand;
  selectAnnotationSourceKind: typeof selectAnnotationSourceKind;
  getLatestAssistantReply: typeof getLatestAssistantReply;
  selectSessionTextReviewSource: typeof selectSessionTextReviewSource;
  acquireClipboardText: typeof acquireClipboardText;
  showTextReviewOverlay: typeof showTextReviewOverlay;
  generateTextReviewContextSummary: typeof generateTextReviewContextSummary;
}

export const defaultAnnotateDependencies: AnnotateDependencies = {
  runCodeReviewCommand,
  selectAnnotationSourceKind,
  getLatestAssistantReply,
  selectSessionTextReviewSource,
  acquireClipboardText,
  showTextReviewOverlay,
  generateTextReviewContextSummary,
};

function createReviewTargetUI(ctx: ExtensionCommandContext): ReviewTargetUI {
  return {
    select: (title, options) => ctx.ui.select(title, options),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}

/** Runs the local review command with optional dependencies for isolated command tests. */
export async function runCodeReviewCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: Partial<CodeReviewDependencies> = {},
): Promise<void> {
  const focus = args.trim() || undefined;
  if (!ctx.hasUI) {
    pi.sendUserMessage(buildHeadlessReviewPrompt(focus));
    return;
  }

  const selectReviewKind =
    dependencies.selectLocalReviewKind ??
    defaultCodeReviewDependencies.selectLocalReviewKind;
  const resolveReviewTarget =
    dependencies.resolveLocalReviewTarget ??
    defaultCodeReviewDependencies.resolveLocalReviewTarget;
  const showReviewOverlay =
    dependencies.showCodeReviewOverlay ??
    defaultCodeReviewDependencies.showCodeReviewOverlay;
  const ui = createReviewTargetUI(ctx);
  const kind = await selectReviewKind(ui);
  if (!kind) return;

  const target = await resolveReviewTarget(kind, pi, ctx.cwd, ui);
  if (!target) return;
  if (!target.rawDiff.trim()) {
    ctx.ui.notify(target.emptyMessage, "warning");
    return;
  }
  if (target.snapshot.files.length === 0) {
    ctx.ui.notify(target.filteredMessage ?? target.emptyMessage, "warning");
    return;
  }

  const result = await showReviewOverlay(ctx, target);
  if (!result) return;
  if (result.action === "paste") {
    const annotations = formatCodeReviewAnnotations(result.annotations, {
      forReviewer: false,
    });
    if (annotations) ctx.ui.pasteToEditor(annotations);
    return;
  }

  const annotations = formatCodeReviewAnnotations(result.annotations, {
    forReviewer: true,
    supplementalInstructions: focus,
  });
  pi.sendUserMessage(buildReviewPrompt(target, annotations));
}

const ANNOTATE_USAGE =
  "Usage: /annotate [code-review [focus]|last|session|clipboard]";

function parseCodeReviewFocus(args: string): string | undefined {
  const match = args.trim().match(/^code-review(?:\s+([\s\S]*))?$/);
  return match ? (match[1]?.trim() ?? "") : undefined;
}

function parseAnnotationSourceKind(
  args: string,
): AnnotationSourceKind | undefined {
  const trimmed = args.trim();
  if (trimmed === "last" || trimmed === "session" || trimmed === "clipboard") {
    return trimmed;
  }
  return undefined;
}

/** Run `/annotate` against a frozen text source, never submitting empty notes. */
export async function runAnnotateCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: Partial<AnnotateDependencies> = {},
): Promise<void> {
  const sourceDependencies = {
    ...defaultAnnotateDependencies,
    ...dependencies,
  };
  const codeReviewFocus = parseCodeReviewFocus(args);
  if (codeReviewFocus !== undefined) {
    await sourceDependencies.runCodeReviewCommand(pi, codeReviewFocus, ctx);
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Text annotation requires the interactive UI. Re-run /annotate from an interactive session; no message was sent.",
      "error",
    );
    return;
  }

  const trimmed = args.trim();
  let kind: AnnotationSourceKind | undefined;
  if (trimmed.length === 0) {
    kind = await sourceDependencies.selectAnnotationSourceKind(ctx.ui);
  } else {
    kind = parseAnnotationSourceKind(trimmed);
    if (!kind) {
      ctx.ui.notify(ANNOTATE_USAGE, "error");
      return;
    }
  }
  if (!kind) return;

  if (kind === "code-review") {
    await sourceDependencies.runCodeReviewCommand(pi, "", ctx);
    return;
  }

  let source: TextReviewSource | undefined;
  switch (kind) {
    case "last":
      source = sourceDependencies.getLatestAssistantReply(ctx);
      if (!source) {
        ctx.ui.notify(
          "No non-empty assistant reply is available on the active session branch.",
          "warning",
        );
      }
      break;
    case "session":
      source = await sourceDependencies.selectSessionTextReviewSource(ctx);
      break;
    case "clipboard": {
      const text = await sourceDependencies.acquireClipboardText(ctx);
      if (text !== undefined) {
        source = createClipboardTextReviewSource(ctx, text);
      }
      break;
    }
  }
  if (!source) return;

  const result = await sourceDependencies.showTextReviewOverlay(ctx, source);
  if (!result) return;
  if (result.annotations.length === 0) {
    ctx.ui.notify(
      "Add at least one annotation before pasting text feedback.",
      "warning",
    );
    return;
  }

  let contextSummary: string | undefined;
  if (shouldSummarizeTextReviewSource(source)) {
    ctx.ui.setStatus(
      "annotate-summary",
      "Summarizing annotation source locally…",
    );
    try {
      const generatedSummary =
        await sourceDependencies.generateTextReviewContextSummary(source.text);
      contextSummary =
        typeof generatedSummary === "string"
          ? normalizeTextReviewContextSummary(generatedSummary) || undefined
          : undefined;
      if (!contextSummary) {
        ctx.ui.notify(
          "Local summary unavailable; including the full source verbatim, which exceeds the normal 1000-character context budget.",
          "warning",
        );
      }
    } catch {
      ctx.ui.notify(
        "Local summary failed; including the full source verbatim, which exceeds the normal 1000-character context budget.",
        "warning",
      );
    } finally {
      ctx.ui.setStatus("annotate-summary", undefined);
    }
  }
  const prompt = buildTextReviewPrompt(
    source,
    result.annotations,
    contextSummary,
  );
  if (!prompt) return;
  ctx.ui.pasteToEditor(prompt);
}

function annotateArgumentCompletions(argumentPrefix: string) {
  if (argumentPrefix.includes(" ")) return null;
  const prefix = argumentPrefix.trim().toLowerCase();
  const choices = [
    {
      value: "code-review",
      label: "code-review",
      description: "Annotate a local diff before review",
    },
    {
      value: "last",
      label: "last",
      description: "Latest assistant reply",
    },
    {
      value: "session",
      label: "session",
      description: "Choose a session message or block",
    },
    {
      value: "clipboard",
      label: "clipboard",
      description: "Read text from the clipboard",
    },
  ];
  const filtered = prefix
    ? choices.filter((choice) => choice.label.startsWith(prefix))
    : choices;
  return filtered.length > 0 ? filtered : null;
}

export default function registerAnnotateExtension(pi: ExtensionAPI): void {
  pi.setLabel("Annotate");
  pi.registerCommand("annotate", {
    description:
      "Annotate a diff or text from the latest reply, session, or clipboard [code-review [focus]|last|session|clipboard]",
    getArgumentCompletions: annotateArgumentCompletions,
    handler: (args, ctx) => runAnnotateCommand(pi, args, ctx),
  });
}
