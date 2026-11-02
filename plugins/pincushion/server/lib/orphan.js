// Orphan self-reaping for the MCP server.
//
// MCP stdio servers are children of the host (Claude Desktop / Code / Cursor).
// On a CLEAN host shutdown the server gets SIGTERM or stdin EOF and exits (see
// the handlers in server.js). But on a HARD host quit/crash, neither signal is
// delivered: the child is reparented to launchd/init (pid 1) and lingers forever
// — holding the bridge port (127.0.0.1:3456), polling the cloud, and storming the
// shared .feedback/ files. Enough of those pile up and the next reconnect fails
// with "Server disconnected". See memory: pincushion-mcp-orphan-disconnect.
//
// The fix is for each process to watch ONLY its own parent. We never scan or kill
// sibling processes, because Claude Desktop and Claude Code legitimately run
// separate servers for the same --project-dir simultaneously — a cross-process
// reaper would make them murder each other.

/**
 * True only when a process that started under a real host parent has since been
 * reparented to init (pid 1) — the unambiguous "my host died" signal.
 *
 * Deliberately conservative: returns false when the parent is unchanged, when the
 * process was launched directly under init (initialPpid === 1, nothing to lose),
 * or when reparented to a non-init subreaper (Linux) where we can't be certain.
 *
 * @param {number} currentPpid - process.ppid right now
 * @param {number} initialPpid - process.ppid captured at boot
 * @returns {boolean}
 */
export function isReparentedOrphan(currentPpid, initialPpid) {
  return initialPpid !== 1 && currentPpid === 1;
}

/**
 * Poll the process's own parent pid; invoke onOrphaned() once it has been
 * reparented to init. The interval is unref'd so it never keeps the event loop
 * alive on its own — it only fires because the orphan's other handles (bridge
 * server, sync loop, pins-refresh timer) keep the process running.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.getPpid]   - parent-pid reader (injectable for tests)
 * @param {number} [opts.initialPpid]     - boot-time parent pid
 * @param {number} [opts.intervalMs]      - poll cadence
 * @param {() => void} opts.onOrphaned    - called when reparenting is detected
 * @returns {NodeJS.Timeout}
 */
export function startOrphanWatch({
  getPpid = () => process.ppid,
  initialPpid = process.ppid,
  intervalMs = 10000,
  onOrphaned,
} = {}) {
  const timer = setInterval(() => {
    if (isReparentedOrphan(getPpid(), initialPpid)) {
      clearInterval(timer);
      onOrphaned();
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
