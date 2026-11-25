// update-check.js — tell people when the pincushion-mcp they are running is
// older than the one on npm.
//
// `npx pincushion-mcp …` without a version reuses whatever copy npx cached the
// first time, so a developer can run a months-old build without knowing it
// (Nov 22 2026: a new signup set up a project with a two-month-old 1.11.16).
// Every setup command we print now says `pincushion-mcp@latest`; this check
// covers people who already have an old copy cached.
//
// The check is a single bounded GET of npm's public `latest` dist-tag. It
// never blocks the MCP handshake or setup, never throws, sends nothing about
// the user, and is skipped in tests, CI and when PINCUSHION_NO_UPDATE_CHECK=1.

export const LATEST_URL = 'https://registry.npmjs.org/pincushion-mcp/latest';
export const UPDATE_COMMAND = 'npx -y pincushion-mcp@latest setup';
const DEFAULT_TIMEOUT_MS = 2500;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(version) {
  const match = VERSION_PATTERN.exec(String(version || '').trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' };
}

// -1 when a < b, 0 when equal, 1 when a > b; null when either is unparseable.
// A prerelease sorts before its release (1.2.0-beta.1 < 1.2.0).
export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export function updateCheckDisabled(env = process.env) {
  return env.PINCUSHION_NO_UPDATE_CHECK === '1' ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    Boolean(env.JEST_WORKER_ID) ||
    (Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0');
}

// Resolves to { current, latest, outdated } or null when the check is skipped
// or npm cannot be read in time. Never rejects.
export async function checkLatestVersion({
  current,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  force = false,
} = {}) {
  if (!force && updateCheckDisabled(env)) return null;
  if (!parse(current) || typeof fetchImpl !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(LATEST_URL, {
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response?.ok) return null;
    const body = await response.json();
    const latest = typeof body?.version === 'string' ? body.version : null;
    const order = compareVersions(current, latest);
    if (order === null) return null;
    return { current, latest, outdated: order < 0 };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The one sentence people and agents see. Plain text so it reads the same on a
// terminal, in an agent transcript and in a tool result.
export function outdatedNotice({ current, latest } = {}) {
  if (!current || !latest) return '';
  return `This is pincushion-mcp ${current}, but ${latest} is the latest. Run \`${UPDATE_COMMAND}\` in this repo to update, then restart your AI agent so it loads the new version.`;
}
