import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
  extractBlocks,
  extractLastCommand,
  type LastCommand,
  type MessageBlock,
} from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";
import type {
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";

import type { TextReviewSource } from "./text-types";

export type TextReviewSourceKind = "last" | "session" | "clipboard";

export const TEXT_REVIEW_SOURCE_CHOICES = [
  {
    kind: "last",
    label: "Latest assistant reply",
    description: "Annotate the latest non-empty assistant reply on this branch",
  },
  {
    kind: "session",
    label: "Session message or block",
    description:
      "Choose a message, code block, quote, or command from this session",
  },
  {
    kind: "clipboard",
    label: "Clipboard text",
    description: "Read text from the system clipboard",
  },
] as const satisfies readonly {
  kind: TextReviewSourceKind;
  label: string;
  description: string;
}[];

type TextReviewSourceUI = Pick<ExtensionUIContext, "select" | "notify">;

/**
 * Return a one-line, terminal-safe preview for a selector control.
 *
 * The preview is display-only. It is never used as the source text, which must
 * remain byte-for-byte equal to the selected copy target content.
 */
export function sanitizeTextReviewPreviewLabel(
  value: string,
  maxLength = 96,
): string {
  const withoutAnsi = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const oneLine = withoutAnsi
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** Show the top-level source picker used by `/annotate` without arguments. */
export async function selectTextReviewSourceKind(
  ui: Pick<TextReviewSourceUI, "select">,
): Promise<TextReviewSourceKind | undefined> {
  const selected = await ui.select(
    "Select text to annotate",
    TEXT_REVIEW_SOURCE_CHOICES.map((choice) => choice.label),
  );
  return TEXT_REVIEW_SOURCE_CHOICES.find((choice) => choice.label === selected)
    ?.kind;
}

function getSessionId(ctx: ExtensionCommandContext): string {
  return ctx.sessionManager.getSessionId();
}

function assistantText(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;

  // Match /copy's assistantVisibleText implementation: concatenate visible
  // text blocks directly, then use trim only as the emptiness check.
  let text = "";
  for (const content of message.content) {
    if (content.type === "text") text += content.text;
  }
  return text.trim() ? text : undefined;
}

/**
 * Find the latest non-empty assistant reply on the active branch.
 * Thinking, tool calls, tool results, and all sibling branches are excluded.
 */
export function getLatestAssistantReply(
  ctx: ExtensionCommandContext,
): TextReviewSource | undefined {
  const branch = ctx.sessionManager.getBranch();

  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const text = assistantText(entry.message);
    if (!text) continue;

    return {
      id: `latest:${entry.id}`,
      kind: "message",
      label: "Latest assistant reply",
      text,
      sessionId: getSessionId(ctx),
    };
  }

  return undefined;
}
export interface TextReviewCopyTarget {
  id: string;
  label: string;
  hint?: string;
  preview: string;
  language?: string;
  content?: string;
  children?: TextReviewCopyTarget[];
}

function textLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/\s+/g, " ");
  }
  return text.trim().replace(/\s+/g, " ");
}

function commandLabel(command: LastCommand): string {
  return command.kind === "bash" ? "Bash command" : "Eval code";
}

function childTargetForBlock(
  parentId: string,
  block: MessageBlock,
  blockIndex: number,
): TextReviewCopyTarget {
  if (block.kind === "code") {
    const lines = textLines(block.code);
    return {
      id: `${parentId}:code:${blockIndex}`,
      label: block.lang ? `${block.lang} code` : "Code block",
      hint: `${lines} line${lines === 1 ? "" : "s"}`,
      preview: block.code,
      language: block.lang || undefined,
      content: block.code,
    };
  }

  const lines = textLines(block.text);
  return {
    id: `${parentId}:quote:${blockIndex}`,
    label: "Quote block",
    hint: `${lines} line${lines === 1 ? "" : "s"}`,
    preview: block.text,
    content: block.text,
  };
}

function commandTarget(
  parentId: string,
  command: LastCommand,
  commandIndex: number,
): TextReviewCopyTarget {
  return {
    id: `cmd:${parentId}:${commandIndex}`,
    label: commandLabel(command),
    hint: command.kind,
    preview: command.code,
    language: command.language,
    content: command.code,
  };
}

