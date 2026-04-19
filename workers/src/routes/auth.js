/**
 * Google OAuth2 route handlers.
 *
 * GET /api/auth/google    — redirect to Google consent screen
 * GET /api/auth/callback  — handle OAuth2 callback, issue session token
 */

import { buildAuthUrl, exchangeCode, verifyIdToken, hashEmail } from '../auth/google.js';
import { signState, verifyState } from '../auth/state.js';
import { buildSessionCookie, buildClearCookie, parseSessionCookie, validateOriginCsrf } from '../auth/cookie.js';
import { generateLinkTicket } from '../lib/hmac.js';

/**
 * GET /api/auth/google
 * Redirects the browser to Google's OAuth2 consent screen.
 *
 * Required env:
 *   GOOGLE_CLIENT_ID, HMAC_SECRET, OAUTH_REDIRECT_URI
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Response}
 */
export async function handleAuthGoogle(request, env) {
  const { GOOGLE_CLIENT_ID, HMAC_SECRET, OAUTH_REDIRECT_URI } = env;

  if (!GOOGLE_CLIENT_ID || !HMAC_SECRET || !OAUTH_REDIRECT_URI) {
    return Response.json(
      { error: 'OAuth not configured (missing env vars)' },
      { status: 503 }
    );
  }

  // Embed invite token in state if provided via ?invite=<token>
  const reqUrl = new URL(request.url);
  const inviteToken = reqUrl.searchParams.get('invite');
  const statePayload = inviteToken ? { invite: inviteToken } : {};

  const state = await signState(statePayload, HMAC_SECRET);
  const url = buildAuthUrl({
    clientId: GOOGLE_CLIENT_ID,
    redirectUri: OAUTH_REDIRECT_URI,
    state,
  });

  return Response.redirect(url, 302);
}

/**
 * GET /api/auth/callback
 * Handles the OAuth2 callback from Google.
 * Verifies state CSRF token, exchanges code, verifies ID token, creates session.
 *
 * Required env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, HMAC_SECRET, OAUTH_REDIRECT_URI, SESSION_STORE
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Response}
 */
export async function handleAuthCallback(request, env) {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    HMAC_SECRET,
    OAUTH_REDIRECT_URI,
    SESSION_STORE,
    INVITE_STORE,
  } = env;

  if (
    !GOOGLE_CLIENT_ID ||
    !GOOGLE_CLIENT_SECRET ||
    !HMAC_SECRET ||
    !OAUTH_REDIRECT_URI ||
    !SESSION_STORE
  ) {
    return Response.json(
      { error: 'OAuth not configured (missing env vars)' },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateStr = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  // Google may return error (e.g. access_denied)
  if (errorParam) {
    return Response.json({ error: `OAuth error: ${errorParam}` }, { status: 400 });
  }

  if (!code || !stateStr) {
    return Response.json({ error: 'code and state are required' }, { status: 400 });
  }

  // Verify CSRF state
  let statePayload;
  try {
    statePayload = await verifyState(stateStr, HMAC_SECRET);
  } catch (err) {
    return Response.json({ error: `invalid state: ${err.message}` }, { status: 400 });
  }

  const inviteToken = statePayload.invite || null;

  // Exchange authorization code for tokens
  let tokenResponse;
  try {
    tokenResponse = await exchangeCode({
      code,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: OAUTH_REDIRECT_URI,
    });
  } catch {
    return Response.json({ error: 'token exchange failed' }, { status: 502 });
  }

  const { id_token } = tokenResponse;
  if (!id_token) {
    return Response.json({ error: 'no id_token in token response' }, { status: 502 });
  }

  // Verify ID token and extract claims
  let claims;
  try {
    claims = await verifyIdToken(id_token, GOOGLE_CLIENT_ID);
  } catch (err) {
    return Response.json({ error: `id_token verification failed: ${err.message}` }, { status: 401 });
  }

  if (claims.email_verified !== true) {
    return Response.json({ error: 'email not verified' }, { status: 403 });
  }

  const { email } = claims;
  if (!email) {
    return Response.json({ error: 'no email in id_token claims' }, { status: 401 });
  }

  const email_hash = await hashEmail(email);

  // Process invite token if present: atomically validate and mark as used
  if (inviteToken && INVITE_STORE) {
    const inviteDoId = INVITE_STORE.idFromName('global');
    const inviteStub = INVITE_STORE.get(inviteDoId);

    let inviteResp;
    try {
      inviteResp = await inviteStub.fetch(
        new Request('http://do/check-and-use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: inviteToken, used_by_email_hash: email_hash }),
        })
      );
    } catch (err) {
      return Response.json({ error: `invite store error: ${err.message}` }, { status: 503 });
    }

    if (!inviteResp.ok) {
      const errBody = await inviteResp.json().catch(() => ({}));
      return Response.json(
        { error: errBody.error ?? 'invite invalid' },
        { status: 403 }
      );
    }
  }

  // Generate session token (32 random bytes as hex)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const session_token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Store session in SessionStore DO
  const doId = SESSION_STORE.idFromName('global');
  const stub = SESSION_STORE.get(doId);

  let sessionResp;
  try {
    sessionResp = await stub.fetch(
      new Request('http://do/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // email も plain で保存（link-ticket 発行時に PC 側 ALLOWED_EMAILS 判定に使う）
        body: JSON.stringify({ token: session_token, email_hash, email }),
      })
    );
  } catch (err) {
    return Response.json({ error: `session store error: ${err.message}` }, { status: 503 });
  }

  if (!sessionResp.ok) {
    const body = await sessionResp.text();
    return Response.json({ error: `session store rejected: ${body}` }, { status: 503 });
  }

  const { expires_at } = await sessionResp.json();

  // Issue HttpOnly session cookie. On DEBUG_RETURN_TOKEN mode return JSON for tests;
  // otherwise redirect back to the PWA root so the user lands on the app.
  const cookieHeader = buildSessionCookie(session_token);
  if (env.DEBUG_RETURN_TOKEN === 'true') {
    const body = { ok: true, email_hash, expires_at, session_token };
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieHeader },
      status: 200,
    });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': cookieHeader },
  });
}

