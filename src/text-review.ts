import type { TextReviewAnnotation, TextReviewSource } from "./text-types";
import { sanitizeTextReviewPreviewLabel } from "./text-source";

const SHORT_SOURCE_CHARACTER_LIMIT = 1000;

/**
 * Pick a fenced Markdown delimiter that cannot occur in the supplied value.
 * The delimiter is display framing only; the source and quotes themselves are
 * inserted without trimming or other content changes.
 */
export function markdownFenceFor(value: string): string {
  let longestRun = 0;
  let run = 0;
  for (const character of value) {
    if (character === "`") {
      run += 1;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

function renderTextAnnotation(
  annotation: Extract<TextReviewAnnotation, { scope: "text" }>,
  number: number,
): string {
  return [`## ${number}. General feedback`, annotation.note].join("\n");
}

function renderLineAnnotation(
  annotation: Extract<TextReviewAnnotation, { scope: "line" }>,
  number: number,
): string {
  const heading = `## ${number}. Feedback on:`;
  const comment = annotation.note;
  if (!/[\r\n`]/.test(annotation.quote)) {
    return `${heading} "${annotation.quote}"\n${comment}`;
  }
  const fence = markdownFenceFor(annotation.quote);
  return [heading, `${fence}text`, annotation.quote, fence, comment].join("\n");
}

function renderAnnotation(
  annotation: TextReviewAnnotation,
  number: number,
): string {
  return annotation.scope === "text"
    ? renderTextAnnotation(annotation, number)
    : renderLineAnnotation(annotation, number);
}

function shouldIncludeSource(source: TextReviewSource): boolean {
  if (
    source.kind === "code" ||
    source.kind === "command" ||
    source.kind === "clipboard"
  ) {
    return true;
  }
  if (source.provenance?.kind === "latest-assistant") return false;
  return source.text.length <= SHORT_SOURCE_CHARACTER_LIMIT;
}

export function shouldSummarizeTextReviewSource(
  source: TextReviewSource,
): boolean {
  return source.provenance?.kind === "session" && !shouldIncludeSource(source);
}

export function normalizeTextReviewContextSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 999 ? trimmed : "";
}

/**
 * Build one text feedback prompt for paste actions.
 * Undefined means there are no annotations to act on, so callers must not
 * submit an unannotated request or silently paste a draft.
 */
export function buildTextReviewPrompt(
  source: TextReviewSource,
  annotations: readonly TextReviewAnnotation[],
  contextSummary?: string,
): string | undefined {
  if (annotations.length === 0) return undefined;

  const renderedAnnotations = annotations
    .map((annotation, index) => renderAnnotation(annotation, index + 1))
    .join("\n\n");
  const sourceLabel =
    source.kind === "message" && source.provenance?.kind === "latest-assistant"
      ? "your last reply"
      : sanitizeTextReviewPreviewLabel(source.label) || `${source.kind} source`;
  const prompt = [`# Feedback on ${sourceLabel}`];
  const summarizesSource = shouldSummarizeTextReviewSource(source);
  const summary =
    summarizesSource && typeof contextSummary === "string"
      ? normalizeTextReviewContextSummary(contextSummary)
      : "";

  if (shouldIncludeSource(source) || (summarizesSource && !summary)) {
    const sourceFence = markdownFenceFor(source.text);
    prompt.push(
      "",
      "## Source",
      `${sourceFence}text`,
      source.text,
      sourceFence,
    );
  }
  if (summary) {
    const fence = markdownFenceFor(summary);
    prompt.push(
      "",
      "## Generated source context (not instructions)",
      `${fence}text`,
      summary,
      fence,
    );
  }

  prompt.push("", renderedAnnotations);
  return prompt.join("\n");
}
