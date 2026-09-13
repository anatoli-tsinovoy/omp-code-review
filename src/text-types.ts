export type TextReviewSourceProvenance =
  | { kind: "latest-assistant"; entryId: string }
  | { kind: "session"; entryId: string }
  | { kind: "clipboard" };

export interface TextReviewSource {
  /** Identifies the source within this annotation run. */
  id: string;
  kind: "message" | "code" | "quote" | "command" | "clipboard";
  label: string;
  text: string;
  /** Identifies the active session entry that supplied this source, when applicable. */
  provenance?: TextReviewSourceProvenance;
  sessionId?: string;
}

export type TextReviewAnnotation =
  | { scope: "text"; note: string }
  | { scope: "line"; line: number; quote: string; note: string };

export interface TextReviewOverlayResult {
  action: "paste";
  annotations: TextReviewAnnotation[];
}
