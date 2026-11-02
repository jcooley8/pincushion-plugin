// Browser-safe helpers shared by the customer capture script and Pincushion's
// internal crit engine. `resolveSnapshotTargets` is passed directly to
// Playwright's page.evaluate(), so it must not close over module state.

export function resolveSnapshotTargets(pins) {
  const clean = (selector) => String(selector || '').replace(/\.__fp_[A-Za-z0-9_-]+/g, '').trim();
  const docWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth);
  const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
  const out = { width: window.innerWidth, height: docHeight, positions: [], hotspots: [], requested: Object.keys(pins || {}).length };
  const hotspotSelectors = new Set();

  for (const [annotationId, pin] of Object.entries(pins || {})) {
    const selector = clean(pin && pin.selector);
    if (!selector) continue;

    let candidates = [];
    try { candidates = Array.from(document.querySelectorAll(selector)); } catch { continue; }

    let target = null;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') continue;

      const left = Math.max(0, rect.left + window.scrollX);
      const top = Math.max(0, rect.top + window.scrollY);
      const right = Math.min(docWidth, rect.right + window.scrollX);
      const bottom = Math.min(docHeight, rect.bottom + window.scrollY);
      if (right <= left || bottom <= top) continue;

      target = { x: left, y: top, w: right - left, h: bottom - top };
      break;
    }
    if (!target) continue;

    const fx = Number.isFinite(pin.relX) ? pin.relX : 0.5;
    const fy = Number.isFinite(pin.relY) ? pin.relY : 0.5;
    out.positions.push({
      annotationId,
      x: Math.round(target.x + fx * target.w),
      y: Math.round(target.y + fy * target.h),
    });
    if (!hotspotSelectors.has(selector)) {
      hotspotSelectors.add(selector);
      out.hotspots.push({
        selector,
        x: Math.round(target.x),
        y: Math.round(target.y),
        w: Math.round(target.w),
        h: Math.round(target.h),
      });
    }
  }

  return out;
}

// Crit producers use this stricter variant before they create a report. A
// selector that happens to match several visible elements is not an anchor: it
// must be repaired or the run fails instead of silently pinning the first one.
// Like resolveSnapshotTargets, this is browser-safe for page.evaluate().
export function resolveExactSnapshotTargets(pins) {
  const clean = (selector) => String(selector || '').replace(/\.__fp_[A-Za-z0-9_-]+/g, '').trim();
  // Crit screenshots retain the full page height but clip horizontal overflow
  // to the device viewport. Only pixels inside that image can anchor a pin.
  const imageWidth = window.innerWidth;
  const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
  const out = { width: imageWidth, height: docHeight, positions: [], hotspots: [], requested: Object.keys(pins || {}).length };
  const hotspotSelectors = new Set();
  const visibleTarget = (element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.contentVisibility === 'hidden' || Number(style.opacity || '1') === 0 ||
          (style.clipPath && style.clipPath !== 'none')) return null;
      if (current !== element && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const parentRect = current.getBoundingClientRect();
        if (!parentRect.width || !parentRect.height || rect.left < parentRect.left || rect.right > parentRect.right ||
            rect.top < parentRect.top || rect.bottom > parentRect.bottom) return null;
      }
    }
    const left = Math.max(0, rect.left + window.scrollX);
    const top = Math.max(0, rect.top + window.scrollY);
    const right = Math.min(imageWidth, rect.right + window.scrollX);
    const bottom = Math.min(docHeight, rect.bottom + window.scrollY);
    return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
  };

  for (const [annotationId, pin] of Object.entries(pins || {})) {
    const selector = clean(pin && pin.selector);
    if (!selector) continue;
    let candidates = [];
    try { candidates = Array.from(document.querySelectorAll(selector)); } catch { continue; }
    const targets = candidates.map(visibleTarget).filter(Boolean);
    if (targets.length !== 1) continue;
    const target = targets[0];
    const fx = Number.isFinite(pin.relX) ? Math.max(0, Math.min(1, pin.relX)) : 0.5;
    const fy = Number.isFinite(pin.relY) ? Math.max(0, Math.min(1, pin.relY)) : 0.5;
    out.positions.push({
      annotationId,
      x: Math.min(imageWidth - 1, Math.max(0, Math.round(target.x + fx * target.w))),
      y: Math.min(docHeight - 1, Math.max(0, Math.round(target.y + fy * target.h))),
    });
    if (!hotspotSelectors.has(selector)) {
      hotspotSelectors.add(selector);
      const x = Math.max(0, Math.floor(target.x));
      const y = Math.max(0, Math.floor(target.y));
      out.hotspots.push({
        selector, x, y,
        w: Math.min(imageWidth, Math.ceil(target.x + target.w)) - x,
        h: Math.min(docHeight, Math.ceil(target.y + target.h)) - y,
      });
    }
  }
  return out;
}

