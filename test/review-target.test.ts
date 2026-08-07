import { describe, expect, test } from "bun:test";

import {
  LOCAL_REVIEW_CHOICES,
  resolveLocalReviewTarget,
  selectLocalReviewKind,
} from "../src/review-target";
import type {
  ReviewExecutionFacade,
  ReviewExecutionResult,
  ReviewTargetUI,
} from "../src/review-target";

type CommandCall = {
  command: string;
  args: string[];
  cwd: string | undefined;
};

type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

function commandKey(command: string, args: readonly string[]): string {
  return `${command}\u0000${args.join("\u0000")}`;
}

function result(stdout: string, code = 0, stderr = ""): ReviewExecutionResult {
  return { stdout, stderr, code };
}

function createExecution(
  results: Readonly<Record<string, ReviewExecutionResult>>,
): {
  execution: ReviewExecutionFacade;
  calls: CommandCall[];
} {
  const calls: CommandCall[] = [];
  return {
    calls,
    execution: {
      async exec(command, args, options) {
        calls.push({ command, args: [...args], cwd: options?.cwd });
        return (
          results[commandKey(command, args)] ??
          result("", 1, "unexpected command")
        );
      },
    },
  };
}

function createUi(
  select: (title: string, options: string[]) => Promise<string | undefined>,
): {
  ui: ReviewTargetUI;
  notifications: Notification[];
} {
  const notifications: Notification[] = [];
  return {
    notifications,
    ui: {
      select,
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };
}

describe("local review targets", () => {
  test("offers and resolves each supported review choice", async () => {
    expect(LOCAL_REVIEW_CHOICES).toEqual([
      {
        label: "1. Review against a base branch (PR Style)",
        kind: "base-branch",
      },
      { label: "2. Review uncommitted changes", kind: "uncommitted" },
      { label: "3. Review a specific commit", kind: "commit" },
    ]);

    for (const choice of LOCAL_REVIEW_CHOICES) {
      const { ui } = createUi(async () => choice.label);
      expect(await selectLocalReviewKind(ui)).toBe(choice.kind);
    }
  });

  test("uses the selected base branch and current branch in the three-dot Git comparison", async () => {
    const { execution, calls } = createExecution({
      [commandKey("git", ["branch", "--all", "--format=%(refname:short)"])]:
        result("main\norigin/main\n"),
      [commandKey("git", ["branch", "--show-current"])]:
        result("feature/review\n"),
      [commandKey("git", ["diff", "main...feature/review"])]: result(
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    });
    const { ui, notifications } = createUi(async (title) => {
      return title === "Select base branch to compare against"
        ? "main"
        : undefined;
    });

    const target = await resolveLocalReviewTarget(
      "base-branch",
      execution,
      "/repo",
      ui,
    );

    expect(calls).toEqual([
      {
        command: "git",
        args: ["branch", "--all", "--format=%(refname:short)"],
        cwd: "/repo",
      },
      { command: "git", args: ["branch", "--show-current"], cwd: "/repo" },
      { command: "git", args: ["diff", "main...feature/review"], cwd: "/repo" },
    ]);
    expect(target).toMatchObject({
      kind: "base-branch",
      mode: "Base comparison: main...feature/review",
      emptyMessage: "No changes between main and feature/review",
    });
    expect(notifications).toEqual([]);
  });

  test("combines unstaged and staged Git diffs into one uncommitted target", async () => {
    const unstaged =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+unstaged\n";
    const staged =
      "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+staged\n";
    const { execution, calls } = createExecution({
      [commandKey("jj", ["root"])]: result("", 1),
      [commandKey("git", ["diff"])]: result(unstaged),
      [commandKey("git", ["diff", "--cached"])]: result(staged),
    });
    const { ui, notifications } = createUi(async () => undefined);

    const target = await resolveLocalReviewTarget(
      "uncommitted",
      execution,
      "/repo",
      ui,
    );

    expect(calls).toEqual([
      { command: "jj", args: ["root"], cwd: "/repo" },
      { command: "git", args: ["diff"], cwd: "/repo" },
      { command: "git", args: ["diff", "--cached"], cwd: "/repo" },
    ]);
    expect(target?.mode).toBe("Uncommitted changes (staged + unstaged)");
    expect(target?.rawDiff).toBe(`${unstaged}\n${staged}`);
    expect(target?.snapshot.files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(notifications).toEqual([]);
  });

  test("uses JJ's git-format working-copy diff when the repository is JJ-managed", async () => {
    const jjDiff =
      "diff --git a/src/jj.ts b/src/jj.ts\n--- a/src/jj.ts\n+++ b/src/jj.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const { execution, calls } = createExecution({
      [commandKey("jj", ["root"])]: result("/repo\n"),
      [commandKey("jj", ["diff", "--git"])]: result(jjDiff),
    });
    const { ui, notifications } = createUi(async () => undefined);

    const target = await resolveLocalReviewTarget(
      "uncommitted",
      execution,
      "/repo",
      ui,
    );

    expect(calls).toEqual([
      { command: "jj", args: ["root"], cwd: "/repo" },
      { command: "jj", args: ["diff", "--git"], cwd: "/repo" },
    ]);
    expect(target).toMatchObject({
      kind: "uncommitted",
      mode: "JJ working-copy changes",
      rawDiff: jjDiff,
    });
    expect(notifications).toEqual([]);
  });

  test("resolves a selected commit through Git show with an exact commit hash", async () => {
    const { execution, calls } = createExecution({
      [commandKey("git", ["log", "--oneline", "-20"])]: result(
        "abc1234 Improve parser\ndef5678 Earlier work\n",
      ),
      [commandKey("git", ["show", "--format=", "abc1234"])]: result(
        "diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1 +1 @@\n-old\n+new\n",
      ),
    });
    const { ui, notifications } = createUi(async (title) => {
      return title === "Select commit to review"
        ? "abc1234 Improve parser"
        : undefined;
    });

    const target = await resolveLocalReviewTarget(
      "commit",
      execution,
      "/repo",
      ui,
    );

    expect(calls).toEqual([
      { command: "git", args: ["log", "--oneline", "-20"], cwd: "/repo" },
      { command: "git", args: ["show", "--format=", "abc1234"], cwd: "/repo" },
    ]);
    expect(target).toMatchObject({ kind: "commit", mode: "Commit: abc1234" });
    expect(notifications).toEqual([]);
  });

  test("surfaces command failures through error notifications", async () => {
    const { execution, calls } = createExecution({
      [commandKey("git", ["log", "--oneline", "-20"])]: result(
        "",
        128,
        "not a git repository",
      ),
    });
    const { ui, notifications } = createUi(async () => undefined);

    const target = await resolveLocalReviewTarget(
      "commit",
      execution,
      "/repo",
      ui,
    );

    expect(target).toBeUndefined();
    expect(calls).toEqual([
      { command: "git", args: ["log", "--oneline", "-20"], cwd: "/repo" },
    ]);
    expect(notifications).toEqual([
      { message: "git failed: not a git repository", type: "error" },
    ]);
  });
});
