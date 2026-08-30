# Notion write safety

## Normal reviewed writes

A user request that names the content and destination authorizes that specific
create or update. Fetch existing targets first, preserve unrelated content, use
the live tool schema, and allow Cusco's MCP permission prompt to show before the
call.

## Confirm before high-impact changes

Obtain explicit confirmation immediately before:

- deleting or archiving pages, databases, data sources, or comments;
- moving content to a different parent or workspace area;
- replacing an entire page when a smaller edit would satisfy the request;
- changing schemas, property types, templates, or saved-view behavior;
- applying the same write across multiple existing objects.

The confirmation summary should identify the action, exact targets, number of
objects when known, content that will be displaced, and whether the operation is
reversible. A vague instruction such as "clean this up" does not authorize
deletion or full replacement.

## Bulk and asynchronous work

Start with a small representative set when the user has not fixed the scope.
Do not launch unbounded page creation or update loops. Respect the server's rate
limits and any `poll_after_seconds` returned for asynchronous tasks. Stop after
a bounded wait and report the task handle if completion cannot be observed.

## Conflicts and partial completion

If the fetched content or schema differs from the user's description, pause the
write and show the mismatch. If only some operations succeed, do not repeat the
whole batch blindly; list successful and failed targets separately, then retry
only the failures with user approval when needed.