// Anchor evidence is intentionally limited to exact, stable facts the Codex
// critic can point out. A repair may carry a bounded set of independent
// anchors: an absent/ambiguous one is not enough by itself, and every anchor
// that uniquely resolves must identify the same visible DOM node. This never
// performs fuzzy text matching or chooses the first of multiple candidates.
export function resolveExactRepairAnchors(repairs) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.contentVisibility === 'hidden' || Number(style.opacity || '1') === 0 ||
          (style.clipPath && style.clipPath !== 'none')) return false;
      if (current !== element && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const parentRect = current.getBoundingClientRect();
        if (!parentRect.width || !parentRect.height || rect.left < parentRect.left || rect.right > parentRect.right ||
            rect.top < parentRect.top || rect.bottom > parentRect.bottom) return false;
      }
    }
    return true;
  };
  const css = (value) => CSS.escape(String(value || ''));
  const exactRole = (element) => {
    const explicit = normalize(element.getAttribute?.('role'));
    if (explicit) return explicit;
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(String(element.getAttribute?.('type')).toLowerCase()))) return 'button';
    if (tag === 'a' && element.getAttribute?.('href')) return 'link';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  };
  const accessibleName = (element) => normalize(element.getAttribute?.('aria-label') || element.getAttribute?.('alt') || element.innerText || element.textContent);
  const all = () => Array.from(document.querySelectorAll('*'));
  const exactAttributeSelector = (name, value) => `${String(name).toLowerCase()}="${css(value)}"`;
  const selectorFor = (element) => {
    const tag = String(element.tagName || '').toLowerCase();
    const id = normalize(element.id);
    if (id) {
      const selector = `#${css(id)}`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    for (const name of ['data-testid', 'data-test', 'data-id', 'data-component', 'aria-label', 'name', 'href']) {
      const value = normalize(element.getAttribute?.(name));
      if (!value) continue;
      const selector = `${tag}[${exactAttributeSelector(name, value)}]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    const parts = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement) {
      const currentTag = String(current.tagName || '').toLowerCase();
      if (!currentTag) return null;
      const parent = current.parentElement;
      const siblings = parent ? Array.from(parent.children || []).filter((child) => String(child.tagName || '').toLowerCase() === currentTag) : [];
      const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
      parts.unshift(`${currentTag}${index}`);
      const selector = parts.join(' > ');
      if (document.querySelectorAll(selector).length === 1) return selector;
      current = parent;
    }
    return null;
  };
  const candidatesForAnchor = (anchor) => {
    const kind = normalize(anchor?.kind);
    let candidates = [];
    if (kind === 'id') {
      const value = normalize(anchor?.value);
      if (!value) return { valid: false, candidates };
      try { candidates = Array.from(document.querySelectorAll(`#${css(value)}`)); } catch { candidates = []; }
      return { valid: true, candidates };
    }
    if (kind === 'attribute') {
      const name = normalize(anchor?.name).toLowerCase();
      const value = normalize(anchor?.value);
      if (!['data-testid', 'data-test', 'data-id', 'data-component', 'aria-label', 'name', 'href'].includes(name) || !value) {
        return { valid: false, candidates };
      }
      try { candidates = Array.from(document.querySelectorAll(`[${exactAttributeSelector(name, value)}]`)); } catch { candidates = []; }
      return { valid: true, candidates };
    }
    if (kind === 'role_name') {
      const role = normalize(anchor?.role);
      const name = normalize(anchor?.name);
      if (!role || !name) return { valid: false, candidates };
      candidates = all().filter((element) => exactRole(element) === role && accessibleName(element) === name);
      return { valid: true, candidates };
    }
    if (kind === 'tag_text') {
      const tag = normalize(anchor?.tag).toLowerCase();
      const text = normalize(anchor?.text);
      if (!tag || !text) return { valid: false, candidates };
      candidates = all().filter((element) => String(element.tagName || '').toLowerCase() === tag && normalize(element.innerText || element.textContent) === text);
      return { valid: true, candidates };
    }
    return { valid: false, candidates };
  };
  const resolved = [];
  const unresolvedIds = [];
  for (const repair of Array.isArray(repairs) ? repairs : []) {
    const id = normalize(repair?.id);
    const anchors = Array.isArray(repair?.anchors)
      ? repair.anchors
      : (repair?.anchor && typeof repair.anchor === 'object' ? [repair.anchor] : []);
    if (!id || !anchors.length || anchors.length > 4) {
      if (id) unresolvedIds.push(id);
      continue;
    }
    const successfulTargets = [];
    let invalidAnchor = false;
    for (const anchor of anchors) {
      const { valid, candidates } = candidatesForAnchor(anchor);
      if (!valid) {
        invalidAnchor = true;
        break;
      }
      const visibleCandidates = candidates.filter(visible);
      if (visibleCandidates.length === 1) successfulTargets.push(visibleCandidates[0]);
    }
    const target = successfulTargets[0];
    if (invalidAnchor || successfulTargets.length === 0 || successfulTargets.some((candidate) => candidate !== target)) {
      unresolvedIds.push(id);
      continue;
    }
    const selector = selectorFor(target);
    let reResolved = [];
    try { reResolved = selector ? Array.from(document.querySelectorAll(selector)).filter(visible) : []; } catch { reResolved = []; }
    if (!selector || reResolved.length !== 1 || reResolved[0] !== target) {
      unresolvedIds.push(id);
      continue;
    }
    resolved.push({ id, selector });
  }
  return { repairs: resolved, unresolvedIds };
}

