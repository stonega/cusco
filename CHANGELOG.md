# Changelog

All notable user-visible changes to Cusco are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added automatic Fedora COPR submission and build verification for tagged releases.

### Fixed

- Kept disabled provider and model selectors opaque while a chat response is running.

## [0.5.33] - 2026-08-04

### Added

- Added Fedora COPR packaging for supported Fedora releases and Rawhide on x86_64 and aarch64.
- Added an active status dot in each working chat's sidebar menu position, yielding to the chat menu on hover.

### Fixed

- Kept each chat's running indicator, elapsed timer, model controls, and queued messages attached to the correct chat when switching or creating a chat during a response.

## [0.5.32] - 2026-08-03

### Fixed

- Removed the empty icon placeholders from the artifact Preview and Source tabs.
- Kept Cusco responsive during output-heavy tool calls, gave shell tools a bounded five-minute window, and stopped timed-out command descendants from holding agent turns open.

## [0.5.31] - 2026-08-02

### Fixed

- Fixed idle memory growth caused by repeatedly rebuilding unchanged chat sidebar rows during cron log polling.

## [0.5.30] - 2026-07-31

### Changed

- Expanded tool results now appear above their artifact cards in assistant messages.

### Fixed

- Question-and-answer panels now use an opaque background so conversation content cannot show through them.

## [0.5.29] - 2026-07-30

### Changed

- Restyled image-editor shapes, arrows, lines, and text with Cartoonist sketch strokes and clearly handwritten type; arrows now have a draggable midpoint curvature handle.

## [0.5.28] - 2026-07-29

### Changed

- Cusco now opens configured sessions in a fresh unsaved chat with the message input focused, and ordinary empty chats stay out of history until the first non-empty user message.

### Fixed

- Computer use now centers popup crops on the relevant visual change and rejects clicks outside the active popup before they can close or retrigger it.
- Pressing Enter in the sudo password dialog now runs the pending command.

## [0.5.27] - 2026-07-28

### Added

- The message composer now supports familiar Readline/Emacs editing shortcuts for cursor movement, line and word deletion, transposition, and yank.
- Up and Down now navigate each chat's input history while preserving the current draft and normal multiline cursor movement.

### Changed

- Built-in DuckDuckGo search is now the default fallback for explicit web searches and models without native search, requiring no API key or additional software; Exa Search remains available as an optional API-key fallback with a free tier.

### Fixed

- Slash-command tool results such as `/search` now remain visually grouped with the assistant response, including after reopening the conversation.

## [0.5.26] - 2026-07-27

### Changed

- The Hooks configuration file now appears in Workspace settings after MCP, without a separate Hooks settings page.
- Turning on Computer Use now automatically enables Cusco's GNOME Shell extension for the current user.

## [0.5.25] - 2026-07-27

### Added

- A per-user installer now installs Cusco under `$HOME/.local` without requiring root access.

### Fixed

- Custom symbolic button icons now render reliably on Ubuntu and follow light, dark, and high-contrast theme changes.

## [0.5.24] - 2026-07-27

### Fixed

- Ubuntu now uses Cusco's stone-texture application icon instead of the obsolete chat-bubble artwork.
- Saving an API key now immediately enables its provider on Ubuntu and keeps the key available after Secret Service completes.

## [0.5.23] - 2026-07-26

### Changed

- Release tarballs and Debian packages now use Zstandard level 19 compression, matching RPM packages.
- The welcome chat now provides a richer formatted guide, and new chats start with Memory off and Agent plus enabled Skills on.
- Token usage details now show Cached and Uncached directly without a redundant Input row.

### Fixed

- Providers can now be enabled immediately after saving an API key through Secret Service.
- Bundled symbolic SVG icons now render with the correct theme color on Ubuntu.
- Assistant and welcome text no longer appears selected while it is streaming.

## [0.5.22] - 2026-07-26

### Added

- Sudo password prompts now send a desktop notification when Cusco is not active.
- Active computer-use job descriptions now shimmer in the GNOME panel, and clicking the indicator returns to Cusco.

### Changed

- Agents now automatically exit computer use and hide its GNOME top-bar indicator once desktop control is no longer needed.
- Computer use now reuses suitable existing windows and can move one to a fresh workspace atomically, avoiding GNOME dynamic-workspace index churn.
- Enlarged computer-use screenshots now use a clearer grid and concise center-targeting guidance.
- The welcome chat now opens with one concise, gently streamed quick-start message without a regenerate button.

### Fixed

- API-key saves and removals no longer freeze the window while Secret Service is working.
- Composer provider and model labels now remain readable on light themes.
- Bundled symbolic toolbar icons and the scalable application icon now load correctly from release packages.
- Missed clicks inside an enlarged region now keep that crop visible for one centered retry instead of falling back to the full window.
- Popup loop detection now survives unchanged option misses and manual region observations.
- Active window capture now waits for verified focus and hides GNOME Overview instead of returning unrelated desktop pixels.

