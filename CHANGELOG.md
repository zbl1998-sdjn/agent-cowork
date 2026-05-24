# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and release versions use SemVer.

## [Unreleased]

### Added

- Added the local `npm run ci` gate for architecture checks, file-size checks, host tests, and UI tests.
- Added a dry-run-first release skeleton for SemVer validation, VERSION planning, git bundle planning, installer signing/archive planning, and tag planning.
- Added testing and release checklist documentation for milestone gates.

## [0.2.0] - 2026-05-25

### Added

- Archived the P0 + FE-1 Windows release under `releases/v0.2.0/` with NSIS, MSI, VERSION, source bundle, manifest, and installed Tauri smoke evidence.

### Fixed

- Made the Windows signing script discover the current `Agent Cowork_*` installer names instead of hard-coding `0.1.0`.

## [0.1.0] - 2026-05-24

### Added

- Baseline local Agent Cowork MVP release snapshot under `releases/v0.1.0/`.