/**
 * POST /api/auth/logout
 * Revokes the session and clears the session cookie.
 *
 * Validates Origin header against env.ALLOWED_ORIGINS (comma-separated).
 * If ALLOWED_ORIGINS is unset or empty, all requests are rejected (403).
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Response}
 */
export async function handleAuthLogout(request, env) {
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (allowedOrigins.length === 0 || !validateOriginCsrf(request, allowedOrigins)) {
    return Response.json({ error: 'forbidden: origin not allowed' }, { status: 403 });
  }

  const token = parseSessionCookie(request.headers.get('Cookie'));

  if (token && env.SESSION_STORE) {
    try {
      const doId = env.SESSION_STORE.idFromName('global');
      const stub = env.SESSION_STORE.get(doId);
      await stub.fetch(
        new Request('http://do/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
      );
    } catch {
      // Best-effort revocation — always clear the cookie regardless
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildClearCookie(),
    },
    status: 200,
  });
}

/**
 * POST /api/auth/link-ticket
 *
 * 案1: dispatcher Cookie を信頼の元に、各PCへ引き継ぐ HMAC 署名済みチケットを発行する。
 * body: { pc_id }
 * 認証: session Cookie 必須 + Origin CSRF チェック（POST のため）
 *
 * レスポンス:
 *   200: { ok: true, ticket, exp }
 *   400: 不正 pc_id
 *   401: Cookie 未提示 or 期限切れ
 *   403: Origin 不一致 or email 無し
 *   500/503: 設定不備
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleLinkTicket(request, env) {
  // 1. CSRF: Origin 検証（POST なので必須）
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowedOrigins.length === 0 || !validateOriginCsrf(request, allowedOrigins)) {
    return Response.json({ error: 'forbidden: origin not allowed' }, { status: 403 });
  }

  // 2. HMAC_SECRET 必須
  if (!env.HMAC_SECRET) {
    return Response.json({ error: 'server misconfiguration' }, { status: 500 });
  }

  // 3. Cookie からセッション取得
  const token = parseSessionCookie(request.headers.get('Cookie'));
  if (!token || !env.SESSION_STORE) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 4. SessionStore で token → email を取り出す
  let sessionRecord;
  try {
    const doId = env.SESSION_STORE.idFromName('global');
    const stub = env.SESSION_STORE.get(doId);
    const sessResp = await stub.fetch(
      new Request(`http://do/get?token=${encodeURIComponent(token)}`, { method: 'GET' })
    );
    if (!sessResp.ok) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const data = await sessResp.json();
    sessionRecord = data.session;
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!sessionRecord || !sessionRecord.email) {
    // 2026-04-17 以前に作られた session には email が無い → OAuth 再ログインで再発行を促す
    return Response.json({ error: 'session missing email; re-login required' }, { status: 403 });
  }

  // 5. body から pc_id
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const pc_id = body && typeof body.pc_id === 'string' ? body.pc_id.trim() : '';
  if (!pc_id) {
    return Response.json({ error: 'pc_id is required' }, { status: 400 });
  }

  // 6. HMAC チケット発行（pc_id|email|exp、2分TTL）
  const { ticket, exp } = await generateLinkTicket(
    { pc_id, email: sessionRecord.email },
    env.HMAC_SECRET,
  );
  return Response.json({ ok: true, ticket, exp });
}
