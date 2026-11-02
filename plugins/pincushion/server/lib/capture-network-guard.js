// Network boundary for browser capture. Browser navigation must not reach
// loopback, private, link-local, documentation, multicast, or other reserved
// destinations. DNS is checked before every top-level navigation and before
// every HTTP(S) route (including redirects and subresources).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const NETWORK_CAPTURE_FAILURE_EXIT_CODE = 7;
// A bounded public A+AAAA fanout from embedded hosts is valid; every returned
// address remains classified before browser navigation or proxy target I/O.
export const MAX_CAPTURE_DNS_ADDRESSES = 32;
export const MAX_CAPTURE_DNS_RESOLVE_MS = 3000;
// The redirect preflight fetch carries the navigation's own response, so it
// gets the same budget as page.goto in capture-snapshot.mjs rather than
// Playwright's 30s request default, which failed slow first bytes early.
export const MAX_CAPTURE_REDIRECT_PREFLIGHT_MS = 45_000;

function failure(code) {
  return { ok: false, code };
}

function bareAddress(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '');
}

function normalizedLoopbackHost(value) {
  return bareAddress(value).toLowerCase().replace(/\.$/, '');
}

function explicitLoopbackHost(value) {
  const hostname = normalizedLoopbackHost(value);
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? hostname : null;
}

/**
 * Return the normalized origin only when the supplied capture target itself is
 * one of the three explicit loopback spellings supported by critique mode.
 * Callers must opt in with this exact value; aliases, subdomains, LAN hosts,
 * private ranges, and alternate ports remain outside the allowance.
 */
