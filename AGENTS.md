# Pincushion plugin repository

This repository is the plugin marketplace that installs Pincushion in Claude
Code, Codex and Cursor. All three hosts install the same plugin folder.

## Layout

- `plugins/pincushion/` is the plugin. Its `skills/` are canonical for every
  host (`skills/<name>/SKILL.md`, one level deep).
- Host manifests inside the plugin: `.claude-plugin/plugin.json` (Claude Code,
  MCP in `.mcp.json`, runs the vendored server in `server/`),
  `.codex-plugin/plugin.json` (Codex, MCP in `.codex.mcp.json`) and
  `.cursor-plugin/plugin.json` (Cursor, MCP in `.cursor.mcp.json`, plus the
  Cursor-only `rules/`).
- Marketplaces at the repository root: `.claude-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json` (Codex) and `.cursor-plugin/marketplace.json`.
- `plugins/pincushion/server/` is an unmodified copy of the published
  `pincushion-mcp` npm package (minus CONTRIBUTING.md, Dockerfile,
  smithery.yaml and test-*.mjs). Its source lives in the private monorepo;
  never edit it here.
- `pincushion-grok/` is the separate Grok plugin. The root `server.js`, `lib/`,
  `commands/` and root `package.json` are legacy and not used by any
  marketplace entry.

## Rules

- Keep the plugin name `pincushion` so Claude Code skills are
  `/pincushion:<skill>`.
- Keep `doctor` read-only.
- Never ask for or write a license key in a skill, manifest or MCP config.
- Keep every manifest version, the Codex and Cursor `pincushion-mcp@<version>`
  pins, `package.json`/`package-lock.json`, `server.json` and the READMEs on the
  same `pincushion-mcp` version. To update: replace `server/` from the new npm
  tarball, keep `server/demo/`, then bump every reference.
- Skills only name MCP tools the vendored server exposes.

## Validation

```bash
node --test tests/*.test.mjs
claude plugin validate .
claude plugin validate plugins/pincushion
```

The layout and the setup and doctor workflow pattern follow
[spotify/portal-ai-plugins](https://github.com/spotify/portal-ai-plugins)
(Apache-2.0). No files were copied from it.
