/**
 * Client for 3ook.com's own login endpoint.
 *
 * Why not call api.like.co directly?
 *   `api.like.co/users/login` returns a `likecoin_auth` JWT scoped to
 *   `.like.co`. But 3ook.com's frontend doesn't read that cookie — it
 *   relies on an encrypted Nuxt session cookie (`nuxt-session` on
 *   `.3ook.com`, set by `nuxt-auth-utils`). To get that cookie we must
 *   call 3ook.com's own `/api/login`, which internally calls
 *   `api.like.co/wallet/authorize` then wraps the result in a Nuxt
 *   session.
 *
 * Refs: likecoin/liker-land-v3 `server/api/login.post.ts`,
 *       `stores/account.ts` JWT_PERMISSIONS + buildSignaturePayload.
 */

const APP_BASE =
  process.env.EXPO_PUBLIC_3OOK_BASE?.replace(/\/$/, '') ?? 'https://3ook.com';

/**
 * Permissions list 3ook.com expects the user to grant. Must match
 * `JWT_PERMISSIONS` in liker-land-v3 `stores/account.ts` byte-for-byte
 * because the message containing this array is what the wallet signs.
 */
export const JWT_PERMISSIONS = [
  'profile',
  'email',
  'read:nftbook',
  'write:nftbook',
  'read:plus',
  'write:plus',
  'read:preferences',
  'write:preferences',
  'read:profile',
  'write:profile',
] as const;

export interface AuthorizePayload {
  action: 'authorize';
  evmWallet: string;
  ts: number;
  email?: string;
  loginMethod?: string;
  permissions: readonly string[];
}

export interface ThreeOokLoginResult {
  setCookieHeader: string | null;
  /** Parsed JSON body from /api/login on success, or `null` on non-200. */
  userInfo: Record<string, unknown> | null;
}

export class ThreeOokAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Build the exact message string the wallet must sign. Pretty-printed
 * with 2-space indent so it matches the web client byte-for-byte —
 * otherwise the server's `recoverPersonalSignature` won't match.
 */
export function buildAuthorizePayload(args: {
  checksummedAddress: string;
  email?: string;
  loginMethod?: string;
}): { payload: AuthorizePayload; message: string } {
  // JSON.stringify drops keys whose value is undefined, so we don't need
  // to conditionally include `email` / `loginMethod`.
  const payload: AuthorizePayload = {
    action: 'authorize',
    evmWallet: args.checksummedAddress,
    ts: Date.now(),
    email: args.email,
    loginMethod: args.loginMethod,
    permissions: JWT_PERMISSIONS,
  };
  const message = JSON.stringify(payload, null, 2);
  return { payload, message };
}

/**
 * POST 3ook.com/api/login. On success, the server sets a `nuxt-session`
 * cookie on `.3ook.com` via Set-Cookie. We parse the Set-Cookie header
 * out of the response so the caller can re-issue it into the WebView's
 * cookie jar (RN's fetch cookie jar is separate from WebView's).
 */
export async function loginTo3ook(opts: {
  walletAddress: string; // checksummed; the server accepts mixed case
  message: string; // exact bytes that were signed
  signature: string; // 0x… personal_sign hex
  email?: string;
  loginMethod?: string;
}): Promise<ThreeOokLoginResult> {
  const body = {
    walletAddress: opts.walletAddress,
    message: opts.message,
    signature: opts.signature,
    email: opts.email,
    loginMethod: opts.loginMethod,
  };

  let res: Response;
  try {
    res = await fetch(`${APP_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ThreeOokAuthError(0, `Network error: ${(e as Error).message}`);
  }

  const setCookieHeader = extractSetCookie(res);

  if (!res.ok) {
    let detail = `Login failed (${res.status})`;
    try {
      const text = await res.text();
      if (text) detail = text;
    } catch {
      // ignore
    }
    throw new ThreeOokAuthError(res.status, detail);
  }

  let userInfo: Record<string, unknown> | null = null;
  try {
    userInfo = (await res.json()) as Record<string, unknown>;
  } catch {
    // Server might return empty body on success; not fatal.
  }

  return { setCookieHeader, userInfo };
}

function extractSetCookie(res: Response): string | null {
  const getter = (res.headers as unknown as { get?: (k: string) => string | null }).get;
  if (typeof getter === 'function') {
    const v = getter.call(res.headers, 'set-cookie');
    if (v) return v;
  }
  const map = (res.headers as unknown as { map?: Record<string, string> }).map;
  if (map && typeof map === 'object') {
    return map['set-cookie'] ?? map['Set-Cookie'] ?? null;
  }
  return null;
}
