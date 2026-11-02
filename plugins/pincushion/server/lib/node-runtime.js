// Supported Node.js runtime check, shared by the cli.js preflight, server.js,
// and setup. Keep this file dependency-free and limited to syntax that parses
// on old Node releases (ES2018 + ESM, no `?.`/`??`): cli.js loads it before
// anything that could fail to link on an unsupported runtime.
//
// The range must match package.json "engines", manifest.json
// compatibility.runtimes.node, and scripts/test-supported-node-runtimes.mjs.

import { writeSync } from 'fs';

// SUPPORTED_NODE_ENGINE is the declared, CI-verified window (Node 22.22+ and
// 24). The runtime gate below only refuses releases older than 22.22: newer
// Node releases (25, 26, ...) start normally, with npm's engines advisory.
export const SUPPORTED_NODE_ENGINE = '^22.22.0 || ^24.0.0';
export const SUPPORTED_NODE_LABEL = 'Node.js 22.22+ or Node.js 24';
export const NODE_UPGRADE_COMMAND = 'nvm install 22 && nvm use 22';
export const NODE_DOWNLOAD_URL = 'https://nodejs.org';
export const NODE_RUNTIME_DOCS_URL = 'https://www.npmjs.com/package/pincushion-mcp#troubleshooting';

export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 22);
}

function rerunHint(command) {
  if (!command) return 'Then restart the Pincushion MCP server in your editor or agent.';
  return 'Then run `npx pincushion-mcp ' + command + '` again.';
}

export function unsupportedNodeMessage(version, command) {
  return [
    'Pincushion needs ' + SUPPORTED_NODE_LABEL + '. You are running Node.js v' + String(version).replace(/^v/, '') + '.',
    '',
    'Upgrade with nvm:',
    '  ' + NODE_UPGRADE_COMMAND,
    'Or download Node.js from ' + NODE_DOWNLOAD_URL,
    '',
    rerunHint(command),
    'Docs: ' + NODE_RUNTIME_DOCS_URL,
    '',
  ].join('\n');
}

// Returns { supported, version, message }. `command` is the CLI subcommand
// (e.g. "setup", "login"), or empty for stdio MCP server mode.
export function checkNodeRuntime(options) {
  const opts = options || {};
  const version = process.versions.node;
  const supported = isSupportedNodeVersion(version);
  return {
    supported: supported,
    version: version,
    message: supported ? '' : unsupportedNodeMessage(version, opts.command),
  };
}

const CLI_COMMANDS = ['setup', 'login', 'claim', 'capture', 'remote-url', 'mcp-url', 'snapshot', 'mobile-wall'];

export function cliCommand(argv) {
  const first = (argv || [])[0];
  return CLI_COMMANDS.indexOf(first) >= 0 ? first : '';
}

// Writes the friendly message to stderr only (stdout is the JSON-RPC channel
// in stdio mode) and exits non-zero. No stack trace. The write is synchronous
// so process.exit cannot truncate it on a piped stderr.
export function exitIfUnsupportedNodeRuntime(argv) {
  const result = checkNodeRuntime({ command: cliCommand(argv || process.argv.slice(2)) });
  if (result.supported) return;
  try { writeSync(2, result.message); } catch (error) { process.stderr.write(result.message); }
  process.exit(1);
}
