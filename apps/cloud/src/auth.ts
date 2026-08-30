/**
 * Who is calling.
 *
 * **No passwords.** Not as a simplification — as the design. A password store
 * is a liability that has to be defended for as long as the service exists, and
 * the two things it buys (a login form people recognise, and offline access)
 * are worth less than the breach it eventually becomes. Two mechanisms instead:
 * an emailed sign-in link for people, and API keys for machines.
 *
 * The rules that make this safe are all about what is *stored*:
 *
 *   - A token is shown once, at creation, and never again. What is stored is a
 *     SHA-256 of it. A dump of this table lets an attacker impersonate nobody.
 *   - Comparison is constant time. A plain `===` on a hash leaks it a byte at a
 *     time to anyone patient enough to measure.
 *   - Sign-in links are single use and short lived. A link that still works
 *     after it has been used is a permanent account takeover sitting in an
 *     inbox, a mail archive, and every corporate scanner that followed it.
 *   - The prefix stored alongside the hash is for humans identifying a key in a
 *     list. It is deliberately too short to be useful to an attacker.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenKind = 'session' | 'apikey';

export interface TokenRecord {
  /** SHA-256 of the token. The token itself is never stored. */
  hash: string;
  kind: TokenKind;
  accountId: string;
  /** First few characters, so a person can tell their keys apart. */
  prefix: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface SignInLink {
  hash: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  /** Set the moment it is used. A second attempt finds this and refuses. */
  usedAt?: string;
}

export interface AuthStore {
  putToken(t: TokenRecord): Promise<void>;
  getToken(hash: string): Promise<TokenRecord | undefined>;
  listTokens(accountId: string): Promise<TokenRecord[]>;
  putLink(l: SignInLink): Promise<void>;
  getLink(hash: string): Promise<SignInLink | undefined>;
  /** Account id for an email, creating one if this is a first sign-in. */
  accountForEmail(email: string): Promise<string>;
}

/** Minutes a sign-in link stays valid. Long enough for slow mail, no longer. */
export const LINK_TTL_MINUTES = 15;
/** Days a browser session lasts before it has to be re-established. */
export const SESSION_TTL_DAYS = 30;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A new token: 32 random bytes, base64url, with a kind prefix.
 *
 * The prefix is not decoration. A key that announces itself as a Chorus
 * credential is one that secret scanners can find in a public repository and
 * report before somebody else uses it.
 */
export function mintToken(kind: TokenKind): string {
  const prefix = kind === 'apikey' ? 'chk_' : 'chs_';
  return prefix + randomBytes(32).toString('base64url');
}

/** Constant-time equality for two hex digests. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export interface Issued {
  /** Show this to the caller once. It cannot be recovered afterwards. */
  token: string;
  record: TokenRecord;
}

export async function issueToken(
  store: AuthStore,
  opts: { accountId: string; kind: TokenKind; label?: string; now?: Date },
): Promise<Issued> {
  const now = opts.now ?? new Date();
  const token = mintToken(opts.kind);
  const expires = opts.kind === 'session'
    ? new Date(now.getTime() + SESSION_TTL_DAYS * 86400_000).toISOString()
    : undefined;                       // API keys last until revoked
  const record: TokenRecord = {
    hash: hashToken(token),
    kind: opts.kind,
    accountId: opts.accountId,
    prefix: token.slice(0, 11),
    label: opts.label,
    createdAt: now.toISOString(),
    expiresAt: expires,
  };
  await store.putToken(record);
  return { token, record };
}

export type AuthResult =
  | { ok: true; accountId: string; kind: TokenKind }
  | { ok: false; reason: string };

/**
 * Authenticate a bearer token.
 *
 * Every failure returns the same shape and a deliberately vague reason. An
 * error that distinguishes "no such token" from "that token expired" tells
 * someone enumerating tokens which guesses were close.
 */
export async function authenticate(
  store: AuthStore,
  header: string | undefined,
  now: Date = new Date(),
): Promise<AuthResult> {
  const token = bearer(header);
  if (!token) return { ok: false, reason: 'not authenticated' };

  const record = await store.getToken(hashToken(token));
  if (!record) return { ok: false, reason: 'not authenticated' };
  if (record.revokedAt) return { ok: false, reason: 'not authenticated' };
  if (record.expiresAt && new Date(record.expiresAt) <= now) {
    return { ok: false, reason: 'not authenticated' };
  }

  // Belt and braces: the lookup was by hash, so this can only differ if the
  // store returned the wrong row. Constant time regardless.
  if (!sameToken(record.hash, hashToken(token))) {
    return { ok: false, reason: 'not authenticated' };
  }

  await store.putToken({ ...record, lastUsedAt: now.toISOString() });
  return { ok: true, accountId: record.accountId, kind: record.kind };
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

export async function revokeToken(store: AuthStore, hash: string, now = new Date()): Promise<boolean> {
  const record = await store.getToken(hash);
  if (!record || record.revokedAt) return false;
  await store.putToken({ ...record, revokedAt: now.toISOString() });
  return true;
}

// --- sign-in links ----------------------------------------------------------

/**
 * Begin a sign-in. Returns the token to put in the emailed link.
 *
 * The caller emails it and does not log it. A sign-in link in an application
 * log is a credential in an application log.
 */
export async function startSignIn(
  store: AuthStore,
  email: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + LINK_TTL_MINUTES * 60_000).toISOString();
  await store.putLink({
    hash: hashToken(token),
    email: email.trim().toLowerCase(),
    createdAt: now.toISOString(),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Complete a sign-in, exchanging the link for a session.
 *
 * Single use, enforced by marking the link before the session is issued. If
 * this order were reversed, two simultaneous uses of one link would both
 * succeed.
 */
export async function completeSignIn(
  store: AuthStore,
  linkToken: string,
  now: Date = new Date(),
): Promise<{ ok: true; token: string; accountId: string } | { ok: false; reason: string }> {
  const hash = hashToken(linkToken);
  const link = await store.getLink(hash);
  if (!link) return { ok: false, reason: 'that link is not valid' };
  if (link.usedAt) return { ok: false, reason: 'that link has already been used' };
  if (new Date(link.expiresAt) <= now) return { ok: false, reason: 'that link has expired' };

  await store.putLink({ ...link, usedAt: now.toISOString() });
  const accountId = await store.accountForEmail(link.email);
  const issued = await issueToken(store, { accountId, kind: 'session', now });
  return { ok: true, token: issued.token, accountId };
}
