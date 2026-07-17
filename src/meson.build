cusco_sources = files(
  'main.js',
  'application.js',
  'bundledIcons.js',
  'searchProvider.js',
  'window.js',
)

configure_file(
  input: 'appInfo.js.in',
  output: 'appInfo.js',
  configuration: conf,
  install: true,
  install_dir: pkgdatadir,
)

chat_sources = files(
  'chat/agentMode.js',
  'chat/artifacts.js',
  'chat/attachments.js',
  'chat/codeThemes.js',
  'chat/compaction.js',
  'chat/conversation.js',
  'chat/markdown.js',
  'chat/messageView.js',
  'chat/usage.js',
)

composer_sources = files(
  'composer/references.js',
)

computer_use_sources = files(
  'computerUse/accessibility.js',
  'computerUse/imageViews.js',
  'computerUse/service.js',
  'computerUse/tools.js',
)

provider_sources = files(
  'providers/config.js',
  'providers/imageGeneration.js',
  'providers/icons.js',
  'providers/provider.js',
  'providers/outputLimits.js',
  'providers/remoteProvider.js',
  'providers/thinking.js',
  'providers/usage.js',
)

memory_sources = files(
  'memory/memory.js',
)

mcp_sources = files(
  'mcp/auth.js',
  'mcp/client.js',
  'mcp/config.js',
  'mcp/manager.js',
)

cron_sources = files(
  'cron/manager.js',
)

settings_sources = files(
  'settings/archivedChats.js',
  'settings/appInfoSettings.js',
  'settings/appSettings.js',
  'settings/computerUseSettings.js',
  'settings/memorySettings.js',
  'settings/mcpSettings.js',
  'settings/providerSettings.js',
  'settings/workspaceSettings.js',
)

secret_sources = files(
  'secrets/apiKeyStore.js',
)

storage_sources = files(
  'storage/conversationStore.js',
  'storage/memoryStore.js',
  'storage/workspaceStore.js',
)

skill_sources = files(
  'skills/skills.js',
)

tool_sources = files(
  'tools/display.js',
  'tools/permissions.js',
  'tools/tools.js',
)

workspace_sources = files(
  'workspace/exports.js',
  'workspace/promptVariables.js',
  'workspace/workspace.js',
)

install_data(
  cusco_sources,
  install_dir: pkgdatadir,
)

install_data(
  chat_sources,
  install_dir: pkgdatadir / 'chat',
)

install_data(
  composer_sources,
  install_dir: pkgdatadir / 'composer',
)

install_data(
  computer_use_sources,
  install_dir: pkgdatadir / 'computerUse',
)

install_data(
  provider_sources,
  install_dir: pkgdatadir / 'providers',
)

install_data(
  memory_sources,
  install_dir: pkgdatadir / 'memory',
)

install_data(
  mcp_sources,
  install_dir: pkgdatadir / 'mcp',
)

install_data(
  cron_sources,
  install_dir: pkgdatadir / 'cron',
)

install_data(
  settings_sources,
  install_dir: pkgdatadir / 'settings',
)

install_data(
  secret_sources,
  install_dir: pkgdatadir / 'secrets',
)

install_data(
  storage_sources,
  install_dir: pkgdatadir / 'storage',
)

install_data(
  skill_sources,
  install_dir: pkgdatadir / 'skills',
)

install_data(
  tool_sources,
  install_dir: pkgdatadir / 'tools',
)

install_data(
  workspace_sources,
  install_dir: pkgdatadir / 'workspace',
)

configure_file(
  input: 'cusco.in',
  output: 'cusco',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)
