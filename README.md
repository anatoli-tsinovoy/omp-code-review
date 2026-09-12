# OMP Code Review

some crap

`/code-review` is an interactive local-diff review workspace for [Oh My Pi](https://github.com/can1357/oh-my-pi). Select a diff, navigate its files and source lines, attach precise inline notes, then either continue the review with the active LLM session or place the annotations in the editor for further editing. The review uses one frozen diff snapshot, so its annotations and submitted context refer to the same changes.

## Requirements

- Oh My Pi 17.2.9 or later
- A Git repository for base-branch and commit reviews; [Jujutsu](https://github.com/jj-vcs/jj) is supported for working-copy reviews

## Install

Install the public plugin:

```sh
omp plugin install github:anatoli-tsinovoy/omp-code-review
```

Start a new OMP session in the repository you want to review, then run:

```text
/code-review
```

## Use

Choose one of the available review targets:

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

## Local development

Link a checkout while developing:

```sh
git clone https://github.com/anatoli-tsinovoy/omp-code-review.git
cd omp-code-review
bun install
omp plugin link .
```

Edits in the linked checkout are used by OMP; start a new OMP session in a Git or JJ repository and invoke `/code-review` to exercise them.

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

This plugin reviews local diffs only. It does not publish reviews or comments to GitHub, persist annotations, or mutate code, commits, branches, or repository configuration.

## License

[MIT](LICENSE)