export function scaleSnapshotTargets(result, scaleX, scaleY) {
  const sx = Number.isFinite(scaleX) ? scaleX : 1;
  const sy = Number.isFinite(scaleY) ? scaleY : 1;
  return {
    ...result,
    positions: (result.positions || []).map((pin) => ({ ...pin, x: Math.round(pin.x * sx), y: Math.round(pin.y * sy) })),
    hotspots: (result.hotspots || []).map((hotspot) => ({
      ...hotspot,
      x: Math.round(hotspot.x * sx),
      y: Math.round(hotspot.y * sy),
      w: Math.round(hotspot.w * sx),
      h: Math.round(hotspot.h * sy),
    })),
  };
}

// Browser-safe auth-challenge probe. It intentionally returns only booleans:
// callers use the categories to reject a signed-out capture, while page text,
// controls, cookies, and storage values remain local to the browser context.
export function collectAuthenticationChallengeSignals() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.();
    const style = getComputedStyle(element);
    return Boolean(rect?.width && rect?.height && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0 && !element.hidden);
  };
  const label = (element) => `${element.getAttribute?.('aria-label') || ''} ${element.textContent || ''} ${element.getAttribute?.('href') || ''}`.replace(/\s+/g, ' ').trim();
  const authWords = /(?:sign\s*in|log\s*in|authenticate|unauthori[sz]ed|access\s+denied|session\s+(?:expired|ended)|not\s+signed\s+in|please\s+(?:sign\s*in|authenticate))/i;
  const signedInWords = /(?:sign\s*out|log\s*out|my\s+account|profile)/i;
  const controls = Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]'));
  const signInControl = controls.some((element) => visible(element) && authWords.test(label(element)));
  const signedInMarker = controls.some((element) => visible(element) && signedInWords.test(label(element))) ||
    Array.from(document.querySelectorAll('[data-authenticated],[data-auth],[data-session],[data-user-state]')).some((element) => {
      const value = `${element.getAttribute?.('data-authenticated') || ''} ${element.getAttribute?.('data-auth') || ''} ${element.getAttribute?.('data-session') || ''} ${element.getAttribute?.('data-user-state') || ''}`.toLowerCase();
      return /(?:true|authenticated|signed-in|signed_in|active)/.test(value);
    });
  const signedOutAttribute = Array.from(document.querySelectorAll('[data-authenticated],[data-auth],[data-session],[data-user-state]')).some((element) => {
    const value = `${element.getAttribute?.('data-authenticated') || ''} ${element.getAttribute?.('data-auth') || ''} ${element.getAttribute?.('data-session') || ''} ${element.getAttribute?.('data-user-state') || ''}`.toLowerCase();
    return /(?:false|anonymous|unauthenticated|signed-out|signed_out|guest)/.test(value);
  });
  const credentialControl = Array.from(document.querySelectorAll('input[type="password"],input[autocomplete="current-password"],form[action*="login" i],form[action*="sign-in" i],form[action*="auth" i]')).some(visible);
  const documentCopy = `${document.title || ''}\n${document.body?.innerText || ''}`.slice(0, 8000);
  return {
    credentialControl,
    signInControl,
    signedInMarker,
    signedOutAttribute,
    authCopy: authWords.test(documentCopy),
  };
}

