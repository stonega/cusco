#!/usr/bin/env sh
set -eu

gjs -m tests/import-smoke.js
gjs -m tests/mock-provider-smoke.js
gjs -m tests/markdown-smoke.js
gjs -m tests/usage-smoke.js
gjs -m tests/memory-smoke.js
gjs -m tests/tools-smoke.js
gjs -m tests/skills-smoke.js
gjs -m tests/search-provider-smoke.js
gjs -m tests/workspace-smoke.js
gjs -m tests/app-settings-smoke.js
gjs -m tests/chat-management-smoke.js
gjs -m tests/conversation-store-smoke.js
gjs -m tests/provider-config-smoke.js
gjs -m tests/remote-provider-adapters-smoke.js
gjs -m tests/remote-provider-http-smoke.js
gjs -m tests/provider-settings-smoke.js

if command -v meson >/dev/null 2>&1; then
  if [ -d builddir ]; then
    meson setup builddir --wipe
  else
    meson setup builddir
  fi
  meson compile -C builddir
fi
