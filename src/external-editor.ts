import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";

export interface OpenInEditorOptions {
  extension?: string;
  trimTrailingNewline?: boolean;
}

/** Resolve the configured editor, with the native Windows fallback. */
export function getEditorCommand(): string | undefined {
  const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
  if (configured) return configured;
  return process.platform === "win32" ? "notepad" : undefined;
}

/** Open text in the configured editor and always remove the private temp file. */
export async function openInEditor(
  editorCommand: string,
  content: string,
  options: OpenInEditorOptions = {},
): Promise<string | null> {
  const extension = options.extension ?? ".md";
  const temporaryFile = path.join(
    os.tmpdir(),
    `omp-code-review-${Snowflake.next()}${extension}`,
  );

  try {
    await Bun.write(temporaryFile, content);
    const [executable, ...arguments_] = editorCommand.trim().split(/\s+/);
    if (!executable) return null;
    const child = spawn(executable, [...arguments_, temporaryFile], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
      child.once("error", reject);
    });
    if (exitCode !== 0) return null;
    const edited = await Bun.file(temporaryFile).text();
    return options.trimTrailingNewline === false
      ? edited
      : edited.replace(/\n$/, "");
  } finally {
    try {
      await fs.rm(temporaryFile, { force: true });
    } catch {
      // A cleanup failure must not hide a successful editor result.
    }
  }
}
