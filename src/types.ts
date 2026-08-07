export type LocalReviewKind = "base-branch" | "uncommitted" | "commit";

export type ReviewSourceRowKind = "context" | "added" | "removed";

export interface ReviewSourceRow {
  kind: ReviewSourceRowKind;
  raw: string;
  content: string;
  oldLine?: number;
  newLine?: number;
  hunkHeader: string;
}

export type ReviewDiffRow =
  | ReviewSourceRow
  | { kind: "hunk"; raw: string; hunkHeader: string }
  | { kind: "no-newline"; raw: string; hunkHeader: string };

export interface ReviewDiffFile {
  path: string;
  oldPath?: string;
  newPath?: string;
  occurrence: number;
  rawDiff: string;
  rows: ReviewDiffRow[];
  linesAdded: number;
  linesRemoved: number;
  isBinary: boolean;
}

export interface ExcludedReviewFile {
  path: string;
  reason: string;
}

export interface ReviewDiffSnapshot {
  files: ReviewDiffFile[];
  excluded: ExcludedReviewFile[];
  totalAdded: number;
  totalRemoved: number;
}

export interface ResolvedReviewTarget {
  kind: LocalReviewKind | "pr";
  mode: string;
  rawDiff: string;
  snapshot: ReviewDiffSnapshot;
  emptyMessage: string;
  filteredMessage?: string;
  diffInstruction?: string;
  contextInstruction?: string;
}

export interface CodeReviewAnnotation {
  path: string;
  oldPath?: string;
  newPath?: string;
  occurrence: number;
  hunkHeader: string;
  oldLine?: number;
  newLine?: number;
  rawLine: string;
  note: string;
}

export interface CodeReviewOverlayResult {
  action: "review" | "paste";
  annotations: CodeReviewAnnotation[];
}
