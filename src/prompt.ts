import { prompt } from "@oh-my-pi/pi-utils";
import { getRecommendedReviewAgentCount, getReviewDiffPreview } from "./diff";
import annotationsTemplate from "./prompts/annotations.md" with { type: "text" };
import headlessReviewTemplate from "./prompts/headless-review.md" with { type: "text" };
import reviewRequestTemplate from "./prompts/review-request.md" with { type: "text" };
import type {
  CodeReviewAnnotation,
  ResolvedReviewTarget,
  ReviewDiffFile,
} from "./types";

const LARGE_DIFF_CHARACTER_LIMIT = 50_000;
const LARGE_DIFF_FILE_LIMIT = 20;
const PREVIEW_LINES_PER_FILE = 80;

export interface FormatCodeReviewAnnotationsOptions {
  forReviewer: boolean;
  supplementalInstructions?: string;
}

interface RenderedAnnotation extends CodeReviewAnnotation {
  pathLabel: string;
  lineLabel: string;
}

interface ReviewPromptFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  ext: string;
  hunksPreview: string;
}

function formatPathLabel(annotation: CodeReviewAnnotation): string {
  return annotation.occurrence > 1
    ? `${annotation.path} (${annotation.occurrence})`
    : annotation.path;
}

function formatLineLabel(annotation: CodeReviewAnnotation): string {
  if (annotation.oldLine !== undefined && annotation.newLine !== undefined) {
    return `old ${annotation.oldLine}, new ${annotation.newLine}`;
  }
  if (annotation.newLine !== undefined) return `new ${annotation.newLine}`;
  if (annotation.oldLine !== undefined) return `old ${annotation.oldLine}`;
  return "hunk";
}

function getFileExtension(file: ReviewDiffFile): string {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "other";
}

function renderReviewPromptFile(file: ReviewDiffFile): ReviewPromptFile {
  return {
    path: file.path,
    linesAdded: file.linesAdded,
    linesRemoved: file.linesRemoved,
    ext: getFileExtension(file),
    hunksPreview: getReviewDiffPreview(file.rawDiff, PREVIEW_LINES_PER_FILE),
  };
}

/** Formats exact source annotations for a reviewer prompt or editor paste. */
export function formatCodeReviewAnnotations(
  annotations: readonly CodeReviewAnnotation[],
  options: FormatCodeReviewAnnotationsOptions,
): string | undefined {
  const supplementalInstructions = options.supplementalInstructions?.trim();
  if (annotations.length === 0 && !supplementalInstructions) return undefined;

  const renderedAnnotations: RenderedAnnotation[] = annotations.map(
    (annotation) => ({
      ...annotation,
      pathLabel: formatPathLabel(annotation),
      lineLabel: formatLineLabel(annotation),
    }),
  );
  return prompt.render(annotationsTemplate, {
    forReviewer: options.forReviewer,
    annotations: renderedAnnotations,
    supplementalInstructions,
  });
}

/** Renders a review request from one frozen target snapshot. */
export function buildReviewPrompt(
  target: ResolvedReviewTarget,
  additionalInstructions?: string,
): string {
  const files = target.snapshot.files.map(renderReviewPromptFile);
  const skipDiff =
    target.rawDiff.length > LARGE_DIFF_CHARACTER_LIMIT ||
    files.length > LARGE_DIFF_FILE_LIMIT;
  const agentCount = getRecommendedReviewAgentCount(target.snapshot);
  return prompt.render(reviewRequestTemplate, {
    mode: target.mode,
    files,
    excluded: target.snapshot.excluded,
    totalAdded: target.snapshot.totalAdded,
    totalRemoved: target.snapshot.totalRemoved,
    agentCount,
    multiAgent: agentCount > 1,
    skipDiff,
    isJj: target.mode.startsWith("JJ "),
    linesPerFile: PREVIEW_LINES_PER_FILE,
    rawDiff: target.rawDiff,
    diffInstruction: target.diffInstruction,
    contextInstruction: target.contextInstruction,
    additionalInstructions: additionalInstructions?.trim(),
  });
}

/** Renders the static fallback used when no interactive UI is available. */
export function buildHeadlessReviewPrompt(focus?: string): string {
  return prompt.render(headlessReviewTemplate, { focus: focus?.trim() });
}
