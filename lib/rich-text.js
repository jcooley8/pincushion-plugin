const RICH_TOKEN_RE = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;

function normalizeUrlCandidate(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  let candidate = trimmed;

  while (/[),.!?:;]$/.test(candidate)) {
    candidate = candidate.slice(0, -1);
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function pushTextToken(tokens, plainParts, text) {
  if (!text) return;
  tokens.push({ type: 'text', text });
  plainParts.push(text);
}

export function parseRichComment(body = '') {
  const source = String(body || '');
  const tokens = [];
  const links = [];
  const images = [];
  const plainParts = [];

  let lastIndex = 0;
  let match;

  RICH_TOKEN_RE.lastIndex = 0;

  while ((match = RICH_TOKEN_RE.exec(source)) !== null) {
    const rawMatch = match[0];
    const matchIndex = match.index;
    pushTextToken(tokens, plainParts, source.slice(lastIndex, matchIndex));

    if (match[1] !== undefined && match[2] !== undefined) {
      const alt = match[1] || '';
      const url = normalizeUrlCandidate(match[2]);
      if (url) {
        tokens.push({ type: 'image', url, alt });
        images.push({ url, ...(alt ? { alt } : {}) });
        plainParts.push(alt || url);
      } else {
        pushTextToken(tokens, plainParts, rawMatch);
      }
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const label = match[3] || '';
      const url = normalizeUrlCandidate(match[4]);
      if (url) {
        tokens.push({ type: 'link', url, label });
        links.push({ url, ...(label ? { label } : {}) });
        plainParts.push(label || url);
      } else {
        pushTextToken(tokens, plainParts, rawMatch);
      }
    } else if (match[5] !== undefined) {
      const url = normalizeUrlCandidate(match[5]);
      if (url) {
        tokens.push({ type: 'link', url, label: url, bare: true });
        links.push({ url });
        plainParts.push(url);
      } else {
        pushTextToken(tokens, plainParts, rawMatch);
      }
    } else {
      pushTextToken(tokens, plainParts, rawMatch);
    }

    lastIndex = matchIndex + rawMatch.length;
  }

  pushTextToken(tokens, plainParts, source.slice(lastIndex));

  return {
    body: source,
    tokens,
    plainText: plainParts.join(''),
    links,
    images,
  };
}

export function summarizeRichComment(body = '', maxLength = 200) {
  const parsed = parseRichComment(body);
  const summary = parsed.plainText.replace(/\s+/g, ' ').trim();
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function enrichThreadMessage(message = {}) {
  const parsed = parseRichComment(message.body || '');
  return {
    ...message,
    body: message.body || '',
    plainText: parsed.plainText,
    links: parsed.links,
    images: parsed.images,
  };
}

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(value) {
  return escHtml(value).replace(/'/g, '&#39;');
}

export function renderRichCommentHtml(body = '') {
  const parsed = parseRichComment(body);

  return parsed.tokens.map((token) => {
    if (token.type === 'text') {
      return escHtml(token.text).replace(/\n/g, '<br>');
    }

    if (token.type === 'link') {
      return `<a class="rich-link" href="${escAttr(token.url)}" target="_blank" rel="noopener noreferrer">${escHtml(token.label || token.url)}</a>`;
    }

    if (token.type === 'image') {
      const alt = token.alt || 'Embedded image';
      const caption = token.alt
        ? `<span class="rich-image-alt">${escHtml(token.alt)}</span>`
        : '';

      return `<span class="rich-image-wrap"><a class="rich-image-link" href="${escAttr(token.url)}" target="_blank" rel="noopener noreferrer"><img class="rich-image" src="${escAttr(token.url)}" alt="${escAttr(alt)}" loading="lazy"></a>${caption}</span>`;
    }

    return '';
  }).join('');
}
