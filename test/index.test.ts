import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";

import { runCodeReviewCommand } from "../src/index";
import { createResolvedReviewTarget } from "../src/review-target";
import type { CodeReviewDependencies } from "../src/index";
import type {
  CodeReviewAnnotation,
  CodeReviewOverlayResult,
  LocalReviewKind,
  ResolvedReviewTarget,
} from "../src/types";

type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

const reviewDiff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -2 +2 @@
-before
+after
`;

const annotation: CodeReviewAnnotation = {
  path: "src/auth.ts",
  occurrence: 1,
  hunkHeader: "@@ -2 +2 @@",
  newLine: 2,
  rawLine: "+after",
  note: "Handle the invalid credential path before continuing.",
};

function createInteractiveContext(): {
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
      async select(): Promise<string | undefined> {
        return undefined;
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

function createPi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage(content: string) {
      sent.push(content);
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
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
