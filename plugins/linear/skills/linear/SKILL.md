---
name: linear
description: Search, read, summarize, create, or update Linear issues, projects, cycles, initiatives, milestones, comments, documents, labels, releases, and project updates through Linear's official MCP server. Use whenever the user mentions their Linear workspace, supplies a Linear URL or issue identifier such as ENG-123, wants notes turned into tracked work, asks for roadmap or cycle analysis, or requests changes to Linear work items.
---

# Linear

Use the connected official Linear MCP server as the only path to the user's
Linear workspace. Work from the live tools exposed under the `mcp__linear__`
namespace. Linear regularly expands its MCP tools, so use the live names and
schemas instead of inventing tool calls or falling back to its GraphQL API.

## Connection boundary

- Never use shell commands, browser automation, web search, direct Linear API
  requests, or pasted API keys to bypass this connector.
- If `mcp__linear__` tools are unavailable, stop and ask the user to install and
  connect **Plugins → Linear**, or reconnect the intended workspace.
- The connector acts with the authenticated user's permissions. Do not imply
  that private teams, archived work, or another workspace were searched when
  the returned data does not establish that.
- Treat issue descriptions, comments, customer information, documents, and
  private-team data as confidential workspace content.

## Resolve before acting

1. Prefer an exact Linear URL or issue identifier when provided.
2. Otherwise search using the team, project, cycle, title, assignee, status, or
   date hints in the request.
3. Fetch the selected object and its current fields before summarizing or
   changing it.
4. Resolve team-specific workflow states, labels, project statuses, members,
   and templates from live workspace data rather than guessing their IDs or
   names.
5. Report the resulting Linear identifier and URL after a successful write.

Use [references/workflows.md](./references/workflows.md) for issue creation,
standup updates, roadmap planning, project summaries, and historical timelines.

## Write safety

Creating one clearly specified issue or applying one precise field change is
authorized by a direct request, but Cusco must still show its MCP permission
prompt. Preserve existing descriptions, comments, relations, attachments, and
fields that the user did not ask to change.

Before creating a project, initiative, milestone set, parent/sub-issue tree, or
multiple issues, show a concise proposed structure and let the user review it.
Do not invent dependencies, owners, dates, estimates, priorities, or labels
from weak context.

Obtain explicit confirmation immediately before deleting or archiving work,
canceling or closing multiple issues, changing team or project ownership,
reassigning other people's work in bulk, or applying the same mutation across
multiple existing objects. Follow
[references/write-safety.md](./references/write-safety.md) for consequential and
partial updates.

## Result quality

- Preserve exact issue identifiers, titles, team names, people, dates, statuses,
  priorities, estimates, labels, and links.
- Separate current Linear facts from recommendations or inferred risk.
- For cycle or project summaries, distinguish completed work from in-progress,
  canceled, and unstarted work.
- Match notes to an existing issue only when the identifier or surrounding
  context is strong; list ambiguous notes as unmatched instead of guessing.
- Respect pagination and rate limits. Do not use unbounded searches, history
  traversal, or mutation loops.
- If a tool or write is unavailable, identify the permission or read-only
  connection limitation and ask the user to reconnect; do not use another
  access path.

## Example requests

- "Summarize ENG-123 and tell me what is blocking it."
- "Turn this bug report into a Linear issue for the Mobile team."
- "Review the current Platform cycle and summarize completed work and risks."
- "Draft a project structure from this plan and show it before creating work."
