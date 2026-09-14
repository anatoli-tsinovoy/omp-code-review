import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

import { runAnnotateCommand } from "../src/index";
import { selectSessionTextReviewSource } from "../src/text-source";
import type { TextReviewSource } from "../src/text-types";

type SelectDialogOptions = {
  initialIndex?: number;
};

type SelectCall = {
  title: string;
  options: string[];
  dialogOptions?: SelectDialogOptions;
};

type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

type SelectHandler = (
  title: string,
  options: string[],
  dialogOptions?: SelectDialogOptions,
) => Promise<string | undefined> | string | undefined;

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text?: string,
): SessionEntry {
  const message =
    role === "assistant"
      ? {
          role,
          content: text === undefined ? [] : [{ type: "text", text }],
        }
      : { role, content: text ?? "" };
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: `${id}-timestamp`,
    message,
  } as unknown as SessionEntry;
}

function sessionBranch(): SessionEntry[] {
  return [
    messageEntry("user-old", "user", "older user request"),
    messageEntry(
      "assistant-latest",
      "assistant",
      "  latest assistant reply\nwith exact spacing  ",
    ),
    messageEntry("user-newer", "user", "newer user follow-up"),
    messageEntry("assistant-empty", "assistant", " \n\t"),
  ];
}

function createSessionContext(
  branch: SessionEntry[],
  select: SelectHandler,
  sessionId = "session-1",
): {
  ctx: ExtensionCommandContext;
  selectCalls: SelectCall[];
  notifications: Notification[];
  pasted: string[];
} {
  const selectCalls: SelectCall[] = [];
  const notifications: Notification[] = [];
  const pasted: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/repo",
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
    },
    ui: {
      setStatus() {},
      async select(
        title: string,
        options: string[],
        dialogOptions?: SelectDialogOptions,
      ): Promise<string | undefined> {
        selectCalls.push({
          title,
          options: [...options],
          dialogOptions,
        });
        return select(title, [...options], dialogOptions);
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      pasteToEditor(content: string) {
        pasted.push(content);
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, selectCalls, notifications, pasted };
}

describe("selectSessionTextReviewSource", () => {
  test("interactive selection keeps the latest message's frozen identity", async () => {
    const branch = sessionBranch();
    const latestText = "  latest assistant reply\nwith exact spacing  ";
    const { ctx, selectCalls } = createSessionContext(
      branch,
      async (_title, options) => {
        // Simulate a message arriving while the selector is open.
        branch.push(
          messageEntry("assistant-appended", "assistant", "appended later"),
        );
        return options.find((option) =>
          option.startsWith("latest assistant reply"),
        );
      },
    );

    const source = await selectSessionTextReviewSource(ctx);

    expect(branch.at(-1)).toMatchObject({ id: "assistant-appended" });
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.options[0]).toContain("newer user follow-up");
    expect(selectCalls[0]?.options[1]).toContain("latest assistant reply");
    expect(selectCalls[0]?.options[0]).not.toContain("msg:");
    expect(selectCalls[0]?.options[1]).not.toContain("msg:");
    expect(source).toEqual({
      id: "msg:assistant-latest",
      kind: "message",
      label: "Message: latest assistant reply",
      text: latestText,
      provenance: {
        kind: "latest-assistant",
        entryId: "assistant-latest",
      },
      sessionId: "session-1",
    });
  });

  test("last opens the latest whole message without rendering a picker", async () => {
    const branch = sessionBranch();
    const latestText =
      "  latest assistant reply\nwith exact spacing  \n\n```ts\nconst value = 42;\n```";
    branch[1] = messageEntry("assistant-latest", "assistant", latestText);
    const { ctx, pasted, selectCalls } = createSessionContext(branch, () => {
      throw new Error("Automatic selection must not render a picker");
    });
    const pi = {
      sendUserMessage() {},
      setLabel() {},
    } as unknown as ExtensionAPI;
    const selectedSources: TextReviewSource[] = [];

    await runAnnotateCommand(pi, "last", ctx, {
      selectSessionTextReviewSource,
      showTextReviewOverlay: async (_ctx, source) => {
        selectedSources.push(source);
        return {
          action: "paste",
          annotations: [
            {
              scope: "line",
              line: 1,
              quote: "latest assistant reply",
              note: "Keep the latest behavior.",
            },
          ],
        };
      },
    });

    expect(selectedSources).toEqual([
      {
        id: "msg:assistant-latest",
        kind: "message",
        label: "Message: latest assistant reply",
        text: latestText,
        provenance: {
          kind: "latest-assistant",
          entryId: "assistant-latest",
        },
        sessionId: "session-1",
      },
    ]);
    expect(selectCalls).toEqual([]);
    const interactive = createSessionContext(branch, (_title, options) =>
      options.find((option) => option.startsWith("latest assistant reply")),
    );
    expect(await selectSessionTextReviewSource(interactive.ctx)).toEqual(
      selectedSources[0],
    );
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain("latest assistant reply");
    expect(pasted[0]).toContain("Keep the latest behavior.");
  });

  test("still allows choosing an older message with session provenance", async () => {
    const { ctx, selectCalls } = createSessionContext(
      sessionBranch(),
      async (_title, options) =>
        options.find((option) => option.includes("older user request")),
    );

    const source = await selectSessionTextReviewSource(ctx);

    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]?.dialogOptions).toBeUndefined();
    expect(source).toEqual({
      id: "msg:user-old",
      kind: "message",
      label: "Message: older user request",
      text: "older user request",
      provenance: { kind: "session", entryId: "user-old" },
      sessionId: "session-1",
    });
  });

  test("disambiguates duplicate previews without colliding with a natural prefix", async () => {
    const branch = [
      messageEntry("duplicate-old", "user", "repeat"),
      messageEntry("duplicate-target", "user", "repeat"),
      messageEntry("natural-prefix", "user", "(2) repeat"),
    ];
    const { ctx, selectCalls } = createSessionContext(
      branch,
      async (_title, options) => options[1],
    );

    const source = await selectSessionTextReviewSource(ctx);
    const options = selectCalls[0]?.options ?? [];

    expect(options).toHaveLength(3);
    expect(options[0]).toBe("(2) repeat");
    expect(new Set(options).size).toBe(options.length);
    expect(options.every((option) => option.includes("repeat"))).toBe(true);
    expect(source).toMatchObject({
      id: "msg:duplicate-target",
      kind: "message",
      text: "repeat",
      provenance: { kind: "session", entryId: "duplicate-target" },
      sessionId: "session-1",
    });
  });

  test("labels blocks by content in document order while preserving exact block text", async () => {
    const blockText = [
      "intro",
      "> quoted value",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");
    const branch = [messageEntry("block-source", "assistant", blockText)];
    const { ctx, selectCalls } = createSessionContext(
      branch,
      async (_title, options) => {
        if (selectCalls.length === 1) {
          expect(options.some((option) => option.includes("intro"))).toBe(true);
          expect(options.some((option) => option.startsWith("Blocks: "))).toBe(
            true,
          );
          expect(options.every((option) => !option.includes("msg:"))).toBe(
            true,
          );
          return options.find((option) => option.startsWith("Blocks: "));
        }
        expect(options[0]?.startsWith("Whole message: ")).toBe(true);
        expect(options[0]).toContain("intro");
        expect(options[1]).toBe("Block #1: quoted value");
        expect(options[2]).toBe("Block #2: const value = 1;");
        return options[2];
      },
    );

    const source = await selectSessionTextReviewSource(ctx);

    expect(source).toMatchObject({
      id: "msg:block-source:code:0",
      kind: "code",
      text: "const value = 1;",
      provenance: { kind: "session", entryId: "block-source" },
      sessionId: "session-1",
    });
  });

  test("cancelling /annotate session does not open the overlay, paste, or warn", async () => {
    const { ctx, selectCalls, notifications, pasted } = createSessionContext(
      sessionBranch(),
      async () => undefined,
    );
    const pi = {
      sendUserMessage() {},
      setLabel() {},
    } as unknown as ExtensionAPI;
    let overlayOpened = 0;

    await runAnnotateCommand(pi, "session", ctx, {
      selectSessionTextReviewSource,
      showTextReviewOverlay: async () => {
        overlayOpened += 1;
        return undefined;
      },
    });

    expect(selectCalls).toHaveLength(1);
    expect(overlayOpened).toBe(0);
    expect(pasted).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("warns and does not default to a user message when no assistant reply exists", async () => {
    const { ctx, selectCalls, notifications } = createSessionContext(
      [
        messageEntry("user-only", "user", "user content"),
        messageEntry("assistant-empty", "assistant", " \n\t"),
      ],
      async (_title, options) => options[0],
    );

    const source = await selectSessionTextReviewSource(ctx, {
      autoSelect: "latest-assistant",
    });

    expect(source).toBeUndefined();
    expect(selectCalls).toEqual([]);
    expect(notifications).toEqual([
      {
        message:
          "No non-empty assistant reply is available on the active session branch.",
        type: "warning",
      },
    ]);
  });
});
