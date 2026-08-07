{{#if forReviewer}}

## Operator-Supplied Review Focus

You MUST verify every annotation against the diff and surrounding code. NEVER repeat an operator note without independently validating it.
{{else}}

## Code Review Annotations

Use these annotations as review notes; they are not independently validated findings.
{{/if}}

{{#list annotations join="\n\n"}}

### {{pathLabel}} — {{lineLabel}}

Path: `{{path}}`
{{#if oldPath}}
Old path: `{{oldPath}}`
{{/if}}
{{#if newPath}}
New path: `{{newPath}}`
{{/if}}
Occurrence: `{{occurrence}}`

Hunk: `{{hunkHeader}}`

{{#codeblock lang="diff"}}
{{rawLine}}
{{/codeblock}}

{{note}}
{{/list}}
{{#if supplementalInstructions}}

## Supplemental Review Focus

{{supplementalInstructions}}
{{/if}}
