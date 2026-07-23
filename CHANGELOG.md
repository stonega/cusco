# Changelog

All notable user-visible changes to Cusco are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/stonega/cusco/compare/v0.5.17...HEAD
[0.5.17]: https://github.com/stonega/cusco/compare/v0.5.16...v0.5.17
[0.5.16]: https://github.com/stonega/cusco/compare/v0.5.15...v0.5.16
[0.5.15]: https://github.com/stonega/cusco/compare/v0.5.14...v0.5.15
[0.5.14]: https://github.com/stonega/cusco/compare/v0.5.13...v0.5.14
[0.5.13]: https://github.com/stonega/cusco/compare/v0.5.12...v0.5.13
