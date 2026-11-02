// GENERATED from supabase/functions/_shared/internal-accounts.js by
// `npm run sync:internal-accounts`. Do not edit; change the source instead.

// Internal, test and outreach accounts: the single source of truth for which
// emails are ours rather than real users. Analytics flags them
// (`$internal_or_test_user` / `is_internal`) and lifecycle mail skips them.
// It is never an authorization boundary: anyone can type one of these
// addresses into a public form.
//
// Plain dependency-free ESM so Deno edge functions and Node tests import this
// file directly. `npm run sync:internal-accounts` copies it verbatim into the
// MCP package (pincushion-mcp/lib/internal-accounts.js), which ships on its
// own; `npm run sync:internal-accounts:check` (part of `npm run validate`)
// fails when the copy drifts. Edit this file, never the copy.

// Whole domains (and their subdomains). mail.grokbot.com holds the ops inboxes
// the X outreach routine submits crits from; any local part or +tag counts.
export const INTERNAL_EMAIL_DOMAINS = Object.freeze([
  "pincushion.io",
  "mail.grokbot.com",
  "maxxspace.com",
  "clarodsol.resend.app",
  "test.local",
  "example.test",
  // The system license that owns 137 projects: its owner address is
  // <name>@pincushion.invalid, never a real inbox.
  "pincushion.invalid",
]);

// Exact mailboxes. Matched after +tag removal (and Gmail dot folding), so
// jmaelync+anything@gmail.com is internal too.
export const INTERNAL_EMAILS = Object.freeze([
  "joshpincushion@gmail.com",
  "jmaelync@gmail.com",
]);

// A local part on any domain: matttdamon@<anything>.
export const INTERNAL_LOCAL_PARTS = Object.freeze(["matttdamon"]);

// A local-part prefix on any domain: jcooley-ops, jcooley-ops2, pincushion-internal-test-<stamp>…
// pcp2-owner-<stamp>@… are the production smoke-test owners.
export const INTERNAL_LOCAL_PREFIXES = Object.freeze([
  "jcooley-ops",
  "pincushion-internal-test",
  "pcp2-",
  "jmaelync",
  "joshpincushion",
]);

// A read-only SQL equivalent for the growth-metrics report's manual queries.
// Keep it derived from the same lists used by isInternalEmail so new internal
// accounts do not silently diverge between application and SQL readouts.
export function internalEmailSqlExclusion(column) {
  if (!/^[a-z][a-z0-9_.]*$/i.test(column)) throw new TypeError("invalid SQL column reference");
  const literal = (value) => `'${value.replace(/'/g, "''")}'`;
  const email = `lower(${column})`;
  const domain = `split_part(${email}, '@', 2)`;
  const local = `split_part(${email}, '@', 1)`;
  const mailbox = `split_part(${local}, '+', 1)`;
  const normalizedMailbox = `case when ${domain} in ('gmail.com', 'googlemail.com') then replace(${mailbox}, '.', '') else ${mailbox} end`;
  const domainTerms = INTERNAL_EMAIL_DOMAINS.flatMap((root) => [
    `${domain} = ${literal(root)}`,
    `${domain} like ${literal(`%.${root}`)}`,
  ]);
  const mailboxTerms = INTERNAL_EMAILS.map((address) => `${normalizedMailbox} || '@' || ${domain} = ${literal(address)}`);
  const localTerms = INTERNAL_LOCAL_PARTS.map((part) => `${normalizedMailbox} = ${literal(part)}`);
  const prefixTerms = INTERNAL_LOCAL_PREFIXES.map((prefix) => `${normalizedMailbox} like ${literal(`${prefix}%`)}`);
  return `not (${[...domainTerms, ...mailboxTerms, ...localTerms, ...prefixTerms].join(' or ')})`;
}

// Projects the verify-pincushion skill creates ("Verify <runId>"). Their owner
// may be a real-looking address, so project-level pin metrics match the name.
export function isInternalProjectName(name) {
  return typeof name === "string" && /^verify [a-z0-9][a-z0-9_-]*$/i.test(name.trim());
}

// ops_events keep only a masked email (j***@domain), so the verdict is stored
// on the event as `is_internal` when it is written. Older rows without the
// flag fall back to the masked address, which still carries the domain.
export function isInternalOpsEvent(props) {
  if (!props || typeof props !== "object") return false;
  if (props.is_internal === true) return true;
  if (props.is_internal === false) return false;
  return typeof props.email === "string" && isInternalEmail(props.email.replace("***", "x"));
}

// Compatibility name used by the ops digest implementation.
export const isInternalOpsProps = isInternalOpsEvent;

// PostHog person properties. `$internal_or_test_user` is what the project's
// "filter out internal and test users" setting matches on; `is_internal` is the
// plain alias for HogQL and Supabase-side reports.
export const INTERNAL_PERSON_PROPERTY = "$internal_or_test_user";
export const INTERNAL_FLAG_PROPERTY = "is_internal";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function splitEmail(email) {
  if (typeof email !== "string") return null;
  const addr = email.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1 || at === addr.length - 1 || addr.indexOf("@") !== at) return null;
  return { local: addr.slice(0, at), domain: addr.slice(at + 1) };
}

// The mailbox an address delivers to: +tag dropped, Gmail dots folded.
export function baseMailbox(email) {
  const parts = splitEmail(email);
  if (!parts) return null;
  let local = parts.local.split("+")[0];
  let domain = parts.domain;
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  return local ? `${local}@${domain}` : null;
}

function domainMatches(domain, root) {
  return domain === root || domain.endsWith(`.${root}`);
}

export function isInternalEmail(email) {
  const parts = splitEmail(email);
  if (!parts) return false;
  if (INTERNAL_EMAIL_DOMAINS.some((root) => domainMatches(parts.domain, root))) return true;
  const base = baseMailbox(email);
  if (!base) return false;
  if (INTERNAL_EMAILS.includes(base)) return true;
  const local = base.slice(0, base.lastIndexOf("@"));
  if (INTERNAL_LOCAL_PARTS.includes(local)) return true;
  return INTERNAL_LOCAL_PREFIXES.some((prefix) => local.startsWith(prefix));
}

// Both person properties for one known internal/real verdict.
export function internalPersonProperties(isInternal) {
  const flag = isInternal === true;
  return { [INTERNAL_PERSON_PROPERTY]: flag, [INTERNAL_FLAG_PROPERTY]: flag };
}

// A distinct id for someone known only by email (a crit requester who has not
// signed up). The raw address never reaches PostHog; sign-up aliases this id
// into the account's email identity, so earlier events join that person.
// SHA-256 of the trimmed, lowercased address, like the MCP's `lic_` ids.
export async function hashedEmailDistinctId(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalized.includes("@")) return null;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `em_${hex.slice(0, 32)}`;
}

// HogQL predicate every PostHog metric query over `events` must carry. It drops
// events flagged on the event itself and events from persons flagged internal.
export const INTERNAL_HOGQL_FILTER =
  "coalesce(toString(properties.is_internal), 'false') != 'true' " +
  "and coalesce(toString(person.properties.$internal_or_test_user), 'false') != 'true'";
