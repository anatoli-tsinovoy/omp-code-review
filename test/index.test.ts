import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";

import registerAnnotateExtension, {
  runAnnotateCommand,
  runCodeReviewCommand,
} from "../src/index";
import { formatCodeReviewAnnotations } from "../src/prompt";
import { markdownFenceFor } from "../src/text-review";
import { createResolvedReviewTarget } from "../src/review-target";
import type { CodeReviewDependencies } from "../src/index";
import type {
  CodeReviewAnnotation,
  CodeReviewOverlayResult,
  LocalReviewKind,
  ResolvedReviewTarget,
} from "../src/types";
import type { TextReviewAnnotation, TextReviewSource } from "../src/text-types";

type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

type SourceSelector = (
  title: string,
  options: string[],
) => Promise<string | undefined>;

type RegisteredCommand = {
  name: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Array<{ value: string }> | null;
};

const reviewDiff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -2 +2 @@
-before
+after
`;

const annotation: CodeReviewAnnotation = {
  scope: "line",
  path: "src/auth.ts",
  occurrence: 1,
  hunkHeader: "@@ -2 +2 @@",
  newLine: 2,
  rawLine: "+after",
  note: "Handle the invalid credential path before continuing.",
};

const fileAnnotation: CodeReviewAnnotation = {
  scope: "file",
  path: "src/auth.ts",
  occurrence: 1,
  note: "Review the authentication boundary and its error handling as a whole.",
};

function createInteractiveContext(
  select: SourceSelector = async () => undefined,
): {
  ctx: ExtensionCommandContext;
  notifications: Notification[];
  pasted: string[];
} {
  const notifications: Notification[] = [];
  const pasted: string[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/repo",
    ui: {
      setStatus() {},
      async select(
        title: string,
        options: string[],
      ): Promise<string | undefined> {
        return select(title, options);
      },
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
      pasteToEditor(content: string) {
        pasted.push(content);
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, pasted };
}

function createPi(): {
  pi: ExtensionAPI;
  sent: string[];
  labels: string[];
  registeredCommands: RegisteredCommand[];
} {
  const sent: string[] = [];
  const labels: string[] = [];
  const registeredCommands: RegisteredCommand[] = [];
  const pi = {
    sendUserMessage(content: string) {
      sent.push(content);
    },
    setLabel(label: string) {
      labels.push(label);
    },
    registerCommand(
      name: string,
      command: {
        getArgumentCompletions?: (
          argumentPrefix: string,
        ) => Array<{ value: string }> | null;
      },
    ) {
      registeredCommands.push({
        name,
        getArgumentCompletions: command.getArgumentCompletions,
      });
    },
  } as unknown as ExtensionAPI;
  return { pi, sent, labels, registeredCommands };
}

function dependenciesFor(
  target: ResolvedReviewTarget,
  overlayResult: CodeReviewOverlayResult | undefined,
  calls: {
    selected: number;
    resolved: number;
    overlays: ResolvedReviewTarget[];
  },
): CodeReviewDependencies {
  return {
    async selectLocalReviewKind(): Promise<LocalReviewKind | undefined> {
      calls.selected++;
      return "commit";
    },
    async resolveLocalReviewTarget(): Promise<
      ResolvedReviewTarget | undefined
    > {
      calls.resolved++;
      return target;
    },
    async showCodeReviewOverlay(
      _ctx,
      receivedTarget,
    ): Promise<CodeReviewOverlayResult | undefined> {
      calls.overlays.push(receivedTarget);
      return overlayResult;
    },
  };
}

describe("runCodeReviewCommand", () => {
  test("sends one focused headless request without starting interactive target selection", async () => {
    const { pi, sent } = createPi();
    const { ctx } = createInteractiveContext();
    const headlessCtx = { ...ctx, hasUI: false } as ExtensionCommandContext;
    let selected = false;

    await runCodeReviewCommand(pi, "  inspect auth boundaries  ", headlessCtx, {
      async selectLocalReviewKind(): Promise<LocalReviewKind | undefined> {
        selected = true;
        return "commit";
      },
    });

    expect(selected).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("inspect auth boundaries");
  });

  test("renders file-level annotations without fabricated line context", () => {
    const formatted = formatCodeReviewAnnotations([fileAnnotation], {
      forReviewer: false,
    });

    expect(formatted).toContain("### src/auth.ts — file");
    expect(formatted).toContain(fileAnnotation.note);
    expect(formatted).not.toContain("Hunk:");
    expect(formatted).not.toContain("```");
  });

  test("sends one review request containing annotations and trimmed focus for the frozen target", async () => {
    const target = createResolvedReviewTarget(
      "commit",
      "Commit: abc1234",
      reviewDiff,
      "No diff",
    );
    const { pi, sent } = createPi();
    const { ctx, pasted } = createInteractiveContext();
    const calls = {
      selected: 0,
      resolved: 0,
      overlays: [] as ResolvedReviewTarget[],
    };

    await runCodeReviewCommand(
      pi,
      "  focus authorization behavior  ",
      ctx,
      dependenciesFor(
        target,
        { action: "review", annotations: [annotation] },
        calls,
      ),
    );

    expect(calls).toEqual({ selected: 1, resolved: 1, overlays: [target] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("focus authorization behavior");
    expect(sent[0]).toContain(annotation.note);
    expect(sent[0]).toContain("+after");
    expect(pasted).toEqual([]);
  });

  test("pastes formatted annotations without submitting a user message", async () => {
    const target = createResolvedReviewTarget(
      "commit",
      "Commit: abc1234",
      reviewDiff,
      "No diff",
    );
    const { pi, sent } = createPi();
    const { ctx, pasted } = createInteractiveContext();
    const calls = {
      selected: 0,
      resolved: 0,
      overlays: [] as ResolvedReviewTarget[],
    };

    await runCodeReviewCommand(
      pi,
      "focus ignored for paste",
      ctx,
      dependenciesFor(
        target,
        { action: "paste", annotations: [annotation] },
        calls,
      ),
    );

    expect(calls.overlays).toEqual([target]);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain(annotation.note);
    expect(sent).toEqual([]);
  });

  test("does not submit or paste when the review overlay is cancelled", async () => {
    const target = createResolvedReviewTarget(
      "commit",
      "Commit: abc1234",
      reviewDiff,
      "No diff",
    );
    const { pi, sent } = createPi();
    const { ctx, pasted } = createInteractiveContext();
    const calls = {
      selected: 0,
      resolved: 0,
      overlays: [] as ResolvedReviewTarget[],
    };

    await runCodeReviewCommand(
      pi,
      "",
      ctx,
      dependenciesFor(target, undefined, calls),
    );

    expect(calls.overlays).toEqual([target]);
    expect(sent).toEqual([]);
    expect(pasted).toEqual([]);
  });

  test("warns instead of opening a review for empty or fully filtered targets", async () => {
    const empty = createResolvedReviewTarget(
      "commit",
      "Commit: empty",
      "",
      "Commit has no diff content",
    );
    const filtered = createResolvedReviewTarget(
      "commit",
      "Commit: generated",
      "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n",
      "Commit has no diff content",
      { filteredMessage: "No reviewable files in commit" },
    );

    for (const [target, warning] of [
      [empty, "Commit has no diff content"],
      [filtered, "No reviewable files in commit"],
    ] as const) {
      const { pi, sent } = createPi();
      const { ctx, notifications, pasted } = createInteractiveContext();
      const calls = {
        selected: 0,
        resolved: 0,
        overlays: [] as ResolvedReviewTarget[],
      };

      await runCodeReviewCommand(
        pi,
        "",
        ctx,
        dependenciesFor(target, undefined, calls),
      );

      expect(notifications).toEqual([{ message: warning, type: "warning" }]);
      expect(calls.overlays).toEqual([]);
      expect(sent).toEqual([]);
      expect(pasted).toEqual([]);
    }
  });
});