// Browser-safe, bounded inspection of already rendered page state. Never
// dispatch events or toggle controls on an untrusted page: even a button named
// "Menu" or a details toggle can run a handler that mutates the signed-in app.
export async function inspectNonDestructivePageState() {
  const MAX_STATES = 8;
  const clean = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const css = (value) => CSS.escape(String(value || ''));
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.contentVisibility === 'hidden' || Number(style.opacity || '1') === 0 ||
          (style.clipPath && style.clipPath !== 'none')) return false;
      if (current !== element && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const parentRect = current.getBoundingClientRect();
        if (!parentRect.width || !parentRect.height || rect.left < parentRect.left || rect.right > parentRect.right ||
            rect.top < parentRect.top || rect.bottom > parentRect.bottom) return false;
      }
    }
    return true;
  };
  const selectorFor = (element) => {
    const tag = String(element?.tagName || '').toLowerCase();
    if (!tag) return null;
    if (element.id) {
      const selector = `#${css(element.id)}`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    for (const name of ['data-testid', 'data-test', 'data-id']) {
      const value = clean(element.getAttribute?.(name), 100);
      if (!value) continue;
      const selector = `${tag}[${name}="${css(value)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    const parts = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement && parts.length < 6) {
      const currentTag = String(current.tagName || '').toLowerCase();
      const parent = current.parentElement;
      if (!currentTag || !parent) break;
      const siblings = Array.from(parent.children || []).filter((child) => String(child.tagName || '').toLowerCase() === currentTag);
      parts.unshift(`${currentTag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`);
      const selector = parts.join(' > ');
      if (document.querySelectorAll(selector).length === 1) return selector;
      current = parent;
    }
    return null;
  };
  const evidence = [];
  const gaps = [];
  let candidateStates = 0;
  let gapsTruncated = false;
  const addGap = (kind, selector, reason) => {
    if (gaps.length >= MAX_STATES) {
      gapsTruncated = true;
      return;
    }
    gaps.push({ kind, selector: selector || null, reason });
  };

  for (const details of Array.from(document.querySelectorAll('details'))) {
    if (!visible(details)) continue;
    candidateStates += 1;
    const selector = selectorFor(details);
    if (evidence.length >= MAX_STATES) {
      addGap('details', selector, 'state_evidence_limit_reached');
      continue;
    }
    if (!selector) {
      addGap('details', null, 'selector_unavailable');
      continue;
    }
    if (!details.open) {
      addGap('details', selector, 'state_requires_interaction');
      continue;
    }
    const contentVisible = Array.from(details.children || []).some((child) =>
      String(child.tagName || '').toLowerCase() !== 'summary' && visible(child));
    if (!contentVisible) {
      addGap('details', selector, 'state_not_visibly_rendered');
      continue;
    }
    const summary = details.querySelector('summary');
    evidence.push({ kind: 'details', selector, name: clean(summary?.innerText || summary?.textContent) || null });
  }

  const dangerous = /(?:delete|remove|destroy|erase|purchase|buy|checkout|pay|submit|send|save|publish|approve|reject|confirm|sign\s*out|log\s*out|disconnect|revoke)/i;
  const menuLabel = /(?:menu|navigation|more|options|actions|account|profile)/i;
  for (const control of Array.from(document.querySelectorAll('button,[role="button"]'))) {
    if (!visible(control)) continue;
    const hasPopup = String(control.getAttribute?.('aria-haspopup') || '').toLowerCase();
    if (!hasPopup || hasPopup === 'false') continue;
    candidateStates += 1;
    const selector = selectorFor(control);
    if (evidence.length >= MAX_STATES) {
      addGap('popup', selector, 'state_evidence_limit_reached');
      continue;
    }
    const type = String(control.getAttribute?.('type') || '').toLowerCase();
    const label = clean(control.getAttribute?.('aria-label') || control.innerText || control.textContent);
    const expandedBefore = String(control.getAttribute?.('aria-expanded') || '').toLowerCase();
    if (String(control.tagName || '').toLowerCase() !== 'button' || control.closest?.('form') ||
        control.hasAttribute?.('form') || control.hasAttribute?.('disabled') || type === 'submit' || type === 'reset' ||
        dangerous.test(label) || !menuLabel.test(label)) {
      addGap('popup', selector, 'unsafe_or_ambiguous_control');
      continue;
    }
    if (expandedBefore === 'true') {
      if (selector) evidence.push({ kind: 'menu', selector, name: label || null });
      else addGap('popup', null, 'selector_unavailable');
      continue;
    }
    if (!selector) {
      addGap('popup', null, 'selector_unavailable');
      continue;
    }
    addGap('popup', selector, 'state_requires_interaction');
  }
  for (const tab of Array.from(document.querySelectorAll('[role="tab"][aria-controls]'))) {
    if (!visible(tab) || String(tab.getAttribute?.('aria-selected') || '').toLowerCase() === 'true') continue;
    candidateStates += 1;
    addGap('tab', selectorFor(tab), 'state_type_not_exercised');
  }
  return {
    evidence,
    coverage: {
      candidateStates,
      capturedStates: evidence.length,
      gapCount: Math.max(0, candidateStates - evidence.length),
      gaps,
      gapsTruncated,
    },
  };
}

// Browser-safe evidence for critique. It exposes only bounded, visible
// semantics and geometry: no HTML, input values, script contents, or pixels.
export function collectVisibleSemanticElements() {
  const MAX_ELEMENTS = 120;
  const TEXT_LIMIT = 120;
  const SELECTOR_LIMIT = 240;
  const clean = (value, max = TEXT_LIMIT) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const css = (value) => CSS.escape(String(value || ''));
  const visible = (element, style, rect) => {
    if (!rect?.width || !rect?.height) return false;
    for (let current = element; current; current = current.parentElement) {
      const currentStyle = current === element ? style : getComputedStyle(current);
      if (current.hidden || current.getAttribute?.('aria-hidden') === 'true' || currentStyle.display === 'none' ||
          currentStyle.visibility === 'hidden' || currentStyle.contentVisibility === 'hidden' || Number(currentStyle.opacity || '1') === 0 ||
          (currentStyle.clipPath && currentStyle.clipPath !== 'none')) return false;
      if (current !== element && /(hidden|clip|auto|scroll)/.test(`${currentStyle.overflowX} ${currentStyle.overflowY}`)) {
        const parentRect = current.getBoundingClientRect();
        if (!parentRect.width || !parentRect.height || rect.left < parentRect.left || rect.right > parentRect.right ||
            rect.top < parentRect.top || rect.bottom > parentRect.bottom) return false;
      }
    }
    return true;
  };
  const isPincushion = (element) => /pincushion|__fp_/i.test(`${element.id || ''} ${element.className || ''} ${element.getAttribute?.('data-pincushion') || ''}`);
  const roleFor = (element, tag) => {
    const explicit = clean(element.getAttribute?.('role'), 40);
    if (explicit) return explicit;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a' && element.getAttribute?.('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = String(element.getAttribute?.('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    }
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'img') return 'img';
    if (['p', 'li', 'dt', 'dd', 'label'].includes(tag)) return 'text';
    return '';
  };
  const selectorFor = (element) => {
    const tag = String(element?.tagName || '').toLowerCase();
    if (!tag) return null;
    if (element.id) {
      const selector = `#${css(element.id)}`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    for (const name of ['data-testid', 'data-test', 'data-id', 'data-component', 'name']) {
      const value = clean(element.getAttribute?.(name), 100);
      if (!value) continue;
      const selector = `${tag}[${name}="${css(value)}"]`;
      if (selector.length <= SELECTOR_LIMIT && document.querySelectorAll(selector).length === 1) return selector;
    }
    const parts = [];
    let current = element;
    while (current && current !== document.body && current !== document.documentElement && parts.length < 8) {
      const currentTag = String(current.tagName || '').toLowerCase();
      const parent = current.parentElement;
      if (!currentTag || !parent) break;
      const siblings = Array.from(parent.children || []).filter((child) => String(child.tagName || '').toLowerCase() === currentTag);
      parts.unshift(`${currentTag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`);
      const selector = parts.join(' > ');
      if (selector.length <= SELECTOR_LIMIT && document.querySelectorAll(selector).length === 1) return selector;
      current = parent;
    }
    return null;
  };
  const documentWidth = window.innerWidth;
  const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight);
  const elements = [];
  for (const element of Array.from(document.querySelectorAll('body *'))) {
    if (elements.length >= MAX_ELEMENTS || isPincushion(element)) continue;
    const tag = String(element.tagName || '').toLowerCase();
    if (!tag || ['script', 'style', 'link', 'meta', 'noscript', 'template', 'svg', 'path'].includes(tag)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!visible(element, style, rect)) continue;
    const role = roleFor(element, tag);
    if (!role) continue;
    if (role === 'text' && element.children?.length) continue;
    const selector = selectorFor(element);
    if (!selector) continue;
    const textSource = tag === 'input'
      ? (element.getAttribute?.('aria-label') || element.getAttribute?.('placeholder') || '')
      : (element.getAttribute?.('aria-label') || element.getAttribute?.('alt') || element.innerText || element.textContent || '');
    const left = Math.max(0, rect.left + window.scrollX);
    const top = Math.max(0, rect.top + window.scrollY);
    const right = Math.min(documentWidth, rect.right + window.scrollX);
    const bottom = Math.min(documentHeight, rect.bottom + window.scrollY);
    if (right <= left || bottom <= top) continue;
    elements.push({
      selector,
      role,
      name: clean(textSource) || null,
      rect: {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
      },
    });
  }
  return elements;
}

