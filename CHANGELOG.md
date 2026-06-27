# Changelog

All notable changes to wumpiary are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [Unreleased]
### Added
- This changelog.

## [0.4.2-alpha] - 2026-06-26
### Fixed
- Linux release build: install the X11 dev headers needed to compile `uiohook-napi`, fixing AppImage/deb packaging in CI.

## [0.4.1] - 2026-06-26
### Added
- Bundled default plugins and a much-expanded plugin platform: new `network`, `files`, `clipboard`, `hotkeys`, and `discord-view` permissions; plugin windows and in-app config panels; Discord-view content scripts; manifest metadata badges.

## [0.4.0-alpha] - 2026-06-26
### Added
- Notification stream/inbox batching; call and notification indicators.
### Fixed
- Chime sound policy, push-to-talk/inbox follow-ups, stream browser identity picker, and event-based notification shake (cleared on focus).

## [0.3.0-alpha] - 2026-06-26
### Added
- App-level push-to-talk; custom window controls (native menu bar removed); Discord theme-colour syncing.
### Fixed
- Login autofill.

## [0.2.0-alpha] - 2026-06-25
### Added
- First release: run multiple Discord accounts at once, each in an isolated, persistent session kept connected in the background, with per-account notifications.
- Right-hand perch sidebar with unread/mention counters and connection status.
- PIN-gated encrypted vault with saved-login autofill.
- Sandboxed, permission-gated plugin system.
- zod-validated IPC; cross-platform packaging and release pipeline.
