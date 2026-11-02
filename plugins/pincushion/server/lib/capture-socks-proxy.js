// A capture-only SOCKS5 CONNECT boundary. Chromium sends the original hostname
// here, this process resolves both A and AAAA at connection time, and the
// resulting TCP socket is opened only to one independently vetted numeric IP.
// The proxy is a byte tunnel: HTTPS SNI, certificate validation, and Host stay
// owned by Chromium and are never rewritten here.

import { lookup } from 'node:dns/promises';
import net, { isIP } from 'node:net';
import {
  MAX_CAPTURE_DNS_ADDRESSES,
  MAX_CAPTURE_DNS_RESOLVE_MS,
  NETWORK_CAPTURE_FAILURE_EXIT_CODE,
  classifyCaptureNetworkAddress,
  isAllowedCaptureLoopbackSocket,
} from './capture-network-guard.js';

export const MAX_CAPTURE_PROXY_DNS_LOOKUPS = 64;
export const MAX_CAPTURE_PROXY_CONNECTIONS = 32;
export const MAX_CAPTURE_PROXY_CONNECT_ATTEMPTS = 64;
export const MAX_CAPTURE_PROXY_CONNECT_MS = 5000;
export const MAX_CAPTURE_PROXY_HANDSHAKE_MS = 5000;
export const MAX_CAPTURE_PROXY_REQUEST_BYTES = 1024;
export const MAX_CAPTURE_PROXY_DRAIN_MS = 6000;

const SOCKS_VERSION = 0x05;
const SOCKS_NO_AUTH = 0x00;
const SOCKS_NO_ACCEPTABLE_AUTH = 0xff;
const SOCKS_CONNECT = 0x01;
const SOCKS_BIND = 0x02;
const SOCKS_UDP_ASSOCIATE = 0x03;
const SOCKS_ADDRESS_IPV4 = 0x01;
const SOCKS_ADDRESS_DOMAIN = 0x03;
const SOCKS_ADDRESS_IPV6 = 0x04;
const SOCKS_REPLY_SUCCEEDED = 0x00;
const SOCKS_REPLY_GENERAL_FAILURE = 0x01;
const SOCKS_REPLY_COMMAND_NOT_SUPPORTED = 0x07;

function failure(code) {
  const error = new Error('capture SOCKS boundary rejected request');
  error.captureNetworkCode = code;
  error.exitCode = NETWORK_CAPTURE_FAILURE_EXIT_CODE;
  return error;
}

function bareAddress(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '');
}

function parseIpv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
  return parsed.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parsed : null;
}