export function captureLoopbackOriginForTarget(targetUrl) {
  try {
    const url = new URL(String(targetUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return explicitLoopbackHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

function loopbackAllowance(allowedLoopbackOrigin) {
  if (!allowedLoopbackOrigin) return null;
  try {
    const url = new URL(String(allowedLoopbackOrigin));
    const hostname = explicitLoopbackHost(url.hostname);
    if (!hostname || url.origin !== allowedLoopbackOrigin || url.username || url.password) return null;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { origin: url.origin, hostname, port };
  } catch {
    return null;
  }
}

export function isAllowedCaptureLoopbackUrl(targetUrl, allowedLoopbackOrigin) {
  const allowance = loopbackAllowance(allowedLoopbackOrigin);
  if (!allowance) return false;
  try {
    const url = new URL(String(targetUrl || '').trim());
    return !url.username && !url.password && url.origin === allowance.origin &&
      explicitLoopbackHost(url.hostname) === allowance.hostname;
  } catch {
    return false;
  }
}

export function isAllowedCaptureLoopbackSocket(hostname, port, address, allowedLoopbackOrigin) {
  const allowance = loopbackAllowance(allowedLoopbackOrigin);
  const requestedHost = explicitLoopbackHost(hostname);
  if (!allowance || requestedHost !== allowance.hostname || Number(port) !== allowance.port) return false;
  if (address === null || address === undefined) return true;
  const resolved = normalizedLoopbackHost(address);
  if (allowance.hostname === 'localhost') return resolved === '127.0.0.1' || resolved === '::1';
  return resolved === allowance.hostname;
}

function parseIpv4(address) {
  const octets = String(address).split('.');
  if (octets.length !== 4) return null;
  const parsed = octets.map((value) => /^\d{1,3}$/.test(value) ? Number(value) : NaN);
  return parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? parsed : null;
}

function ipv4FromGroups(groups) {
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function ipv4FromTeredoGroups(groups) {
  // Teredo stores the client IPv4 address in the final 32 bits, inverted.
  return [
    (~(groups[6] >> 8)) & 0xff,
    (~groups[6]) & 0xff,
    (~(groups[7] >> 8)) & 0xff,
    (~groups[7]) & 0xff,
  ];
}

function parseIpv6(address) {
  let raw = bareAddress(address).toLowerCase();
  if (!raw || raw.includes('%')) return null;
  const ipv4Index = raw.lastIndexOf(':');
  if (raw.includes('.')) {
    const ipv4 = parseIpv4(raw.slice(ipv4Index + 1));
    if (!ipv4) return null;
    raw = `${raw.slice(0, ipv4Index)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const parts = raw.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const zeros = 8 - left.length - right.length;
  if ((parts.length === 1 && zeros !== 0) || zeros < 0) return null;
  const expanded = [...left, ...Array(zeros).fill('0'), ...right];
  return expanded.length === 8 ? expanded.map((part) => Number.parseInt(part, 16)) : null;
}

function classifyIpv4(address) {
  const value = Array.isArray(address) ? address : parseIpv4(address);
  if (!value) return 'network_dns_invalid_result';
  const [a, b, c] = value;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return 'network_private_or_reserved_address';
  if (a === 100 && b >= 64 && b <= 127) return 'network_private_or_reserved_address';
  if (a === 169 && b === 254) return 'network_private_or_reserved_address';
  if (a === 172 && b >= 16 && b <= 31) return 'network_private_or_reserved_address';
  if (a === 192 && (b === 0 || b === 168)) return 'network_private_or_reserved_address';
  if (a === 192 && b === 88 && c === 99) return 'network_private_or_reserved_address';
  if (a === 192 && b === 0 && c === 2) return 'network_private_or_reserved_address';
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return 'network_private_or_reserved_address';
  if (a === 203 && b === 0 && c === 113) return 'network_private_or_reserved_address';
  return null;
}

function classifyIpv6(address) {
  const groups = parseIpv6(address);
  if (!groups) return 'network_dns_invalid_result';
  const allZero = groups.every((group) => group === 0);
  if (allZero || (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)) {
    return 'network_private_or_reserved_address';
  }
  const first = groups[0];
  // Classify the outer IPv6 range before inspecting any embedded IPv4 suffix.
  // Otherwise an ISATAP or translation spelling can make a ULA or
  // documentation destination appear public merely because its suffix is.
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) {
    return 'network_private_or_reserved_address';
  }
  // Documentation, benchmarking, and discard-only prefixes are not routable
  // public capture targets. Block them rather than relying on browser behavior.
  if ((groups[0] === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8)) ||
      (groups[0] === 0x3fff && (groups[1] & 0xf000) === 0) ||
      groups[0] === 0x5f00 ||
      (groups[0] === 0x0100 && groups.slice(1).every((group) => group === 0))) {
    return 'network_private_or_reserved_address';
  }
  // IPv4-mapped IPv6 is special-use, not a globally reachable IPv6 capture
  // destination. Block the whole ::ffff:0:0/96 prefix, including public IPv4
  // suffixes, rather than allowing an alternate spelling through the guard.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return 'network_private_or_reserved_address';
  }
  // Deprecated IPv4-compatible form and the well-known NAT64 prefix can also
  // embed an IPv4 loopback/private destination. Preserve the IPv4 decision for
  // those addresses instead of treating their IPv6 spelling as public.
  if (groups.slice(0, 6).every((group) => group === 0)) {
    // IPv4-compatible IPv6 is deprecated special-use space. Even a public
    // suffix is not a globally routable IPv6 capture destination.
    return classifyIpv4(ipv4FromGroups(groups)) || 'network_private_or_reserved_address';
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return classifyIpv4(ipv4FromGroups(groups));
  }
  // IPv4-translated and ISATAP encodings are special transport classes, not
  // globally reachable IPv6 capture targets. Block them wholesale rather than
  // allowing a public embedded IPv4 suffix to override their outer class.
  if ((groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) ||
      ((groups[4] === 0 || groups[4] === 0x0200) && groups[5] === 0x5efe)) {
    return 'network_private_or_reserved_address';
  }
  // 64:ff9b:1::/48 is the locally assigned NAT64 prefix, not the globally
  // reachable well-known NAT64 range. No value within it is a capture target.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return 'network_private_or_reserved_address';
  }
  // 6to4 is special-use space with no global-reachability guarantee. Block the
  // whole 2002::/16 prefix, including addresses with a public embedded IPv4.
  if (groups[0] === 0x2002) {
    return 'network_private_or_reserved_address';
  }
  // Teredo similarly contains an inverted client IPv4 address. Treat a
  // private client endpoint as a private destination.
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    const embedded = classifyIpv4(ipv4FromTeredoGroups(groups));
    if (embedded) return embedded;
  }
  // Global unicast is 2000::/3. Every other unicast range is special-use,
  // local, experimental, or otherwise non-global and must fail closed.
  if ((first & 0xe000) !== 0x2000) return 'network_private_or_reserved_address';
  return null;
}

export function classifyCaptureNetworkAddress(address) {
  const normalized = bareAddress(address);
  const family = isIP(normalized);
  if (family === 4) return classifyIpv4(normalized);
  if (family === 6) return classifyIpv6(normalized);
  return 'network_dns_invalid_result';
}

function normalizeResolverResult(result) {
  if (!Array.isArray(result)) return [];
  return result.map((entry) => typeof entry === 'string' ? entry : entry?.address).filter(Boolean);
}

async function defaultResolveAddresses(hostname) {
  const addresses = normalizeResolverResult(await lookup(hostname, { all: true, verbatim: true, hints: 0 }));
  if (!addresses.length) throw new Error('no DNS addresses');
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

export async function validateCaptureNavigationTarget(targetUrl, {
  resolveAddresses = defaultResolveAddresses,
  maxAddresses = MAX_CAPTURE_DNS_ADDRESSES,
  resolveTimeoutMs = MAX_CAPTURE_DNS_RESOLVE_MS,
  allowedLoopbackOrigin = null,
} = {}) {
  let url;
  try {
    url = new URL(String(targetUrl || '').trim());
  } catch {
    return failure('network_target_url_invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return failure('network_target_url_invalid');
  }
  if (isAllowedCaptureLoopbackUrl(url.toString(), allowedLoopbackOrigin)) {
    return { ok: true, origin: url.origin };
  }
  const hostname = bareAddress(url.hostname);
  if (!hostname) return failure('network_target_url_invalid');
  const canonicalHost = hostname.toLowerCase().replace(/\.$/, '');
  if (canonicalHost === 'localhost' || canonicalHost.endsWith('.localhost')) {
    return failure('network_private_or_reserved_address');
  }
  const directFamily = isIP(hostname);
  let addresses;
  if (directFamily) {
    addresses = [hostname];
  } else {
    try {
      if (!Number.isInteger(resolveTimeoutMs) || resolveTimeoutMs < 1) return failure('network_dns_resolution_budget_invalid');
      addresses = normalizeResolverResult(await resolveWithinBudget(resolveAddresses, hostname, resolveTimeoutMs));
    } catch {
      return failure('network_dns_unresolved');
    }
    if (!addresses.length) return failure('network_dns_unresolved');
  }
  if (!Number.isInteger(maxAddresses) || maxAddresses < 1 || addresses.length > maxAddresses) {
    return failure('network_dns_result_cap_exceeded');
  }
  for (const address of addresses) {
    const unsafe = classifyCaptureNetworkAddress(address);
    if (unsafe) return failure(unsafe);
  }
  return { ok: true, origin: url.origin };
}

// Installs before any page is created. Explicit navigation validates before a
// browser request; route interception validates redirect hops before allowing
// the browser to request them. The guard intentionally stores only a bounded
// failure code, never a URL, hostname, or resolved address.
export function createCaptureNavigationGuard(options = {}) {
  let blockedCode = null;
  let redirectRetryAllowed = false;
  let pendingRedirectTarget = null;
  const routeValidations = new Set();
  const routeValidationWaiters = new Set();
  const expectedNavigationOrigin = (() => {
    if (!options.navigationOrigin) return null;
    try { return new URL(options.navigationOrigin).origin; } catch { return null; }
  })();
  const routeValidationDrainTimeoutMs = Number.isInteger(options.routeValidationDrainTimeoutMs)
    ? options.routeValidationDrainTimeoutMs
    : MAX_CAPTURE_DNS_RESOLVE_MS;

  const latch = (code) => {
    if (!blockedCode && code) blockedCode = code;
    return blockedCode;
  };

  const getBlockedCode = () => {
    try {
      latch(options.getBlockedCode?.());
    } catch {
      latch('network_socket_boundary_unavailable');
    }
    return blockedCode;
  };

  const notifyRouteValidationIdle = () => {
    if (routeValidations.size) return;
    for (const finish of routeValidationWaiters) finish(true);
    routeValidationWaiters.clear();
  };

  const trackRouteValidation = (work) => {
    const task = Promise.resolve().then(work);
    routeValidations.add(task);
    return task.finally(() => {
      routeValidations.delete(task);
      notifyRouteValidationIdle();
    });
  };

  const waitForRouteValidationIdle = async ({ timeoutMs = routeValidationDrainTimeoutMs } = {}) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      latch('network_route_validation_drain_timeout');
      return false;
    }
    if (!routeValidations.size) return true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        routeValidationWaiters.delete(finish);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        latch('network_route_validation_drain_timeout');
        finish(false);
      }, timeoutMs);
      routeValidationWaiters.add(finish);
      if (!routeValidations.size) finish(true);
    });
  };

  const validate = async (url, { navigation = false } = {}) => {
    const alreadyBlocked = getBlockedCode();
    if (alreadyBlocked) return failure(alreadyBlocked);
    if (navigation && expectedNavigationOrigin) {
      try {
        if (new URL(String(url || '').trim()).origin !== expectedNavigationOrigin) {
          return failure(latch('network_off_origin_navigation'));
        }
      } catch {
        // The normal target validation below owns malformed URL classification.
      }
    }
    // Re-resolve immediately before each navigation request. A durable cache
    // would turn DNS rebinding after the initial preflight into a TOCTOU gap.
    const result = await validateCaptureNavigationTarget(url, options);
    if (!result.ok) latch(result.code);
    return result;
  };

  const isKnownNestedFrameNavigation = (request) => {
    try {
      if (typeof request?.frame !== 'function') return false;
      const frame = request.frame();
      const parent = frame && typeof frame.parentFrame === 'function' ? frame.parentFrame() : null;
      // Only a proven parent frame may bypass the top-level origin lock.
      return Boolean(parent && typeof parent === 'object');
    } catch {
      return false;
    }
  };

  const routeNavigationRequest = async (route) => {
    const request = route.request();
    if (getBlockedCode()) {
      try { await route.abort('blockedbyclient'); } catch { /* capture remains latched */ }
      return;
    }
    const requestUrl = request?.url?.();
    // A caller may impose a stricter per-request policy after redirects have
    // resolved. Keep it in this guard so a blocked action is latched before
    // browser I/O and no subsequent capture can be published from the run.
    const isNavigation = typeof request?.isNavigationRequest === 'function' && request.isNavigationRequest();
    const resourceType = request?.resourceType?.();
    const inspectRedirect = options.inspectRedirects && (isNavigation || resourceType === 'fetch' || resourceType === 'xhr');
    const blockedByCaller = inspectRedirect ? options.blockActionUrl?.(requestUrl) : null;
    if (blockedByCaller) {
      latch(blockedByCaller);
      try { await route.abort('blockedbyclient'); } catch { /* capture remains latched */ }
      return;
    }
    let protocol = null;
    try { protocol = new URL(requestUrl).protocol; } catch { /* navigation is handled below */ }
    const isHttp = protocol === 'http:' || protocol === 'https:';
    // HTTP(S) subresources can redirect or resolve independently of the
    // document. Validate every such request before allowing browser I/O.
    if (!isHttp && !isNavigation) {
      await route.continue();
      return;
    }
    const result = await trackRouteValidation(() => validate(requestUrl, {
      navigation: isNavigation && !isKnownNestedFrameNavigation(request),
    }));
    if (!result.ok) {
      try { await route.abort('blockedbyclient'); } catch { /* navigation remains blocked */ }
      return;
    }
    if (inspectRedirect) {
      // Playwright routes only the first URL in an HTTP redirect chain. Fetch
      // one hop without auto-following so an action destination is checked
      // before it can receive cookies or mutate the saved session.
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: MAX_CAPTURE_REDIRECT_PREFLIGHT_MS });
      } catch {
        latch(options.getBlockedCode?.() || 'network_capture_fetch_failed');
        try { await route.abort('blockedbyclient'); } catch { /* capture remains latched */ }
        return;
      }
      const location = response.headers()?.location;
      if (response.status() >= 300 && response.status() < 400 && location) {
        let target;
        try { target = new URL(location, requestUrl).toString(); } catch { latch('network_redirect_target_invalid'); }
        const actionCode = target && options.blockActionUrl?.(target);
        if (actionCode) latch(actionCode);
        if (!getBlockedCode() && target) {
          const redirectCheck = await trackRouteValidation(() => validate(target, { navigation: isNavigation && !isKnownNestedFrameNavigation(request) }));
          if (redirectCheck.ok && isNavigation && !isKnownNestedFrameNavigation(request) && redirectRetryAllowed) pendingRedirectTarget = target;
          else if (redirectCheck.ok) latch('network_redirect_not_reviewable');
        }
        await response.dispose().catch(() => {});
        if (pendingRedirectTarget && !getBlockedCode()) {
          // Finish the intercepted request without asking Chromium to follow
          // an unchecked 302. gotoPage immediately navigates the validated
          // target, so this temporary document is never captured.
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Crit route handoff</title>' });
        } else {
          try { await route.abort('blockedbyclient'); } catch { /* capture remains bounded */ }
        }
        return;
      }
      try { await route.fulfill({ response }); } finally { await response.dispose().catch(() => {}); }
      return;
    }
    await route.continue();
  };

  return {
    validate,
    async install(context) {
      await context.route('**/*', routeNavigationRequest);
    },
    async assertInitial(targetUrl) {
      return validate(targetUrl, { navigation: true });
    },
    consumeBlockedCode() {
      // This is intentionally a read, not a reset. Once a route or socket
      // boundary rejects a request, no later frame receipt may complete.
      return getBlockedCode();
    },
    getBlockedCode() {
      return getBlockedCode();
    },
    setRedirectRetryAllowed(value) {
      redirectRetryAllowed = value === true;
    },
    consumeRedirectTarget() {
      const target = pendingRedirectTarget;
      pendingRedirectTarget = null;
      return target;
    },
    async waitForRouteValidationIdle(options) {
      return waitForRouteValidationIdle(options);
    },
  };
}
