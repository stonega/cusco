# Notion workflows

## Exact URL or ID

Use the live fetch tool with the supplied Notion URL or ID. A fetch may return a
page, database, data source, or saved view, so inspect the returned object before
choosing a follow-up tool. Do not turn an exact target into a broad search unless
the fetch reports that the target is unavailable.

## Workspace search

Use the live search tool with a narrow query derived from the user's words.
Review titles, object types, locations, and timestamps before fetching the most
likely matches. If several results remain plausible, show a short choice rather
than editing one by guesswork. Notion search may include connected sources when
the workspace plan permits it; label those sources accurately.

## Read a database or view

Fetch first to learn the current data sources, schema, templates, and saved-view
references. Query the appropriate data source or saved view using the tool's
live schema. Do not assume database property names or select/status values.

## Create content

Identify the parent page or data source before creation. Preserve the user's
structure in headings, lists, tables, links, and code blocks. For a data-source
row, fetch the schema and map only properties that exist. If a required property
is missing from the user's input, ask instead of inventing a value.

## Update content

Fetch the current target, select the narrowest update command, and retain
unrelated content. Prefer a scoped insertion or property change over full
content replacement. When the tool supports an asynchronous option for a large
create or update, use it only for genuinely large content and poll at or after
the returned interval until it succeeds, fails, or reaches a reasonable bound.

## Comments and meeting notes

Use comment tools only when the user clearly wants a comment posted, not when
they merely want draft wording. Meeting-note access can be plan- or
permission-dependent; describe that limitation if the official tool reports it.
