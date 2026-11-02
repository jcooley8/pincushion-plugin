// lib/realtime.js — private revision notifications for authorized sync
//
// Realtime is a wake-up signal only. It must never carry annotation rows:
// the MCP server fetches canonical data through the license-authenticated
// journal API after receiving a revision notification.

import { createClient } from '@supabase/supabase-js';

const TOPIC_RE = /^pincushion:v1:p:([0-9a-f]{64}):a:[0-9a-f-]{36}:e:[0-9]+:x:([0-9]+):t:[0-9a-f]{64}$/;
// Supabase permits at most 100 channels on one Realtime connection.
const MAX_CHANNELS = 100;
const MAX_TOPIC_LENGTH = 255;
const EXPIRY_SAFETY_WINDOW_MS = 5_000;

function normalizeChannels(channels) {
  if (!Array.isArray(channels)) return [];
  const seen = new Set();
  return channels.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const topic = typeof entry.topic === 'string' ? entry.topic : '';
    const projectId = typeof entry.projectId === 'string' ? entry.projectId : '';
    const expiresAt = typeof entry.expiresAt === 'string' ? Date.parse(entry.expiresAt) : NaN;
    const topicMatch = topic && TOPIC_RE.exec(topic);
    if (!topic || topic.length > MAX_TOPIC_LENGTH || !topicMatch || seen.has(topic)) return [];
    const topicExpirySeconds = Number(topicMatch[2]);
    if (!Number.isSafeInteger(topicExpirySeconds) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return [];
    // The expiry metadata is part of the signed topic derivation. Reject a
    // mismatched companion value instead of trusting a response that could
    // keep an old socket alive longer than the database grant.
    if (Math.floor(expiresAt / 1000) !== topicExpirySeconds) return [];
    seen.add(topic);
    return [{ topic, projectId, expiresAt }];
  }).slice(0, MAX_CHANNELS);
}

function noopHandle() {
  return {
    unsubscribe: () => {},
    updateChannels: async () => {},
  };
}

/**
 * Start private, project-scoped Realtime listeners.
 *
 * `channels` is issued by sync-annotations and contains opaque short-lived
 * topics. There is deliberately no `licenseKey` option and no custom auth
 * header: an account credential must never be sent to the Realtime socket.
 *
 * @param {object} options
 * @param {string} options.supabaseUrl
 * @param {string} options.supabaseAnonKey
 * @param {Array<{projectId?: string, topic: string, expiresAt: string}>} options.channels
 * @param {function} [options.onRevision] - Called with revision-only metadata
 * @param {function} [options.onError] - Called on channel errors
 * @param {function} [options.createClientImpl] - Test seam for the Supabase client
 * @returns {{ unsubscribe: () => void, updateChannels: (channels: unknown[]) => Promise<void> }}
 */
export function startRealtimeListener({
  supabaseUrl,
  supabaseAnonKey,
  channels,
  onRevision = () => {},
  onError = () => {},
  createClientImpl = createClient,
}) {
  const normalized = normalizeChannels(channels);
  if (!supabaseUrl || !supabaseAnonKey) return noopHandle();
  if (normalized.length === 0) {
    // A grant can expire while the sync response is in flight. Keep a
    // credentialed-but-idle handle upgradeable so the next authorized sync
    // can attach fresh channels without requiring an MCP restart.
    let delegate = noopHandle();
    let delegateActive = false;
    let stopped = false;
    let updatePromise = Promise.resolve();
    return {
      unsubscribe: () => {
        stopped = true;
        delegate.unsubscribe();
      },
      updateChannels: async (nextChannels) => {
        if (stopped) return;
        updatePromise = updatePromise.then(async () => {
          if (stopped) return;
          const next = normalizeChannels(nextChannels);
          if (delegateActive) {
            await delegate.updateChannels(nextChannels);
            return;
          }
          if (next.length === 0) return;
          delegate = startRealtimeListener({
            supabaseUrl,
            supabaseAnonKey,
            channels: nextChannels,
            onRevision,
            onError,
            createClientImpl,
          });
          delegateActive = true;
        });
        await updatePromise;
      },
    };
  }

  const supabase = createClientImpl(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const active = new Map();
  let stopped = false;
  let updatePromise = Promise.resolve();

  const reportError = (error) => {
    try {
      onError(error);
    } catch (callbackError) {
      console.error('[realtime] Error callback failed:', callbackError?.message || 'unknown');
    }
  };

  const removeTopic = async (topic) => {
    const current = active.get(topic);
    if (!current) return;
    active.delete(topic);
    if (current.expiryTimer) clearTimeout(current.expiryTimer);
    try {
      await supabase.removeChannel(current.channel);
    } catch (error) {
      reportError(error);
    }
  };

  const subscribe = (entry) => {
    const channel = supabase
      .channel(entry.topic, { config: { private: true } })
      .on('broadcast', { event: 'annotation_changed' }, (message) => {
        // Supabase wraps broadcast data in `payload`. Do not pass through any
        // other fields; annotation data is fetched via the authenticated API.
        const payload = message?.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const revision = typeof payload.revision === 'number' || typeof payload.revision === 'string'
          ? String(payload.revision)
          : '';
        if (!/^(?:0|[1-9][0-9]{0,18})$/.test(revision)) return;
        const event = {
          projectId: entry.projectId || (typeof payload.projectId === 'string' ? payload.projectId : null),
          annotationId: typeof payload.annotationId === 'string' ? payload.annotationId : null,
          revision,
          action: typeof payload.action === 'string' ? payload.action : null,
          deleted: payload.deleted === true,
        };
        try {
          const result = onRevision(event);
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(reportError);
          }
        } catch (error) {
          reportError(error);
        }
      })
      .subscribe((status, error) => {
        if (status === 'SUBSCRIBED') {
          console.error(`[realtime] Connected to private revision channel for ${entry.projectId || 'project'}`);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reportError(error || new Error(`Realtime channel ${status.toLowerCase()}`));
        }
      });

    const expiryTimer = setTimeout(() => {
      removeTopic(entry.topic).catch(() => {});
      if (!stopped) reportError(new Error('Realtime grant expired; waiting for the next authorized sync'));
    }, Math.max(1_000, entry.expiresAt - Date.now() - EXPIRY_SAFETY_WINDOW_MS));
    active.set(entry.topic, { channel, expiryTimer });
  };

  const subscribeAll = async (nextChannels) => {
    const normalizedNext = normalizeChannels(nextChannels);
    const nextTopics = new Set(normalizedNext.map((entry) => entry.topic));
    const oldTopics = [...active.keys()].filter((topic) => !nextTopics.has(topic));
    await Promise.all(oldTopics.map((topic) => removeTopic(topic)));
    if (stopped) return;
    for (const entry of normalizedNext) {
      if (!active.has(entry.topic)) subscribe(entry);
    }
  };

  for (const entry of normalized) subscribe(entry);

  return {
    unsubscribe: () => {
      stopped = true;
      for (const topic of [...active.keys()]) removeTopic(topic).catch(() => {});
      console.error('[realtime] Unsubscribing from private revision channels');
    },
    updateChannels: async (nextChannels) => {
      if (stopped) return;
      updatePromise = updatePromise.then(() => subscribeAll(nextChannels));
      await updatePromise;
    },
    channel: active.values().next().value?.channel,
    supabase,
  };
}

export { normalizeChannels };
