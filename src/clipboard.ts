import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { readTextFromClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";

const PASTE_TEXT_TITLE = "Paste text to annotate";

function isSshSession(): boolean {
  const env = process.env;
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

/**
 * Acquire annotation text without confusing the OMP host clipboard with the
 * terminal user's clipboard when the session is remote.
 *
 * Native clipboard reads are intentionally local-only. Over SSH, the native
 * helper reads the remote OS clipboard (if one exists), while the terminal
 * paste dialog can receive text forwarded by the user's terminal. The dialog
 * is also the fallback when a local native read is unavailable or empty.
 */
export async function acquireClipboardText(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const overSsh = isSshSession();

  if (!overSsh) {
    try {
      const text = await readTextFromClipboard();
      if (text.trim().length > 0) return text;
      ctx.ui.notify(
        "Clipboard has no text; paste text to annotate instead.",
        "warning",
      );
    } catch {
      ctx.ui.notify(
        "Unable to read the local clipboard automatically; paste text to annotate instead.",
        "warning",
      );
    }
  } else {
    ctx.ui.notify(
      "Clipboard auto-read is disabled over SSH to avoid reading the remote clipboard; paste text to annotate instead.",
      "warning",
    );
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(
      "An interactive session is required to paste text to annotate.",
      "warning",
    );
    return undefined;
  }

  const pasted = await ctx.ui.editor(PASTE_TEXT_TITLE);
  if (pasted === undefined) return undefined;
  if (pasted.trim().length === 0) {
    ctx.ui.notify("No text was pasted to annotate.", "warning");
    return undefined;
  }
  return pasted;
}
