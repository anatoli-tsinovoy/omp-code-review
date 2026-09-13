# OMP Code Review

`/annotate code-review` is an interactive local-diff review workspace for [Oh My Pi](https://github.com/can1357/oh-my-pi). Select a diff, navigate its files and source lines, attach precise inline notes, then either continue the review with the active LLM session or place the annotations in the editor for further editing. The review uses one frozen diff snapshot, so its annotations and submitted context refer to the same changes.

`/annotate` offers one source menu for code review, assistant replies, session messages and blocks, and clipboard text. Text annotation works outside Git repositories.

## Requirements

- Oh My Pi 18.1.18 or later
- A Git repository for base-branch and commit reviews; [Jujutsu](https://github.com/jj-vcs/jj) is supported for working-copy reviews

## Install

Install the public plugin:

```sh
omp plugin install github:anatoli-tsinovoy/omp-code-review
```

Start a new OMP session in the repository you want to review, then run:

```text
/annotate
```

## Use

Choose **Code review** from the source menu, or run `/annotate code-review` directly, then choose a review target. Optional trailing text focuses the review, for example `/annotate code-review focus on error handling`.

1. **Base branch (PR style)** — choose a Git base branch; the plugin reviews the three-dot comparison from that branch to the current branch.
2. **Uncommitted changes** — reviews both staged and unstaged Git changes. In a JJ repository, it reviews the JJ working-copy diff.
3. **Specific commit** — choose one of the 20 most recent Git commits and review its diff.

The fullscreen view shows files, the selected diff, and actions. Add notes to a selected source line or to the whole file. Line annotations retain the file, hunk, and old/new line anchors and appear above the source line. File annotations appear above the diff; binary and rename-only entries support file annotations too. Existing notes can be reopened and edited without adding duplicates.

When you finish, choose one of these actions:

- **Continue with LLM review** sends the annotated, frozen diff context to the active OMP session.
- **Paste annotations into prompt** inserts formatted annotations into the editor without submitting a message.

Press `Esc` to cancel; cancellation neither submits nor pastes anything.

### Keyboard map

| Area              | Keys                                     | Action                                            |
| ----------------- | ---------------------------------------- | ------------------------------------------------- |
| Anywhere          | `Tab` / `Shift+Tab`                      | Move between files, diff, and actions             |
| Anywhere          | `[` / `]`                                | Previous / next file                              |
| Anywhere          | `u`                                      | Undo the most recently saved annotation           |
| Anywhere          | `Esc`                                    | Cancel the review (or cancel an open annotation)  |
| Files             | `↑` / `↓`, `j` / `k`                     | Select a file                                     |
| Files             | `→`, `l`, `Enter`                        | Move to the diff                                  |
| Diff              | `↑` / `↓`, `j` / `k`                     | Move by source line                               |
| Diff              | `Shift+↑` / `Shift+↓`                    | Move five source lines                            |
| Diff              | `PageUp` / `PageDown`                    | Move by a page                                    |
| Diff              | `g` / `G`                                | First / last source line                          |
| Diff              | `←`, `h`                                 | Return to files                                   |
| Diff              | `→`, `l`, `Enter`                        | Move to actions                                   |
| Diff              | `a`                                      | Annotate the selected source line                 |
| Files             | `a`                                      | Annotate the selected file                        |
| Browsing          | `A`                                      | Add a file-level annotation                       |
| Files / Diff      | `e`                                      | Edit an existing note; choose when several apply  |
| Browsing          | `Ctrl+O`                                 | Open the working-tree file in a focused tmux pane |
| Actions           | `↑` / `↓`, `j` / `k`                     | Select an action                                  |
| Actions           | `Enter`                                  | Run the selected action                           |
| Annotation editor | `Enter`                                  | Save annotation                                   |
| Annotation editor | `Shift+Enter`                            | Insert a newline                                  |
| Annotation editor | `Ctrl+G` or OMP external-editor shortcut | Edit the draft in `$VISUAL` or `$EDITOR`          |
| Note chooser      | `↑` / `↓`, `Enter`, `Esc`                | Choose a note to edit, or cancel                  |

External-editor changes return to the annotation draft; press `Enter` to save or `Esc` to discard. Cancelling an edit leaves the saved note unchanged. In the diff, `e` offers notes on the current line and notes on the file; in the file list, it offers file notes.

`Ctrl+O` requires tmux. It opens the current working-tree file, not the frozen diff revision, using `$VISUAL`, then `$EDITOR`, or `$PAGER` / `less` when neither editor is set. Missing or deleted working-tree files produce a warning rather than opening a pane.

## Annotate messages and clipboard text

| Command                         | Source                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/annotate`                     | Choose a source                                                                                      |
| `/annotate code-review [focus]` | Review a local diff, optionally with a review focus                                                  |
| `/annotate last`                | Latest non-empty assistant reply on the active branch                                                |
| `/annotate session`             | Choose a user/assistant message, fenced code block, quote, or Bash/eval command on the active branch |
| `/annotate clipboard`           | Read local clipboard text, or open a paste editor                                                    |

The session picker uses OMP's block-extraction helpers but is separate from `/copy`: the built-in menu does not expose an extension hook. It does not reproduce `/copy`'s complete transcript/tool-output browser. Sibling branches and hidden thinking are excluded. Stored message text is used, as in OMP's current `/copy` picker; provider-secret placeholders in stored history are not reconstructed.

In the text workspace, `a` annotates the selected logical line and `A` annotates the whole source. `e` revisits notes, `u` undoes the last saved note, and `Ctrl+G` edits the current draft externally. Long lines wrap; `PageUp` / `PageDown` navigate visual pages while annotations retain their original logical-line anchors. `Ctrl+O` is unavailable because these sources are not working-tree files.

**Paste annotations into prompt** is the only completion action for messages, blocks, and clipboard text. It places passage/comment feedback in the prompt editor for you to edit and submit manually; these annotation paths never submit a message automatically. Cancelling or finishing without notes sends nothing. **Continue with LLM review** is available only for `/annotate code-review`.

Prompt context depends on the selected source:

- The latest assistant reply uses quoted passages and comments only, whether opened through `/annotate last` or selected in the session picker.
- Selected code blocks and Bash/eval commands are included verbatim.
- Other session prose and quote selections are included verbatim through 1,000 characters. Longer selections receive a local TINY-generated compact, faithful source context of fewer than 1,000 characters for grounding annotations. It preserves as much original information and detail as fits, preferring rephrasing or reformatting before omitting details, alongside the exact annotated passages and comments.
- Clipboard text is included in full so the prompt is self-contained.

Whole-text notes appear as general feedback. Source-line anchors remain internal; the prompt does not expose logical-line markers.

Summaries run only after choosing to paste non-empty annotations. The configured local TINY model is used; an online setting selects OMP's default small local model instead, never a hosted fallback. Generation has a 60-second timeout. If generation returns blank or oversized output, or fails for any reason (including exceptions and timeouts), the full source is pasted verbatim with the oversized-source warning.

Text summaries use OMP's dedicated generic `tinyModelClient` completion client, while title generation remains behind the title-policy `tinyTitleClient` facade. This extension therefore requires an OMP source checkout containing the unreleased generic-client split; the currently published dependency does not contain `@oh-my-pi/pi-coding-agent/tiny/model-client`. No released minimum version is claimed here—run with a source checkout that includes this change (or a later release once available) to enable small-model summaries.

### Clipboard across SSH and tmux

Locally, the command uses OMP's clipboard reader. If reading fails or the clipboard has no text, it opens **Paste text to annotate**. Over SSH it opens that editor directly rather than risk annotating the remote machine's clipboard. Paste using your terminal's paste shortcut, then press `Ctrl+Q` or `Ctrl+Enter` to accept; `Esc` cancels.

OMP 18.1.18 forwards clipboard **writes** using OSC 52, but its text reader invokes host-local clipboard tools. Its enhanced paste support uses [OSC 5522](https://sw.kovidgoyal.net/kitty/clipboard/), which tmux 3.7c does not forward. Ordinary terminal/bracketed paste remains the fallback across SSH/tmux; this extension does not alter terminal permissions or tmux configuration. A tmux paste buffer is not necessarily the current client clipboard—tmux's default `get-clipboard=buffer` can return older server-buffer contents instead.

## Local development

Link a checkout while developing:

```sh
git clone https://github.com/anatoli-tsinovoy/omp-code-review.git
cd omp-code-review
bun install
omp plugin link .
```

Edits in the linked checkout are used by OMP; start a new OMP session and invoke `/annotate` to exercise them. Use `/annotate code-review` in a Git or JJ repository for the diff workflow.

## Upgrade and uninstall

Reinstall from GitHub to update:

```sh
omp plugin install github:anatoli-tsinovoy/omp-code-review
```

Remove it:

```sh
omp plugin uninstall omp-code-review
```

## Non-goals

This plugin annotates local diffs and text sources. It does not publish reviews or comments to GitHub, persist annotations, or mutate code, commits, branches, or repository configuration.

## License

[MIT](LICENSE)