function expandIpv6(value) {
  let raw = bareAddress(value).toLowerCase();
  if (!raw || raw.includes('%')) return null;
  const ipv4Colon = raw.lastIndexOf(':');
  if (raw.includes('.')) {
    const ipv4 = parseIpv4(raw.slice(ipv4Colon + 1));
    if (!ipv4) return null;
    raw = `${raw.slice(0, ipv4Colon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const chunks = raw.split('::');
  if (chunks.length > 2) return null;
  const left = chunks[0] ? chunks[0].split(':') : [];
  const right = chunks.length === 2 && chunks[1] ? chunks[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const zeroes = 8 - left.length - right.length;
  if ((chunks.length === 1 && zeroes !== 0) || zeroes < 0) return null;
  const groups = [...left, ...Array(zeroes).fill('0'), ...right].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 ? groups : null;
}

function comparableAddress(value) {
  const address = bareAddress(value);
  const family = isIP(address);
  if (family === 4) {
    const parsed = parseIpv4(address);
    return parsed ? `4:${parsed.join('.')}` : null;
  }
  if (family !== 6) return null;
  const groups = expandIpv6(address);
  if (!groups) return null;
  // Some platforms report an IPv4 remote peer as IPv4-mapped IPv6.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `4:${[groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')}`;
  }
  return `6:${groups.map((group) => group.toString(16).padStart(4, '0')).join(':')}`;
}

function sameNumericAddress(expected, actual) {
  const left = comparableAddress(expected);
  const right = comparableAddress(actual);
  return Boolean(left && right && left === right);
}

function normalizeResolverResult(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === 'string' ? entry : entry?.address)
    .map(bareAddress)
    .filter(Boolean);
}

async function defaultResolveAddresses(hostname) {
  const addresses = normalizeResolverResult(await lookup(hostname, { all: true, verbatim: true, hints: 0 }));
  if (!addresses.length) throw new Error('no DNS answers');
  return addresses;
}

async function resolveWithinBudget(resolveAddresses, hostname, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(resolveAddresses(hostname)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS resolution timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validHostname(value) {
  const hostname = String(value || '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || hostname.includes('..')) return null;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) return null;
  return hostname;
}

function socksReply(code) {
  // Bound address is intentionally 0.0.0.0:0: this proxy never BINDs and
  // never exposes a peer or target address to Chromium.
  return Buffer.from([SOCKS_VERSION, code, 0x00, SOCKS_ADDRESS_IPV4, 0, 0, 0, 0, 0, 0]);
}

function parseGreeting(buffer) {
  if (buffer.length < 2) return null;
  const methodsLength = buffer[1];
  if (buffer.length < 2 + methodsLength) return null;
  if (buffer[0] !== SOCKS_VERSION) return { invalid: true, consumed: 2 + methodsLength };
  return {
    consumed: 2 + methodsLength,
    acceptsNoAuth: buffer.subarray(2, 2 + methodsLength).includes(SOCKS_NO_AUTH),
  };
}

function ipv4FromBuffer(buffer) {
  return `${buffer[0]}.${buffer[1]}.${buffer[2]}.${buffer[3]}`;
}

function ipv6FromBuffer(buffer) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(buffer.readUInt16BE(index).toString(16));
  return groups.join(':');
}

function parseRequest(buffer) {
  if (buffer.length < 4) return null;
  const [version, command, reserved, addressType] = buffer;
  if (version !== SOCKS_VERSION || reserved !== 0x00) return { invalid: true, consumed: 4 };
  let cursor = 4;
  let hostname;
  if (addressType === SOCKS_ADDRESS_IPV4) {
    if (buffer.length < cursor + 4 + 2) return null;
    hostname = ipv4FromBuffer(buffer.subarray(cursor, cursor + 4));
    cursor += 4;
  } else if (addressType === SOCKS_ADDRESS_IPV6) {
    if (buffer.length < cursor + 16 + 2) return null;
    hostname = ipv6FromBuffer(buffer.subarray(cursor, cursor + 16));
    cursor += 16;
  } else if (addressType === SOCKS_ADDRESS_DOMAIN) {
    if (buffer.length < cursor + 1) return null;
    const length = buffer[cursor];
    cursor += 1;
    if (!length || buffer.length < cursor + length + 2) return null;
    hostname = validHostname(buffer.subarray(cursor, cursor + length).toString('ascii'));
    if (!hostname) return { invalid: true, consumed: cursor + length + 2 };
    cursor += length;
  } else {
    return { invalid: true, consumed: 4 };
  }
  const port = buffer.readUInt16BE(cursor);
  cursor += 2;
  if (!port) return { invalid: true, consumed: cursor };
  return { command, hostname, port, consumed: cursor };
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close((error) => resolve(error || null));
    } catch (error) {
      resolve(error);
    }
  });
}

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/**
 * Start a local SOCKS5 CONNECT boundary for a single capture process.
 *
 * Test hooks intentionally accept only resolver and numeric-connect functions;
 * production defaults use Node DNS and net.connect. No URL, hostname, or IP is
 * retained in the block latch, making the latch safe to surface in receipts.
 */
