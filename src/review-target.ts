import { parseReviewDiffSnapshot } from "./diff";
import type { LocalReviewKind, ResolvedReviewTarget } from "./types";

export interface ReviewExecutionResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Structural subset of ExtensionAPI used to acquire review targets. */
export interface ReviewExecutionFacade {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string },
  ): Promise<ReviewExecutionResult>;
}

export interface ReviewTargetUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{
  label: string;
  kind: LocalReviewKind;
}> = [
  { label: "1. Review against a base branch (PR Style)", kind: "base-branch" },
  { label: "2. Review uncommitted changes", kind: "uncommitted" },
  { label: "3. Review a specific commit", kind: "commit" },
];

function createCommandFailure(
  command: string,
  result: ReviewExecutionResult,
): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${command} failed: ${detail}` : `${command} failed`;
}

async function execute(
  execution: ReviewExecutionFacade,
  ui: Pick<ReviewTargetUI, "notify">,
  cwd: string,
  command: string,
  args: string[],
): Promise<ReviewExecutionResult | undefined> {
  try {
    const result = await execution.exec(command, args, { cwd });
    if (result.code === 0) return result;
    ui.notify(createCommandFailure(command, result), "error");
  } catch (error) {
    ui.notify(
      `${command} failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
  return undefined;
}

async function isJjRepository(
  execution: ReviewExecutionFacade,
  cwd: string,
): Promise<boolean> {
  try {
    return (await execution.exec("jj", ["root"], { cwd })).code === 0;
  } catch {
    return false;
  }
}

export function createResolvedReviewTarget(
  kind: ResolvedReviewTarget["kind"],
  mode: string,
  rawDiff: string,
  emptyMessage: string,
  options: Pick<
    ResolvedReviewTarget,
    "filteredMessage" | "diffInstruction" | "contextInstruction"
  > = {},
): ResolvedReviewTarget {
  return {
    kind,
    mode,
    rawDiff,
    snapshot: parseReviewDiffSnapshot(rawDiff),
    emptyMessage,
    ...options,
  };
}

/** Freezes externally acquired PR diff data into the same target shape as local reviews. */
export function createPrReviewTarget(
  mode: string,
  rawDiff: string,
  emptyMessage: string,
  options: Pick<
    ResolvedReviewTarget,
    "diffInstruction" | "contextInstruction"
  > = {},
): ResolvedReviewTarget {
  return createResolvedReviewTarget("pr", mode, rawDiff, emptyMessage, options);
}

export async function resolveUncommittedReviewTarget(
  execution: ReviewExecutionFacade,
  cwd: string,
  ui: Pick<ReviewTargetUI, "notify">,
): Promise<ResolvedReviewTarget | undefined> {
  if (await isJjRepository(execution, cwd)) {
    const diff = await execute(execution, ui, cwd, "jj", ["diff", "--git"]);
    if (diff === undefined) return undefined;
    return createResolvedReviewTarget(
      "uncommitted",
      "JJ working-copy changes",
      diff.stdout,
      "No uncommitted changes found",
    );
  }

  const [unstaged, staged] = await Promise.all([
    execute(execution, ui, cwd, "git", ["diff"]),
    execute(execution, ui, cwd, "git", ["diff", "--cached"]),
  ]);
  if (unstaged === undefined || staged === undefined) return undefined;
  return createResolvedReviewTarget(
    "uncommitted",
    "Uncommitted changes (staged + unstaged)",
    [unstaged.stdout, staged.stdout].filter(Boolean).join("\n"),
    "No uncommitted changes found",
  );
}

export async function selectLocalReviewKind(
  ui: Pick<ReviewTargetUI, "select">,
): Promise<LocalReviewKind | undefined> {
  const selected = await ui.select(
    "Review Mode",
    LOCAL_REVIEW_CHOICES.map((choice) => choice.label),
  );
  return LOCAL_REVIEW_CHOICES.find((choice) => choice.label === selected)?.kind;
}

export async function resolveLocalReviewTarget(
  kind: LocalReviewKind,
  execution: ReviewExecutionFacade,
  cwd: string,
  ui: ReviewTargetUI,
): Promise<ResolvedReviewTarget | undefined> {
  switch (kind) {
    case "base-branch": {
      const branchesResult = await execute(execution, ui, cwd, "git", [
        "branch",
        "--all",
        "--format=%(refname:short)",
      ]);
      if (branchesResult === undefined) return undefined;
      const branches = branchesResult.stdout
        .split("\n")
        .map((branch) => branch.trim())
        .filter(Boolean);
      if (branches.length === 0) {
        ui.notify("No git branches found", "error");
        return undefined;
      }
      const baseBranch = await ui.select(
        "Select base branch to compare against",
        branches,
      );
      if (!baseBranch) return undefined;
      const currentBranchResult = await execute(execution, ui, cwd, "git", [
        "branch",
        "--show-current",
      ]);
      if (currentBranchResult === undefined) return undefined;
      const currentBranch = currentBranchResult.stdout.trim() || "HEAD";
      const diff = await execute(execution, ui, cwd, "git", [
        "diff",
        `${baseBranch}...${currentBranch}`,
      ]);
      if (diff === undefined) return undefined;
      return createResolvedReviewTarget(
        "base-branch",
        `Base comparison: ${baseBranch}...${currentBranch}`,
        diff.stdout,
        `No changes between ${baseBranch} and ${currentBranch}`,
      );
    }
    case "uncommitted":
      return resolveUncommittedReviewTarget(execution, cwd, ui);
    case "commit": {
      const commitsResult = await execute(execution, ui, cwd, "git", [
        "log",
        "--oneline",
        "-20",
      ]);
      if (commitsResult === undefined) return undefined;
      const commits = commitsResult.stdout.split("\n").filter(Boolean);
      if (commits.length === 0) {
        ui.notify("No commits found", "error");
        return undefined;
      }
      const selectedCommit = await ui.select(
        "Select commit to review",
        commits,
      );
      if (!selectedCommit) return undefined;
      const hash = selectedCommit.split(" ")[0];
      if (!hash) {
        ui.notify("Selected commit is invalid", "error");
        return undefined;
      }
      const diff = await execute(execution, ui, cwd, "git", [
        "show",
        "--format=",
        hash,
      ]);
      if (diff === undefined) return undefined;
      return createResolvedReviewTarget(
        "commit",
        `Commit: ${hash}`,
        diff.stdout,
        "Commit has no diff content",
        {
          filteredMessage:
            "No reviewable files in commit (all changes filtered out)",
        },
      );
    }
  }
}
