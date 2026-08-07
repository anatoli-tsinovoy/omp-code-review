import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, OverlayHandle } from "@oh-my-pi/pi-tui";
import { CodeReviewOverlay } from "./overlay";
import type { CodeReviewOverlayResult, ResolvedReviewTarget } from "./types";

const EMPTY_ROWS: readonly string[] = [];

/** Mounts the review UI as a raw fullscreen TUI overlay owned by a zero-row host. */
export async function showCodeReviewOverlay(
  ctx: ExtensionCommandContext,
  target: ResolvedReviewTarget,
): Promise<CodeReviewOverlayResult | undefined> {
  return ctx.ui.custom<CodeReviewOverlayResult | undefined>(
    (tui, theme, keybindings, done) => {
      let completed = false;
      let disposed = false;
      let overlayHandle: OverlayHandle | undefined;
      let overlayComponent: Component | undefined;

      const disposeOverlay = (): void => {
        if (disposed) return;
        disposed = true;
        overlayHandle?.hide();
        overlayComponent?.dispose?.();
      };
      const complete = (result: CodeReviewOverlayResult | undefined): void => {
        if (completed) return;
        completed = true;
        disposeOverlay();
        done(result);
      };

      const overlay = new CodeReviewOverlay(
        tui,
        theme,
        keybindings,
        target.snapshot.files,
        target.mode,
        {
          onComplete: complete,
          onWarning: (message) => ctx.ui.notify(message, "warning"),
        },
      );
      overlayComponent = overlay;
      overlayHandle = tui.showOverlay(overlay, {
        width: "100%",
        maxHeight: "100%",
        margin: 0,
        fullscreen: true,
        mouseTracking: false,
      });

      return {
        render: (_width: number): readonly string[] => EMPTY_ROWS,
        dispose: disposeOverlay,
      };
    },
  );
}
