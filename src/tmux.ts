import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import { getEditorCommand } from "./external-editor";

/**
 * Split a shell-style command configured through VISUAL, EDITOR, or PAGER.
 *
 * The resulting argv is passed to tmux as separate arguments. In particular,
 * the command is never interpolated into a shell string, so an editor setting
 * cannot reinterpret the file path as shell syntax.
 */
function parseCommand(command: string, variable: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        const next = command[++index];
        if (next === undefined) {
          throw new Error(`Invalid ${variable} command: trailing escape`);
        }
        current += next;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\") {
      const next = command[++index];
      if (next === undefined) {
        throw new Error(`Invalid ${variable} command: trailing escape`);
      }
      current += next;
      tokenStarted = true;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += character;
      tokenStarted = true;
    }
  }

  if (quote !== undefined) {
    throw new Error(`Invalid ${variable} command: unterminated quote`);
  }
  if (tokenStarted) args.push(current);
  if (args.length === 0)
    throw new Error(`Invalid ${variable} command: empty command`);
  if (args.some((argument) => argument.includes("\0"))) {
    throw new Error(`Invalid ${variable} command: contains a NUL byte`);
  }
  return args;
}

function commandForFile(): string[] {
  const configuredEditor = getEditorCommand();
  const configuredPager = $env.PAGER?.trim();
  if (configuredEditor) return parseCommand(configuredEditor, "editor");
  return parseCommand(configuredPager || "less", "pager");
}

async function resolveExistingFile(
  filePath: string,
  cwd: string,
): Promise<{
  cwd: string;
  filePath: string;
}> {
  const resolvedCwd = path.resolve(cwd);
  try {
    const cwdStat = await fs.stat(resolvedCwd);
    if (!cwdStat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "not a directory") {
      throw new Error(
        `Cannot open file in tmux: cwd is not a directory: ${resolvedCwd}`,
      );
    }
    throw new Error(
      `Cannot open file in tmux: cwd does not exist or is not accessible: ${resolvedCwd}`,
    );
  }

  const resolvedFilePath = path.resolve(resolvedCwd, filePath);
  try {
    const fileStat = await fs.stat(resolvedFilePath);
    if (!fileStat.isFile()) {
      throw new Error("not a regular file");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "not a regular file") {
      throw new Error(
        `Cannot open file in tmux: path is not a regular file: ${resolvedFilePath}`,
      );
    }
    throw new Error(
      `Cannot open file in tmux: file does not exist or is not accessible: ${resolvedFilePath}`,
    );
  }

  return { cwd: resolvedCwd, filePath: resolvedFilePath };
}

async function runTmux(argv: readonly string[]): Promise<string> {
  let processHandle: Bun.ReadableSubprocess;
  try {
    processHandle = Bun.spawn(["tmux", ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (error) {
    throw new Error(
      `Cannot open file in tmux: failed to start tmux: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || "no diagnostic output";
    throw new Error(
      `Cannot open file in tmux: tmux ${argv[0] ?? "command"} failed (exit ${exitCode}): ${detail}`,
    );
  }
  return stdout;
}

/**
 * Open an existing working-tree file in a newly focused tmux pane.
 *
 * VISUAL takes precedence over EDITOR, matching the external-editor helper.
 * When neither is configured, PAGER (or `less`) is used. The command and
 * filename are supplied as direct tmux argv entries, preserving spaces and
 * shell metacharacters in both values.
 */
export async function openFileInTmux(
  filePath: string,
  cwd: string,
): Promise<void> {
  if (!$env.TMUX?.trim()) {
    throw new Error(
      "Cannot open file in tmux: not running inside tmux (TMUX is unset)",
    );
  }

  const resolved = await resolveExistingFile(filePath, cwd);
  const command = commandForFile();
  const targetPane = $env.TMUX_PANE?.trim();
  const tmuxArgs = [
    "split-window",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    resolved.cwd,
    ...(targetPane ? ["-t", targetPane] : []),
    "--",
    ...command,
    resolved.filePath,
  ];
  const paneId = (await runTmux(tmuxArgs)).trim();
  if (paneId === "") {
    throw new Error(
      "Cannot open file in tmux: tmux split-window returned no pane id",
    );
  }
}
