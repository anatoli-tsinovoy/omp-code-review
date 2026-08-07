## Code Review Request

### Mode

Headless local review

### Review Workflow

Review recent local changes using the ordinary repository workflow:

1. Inspect the working tree and identify the relevant local changes.
2. Read the changed code and necessary surrounding context.
3. Verify each potential finding before reporting it.
4. Report actionable findings with exact file and line anchors, then a verdict.

Do NOT require UI selection or ask the operator to choose a review target.

### Distribution Guidelines

Use the `task` tool with `agent: "reviewer"` and a `tasks` array.
Create exactly **1 reviewer task** for recent local changes.

{{#if focus}}

### Focus

{{focus}}
{{/if}}
