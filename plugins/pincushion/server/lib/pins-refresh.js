// Cost and concurrency controls for the MCP server's background pin refreshes.
//
// Multiple IDE windows can legitimately launch a Pincushion MCP server for the
// same workspace. Direct MCP tool reads remain independently authoritative, but
// periodic sync/refresh work must have exactly one local leader so duplicate
// processes cannot multiply Supabase invocations, attachment signing, or local
// artifact writes.

import { randomUUID } from 'crypto';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import { join } from 'path';

export const PINS_REFRESH_LEASE_DIR = '.pincushion-background-refresh-lease';

function positiveDuration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function leaseToken(value) {
  const token = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160);
  return token || `lease_${randomUUID().replace(/-/g, '')}`;
}

async function tokenMtime(leaseDir) {
  try {
    const names = await readdir(leaseDir);
    if (!names.length) return null;
    const times = await Promise.all(names.map(async (name) => {
      try {
        const info = await stat(join(leaseDir, name));
        return info.isFile() ? info.mtimeMs : null;
      } catch {
        return null;
      }
    }));
    return times.filter((value) => Number.isFinite(value)).sort((a, b) => b - a)[0] ?? null;
  } catch {
    return null;
  }
}

async function createLease(leaseDir, token, now, clock) {
  await mkdir(leaseDir);
  const tokenPath = join(leaseDir, token);
  await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  const at = new Date(now);
  await utimes(tokenPath, at, at);

  let released = false;
  return {
    acquired: true,
    reclaimedStale: false,
    async renew() {
      if (released) return false;
      try {
        const info = await stat(tokenPath);
        if (!info.isFile()) return false;
        const time = new Date(clock());
        await utimes(tokenPath, time, time);
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      if (released) return false;
      released = true;
      try {
        const info = await stat(tokenPath);
        if (!info.isFile()) return false;
        // Move only the directory that still contains this exact token before
        // deletion. A stale successor can create a new lease at leaseDir after
        // this rename, but this release only removes its private moved copy.
        const releasedDir = `${leaseDir}.released-${token}`;
        await rename(leaseDir, releasedDir);
        await rm(releasedDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// Acquire one lease for all background maintenance in a workspace. The lease
// is a directory, created atomically by mkdir; its token file doubles as the
// renewal heartbeat. A stale leader is renamed away before a successor tries
// to acquire, so an old release can never remove the successor's lease.
export async function acquirePinsRefreshLease({
  feedbackDir,
  clock = () => Date.now(),
  ttlMs = 60_000,
  tokenFactory = () => `lease_${randomUUID().replace(/-/g, '')}`,
} = {}) {
  if (!feedbackDir) throw new Error('feedbackDir is required');
  const nowClock = clock;
  const leaseDir = join(feedbackDir, PINS_REFRESH_LEASE_DIR);
  const ttl = positiveDuration(ttlMs, 60_000);
  const token = leaseToken(tokenFactory());
  let reclaimedStale = false;

  await mkdir(feedbackDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = nowClock();
    try {
      const lease = await createLease(leaseDir, token, now, nowClock);
      lease.reclaimedStale = reclaimedStale;
      return lease;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const heartbeat = await tokenMtime(leaseDir);
    const stale = heartbeat === null || nowClock() - heartbeat >= ttl;
    if (!stale) {
      return { acquired: false, reclaimedStale: false, renew: async () => false, release: async () => false };
    }

    const staleDir = `${leaseDir}.stale-${token}`;
    try {
      await rename(leaseDir, staleDir);
      reclaimedStale = true;
      await rm(staleDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST') {
        return { acquired: false, reclaimedStale: false, renew: async () => false, release: async () => false };
      }
    }
  }

  return { acquired: false, reclaimedStale: false, renew: async () => false, release: async () => false };
}

export function createBackgroundRefreshLease(options = {}) {
  let activeLease = null;
  let acquiring = null;

  return {
    async ensureLeader() {
      if (activeLease && await activeLease.renew()) return true;
      activeLease = null;
      if (acquiring) return acquiring;
      acquiring = acquirePinsRefreshLease(options)
        .then((lease) => {
          if (lease.acquired) activeLease = lease;
          return lease.acquired;
        })
        .finally(() => { acquiring = null; });
      return acquiring;
    },
    async release() {
      const lease = activeLease;
      activeLease = null;
      return lease ? lease.release() : false;
    },
  };
}

// Fetch an authoritative snapshot once, hand that immutable reference to each
// writer, and coalesce concurrent refresh triggers. Failure retry is bounded so
// a quota outage or 5xx does not turn the 15-second timer into a request storm.
export function createPinsRefreshCoordinator({
  fetchSnapshot,
  artifactWriters = [],
  clock = () => Date.now(),
  baseBackoffMs = 30_000,
  maxBackoffMs = 5 * 60_000,
  onFailure = async () => {},
} = {}) {
  if (typeof fetchSnapshot !== 'function') throw new Error('fetchSnapshot is required');
  const base = positiveDuration(baseBackoffMs, 30_000);
  const maximum = Math.max(base, positiveDuration(maxBackoffMs, 5 * 60_000));
  let inFlight = null;
  let failures = 0;
  let retryAt = 0;

  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    if (!force && clock() < retryAt) {
      return Promise.resolve({ status: 'backoff', retryAt });
    }

    const cycle = (async () => {
      let snapshotPromise = null;
      const readSnapshot = () => {
        if (!snapshotPromise) snapshotPromise = Promise.resolve().then(fetchSnapshot);
        return snapshotPromise;
      };
      try {
        // Establish the single authoritative read before any local artifact
        // write begins. Writers receive the same lazy accessor so existing
        // core helpers can retain their callback contract.
        await readSnapshot();
        const artifacts = [];
        for (const writer of artifactWriters) artifacts.push(await writer(readSnapshot));
        failures = 0;
        retryAt = 0;
        return { status: 'refreshed', artifacts };
      } catch (error) {
        failures = Math.min(failures + 1, 10);
        const delay = Math.min(maximum, base * (2 ** (failures - 1)));
        retryAt = clock() + delay;
        const result = { status: 'failed', retryAt, error };
        try { await onFailure(error, result); } catch { /* failure reporting must not restart the loop */ }
        return result;
      }
    })();
    inFlight = cycle;
    cycle.finally(() => {
      if (inFlight === cycle) inFlight = null;
    }).catch(() => {});
    return cycle;
  }

  return { refresh };
}
