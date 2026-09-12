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
import { buildTextReviewPrompt } from "./text-review";
import {
  createClipboardTextReviewSource,
  getLatestAssistantReply,
  selectSessionTextReviewSource,
  selectTextReviewSourceKind,
  type TextReviewSourceKind,
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

export interface TextReviewDependencies {
  selectTextReviewSourceKind: typeof selectTextReviewSourceKind;
  getLatestAssistantReply: typeof getLatestAssistantReply;
  selectSessionTextReviewSource: typeof selectSessionTextReviewSource;
  acquireClipboardText: typeof acquireClipboardText;
  showTextReviewOverlay: typeof showTextReviewOverlay;
}

export const defaultTextReviewDependencies: TextReviewDependencies = {
  selectTextReviewSourceKind,
  getLatestAssistantReply,
  selectSessionTextReviewSource,
  acquireClipboardText,
  showTextReviewOverlay,
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

const ANNOTATE_USAGE = "Usage: /annotate [last|session|clipboard]";

function parseTextReviewSourceKind(
  args: string,
): TextReviewSourceKind | undefined {
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
  dependencies: Partial<TextReviewDependencies> = {},
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Text annotation requires the interactive UI. Re-run /annotate from an interactive session; no message was sent.",
      "error",
    );
    return;
  }

  const sourceDependencies = {
    ...defaultTextReviewDependencies,
    ...dependencies,
  };
  const trimmed = args.trim();
  let kind: TextReviewSourceKind | undefined;
  if (trimmed.length === 0) {
    kind = await sourceDependencies.selectTextReviewSourceKind(ctx.ui);
  } else {
    kind = parseTextReviewSourceKind(trimmed);
    if (!kind) {
      ctx.ui.notify(ANNOTATE_USAGE, "error");
      return;
    }
  }
  if (!kind) return;

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
      "Add at least one annotation before submitting or pasting text feedback.",
      "warning",
    );
    return;
  }

  const prompt = buildTextReviewPrompt(source, result.annotations);
  if (!prompt) return;
  if (result.action === "paste") {
    ctx.ui.pasteToEditor(prompt);
    return;
  }
  pi.sendUserMessage(prompt);
}

function textReviewArgumentCompletions(argumentPrefix: string) {
  if (argumentPrefix.includes(" ")) return null;
  const prefix = argumentPrefix.trim().toLowerCase();
  const choices = [
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

export default function registerCodeReviewExtension(pi: ExtensionAPI): void {
  pi.setLabel("Code Review");
  pi.registerCommand("code-review", {
    description: "Annotate a diff before review",
    handler: (args, ctx) => runCodeReviewCommand(pi, args, ctx),
  });
  pi.registerCommand("annotate", {
    description:
      "Annotate text from the latest reply, session, or clipboard [last|session|clipboard]",
    getArgumentCompletions: textReviewArgumentCompletions,
    handler: (args, ctx) => runAnnotateCommand(pi, args, ctx),
  });
}