// Browser-safe, bounded semantic representation of the rendered document.
// This function is passed directly to Playwright's page.evaluate(), so every
// helper it needs intentionally lives inside the function body (no module
// closure). It returns normalized structure only; the caller hashes it locally
// and must never upload the raw entries.
export function collectSemanticFingerprint() {
  const MAX_ENTRIES = 700;
  const textLimit = 180;
  const cleanText = (value) => String(value || '')
    .replace(/\u00a0/g, ' ')
    // Obvious volatile time/date, nonce, UUID, and high-entropy token forms.
    .replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi, '{time}')
    .replace(/\b(?:today|yesterday|tomorrow)\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?\b/gi, '{time}')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '{id}')
    .replace(/\b(?:nonce|token|session|request)[_:-]?[a-z0-9_-]{8,}\b/gi, '{volatile}')
    .replace(/\b\d{10,}\b/g, '{number}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, textLimit);
  const isPincushion = (element) => {
    const id = String(element.getAttribute?.('id') || '');
    const cls = String(element.getAttribute?.('class') || '');
    const data = String(element.getAttribute?.('data-pincushion') || element.getAttribute?.('data-pincushion-widget') || '');
    return /pincushion|__fp_/i.test(`${id} ${cls} ${data}`);
  };
  const implicitRole = (element, tag) => {
    const explicit = element.getAttribute?.('role');
    if (explicit) return explicit;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a' && element.getAttribute?.('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = String(element.getAttribute?.('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    }
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'img') return 'img';
    return '';
  };
  const normalizedDestination = (element, tag) => {
    const raw = tag === 'a' ? element.getAttribute?.('href') : tag === 'form' ? element.getAttribute?.('action') : null;
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
      if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      return url.toString();
    } catch {
      return '';
    }
  };
  const visible = (element, style, rect) => {
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
    if (element.getAttribute?.('aria-hidden') === 'true' || element.hidden) return false;
    return true;
  };
  const compactColor = (value) => String(value || '').replace(/\s+/g, '');
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth);
  const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight);
  const quantize = (value, total) => Math.round((Math.max(0, Number(value) || 0) / Math.max(1, total)) * 1000);
  const entries = [];

  for (const element of Array.from(document.querySelectorAll('body *'))) {
    if (entries.length >= MAX_ENTRIES || isPincushion(element)) continue;
    const tag = String(element.tagName || '').toLowerCase();
    if (!tag || ['script', 'style', 'link', 'meta', 'noscript', 'template', 'svg', 'path'].includes(tag)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!visible(element, style, rect)) continue;
    const role = implicitRole(element, tag);
    const heading = /^h[1-6]$/.test(tag);
    const control = ['button', 'textbox', 'checkbox', 'radio', 'combobox'].includes(role);
    const destination = normalizedDestination(element, tag);
    const rawText = element.getAttribute?.('aria-label') || element.getAttribute?.('alt') || element.innerText || element.textContent || '';
    const text = cleanText(rawText);
    if (!heading && !control && !role && !destination && !text) continue;
    // Containers often repeat all descendant text. Keep their structural role,
    // but only record ordinary text leaves to keep the digest stable and bounded.
    if (!heading && !control && !role && element.children?.length) continue;

    entries.push({
      tag,
      role: role || null,
      headingLevel: heading ? Number(tag.slice(1)) : null,
      name: text || null,
      destination: destination || null,
      control: control ? {
        type: String(element.getAttribute?.('type') || '').toLowerCase() || null,
        label: cleanText(element.getAttribute?.('placeholder') || element.getAttribute?.('aria-label') || '') || null,
        disabled: element.hasAttribute?.('disabled') || false,
        checked: element.hasAttribute?.('checked') || element.getAttribute?.('aria-checked') === 'true',
      } : null,
      geometry: [
        quantize(rect.left + window.scrollX, documentWidth),
        quantize(rect.top + window.scrollY, documentHeight),
        quantize(rect.width, documentWidth),
        quantize(rect.height, documentHeight),
      ],
      style: {
        display: String(style.display || ''),
        position: String(style.position || ''),
        fontSize: String(style.fontSize || ''),
        fontWeight: String(style.fontWeight || ''),
        color: compactColor(style.color),
        backgroundColor: compactColor(style.backgroundColor),
        borderRadius: String(style.borderRadius || ''),
        textAlign: String(style.textAlign || ''),
      },
    });
  }

  return {
    version: 'semantic-rendered-v1',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: { width: documentWidth, height: documentHeight },
    entryCount: entries.length,
    entries,
  };
}

