// Capture only: no LLM, pin writes, reports, or browser provisioning.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function runCapture(argv = []) {
  if (process.platform === 'win32') {
    console.error('Capture is unavailable on Windows: owned browser-tree cleanup is not supported yet. MCP setup remains available.');
    return 1;
  }
  if (argv.length < 2 || argv.some((arg) => arg.startsWith('--') &&
    !/^(--page-only|--require-auth|--inventory=.+|--pins=.+)$/.test(arg))) {
    console.error('Usage: pincushion-mcp capture <url> <outputDir> [--inventory=<file>] [--pins=<file>] [--page-only] [--require-auth]');
    return 2;
  }
  const helper = fileURLToPath(new URL('./scripts/capture-snapshot.mjs', import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, '--critique', ...argv], {
      stdio: 'inherit', detached: process.platform !== 'win32',
      env: { ...process.env, PINCUSHION_CAPTURE_NO_INSTALL: '1' },
    });
    let expired = false;
    let interruption = 0;
    const stop = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* owned process group already exited */ }
    };
    const timer = setTimeout(() => { expired = true; stop(); }, 180_000);
    const interrupted = () => { interruption = 130; stop(); };
    const terminated = () => { interruption = 143; stop(); };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', terminated);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', terminated);
    };
    child.once('error', () => { cleanup(); console.error('Capture could not start.'); resolve(1); });
    child.once('close', (code) => {
      cleanup();
      stop(); // Close any remaining children in this invocation's own group.
      if (expired) console.error('Capture stopped after 180 seconds; coverage is incomplete. No report was published.');
      else if (interruption) console.error('Capture interrupted; coverage is incomplete. No report was published.');
      resolve(expired ? 124 : interruption || (code ?? 1));
    });
  });
}
