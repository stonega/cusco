#!/usr/bin/env sh
set -eu

missing_sources=$(
  find src -type f -name '*.js' | sort | while IFS= read -r source; do
    relative=${source#src/}
    if ! grep -F "'$relative'" src/meson.build >/dev/null 2>&1; then
      printf '%s\n' "$source"
    fi
  done
)

if [ -n "$missing_sources" ]; then
  printf 'src/meson.build is missing install entries for:\n%s\n' "$missing_sources" >&2
  exit 1
fi

gjs -m tests/import-smoke.js
gjs -m tests/markdown-smoke.js
gjs -m tests/usage-smoke.js
gjs -m tests/memory-smoke.js
gjs -m tests/image-generation-smoke.js
gjs -m tests/tools-smoke.js
gjs -m tests/cron-smoke.js
gjs -m tests/agent-mode-smoke.js
gjs -m tests/skills-smoke.js
gjs -m tests/mcp-smoke.js
gjs -m tests/search-provider-smoke.js
gjs -m tests/workspace-smoke.js
gjs -m tests/prompt-variables-smoke.js
gjs -m tests/app-settings-smoke.js
gjs -m tests/chat-management-smoke.js
gjs -m tests/conversation-store-smoke.js
gjs -m tests/provider-config-smoke.js
gjs -m tests/remote-provider-adapters-smoke.js
gjs -m tests/remote-provider-http-smoke.js
gjs -m tests/provider-settings-smoke.js

if command -v glib-compile-schemas >/dev/null 2>&1; then
  glib-compile-schemas --strict --dry-run data
fi

if command -v meson >/dev/null 2>&1; then
  if [ -d builddir ]; then
    meson setup builddir --wipe
  else
    meson setup builddir
  fi
  meson compile -C builddir
fi