// Decode two screenshot data URLs in-browser, downsample them into a bounded
// tile grid, and return only aggregate tile values plus the mask of tiles that
// changed between the two settled captures. No pixels leave this function.
export async function deriveVisualFingerprint({ firstDataUrl, secondDataUrl }) {
  const load = async (dataUrl) => {
    // A target site's connect-src can block fetch(data:), even though these
    // screenshots were captured locally. Decode in memory so its CSP cannot
    // turn a successful page capture into a failed Crit.
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  };
  const [first, second] = await Promise.all([load(firstDataUrl), load(secondDataUrl)]);
  const source = { width: first.width, height: first.height };
  const columns = Math.max(1, Math.min(24, Math.ceil(Math.max(first.width, second.width) / 160)));
  const rows = Math.max(1, Math.min(64, Math.ceil(Math.max(first.height, second.height) / 160)));
  const sample = 8;
  const canvas = document.createElement('canvas');
  canvas.width = columns * sample;
  canvas.height = rows * sample;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2d canvas unavailable for visual fingerprinting');
  const downsample = (bitmap) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const firstPixels = downsample(first);
  const secondPixels = downsample(second);
  const vector = [];
  const unstableTiles = [];
  for (let tileY = 0; tileY < rows; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) {
      let r = 0; let g = 0; let b = 0; let edge = 0; let diff = 0;
      for (let sampleY = 0; sampleY < sample; sampleY += 1) {
        for (let sampleX = 0; sampleX < sample; sampleX += 1) {
          const x = tileX * sample + sampleX;
          const y = tileY * sample + sampleY;
          const index = (y * canvas.width + x) * 4;
          r += firstPixels[index];
          g += firstPixels[index + 1];
          b += firstPixels[index + 2];
          diff += Math.abs(firstPixels[index] - secondPixels[index]) +
            Math.abs(firstPixels[index + 1] - secondPixels[index + 1]) +
            Math.abs(firstPixels[index + 2] - secondPixels[index + 2]);
          if (sampleX > 0) {
            const left = index - 4;
            edge += Math.abs(firstPixels[index] - firstPixels[left]) +
              Math.abs(firstPixels[index + 1] - firstPixels[left + 1]) +
              Math.abs(firstPixels[index + 2] - firstPixels[left + 2]);
          }
          if (sampleY > 0) {
            const above = index - canvas.width * 4;
            edge += Math.abs(firstPixels[index] - firstPixels[above]) +
              Math.abs(firstPixels[index + 1] - firstPixels[above + 1]) +
              Math.abs(firstPixels[index + 2] - firstPixels[above + 2]);
          }
        }
      }
      const pixels = sample * sample;
      const packed = ((Math.round(r / pixels) & 0xff) << 24) |
        ((Math.round(g / pixels) & 0xff) << 16) |
        ((Math.round(b / pixels) & 0xff) << 8) |
        (Math.min(255, Math.round(edge / Math.max(1, pixels * 3))) & 0xff);
      vector.push(packed >>> 0);
      if ((diff / (pixels * 3)) > 12) unstableTiles.push(vector.length - 1);
    }
  }
  first.close?.();
  second.close?.();
  return {
    algorithm: 'tile-rgb-v1',
    columns,
    rows,
    vector,
    unstableTiles,
    source,
  };
}
