# Linear write safety

## Normal writes

A direct request can authorize one clearly scoped create or update. Fetch the
target first, retain unrelated fields and content, use resolved workspace IDs,
and allow Cusco's permission prompt to show for the MCP call.

## Review before creating structures

Before creating a project, initiative, milestones, or a group of related issues,
show the proposed hierarchy, titles, team, ownership, dates, and relationships.
Highlight any missing decisions. Apply only the reviewed structure.

## Confirm consequential changes

Obtain explicit confirmation immediately before:

- deleting, archiving, canceling, or bulk-closing work;
- moving issues between teams or projects;
- bulk assignment, status, priority, estimate, label, or due-date changes;
- replacing a description or document when a scoped edit is possible;
- changing initiative, project, or release ownership and status in bulk.

The confirmation should identify exact objects, count, before-and-after values,
and any irreversible or notification-producing effects.

## Partial completion and conflicts

If live workflow fields differ from the user's description, pause and show the
mismatch. If a batch partially succeeds, do not repeat successful mutations.
List successful and failed identifiers separately and retry only failures after
reviewing the error.
