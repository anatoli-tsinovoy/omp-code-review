import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { showCodeReviewOverlay } from "./fullscreen";
import {
  buildHeadlessReviewPrompt,
  buildReviewPrompt,
  formatCodeReviewAnnotations,
} from "./prompt";
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

export default function registerCodeReviewExtension(pi: ExtensionAPI): void {
  pi.setLabel("Code Review");
  pi.registerCommand("code-review", {
    description: "Annotate a diff before review",
    handler: (args, ctx) => runCodeReviewCommand(pi, args, ctx),
  });
}
