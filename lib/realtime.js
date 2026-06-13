// lib/realtime.js — Supabase Realtime listener for push-based pin notifications
// Subscribes to annotation changes and fires callbacks for status transitions.
// Used by the MCP server to detect newly approved pins in real time.

import { createClient } from '@supabase/supabase-js';

/**
 * Start a Realtime subscription for a project's annotations.
 *
 * @param {object} options
 * @param {string} options.supabaseUrl - Direct Supabase URL (e.g. https://xxx.supabase.co)
 * @param {string} options.supabaseAnonKey - Public anon key (safe to embed)
 * @param {string} options.projectId - Project ID to filter changes
 * @param {string} options.licenseKey - License key for RLS (passed as auth header)
 * @param {function} options.onPinApproved - Called when a pin transitions to 'approved'
 * @param {function} options.onPinUpdated - Called on any annotation change
 * @param {function} options.onPinCreated - Called when a new pin is inserted
 * @param {function} [options.onError] - Called on channel errors
 * @returns {{ unsubscribe: () => void }}
 */
export function startRealtimeListener({
  supabaseUrl,
  supabaseAnonKey,
  projectId,
  licenseKey,
  onPinApproved = () => {},
  onPinUpdated = () => {},
  onPinCreated = () => {},
  onError = () => {},
}) {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[realtime] Missing Supabase credentials — skipping Realtime');
    return { unsubscribe: () => {} };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    // Pass license key as custom header for RLS policies
    global: {
      headers: { 'x-license-key': licenseKey },
    },
  });

  const channelName = `pincushion-${projectId || 'all'}`;
  const filterClause = projectId ? `project_id=eq.${projectId}` : undefined;

  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'annotations',
      ...(filterClause ? { filter: filterClause } : {}),
    }, (payload) => {
      const { new: newRow, old: oldRow } = payload;

      // Detect status transition to ready/approved.
      // The cloud schema uses `ready` post-rename_approved_to_ready_status migration;
      // `approved` is the legacy alias still found in older clients. Treat both as
      // the same implementation-ready signal so realtime fires on either label.
      const isReady = (s) => s === 'ready' || s === 'approved';
      if (isReady(newRow.status) && !isReady(oldRow?.status)) {
        onPinApproved({
          id: newRow.id,
          pageUrl: newRow.page_url,
          pageTitle: newRow.page_title,
          approvedBy: newRow.approved_by,
          approvedAt: newRow.approved_at,
          comment: newRow.thread?.[0]?.body?.slice(0, 80) || '',
          projectId: newRow.project_id,
        });
      }

      // Fire generic update callback
      onPinUpdated(newRow, oldRow);
    })
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'annotations',
      ...(filterClause ? { filter: filterClause } : {}),
    }, (payload) => {
      onPinCreated({
        id: payload.new.id,
        pageUrl: payload.new.page_url,
        pageTitle: payload.new.page_title,
        author: payload.new.author,
        comment: payload.new.thread?.[0]?.body?.slice(0, 80) || '',
        projectId: payload.new.project_id,
      });

      onPinUpdated(payload.new, null);
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.error(`[realtime] Connected to channel "${channelName}" — listening for pin changes`);
      } else if (status === 'CHANNEL_ERROR') {
        console.error(`[realtime] Channel error on "${channelName}":`, err?.message || 'unknown');
        onError(err);
      } else if (status === 'TIMED_OUT') {
        console.error(`[realtime] Channel "${channelName}" timed out — will retry`);
      } else if (status === 'CLOSED') {
        console.error(`[realtime] Channel "${channelName}" closed`);
      }
    });

  return {
    unsubscribe: () => {
      console.error(`[realtime] Unsubscribing from channel "${channelName}"`);
      supabase.removeChannel(channel);
    },
    channel,
    supabase,
  };
}