## [0.5.21] - 2026-07-24

### Changed

- RPM release packages now use Zstandard compression for smaller downloads.

## [0.5.20] - 2026-07-24

### Added

- Hovering over the chat header message count now shows message, tool, and token totals.
- Very long text pasted into the composer is now added as a private `.txt` article attachment.

### Changed

- Chat loading states now show the empty-chat artwork without a spinner or loading text.

### Fixed

- Streaming code blocks now keep a stable themed background while their content updates.

## [0.5.19] - 2026-07-23

### Changed

- Expanded reasoning content now has a subtle left border for clearer visual separation.

### Fixed

- Tool call subtitles are now limited to one line.

## [0.5.18] - 2026-07-23

### Added

- Added reviewed local lifecycle hooks for prompts, tools, permissions, context compaction, and turn completion, with per-chat working directories and native trust controls.
- Empty chats can now use a custom image selected from Chat settings, with an option to restore Cusco's default artwork.

### Fixed

- Text annotations in the image editor now edit directly on the canvas without a separate input bar.

## [0.5.17] - 2026-07-23

### Fixed

- Absolute local file links, including generated images, now open through valid file URIs.
- User message bubbles now keep the same background color in light and dark themes.

## [0.5.16] - 2026-07-22

### Added

- Added a maintained changelog and a current application screenshot to the public project documentation.

### Changed

- Providers with matching API keys in the environment are now enabled automatically at startup.
- GitHub releases now publish their notes from the matching changelog section.

## [0.5.15] - 2026-07-22

### Added

- Added Gemini 3.5 Flash-Lite support.
- Added support for pasting image attachments directly into the composer.

### Changed

- Long conversations now load their transcripts lazily for faster chat switching.
- Updated provider endpoints, model metadata, and native tool handling.

### Fixed

- Fixed Ask User cancellation behavior and question layout.

## [0.5.14] - 2026-07-22

### Added

- Added a native image viewer and editor with crop, transform, drawing, shape, arrow, and text tools.

### Changed

- Improved multimodal image attachments, previews, and generated-image workflows.

## [0.5.13] - 2026-07-21

### Added

- Added a native clipboard paste action.
- Added clearer agent activity feedback and improved agent workflows.

### Changed

- Hardened computer-use control flow and action verification.

### Fixed

- Fixed Gemini parallel tool-call signatures.
- Fixed long-response notification property handling.

Earlier releases are available on the [GitHub releases page](https://github.com/stonega/cusco/releases).

[Unreleased]: https://github.com/stonega/cusco/compare/v0.5.33...HEAD
[0.5.33]: https://github.com/stonega/cusco/compare/v0.5.32...v0.5.33
[0.5.32]: https://github.com/stonega/cusco/compare/v0.5.31...v0.5.32
[0.5.31]: https://github.com/stonega/cusco/compare/v0.5.30...v0.5.31
[0.5.30]: https://github.com/stonega/cusco/compare/v0.5.29...v0.5.30
[0.5.29]: https://github.com/stonega/cusco/compare/v0.5.28...v0.5.29
[0.5.28]: https://github.com/stonega/cusco/compare/v0.5.27...v0.5.28
[0.5.27]: https://github.com/stonega/cusco/compare/v0.5.26...v0.5.27
[0.5.26]: https://github.com/stonega/cusco/compare/v0.5.25...v0.5.26
[0.5.25]: https://github.com/stonega/cusco/compare/v0.5.24...v0.5.25
[0.5.24]: https://github.com/stonega/cusco/compare/v0.5.23...v0.5.24
[0.5.23]: https://github.com/stonega/cusco/compare/v0.5.22...v0.5.23
[0.5.22]: https://github.com/stonega/cusco/compare/v0.5.21...v0.5.22
[0.5.21]: https://github.com/stonega/cusco/compare/v0.5.20...v0.5.21
[0.5.20]: https://github.com/stonega/cusco/compare/v0.5.19...v0.5.20
[0.5.19]: https://github.com/stonega/cusco/compare/v0.5.18...v0.5.19
[0.5.18]: https://github.com/stonega/cusco/compare/v0.5.17...v0.5.18
[0.5.17]: https://github.com/stonega/cusco/compare/v0.5.16...v0.5.17
[0.5.16]: https://github.com/stonega/cusco/compare/v0.5.15...v0.5.16
[0.5.15]: https://github.com/stonega/cusco/compare/v0.5.14...v0.5.15
[0.5.14]: https://github.com/stonega/cusco/compare/v0.5.13...v0.5.14
[0.5.13]: https://github.com/stonega/cusco/compare/v0.5.12...v0.5.13