function messageTarget(
  id: string,
  role: "user" | "assistant",
  text: string | undefined,
  message: AgentMessage,
): TextReviewCopyTarget | undefined {
  const children: TextReviewCopyTarget[] = [];
  const codeBlocks: TextReviewCopyTarget[] = [];
  const quoteBlocks: TextReviewCopyTarget[] = [];

  if (text) {
    let codeIndex = 0;
    let quoteIndex = 0;
    for (const block of extractBlocks(text)) {
      const blockIndex = block.kind === "code" ? codeIndex++ : quoteIndex++;
      const target = childTargetForBlock(id, block, blockIndex);
      children.push(target);
      if (block.kind === "code") codeBlocks.push(target);
      else quoteBlocks.push(target);
    }
  }

  // 18.1.18 exposes command extraction as a public helper, but not the
  // per-tool-call parser. Ask the helper about each tool call so every
  // recognized command remains available in source order.
  if (role === "assistant" && message.role === "assistant") {
    let commandIndex = 0;
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      const command = extractLastCommand([
        {
          ...message,
          content: [content],
        },
      ]);
      if (!command) continue;
      children.push(commandTarget(id, command, commandIndex));
      commandIndex += 1;
    }
  }

  if (codeBlocks.length > 1) {
    const combined = codeBlocks
      .map((block) => block.content ?? "")
      .join("\n\n");
    const lines = textLines(combined);
    children.push({
      id: `${id}:all`,
      label: `All ${codeBlocks.length} code blocks`,
      hint: `${lines} line${lines === 1 ? "" : "s"}`,
      preview: combined,
      content: combined,
    });
  }
  if (quoteBlocks.length > 1) {
    const combined = quoteBlocks
      .map((block) => block.content ?? "")
      .join("\n\n");
    const lines = textLines(combined);
    children.push({
      id: `${id}:all-quotes`,
      label: `All ${quoteBlocks.length} quote blocks`,
      hint: `${lines} line${lines === 1 ? "" : "s"}`,
      preview: combined,
      content: combined,
    });
  }

  if (!text && children.length === 0) return undefined;

  // `/copy` trims assistant prose for its whole-message target, while user
  // messages preserve the raw text blocks.
  const content = role === "assistant" ? text?.trim() : text;
  const lines = content === undefined ? 0 : textLines(content);
  return {
    id,
    label:
      firstLine(content ?? "") ||
      `${role === "assistant" ? "Assistant" : "User"} message`,
    hint:
      content === undefined
        ? undefined
        : `${lines} line${lines === 1 ? "" : "s"}`,
    preview: content ?? children[0]?.preview ?? "",
    content,
    children: children.length > 0 ? children : undefined,
  };
}

function messageText(message: AgentMessage): string | undefined {
  if (message.role === "assistant") return assistantText(message);
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  const parts = message.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content.type === "text",
    )
    .map((content) => content.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Build the current `/copy`-compatible text tree from the active branch. */
export function buildSessionTextReviewTargets(
  ctx: ExtensionCommandContext,
): TextReviewCopyTarget[] {
  const targets: TextReviewCopyTarget[] = [];
  const branch = ctx.sessionManager.getBranch();

  // `/copy` presents recent transcript material first. The entry id remains
  // part of every target id, so selecting a target is stable if labels collide.
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const target = messageTarget(
      `msg:${entry.id}`,
      message.role,
      messageText(message),
      message,
    );
    if (target) targets.push(target);
  }
  return targets;
}

function targetKind(target: TextReviewCopyTarget): TextReviewSource["kind"] {
  if (target.id.startsWith("cmd:")) return "command";
  if (target.id.includes(":code:") || target.id.endsWith(":all")) return "code";
  if (target.id.includes(":quote:") || target.id.endsWith(":all-quotes")) {
    return "quote";
  }
  return "message";
}

function targetTypeLabel(target: TextReviewCopyTarget): string {
  if (target.id.startsWith("cmd:")) return "Command";
  if (target.id.includes(":code:")) return "Code block";
  if (target.id.endsWith(":all")) return "All code blocks";
  if (target.id.includes(":quote:")) return "Quote block";
  if (target.id.endsWith(":all-quotes")) return "All quote blocks";
  return "Message";
}

