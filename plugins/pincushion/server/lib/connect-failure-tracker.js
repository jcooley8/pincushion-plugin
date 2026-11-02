// Decides when a configured MCP server's failure to reach its account counts
// as a failed connection (`connect_failed`, stage `mcp`). Each reason is
// reported at most once per process.
//   - A rejected key is definitive: `license_rejected` at once.
//   - An unreachable cloud is often a blip (sleep/wake, a flaky network): it
//     counts as `cloud_unreachable` only if the server is still unavailable,
//     with a key, after `graceMs` and no authenticated sync came in between.
//   - No configured key is local-only mode, never a failure.
// Pure and timer-injectable so the decision is unit-tested apart from server.js.
export const CLOUD_UNREACHABLE_GRACE_MS = 2 * 60_000;

export function createConnectFailureTracker({
  report,
  currentState,
  currentKey,
  graceMs = CLOUD_UNREACHABLE_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const reported = new Set();
  let timer = null;
  const once = (reason) => {
    if (reported.has(reason)) return;
    reported.add(reason);
    try { report(reason); } catch { /* telemetry is never load-bearing */ }
  };
  const cancel = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  return {
    reported,
    // Call on every auth-state change, with the state being entered.
    transition(state, key) {
      if (state === 'authenticated') { cancel(); return; }
      if (state === 'rejected') { cancel(); once('license_rejected'); return; }
      if (state !== 'unavailable' || !key || timer || reported.has('cloud_unreachable')) return;
      timer = setTimer(() => {
        timer = null;
        if (currentState() === 'unavailable' && currentKey()) once('cloud_unreachable');
      }, graceMs);
      timer?.unref?.();
    },
  };
}
