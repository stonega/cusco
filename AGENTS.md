<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer codegraph over native search

Use codegraph for structural questions: what calls what, what would break, where a symbol is defined, and what a symbol's signature/source looks like. Use native grep/read only for literal text queries or after you already have a specific file open.

| Question | Tool |
|---|---|
| Where is X defined? | `codegraph_search` |
| What calls function Y? | `codegraph_callers` |
| What does Y call? | `codegraph_callees` |
| What would break if I changed Z? | `codegraph_impact` |
| Show me Y's source | `codegraph_node` |
| Give focused context for an area | `codegraph_context` |
| See related symbols together | `codegraph_explore` |
| What files exist under path/ | `codegraph_files` |
| Is the index healthy? | `codegraph_status` |

If `.codegraph/` does not exist and CodeGraph reports "not initialized", ask before running `codegraph init -i`.
<!-- CODEGRAPH_END -->

## Project

Cusco is a native GNOME AI chat application built with GJS, GTK 4, and libadwaita.

## Commands

- Smoke import check: `gjs -m tests/import-smoke.js`
- Run from source: `gjs -m src/main.js`
- Configure build: `meson setup builddir`
- Compile: `meson compile -C builddir`
- Install locally: `meson install -C builddir`

Do not run `meson install -C builddir`, copy files into `~/.local/share/cusco`, or otherwise update the user's installed Cusco app unless the user explicitly asks for an install. Default to source changes, tests, and clear restart/install instructions instead.

## Structure

- `src/`: GJS application, window, and UI code.
- `data/`: desktop entry, app metadata, schema, icon, and resources.
- `docs/design/`: product and architecture notes.
- `docs/implementation/`: setup and development notes.
- `docs/user/`: user-facing usage notes.
- `tests/`: lightweight smoke checks.
- `scripts/`: repeatable local development scripts.

## Changelog

- Maintain `CHANGELOG.md` as the chronological, user-facing record of notable changes.
- Before every commit or push, check whether the work changes user-visible behavior. If it does, add a concise entry under `## [Unreleased]` in the appropriate Added, Changed, Fixed, Deprecated, Removed, or Security section.
- Do not add entries for internal refactors, tests, formatting, or documentation-only maintenance unless they materially affect users or contributors.
- When cutting a release, move the Unreleased entries into a versioned section with the release date, add a fresh `## [Unreleased]` section, and update the comparison links at the bottom of the file.
- Do not rewrite released entries except to correct factual errors.

## Coding Notes

- Keep the first app surface native to GNOME: prefer GTK 4/libadwaita widgets over web views unless a feature needs web content.
- Keep provider-specific code behind a small provider interface before adding individual API clients.
- Store secrets through the desktop Secret Service, not plain settings files.
- Make memory features explicit and user-controlled; never hide stored memory state.
- Preserve custom bundled icon artwork. If an icon has the wrong color in dark/light themes, fix the symbolic icon loading or CSS recoloring path instead of replacing it with a different system icon.
