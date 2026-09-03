# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Native adapters for Claude and Codex that read credentials at call time and never refresh tokens.
- Optional Swift engine on CodexBarCore for Antigravity and additional providers.
- Local inference pools (vLLM, llama.cpp) reported as capacity with UP, BUSY and DOWN states.
- SQLite history, reset and free-reset events, pace states with a post-reset grace period.
- `headroom can` go/no-go across every meter an action consumes; `--threshold` exit codes.
- Daemon on a Unix socket, stdio MCP server, launchd and systemd service installer.
- Rejection of availability-only vendor payloads that other tools render as full meters.
