#!/usr/bin/env sh
set -eu

sh -n scripts/update-computer-use-extension.sh

missing_sources=$(
  find src packages -type f -name '*.js' | sort | while IFS= read -r source; do
    case "$source" in
      src/*)
        relative=${source#src/}
        source_manifest=src/meson.build
        ;;
      packages/*)
        relative=${source#packages/}
        source_manifest=packages/meson.build
        ;;
    esac

    if [ "$relative" = "appInfo.js" ] \
      && grep -F "output: 'appInfo.js'" src/meson.build >/dev/null 2>&1; then
      continue
    fi
    if ! grep -F "'$relative'" "$source_manifest" >/dev/null 2>&1; then
      printf '%s\n' "$source"
    fi
  done
)

if [ -n "$missing_sources" ]; then
  printf 'Meson source manifests are missing install entries for:\n%s\n' "$missing_sources" >&2
  exit 1
fi

gjs -m tests/import-smoke.js
gjs -m tests/application-icon-smoke.js
gjs -m tests/bundled-icons-smoke.js
gjs -m tests/artifacts-smoke.js
gjs -m tests/artifact-manager-smoke.js
gjs -m tests/artifact-web-security-smoke.js
gjs -m tests/artifact-tools-smoke.js
gjs -m tests/artifact-workspace-smoke.js
gjs -m tests/attachments-smoke.js
gjs -m tests/markdown-smoke.js
gjs -m tests/message-view-smoke.js
gjs -m tests/streaming-text-smoke.js
gjs -m tests/stream-animation-smoke.js
gjs -m tests/stream-replay-window-smoke.js
gjs -m tests/scroll-controller-smoke.js
gjs -m tests/usage-smoke.js
gjs -m tests/usage-page-smoke.js
gjs -m tests/plugin-branding-smoke.js
gjs -m tests/plugins-smoke.js
gjs -m tests/gmail-goa-smoke.js
gjs -m tests/mail-goa-smoke.js
gjs -m tests/gnome-extension-plugin-smoke.js
gjs -m tests/notion-plugin-smoke.js
gjs -m tests/slack-plugin-smoke.js
gjs -m tests/linear-plugin-smoke.js
gjs -m tests/compaction-smoke.js
gjs -m tests/composer-readline-smoke.js
gjs -m tests/hooks-smoke.js
gjs -m tests/hooks-settings-smoke.js
gjs -m tests/memory-smoke.js
gjs -m tests/image-generation-smoke.js
gjs -m tests/image-editor-smoke.js
gjs -m tests/image-editor-window-smoke.js
gjs -m tests/tools-smoke.js
gjs -m tests/cron-smoke.js
gjs -m tests/automation-smoke.js
gjs -m tests/window-background-sync-smoke.js
gjs -m tests/window-provider-fallback-smoke.js
gjs -m tests/agent-mode-smoke.js
gjs -m tests/ask-user-smoke.js
gjs -m tests/accessibility-smoke.js
gjs -m tests/computer-use-extension-enable-smoke.js
gjs -m tests/computer-use-image-views-smoke.js
gjs -m tests/computer-use-smoke.js
gjs -m tests/computer-use-benchmark-smoke.js
gjs -m tests/skills-smoke.js
gjs -m tests/mcp-smoke.js
gjs -m tests/mcp-management-smoke.js
gjs -m tests/search-provider-smoke.js
gjs -m tests/workspace-smoke.js
gjs -m tests/prompt-variables-smoke.js
gjs -m tests/app-settings-smoke.js
gjs -m tests/archived-chats-smoke.js
gjs -m tests/chat-management-smoke.js
gjs -m tests/conversation-store-smoke.js
gjs -m tests/provider-config-smoke.js
gjs -m tests/provider-auth-smoke.js
gjs -m tests/output-limits-smoke.js
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
