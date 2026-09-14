import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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

export type AnnotationSourceKind =
  "code-review" | "last" | "session" | "clipboard";

export const ANNOTATION_SOURCE_CHOICES = [
  {
    kind: "code-review",
    label: "Code review",
    description: "Annotate a local diff before review",
  },
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
  kind: AnnotationSourceKind;
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
export async function selectAnnotationSourceKind(
  ui: Pick<TextReviewSourceUI, "select">,
): Promise<AnnotationSourceKind | undefined> {
  const selected = await ui.select(
    "Select content to annotate",
    ANNOTATION_SOURCE_CHOICES.map((choice) => choice.label),
  );
  return ANNOTATION_SOURCE_CHOICES.find((choice) => choice.label === selected)
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
function latestAssistantMessageEntry(branch: readonly SessionEntry[]):
  | {
      entry: Extract<SessionEntry, { type: "message" }>;
      text: string;
    }
  | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const text = assistantText(entry.message);
    if (!text) continue;
    return { entry, text };
  }
  return undefined;
}
export interface TextReviewCopyTarget {
  id: string;
  /** The session message entry containing this target, when applicable. */
  messageEntryId?: string;
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
  messageEntryId: string,
  block: MessageBlock,
  blockIndex: number,
): TextReviewCopyTarget {
  if (block.kind === "code") {
    const lines = textLines(block.code);
    return {
      id: `${parentId}:code:${blockIndex}`,
      messageEntryId,
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
    messageEntryId,
    label: "Quote block",
    hint: `${lines} line${lines === 1 ? "" : "s"}`,
    preview: block.text,
    content: block.text,
  };
}

function commandTarget(
  parentId: string,
  messageEntryId: string,
  command: LastCommand,
  commandIndex: number,
): TextReviewCopyTarget {
  return {
    id: `cmd:${parentId}:${commandIndex}`,
    messageEntryId,
    label: commandLabel(command),
    hint: command.kind,
    preview: command.code,
    language: command.language,
    content: command.code,
  };
}

function messageTarget(
  id: string,
  messageEntryId: string,
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
      const target = childTargetForBlock(id, messageEntryId, block, blockIndex);
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
      children.push(commandTarget(id, messageEntryId, command, commandIndex));
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
      messageEntryId,
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
      messageEntryId,
      label: `All ${quoteBlocks.length} quote blocks`,
      hint: `${lines} line${lines === 1 ? "" : "s"}`,
      preview: combined,
      content: combined,
    });
  }

  if (!text && children.length === 0) return undefined;

  // Preserve the source text exactly; labels and previews may sanitize it for
  // display, but annotation quotes must retain the selected content.
  const content = text;
  const lines = content === undefined ? 0 : textLines(content);
  return {
    id,
    messageEntryId,
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
function buildSessionTextReviewTargetsFromBranch(
  branch: readonly SessionEntry[],
): TextReviewCopyTarget[] {
  const targets: TextReviewCopyTarget[] = [];

  // `/copy` presents recent transcript material first. The entry id remains
  // part of every target id, so selecting a target is stable if labels collide.
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const target = messageTarget(
      `msg:${entry.id}`,
      entry.id,
      message.role,
      messageText(message),
      message,
    );
    if (target) targets.push(target);
  }
  return targets;
}
export function buildSessionTextReviewTargets(
  ctx: ExtensionCommandContext,
): TextReviewCopyTarget[] {
  return buildSessionTextReviewTargetsFromBranch(
    ctx.sessionManager.getBranch(),
  );
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

/** Build a content-first, selector-safe label for a copy target. */
export function formatTextReviewTargetLabel(
  target: TextReviewCopyTarget,
  wholeMessage = false,
): string {
  const preview = sanitizeTextReviewPreviewLabel(
    target.content ?? target.preview,
  );
  if (wholeMessage) return `Whole message: ${preview || "(empty)"}`;
  if (target.id.startsWith("cmd:")) return `Command: ${preview || "(empty)"}`;
  if (target.id.includes(":code:") || target.id.includes(":quote:")) {
    return `Block: ${preview || "(empty)"}`;
  }
  if (target.id.endsWith(":all")) {
    return `All code blocks: ${preview || "(empty)"}`;
  }
  if (target.id.endsWith(":all-quotes")) {
    return `All quote blocks: ${preview || "(empty)"}`;
  }
  return preview || "(empty)";
}

interface TargetChoice {
  label: string;
  target: TextReviewCopyTarget;
  whole: boolean;
}

function rootChoicesForTargets(
  targets: readonly TextReviewCopyTarget[],
): TargetChoice[] {
  const rootChoices: TargetChoice[] = [];
  for (const target of targets) {
    if (target.content !== undefined) {
      rootChoices.push({
        label: formatTextReviewTargetLabel(target),
        target,
        whole: true,
      });
    }
    if (target.children && target.children.length > 0) {
      const preview = sanitizeTextReviewPreviewLabel(
        target.content ?? target.preview,
      );
      rootChoices.push({
        label: `Blocks: ${preview || "(empty)"}`,
        target,
        whole: false,
      });
    }
  }
  return rootChoices;
}

function disambiguateChoiceLabels(
  choices: readonly TargetChoice[],
): TargetChoice[] {
  const counts = new Map<string, number>();
  for (const choice of choices) {
    counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
  }

  const usedLabels = new Set(choices.map((choice) => choice.label));
  const duplicateLabels = new Set(
    [...counts].filter(([, count]) => count > 1).map(([label]) => label),
  );
  const nextOccurrence = new Map<string, number>();

  return choices.map((choice) => {
    if (!duplicateLabels.has(choice.label)) return choice;
    let occurrence = (nextOccurrence.get(choice.label) ?? 0) + 1;
    let label = `(${occurrence}) ${choice.label}`;
    while (usedLabels.has(label)) {
      occurrence += 1;
      label = `(${occurrence}) ${choice.label}`;
    }
    nextOccurrence.set(choice.label, occurrence);
    usedLabels.add(label);
    return { ...choice, label };
  });
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

  let blockNumber = 0;
  for (const child of target.children ?? []) {
    const isBlock = child.id.includes(":code:") || child.id.includes(":quote:");
    let label: string;
    if (isBlock) {
      blockNumber += 1;
      const preview = sanitizeTextReviewPreviewLabel(
        child.content ?? child.preview,
      );
      label = `Block #${blockNumber}: ${preview || "(empty)"}`;
    } else {
      label = formatTextReviewTargetLabel(child);
    }
    choices.push({ label, target: child, whole: true });
  }
  return disambiguateChoiceLabels(choices);
}

async function selectTargetFromTree(
  ui: Pick<TextReviewSourceUI, "select">,
  targets: readonly TextReviewCopyTarget[],
): Promise<TextReviewCopyTarget | undefined> {
  const rootChoices = disambiguateChoiceLabels(rootChoicesForTargets(targets));

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
  latestAssistantEntryId?: string,
): TextReviewSource | undefined {
  if (target.content === undefined) return undefined;

  const kind = targetKind(target);
  const provenance: TextReviewSource["provenance"] =
    target.messageEntryId === undefined
      ? undefined
      : target.messageEntryId === latestAssistantEntryId && kind === "message"
        ? {
            kind: "latest-assistant",
            entryId: target.messageEntryId,
          }
        : {
            kind: "session",
            entryId: target.messageEntryId,
          };

  return {
    id: target.id,
    kind,
    label: `${targetTypeLabel(target)}: ${target.label}`,
    text: target.content,
    provenance,
    sessionId,
  };
}

/** Choose a `/copy`-compatible target from the active branch. */
export async function selectSessionTextReviewSource(
  ctx: ExtensionCommandContext,
  options?: { autoSelect?: "latest-assistant" },
): Promise<TextReviewSource | undefined> {
  // Keep this branch snapshot for both target construction and latest-message
  // provenance. The picker is asynchronous, so querying the branch afterward
  // could classify a newly appended message instead of the displayed target.
  const branch = ctx.sessionManager.getBranch();
  const sessionId = getSessionId(ctx);
  const latestAssistantEntryId = latestAssistantMessageEntry(branch)?.entry.id;
  if (
    options?.autoSelect === "latest-assistant" &&
    latestAssistantEntryId === undefined
  ) {
    ctx.ui.notify(
      "No non-empty assistant reply is available on the active session branch.",
      "warning",
    );
    return undefined;
  }

  const targets = buildSessionTextReviewTargetsFromBranch(branch);
  if (targets.length === 0) {
    ctx.ui.notify(
      "No assistant or user messages with copyable text are available on the active session branch.",
      "warning",
    );
    return undefined;
  }

  if (options?.autoSelect === "latest-assistant") {
    const latestTarget = targets.find(
      (target) =>
        target.id === `msg:${latestAssistantEntryId}` &&
        target.messageEntryId === latestAssistantEntryId &&
        target.content !== undefined,
    );
    return latestTarget
      ? sourceFromCopyTarget(latestTarget, sessionId, latestAssistantEntryId)
      : undefined;
  }

  const target = await selectTargetFromTree(ctx.ui, targets);
  if (!target) return undefined;
  return sourceFromCopyTarget(target, sessionId, latestAssistantEntryId);
}

/** Capture clipboard text as a distinct annotation source. */
export function createClipboardTextReviewSource(
  ctx: ExtensionCommandContext,
  text: string,
): TextReviewSource {
  return {
    id: "clipboard",
    kind: "clipboard",
    label: "Clipboard text",
    text,
    provenance: { kind: "clipboard" },
    sessionId: getSessionId(ctx),
  };
}