/** Build an unambiguous, selector-safe label for a copy target. */
export function formatTextReviewTargetLabel(
  target: TextReviewCopyTarget,
  wholeMessage = false,
): string {
  const preview = sanitizeTextReviewPreviewLabel(
    target.label || target.preview,
  );
  const suffix = wholeMessage ? " (whole text)" : "";
  return `${targetTypeLabel(target)} [${target.id}]${suffix}: ${preview || "(empty)"}`;
}

interface TargetChoice {
  label: string;
  target: TextReviewCopyTarget;
  whole: boolean;
}

function choicesForTarget(target: TextReviewCopyTarget): TargetChoice[] {
  const choices: TargetChoice[] = [];
  if (target.content !== undefined) {
    choices.push({
      label: formatTextReviewTargetLabel(target, true),
      target,
      whole: true,
    });
  }
  if (target.children && target.children.length > 0) {
    choices.push(
      ...target.children.map((child) => ({
        label: formatTextReviewTargetLabel(child),
        target: child,
        whole: true,
      })),
    );
  }
  return choices;
}

async function selectTargetFromTree(
  ui: Pick<TextReviewSourceUI, "select">,
  targets: readonly TextReviewCopyTarget[],
): Promise<TextReviewCopyTarget | undefined> {
  const rootChoices: TargetChoice[] = [];
  for (const target of targets) {
    if (target.content !== undefined) {
      rootChoices.push({
        label: formatTextReviewTargetLabel(target, true),
        target,
        whole: true,
      });
    }
    if (target.children && target.children.length > 0) {
      rootChoices.push({
        label: `${formatTextReviewTargetLabel(target)} (choose a block)`,
        target,
        whole: false,
      });
    }
  }

  const selectedRootLabel = await ui.select(
    "Select a session message or block",
    rootChoices.map((choice) => choice.label),
  );
  if (selectedRootLabel === undefined) return undefined;

  const selectedRoot = rootChoices.find(
    (choice) => choice.label === selectedRootLabel,
  );
  if (!selectedRoot) return undefined;
  if (selectedRoot.whole || !selectedRoot.target.children?.length) {
    return selectedRoot.target;
  }

  const childChoices = choicesForTarget(selectedRoot.target);
  const selectedChildLabel = await ui.select(
    `Select from ${sanitizeTextReviewPreviewLabel(selectedRoot.target.label)}`,
    childChoices.map((choice) => choice.label),
  );
  if (selectedChildLabel === undefined) return undefined;

  const selectedChild = childChoices.find(
    (choice) => choice.label === selectedChildLabel,
  );
  if (!selectedChild) return undefined;
  return selectedChild.target;
}

function sourceFromCopyTarget(
  target: TextReviewCopyTarget,
  sessionId: string,
): TextReviewSource | undefined {
  if (target.content === undefined) return undefined;
  return {
    id: target.id,
    kind: targetKind(target),
    label: `${targetTypeLabel(target)} [${target.id}]`,
    text: target.content,
    sessionId,
  };
}

/** Choose a `/copy`-compatible target from the active branch. */
export async function selectSessionTextReviewSource(
  ctx: ExtensionCommandContext,
): Promise<TextReviewSource | undefined> {
  const targets = buildSessionTextReviewTargets(ctx);
  if (targets.length === 0) {
    ctx.ui.notify(
      "No assistant or user messages with copyable text are available on the active session branch.",
      "warning",
    );
    return undefined;
  }

  const target = await selectTargetFromTree(ctx.ui, targets);
  if (!target) return undefined;
  return sourceFromCopyTarget(target, getSessionId(ctx));
}

/** Freeze clipboard text as a distinct annotation source. */
export function createClipboardTextReviewSource(
  ctx: ExtensionCommandContext,
  text: string,
): TextReviewSource {
  return {
    id: "clipboard",
    kind: "clipboard",
    label: "Clipboard text",
    text,
    sessionId: getSessionId(ctx),
  };
}