describe("runAnnotateCommand", () => {
  test("summary exceptions preserve exact source feedback without submitting", async () => {
    const source: TextReviewSource = {
      id: "older",
      kind: "message",
      label: "Older reply",
      text: "Context about parser boundaries. ```embedded```\n".repeat(60),
      provenance: { kind: "session", entryId: "older" },
    };
    const { pi, sent } = createPi();
    const { ctx, pasted, notifications } = createInteractiveContext();
    const quote = "Context about parser boundaries.";
    await runAnnotateCommand(pi, "session", ctx, {
      selectSessionTextReviewSource: async () => source,
      showTextReviewOverlay: async () => ({
        action: "paste",
        annotations: [
          { scope: "line", line: 1, quote, note: "Keep this exact boundary." },
        ],
      }),
      generateTextReviewContextSummary: async () => {
        throw new Error("local inference failed");
      },
    });
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain(source.text);
    const sourceFence = markdownFenceFor(source.text);
    expect(pasted[0]).toContain(
      `${sourceFence}text\n${source.text}\n${sourceFence}`,
    );
    expect(pasted[0]).toContain(quote);
    expect(pasted[0]).toContain("Keep this exact boundary.");
    expect(
      notifications.some(
        (item) =>
          item.type === "warning" &&
          /full source/i.test(item.message) &&
          /1000/.test(item.message),
      ),
    ).toBe(true);
    expect(sent).toEqual([]);
  });
  test("blank summary preserves the full source and warns before pasting", async () => {
    const source: TextReviewSource = {
      id: "older",
      kind: "message",
      label: "Older reply",
      text: "Long session context. ".repeat(80),
      provenance: { kind: "session", entryId: "older" },
    };
    const { pi, sent } = createPi();
    const { ctx, pasted, notifications } = createInteractiveContext();

    await runAnnotateCommand(pi, "session", ctx, {
      selectSessionTextReviewSource: async () => source,
      showTextReviewOverlay: async () => ({
        action: "paste",
        annotations: [{ scope: "text", note: "Keep this context." }],
      }),
      generateTextReviewContextSummary: async () => " \n\t ",
    });

    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain(source.text);
    expect(
      notifications.some(
        (item) =>
          item.type === "warning" &&
          /full source/i.test(item.message) &&
          /1000/.test(item.message),
      ),
    ).toBe(true);
    expect(sent).toEqual([]);
  });

  test("routes code-review arguments through the diff flow with trailing focus", async () => {
    const target = createResolvedReviewTarget(
      "commit",
      "Commit: abc1234",
      reviewDiff,
      "No diff",
    );
    const { pi, sent } = createPi();
    const { ctx, pasted } = createInteractiveContext();
    const calls = {
      selected: 0,
      resolved: 0,
      overlays: [] as ResolvedReviewTarget[],
    };

    await runAnnotateCommand(pi, "code-review  focus authorization  ", ctx, {
      runCodeReviewCommand: (receivedPi, focus, receivedCtx) =>
        runCodeReviewCommand(
          receivedPi,
          focus,
          receivedCtx,
          dependenciesFor(
            target,
            { action: "review", annotations: [annotation] },
            calls,
          ),
        ),
    });

    expect(calls).toEqual({ selected: 1, resolved: 1, overlays: [target] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("focus authorization");
    expect(sent[0]).toContain(annotation.note);
    expect(pasted).toEqual([]);
  });

  test("routes the Code review source choice through the diff flow", async () => {
    const target = createResolvedReviewTarget(
      "commit",
      "Commit: abc1234",
      reviewDiff,
      "No diff",
    );
    const { pi, sent } = createPi();
    const { ctx } = createInteractiveContext(async (_title, options) => {
      expect(options).toContain("Code review");
      return "Code review";
    });
    const calls = {
      selected: 0,
      resolved: 0,
      overlays: [] as ResolvedReviewTarget[],
    };

    await runAnnotateCommand(pi, "", ctx, {
      runCodeReviewCommand: (receivedPi, focus, receivedCtx) =>
        runCodeReviewCommand(
          receivedPi,
          focus,
          receivedCtx,
          dependenciesFor(
            target,
            { action: "review", annotations: [annotation] },
            calls,
          ),
        ),
    });

    expect(calls).toEqual({ selected: 1, resolved: 1, overlays: [target] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(annotation.note);
  });

  test("keeps explicit code-review headless behavior", async () => {
    const { pi, sent } = createPi();
    const { ctx } = createInteractiveContext();
    const headlessCtx = { ...ctx, hasUI: false } as ExtensionCommandContext;

    await runAnnotateCommand(
      pi,
      "code-review inspect auth boundaries",
      headlessCtx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("inspect auth boundaries");
  });

  test("registers only annotate and completes the code-review subcommand", () => {
    const { pi, labels, registeredCommands } = createPi();

    registerAnnotateExtension(pi);

    expect(labels).toEqual(["Annotate"]);
    expect(registeredCommands.map((command) => command.name)).toEqual([
      "annotate",
    ]);
    const completions = registeredCommands[0]?.getArgumentCompletions?.("code");
    expect(completions?.some((item) => item.value === "code-review")).toBe(
      true,
    );
  });

  test("pastes text-source annotations into the prompt without submitting", async () => {
    const source: TextReviewSource = {
      id: "latest:assistant",
      kind: "message",
      label: "Latest assistant reply",
      text: "Keep the parser boundary explicit.",
    };
    const textAnnotation: TextReviewAnnotation = {
      scope: "text",
      note: "Preserve this behavior.",
    };
    const { pi, sent } = createPi();
    const { ctx, pasted } = createInteractiveContext();

    await runAnnotateCommand(pi, "last", ctx, {
      getLatestAssistantReply: () => source,
      showTextReviewOverlay: async (_ctx, receivedSource) => {
        expect(receivedSource).toEqual(source);
        return { action: "paste", annotations: [textAnnotation] };
      },
    });

    expect(sent).toEqual([]);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).toContain(source.text);
    expect(pasted[0]).toContain(textAnnotation.note);

    const invalid = createPi();
    const invalidContext = createInteractiveContext();
    await runAnnotateCommand(invalid.pi, "last extra", invalidContext.ctx);
    expect(invalidContext.notifications).toHaveLength(1);
    expect(invalidContext.notifications[0]?.type).toBe("error");
    expect(invalid.sent).toEqual([]);

    const headless = createPi();
    const headlessContext = createInteractiveContext();
    await runAnnotateCommand(headless.pi, "last", {
      ...headlessContext.ctx,
      hasUI: false,
    } as ExtensionCommandContext);
    expect(headlessContext.notifications[0]?.type).toBe("error");
    expect(headless.sent).toEqual([]);
  });
});
