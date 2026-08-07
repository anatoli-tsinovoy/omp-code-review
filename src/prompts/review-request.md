## Code Review Request

### Mode

{{mode}}

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}

### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

Use the `task` tool with `agent: "reviewer"` and a `tasks` array.
{{#when agentCount "==" 1}}Create exactly **1 reviewer task**.{{else}}Spawn **{{agentCount}} reviewer agents** in parallel.{{/when}}
{{#if multiAgent}}
Group files by locality:

- Same directory or module → same agent
- Related functionality → same agent
- Tests with implementation → same agent
  {{/if}}

### Reviewer Instructions

Reviewer MUST:

- Focus ONLY on assigned files.
  {{#if skipDiff}}
- {{#if diffInstruction}}{{diffInstruction}}{{else}}Use the frozen previews only to route work; NEVER re-run a broad diff command.{{/if}}
- {{#if isJj}}Use `jj` to read assigned paths and surrounding context.{{else}}Use `git` to read assigned paths and surrounding context.{{/if}}
- {{#if contextInstruction}}{{contextInstruction}}{{else}}Read necessary surrounding context before reporting findings.{{/if}}
  {{else}}
- {{#if diffInstruction}}{{diffInstruction}}{{else}}Use the frozen diff below; NEVER re-run a diff command.{{/if}}
- {{#if contextInstruction}}{{contextInstruction}}{{else}}Read necessary surrounding context before reporting findings.{{/if}}
  {{/if}}
- Report only actionable, verified findings with exact file and line anchors.
- Use incremental `yield` sections for findings and verdict fields.

{{#if skipDiff}}

### Diff Previews

_Full diff is too large ({{len files}} files). Each preview contains the first ~{{linesPerFile}} relevant lines. Read assigned paths and surrounding context before reporting findings._

{{#list files join="\n\n"}}

#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}

### Additional Annotations and Instructions

{{additionalInstructions}}
{{/if}}
