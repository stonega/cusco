# Changelog

All notable user-visible changes to Cusco are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Providers with matching API keys in the environment are now enabled automatically at startup.

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

[Unreleased]: https://github.com/stonega/cusco/compare/v0.5.15...HEAD
[0.5.15]: https://github.com/stonega/cusco/compare/v0.5.14...v0.5.15
[0.5.14]: https://github.com/stonega/cusco/compare/v0.5.13...v0.5.14
[0.5.13]: https://github.com/stonega/cusco/compare/v0.5.12...v0.5.13
