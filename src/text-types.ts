export interface TextReviewSource {
  /** Identifies the frozen source within this annotation run. */
  id: string;
  kind: "message" | "code" | "quote" | "command" | "clipboard";
  label: string;
  text: string;
  sessionId?: string;
}

export type TextReviewAnnotation =
  | { scope: "text"; note: string }
  | { scope: "line"; line: number; quote: string; note: string };

export interface TextReviewOverlayResult {
  action: "review" | "paste";
  annotations: TextReviewAnnotation[];
}
