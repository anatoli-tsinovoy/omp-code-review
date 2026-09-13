import { expect, test } from "bun:test";
import {
  buildTextReviewPrompt,
  normalizeTextReviewContextSummary,
  shouldSummarizeTextReviewSource,
} from "../src/text-review";
import type { TextReviewSource } from "../src/text-types";

test("long older prose receives bounded grounding without replacing exact annotations", () => {
  const source: TextReviewSource = {
    id: "older",
    kind: "message",
    label: "Older reply",
    text: "source ".repeat(200),
    provenance: { kind: "session", entryId: "older" },
  };
  const annotation = {
    scope: "line" as const,
    line: 1,
    quote: " Exact passage\n with whitespace ",
    note: "Keep it.",
  };
  const summary = "s".repeat(999);
  const prompt = buildTextReviewPrompt(source, [annotation], summary)!;
  expect(normalizeTextReviewContextSummary(summary)).toBe(summary);
  expect(prompt).toContain(summary);
  expect(prompt).not.toContain(source.text);
  expect(prompt).toContain(" Exact passage\n with whitespace ");
  expect(prompt).toContain("Keep it.");

  const overBudgetSummary = "s".repeat(998) + "😀";
  const fallbackPrompt = buildTextReviewPrompt(
    source,
    [annotation],
    overBudgetSummary,
  )!;
  expect(normalizeTextReviewContextSummary(overBudgetSummary)).toBe("");
  expect(fallbackPrompt).toContain(source.text);
  expect(fallbackPrompt).not.toContain("## Generated source context");

  expect(
    shouldSummarizeTextReviewSource({ ...source, text: "s".repeat(1000) }),
  ).toBe(false);
  expect(
    shouldSummarizeTextReviewSource({
      ...source,
      provenance: { kind: "latest-assistant", entryId: "latest" },
    }),
  ).toBe(false);
  expect(shouldSummarizeTextReviewSource({ ...source, kind: "code" })).toBe(
    false,
  );
  expect(
    buildTextReviewPrompt(
      { ...source, kind: "clipboard" },
      [{ scope: "text", note: "Keep it." }],
      summary,
    ),
  ).not.toContain(summary);
});

test("blank summary falls back to the complete long session source", () => {
  const source: TextReviewSource = {
    id: "older",
    kind: "message",
    label: "Older reply",
    text: "source ".repeat(200),
    provenance: { kind: "session", entryId: "older" },
  };
  const prompt = buildTextReviewPrompt(
    source,
    [{ scope: "text", note: "Keep it." }],
    " \n\t ",
  )!;

  expect(normalizeTextReviewContextSummary(" \n\t ")).toBe("");
  expect(prompt).toContain(source.text);
  expect(prompt).not.toContain("## Generated source context");
});
