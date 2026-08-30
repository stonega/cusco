---
name: notion
description: Search, read, summarize, create, or update Notion pages, databases, data sources, views, comments, tasks, meeting notes, and workspace knowledge through Notion's official MCP server. Use whenever the user asks about their Notion workspace, supplies a Notion URL or ID, wants notes turned into structured Notion content, or wants existing Notion content reviewed or changed.
---

# Notion

Use the connected official Notion MCP server as the only path to the user's
Notion workspace. Work from the live tools exposed under the `mcp__notion__`
namespace; the official tool list can evolve, so inspect the available tools
instead of inventing an unsupported name or request shape.

## Connection boundary

- Never use shell commands, browser automation, web search, a direct Notion API
  request, or a manually supplied integration token to bypass this connector.
- If no `mcp__notion__` tools are available, stop and ask the user to install
  and connect **Plugins → Notion**, or reconnect it if authorization expired.
- The connector acts with the authorized Notion user's permissions. Do not
  imply that inaccessible content does not exist or that a search covered
  another workspace.
- Treat Notion and connected-source search results as private workspace data.
  Include only the content needed for the user's task.

## Choose the smallest workflow

1. Establish the target from the user's Notion URL, page/database ID, exact
   title, or described location.
2. Prefer an exact fetch when a URL or ID is available. Search only when the
   target is unknown or the user explicitly asks for discovery.
3. Fetch the selected page, database, data source, or view before relying on its
   current content or schema.
4. For read requests, summarize only the retrieved evidence and distinguish a
   partial search from a workspace-wide conclusion.
5. For writes, use the narrowest create or update tool that expresses the
   requested change, then report the resulting page title and URL or ID when
   returned.

Common official tools include search, fetch, page creation, page update,
database creation, data-source queries, comments, and meeting-note queries.
Use the exact live schema shown by Cusco. See
[references/workflows.md](./references/workflows.md) for task-specific routing.

## Write safety

Read the target before changing existing content. Preserve its current title,
properties, blocks, links, and unrelated text unless the user explicitly asks
to replace or remove them.

Creating the clearly requested page or applying a precisely described edit is
authorized by the request, but still let Cusco present its MCP permission
prompt. Ask for clarification before a write when the parent, target page,
database/data-source schema, property mapping, or intended replacement scope is
ambiguous.

Never delete, archive, bulk-replace, move, or overwrite full page content based
on an inference. For those operations, summarize the exact targets and impact
and obtain explicit confirmation first. Follow
[references/write-safety.md](./references/write-safety.md) for replacements,
bulk work, and large asynchronous updates.

## Result quality

- Cite Notion evidence with returned page titles and URLs when available.
- State the search terms and scope when completeness matters.
- Keep page titles, property names, status values, people, dates, and URLs exact.
- Do not invent missing properties or silently coerce values into a schema.
- After a write, say what changed and identify anything requested that the MCP
  server did not complete.
- On rate limits, reduce parallel calls and retry only when useful; do not start
  an unbounded polling or search loop.

## Example requests

- "Find the current launch plan in Notion and summarize open risks."
- "Turn these meeting notes into a page under the Engineering wiki."
- "Update the status of the project page at this Notion URL after checking its
  current properties."
- "Search our workspace for decisions about authentication and link the source
  pages."