export function createCaptureSocksProxy({
  resolveAddresses = defaultResolveAddresses,
  connectSocket = (options) => net.connect(options),
  maxAddresses = MAX_CAPTURE_DNS_ADDRESSES,
  resolveTimeoutMs = MAX_CAPTURE_DNS_RESOLVE_MS,
  maxDnsLookups = MAX_CAPTURE_PROXY_DNS_LOOKUPS,
  maxConnections = MAX_CAPTURE_PROXY_CONNECTIONS,
  maxConnectAttempts = MAX_CAPTURE_PROXY_CONNECT_ATTEMPTS,
  connectTimeoutMs = MAX_CAPTURE_PROXY_CONNECT_MS,
  handshakeTimeoutMs = MAX_CAPTURE_PROXY_HANDSHAKE_MS,
  maxRequestBytes = MAX_CAPTURE_PROXY_REQUEST_BYTES,
  drainTimeoutMs = MAX_CAPTURE_PROXY_DRAIN_MS,
  allowedLoopbackOrigin = null,
} = {}) {
  let server = null;
  let serverAddress = null;
  let blockedCode = null;
  let dnsLookups = 0;
  let connectAttempts = 0;
  let pendingOperations = 0;
  let listenerClosePromise = null;
  let quiescePromise = null;
  let quiescing = false;
  const clients = new Set();
  const idleWaiters = new Set();

  const hasValidBudgets = () => [
    maxAddresses,
    resolveTimeoutMs,
    maxDnsLookups,
    maxConnections,
    maxConnectAttempts,
    connectTimeoutMs,
    handshakeTimeoutMs,
    maxRequestBytes,
    drainTimeoutMs,
  ].every(positiveInteger);

  const latch = (code) => {
    if (!blockedCode) blockedCode = code || 'network_socket_boundary_rejected';
    return blockedCode;
  };

  const isIdle = () => clients.size === 0 && pendingOperations === 0;
  const notifyIdle = () => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve(true);
    idleWaiters.clear();
  };

  const waitForQueuedAcceptTurn = () => new Promise((resolve) => setImmediate(resolve));

  const beginListenerClose = () => {
    if (listenerClosePromise) return listenerClosePromise;
    if (!server) {
      listenerClosePromise = Promise.resolve(true);
      return listenerClosePromise;
    }
    const activeServer = server;
    server = null;
    serverAddress = null;
    listenerClosePromise = closeServer(activeServer).then((error) => {
      if (error) {
        latch('network_socks_listener_close_failed');
        return false;
      }
      return true;
    });
    return listenerClosePromise;
  };

  const quiesce = async () => {
    if (quiescePromise) return quiescePromise;
    quiescing = true;
    // Browser shutdown can enqueue a final local SOCKS connect before its
    // promise resolves. Yield exactly one event-loop turn while receipts are
    // still withheld so that already queued accepts become tracked clients,
    // then close the listener against any later accepts.
    quiescePromise = (async () => {
      await waitForQueuedAcceptTurn();
      beginListenerClose();
    })();
    return quiescePromise;
  };

  const waitForIdle = async ({ timeoutMs = drainTimeoutMs } = {}) => {
    if (isIdle()) return true;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      latch('network_socks_drain_timeout');
      return false;
    }
    return new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timeout);
        idleWaiters.delete(onIdle);
        resolve(value);
      };
      const onIdle = () => finish(true);
      const timeout = setTimeout(() => {
        latch('network_socks_drain_timeout');
        finish(false);
      }, timeoutMs);
      idleWaiters.add(onIdle);
      if (isIdle()) onIdle();
    });
  };

  const waitForQuiescence = async ({ timeoutMs = drainTimeoutMs } = {}) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      latch('network_socks_drain_timeout');
      return false;
    }
    await quiesce();
    let timeout;
    try {
      return await Promise.race([
        Promise.all([waitForIdle({ timeoutMs }), listenerClosePromise || Promise.resolve(true)])
          .then(([idle, listenerClosed]) => Boolean(idle && listenerClosed)),
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            latch('network_socks_drain_timeout');
            resolve(false);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const rejectClient = (client, code, replyCode = SOCKS_REPLY_GENERAL_FAILURE) => {
    latch(code);
    if (client.destroyed) return;
    try {
      client.write(socksReply(replyCode), () => client.destroy());
    } catch {
      client.destroy();
    }
  };

  const resolveTarget = async (hostname, port) => {
    const literal = bareAddress(hostname);
    const canonicalHost = literal.toLowerCase().replace(/\.$/, '');
    const loopbackRequested = ['localhost', '127.0.0.1', '::1'].includes(canonicalHost);
    if (!canonicalHost || ((canonicalHost === 'localhost' || canonicalHost.endsWith('.localhost')) &&
        !isAllowedCaptureLoopbackSocket(canonicalHost, port, null, allowedLoopbackOrigin))) {
      throw failure('network_private_or_reserved_address');
    }
    const directFamily = isIP(literal);
    let addresses;
    if (directFamily) {
      addresses = [literal];
    } else {
      if (!Number.isInteger(maxDnsLookups) || maxDnsLookups < 1 || dnsLookups >= maxDnsLookups) {
        throw failure('network_socks_dns_budget_exceeded');
      }
      if (!Number.isInteger(resolveTimeoutMs) || resolveTimeoutMs < 1) throw failure('network_dns_resolution_budget_invalid');
      dnsLookups += 1;
      try {
        addresses = normalizeResolverResult(await resolveWithinBudget(resolveAddresses, canonicalHost, resolveTimeoutMs));
      } catch {
        throw failure('network_dns_unresolved');
      }
      if (!addresses.length) throw failure('network_dns_unresolved');
    }
    if (!Number.isInteger(maxAddresses) || maxAddresses < 1 || addresses.length > maxAddresses) {
      throw failure('network_dns_result_cap_exceeded');
    }
    for (const address of addresses) {
      if (loopbackRequested && isAllowedCaptureLoopbackSocket(canonicalHost, port, address, allowedLoopbackOrigin)) continue;
      const unsafe = classifyCaptureNetworkAddress(address);
      if (unsafe) throw failure(unsafe);
    }
    if (loopbackRequested && !addresses.every((address) =>
      isAllowedCaptureLoopbackSocket(canonicalHost, port, address, allowedLoopbackOrigin))) {
      throw failure('network_private_or_reserved_address');
    }
    return addresses[0];
  };

  const connectNumeric = async (host, port) => {
    if (!Number.isInteger(maxConnectAttempts) || maxConnectAttempts < 1 || connectAttempts >= maxConnectAttempts) {
      throw failure('network_socks_connect_budget_exceeded');
    }
    const family = isIP(host);
    if (!family) throw failure('network_dns_invalid_result');
    connectAttempts += 1;
    let remote;
    try {
      remote = connectSocket({ host, port, family });
    } catch {
      throw failure('network_socks_connect_failed');
    }
    if (!remote || typeof remote.once !== 'function') throw failure('network_socks_connect_failed');
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback(value);
      };
      const fail = (code) => {
        if (settled) return;
        finish(reject, failure(code));
        try { remote.destroy?.(); } catch { /* owned remote socket only */ }
      };
      timeout = setTimeout(() => fail('network_socks_connect_timeout'), connectTimeoutMs);
      remote.once('error', () => fail('network_socks_connect_failed'));
      remote.once('close', () => {
        if (!settled) fail('network_socks_connect_failed');
      });
      remote.once('connect', () => {
        if (!sameNumericAddress(host, remote.remoteAddress)) {
          fail('network_socket_remote_address_mismatch');
          return;
        }
        finish(resolve, remote);
      });
    });
  };

  const handleClient = (client) => {
    if (quiescing) {
      // A browser shutdown can leave an accept already queued in the event
      // loop. It must become a latched capture failure, never a fresh relay.
      latch('network_socks_accept_after_quiesce');
      client.destroy();
      return;
    }
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || clients.size >= maxConnections) {
      latch('network_socks_connection_cap_exceeded');
      client.destroy();
      return;
    }
    clients.add(client);
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    let remote = null;
    let requestPending = false;
    let handshakeTimeout = null;

    const clearHandshakeTimeout = () => {
      if (handshakeTimeout) clearTimeout(handshakeTimeout);
      handshakeTimeout = null;
    };
    const closeClient = () => {
      clearHandshakeTimeout();
      clients.delete(client);
      try { remote?.destroy?.(); } catch { /* owned remote socket only */ }
      notifyIdle();
    };
    client.once('close', closeClient);
    client.once('error', () => { /* close handler owns cleanup */ });
    handshakeTimeout = setTimeout(() => rejectClient(client, 'network_socks_handshake_timeout'), handshakeTimeoutMs);

    const beginRelay = (outbound) => {
      remote = outbound;
      clearHandshakeTimeout();
      stage = 'relay';
      client.off('data', onData);
      try {
        client.write(socksReply(SOCKS_REPLY_SUCCEEDED));
        if (buffer.length) remote.write(buffer);
        buffer = Buffer.alloc(0);
        // Deliberately raw bytes only: Chromium keeps the original hostname in
        // TLS SNI/Host and performs its normal certificate verification.
        client.pipe(remote);
        remote.pipe(client);
        remote.once('error', () => client.destroy());
        remote.once('close', () => client.destroy());
      } catch {
        rejectClient(client, 'network_socks_relay_failed');
      }
    };

    const processRequest = async (request) => {
      pendingOperations += 1;
      try {
        if (request.command === SOCKS_BIND || request.command === SOCKS_UDP_ASSOCIATE || request.command !== SOCKS_CONNECT) {
          rejectClient(client, 'network_socks_command_rejected', SOCKS_REPLY_COMMAND_NOT_SUPPORTED);
          return;
        }
        const selectedAddress = await resolveTarget(request.hostname, request.port);
        const outbound = await connectNumeric(selectedAddress, request.port);
        if (client.destroyed) {
          try { outbound.destroy?.(); } catch { /* owned remote socket only */ }
          return;
        }
        beginRelay(outbound);
      } catch (error) {
        rejectClient(client, error?.captureNetworkCode || 'network_socks_connect_failed');
      } finally {
        pendingOperations -= 1;
        notifyIdle();
      }
    };

    const onData = (chunk) => {
      if (stage === 'relay') return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxRequestBytes) {
        rejectClient(client, 'network_socks_request_too_large');
        return;
      }
      if (stage === 'greeting') {
        const greeting = parseGreeting(buffer);
        if (!greeting) return;
        buffer = buffer.subarray(greeting.consumed);
        if (greeting.invalid || !greeting.acceptsNoAuth) {
          latch('network_socks_auth_rejected');
          try { client.write(Buffer.from([SOCKS_VERSION, SOCKS_NO_ACCEPTABLE_AUTH]), () => client.destroy()); } catch { client.destroy(); }
          return;
        }
        try { client.write(Buffer.from([SOCKS_VERSION, SOCKS_NO_AUTH])); } catch { client.destroy(); return; }
        stage = 'request';
      }
      if (stage !== 'request' || requestPending) return;
      const request = parseRequest(buffer);
      if (!request) return;
      buffer = buffer.subarray(request.consumed);
      if (request.invalid) {
        rejectClient(client, 'network_socks_request_invalid');
        return;
      }
      requestPending = true;
      stage = 'connecting';
      void processRequest(request);
    };
    client.on('data', onData);
  };

  return {
    get server() {
      return serverAddress ? `socks5://127.0.0.1:${serverAddress.port}` : null;
    },
    getBlockedCode() {
      return blockedCode;
    },
    async start() {
      if (serverAddress) return this.server;
      if (server || quiescing || quiescePromise) throw failure('network_socks_start_failed');
      if (!hasValidBudgets()) {
        latch('network_socks_budget_invalid');
        throw failure('network_socks_budget_invalid');
      }
      server = net.createServer(handleClient);
      server.on('error', () => latch('network_socks_server_error'));
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch {
        latch('network_socks_start_failed');
        try { await closeServer(server); } catch { /* no listener to close */ }
        server = null;
        throw failure('network_socks_start_failed');
      }
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || !Number.isInteger(address.port)) {
        latch('network_socks_start_failed');
        await closeServer(server);
        server = null;
        throw failure('network_socks_start_failed');
      }
      serverAddress = address;
      return this.server;
    },
    async quiesce() {
      await quiesce();
    },
    async waitForIdle(options) {
      return waitForIdle(options);
    },
    async waitForQuiescence(options) {
      return waitForQuiescence(options);
    },
    async stop() {
      for (const client of clients) {
        try { client.destroy(); } catch { /* owned loopback client only */ }
      }
      await quiesce();
      // A queued accept can become a client during the one-turn quiesce
      // barrier. Stop owns these sockets and may destroy them only here.
      for (const client of clients) {
        try { client.destroy(); } catch { /* owned loopback client only */ }
      }
      if (listenerClosePromise) await listenerClosePromise;
      notifyIdle();
    },
  };
}
