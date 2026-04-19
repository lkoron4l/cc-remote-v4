/**
 * GET /api/pcs — PC一覧取得
 *
 * Cookie セッション認証必須。
 * - Cookie: session=<token> が必要
 * - GET リクエストのため CSRF チェックはスキップ（validateOriginCsrf の仕様通り）
 * - 有効なセッションから email_hash を取得し、PCRegistry DO にリスト要求
 * - クエリパラメータの email_hash は受け付けない（セキュリティ上削除）
 *
 * レスポンス:
 *   200: { pcs: [{ pcId, tunnel_url, email_hash, last_heartbeat_at, registered_at }] }
 *   401: { error: "unauthorized" }
 */

import { parseSessionCookie } from '../auth/cookie.js';

/**
 * GET /api/pcs
 *
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleGetPcs(request, env) {
  // Cookie からセッショントークンを取得
  const token = parseSessionCookie(request.headers.get('Cookie'));
  if (!token) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // SessionStore DO でトークンを検証し email_hash を取得
  if (!env.SESSION_STORE) {
    return Response.json({ error: 'session store not configured' }, { status: 503 });
  }

  let email_hash;
  try {
    const doId = env.SESSION_STORE.idFromName('global');
    const stub = env.SESSION_STORE.get(doId);
    const sessResp = await stub.fetch(
      new Request(`http://do/get?token=${encodeURIComponent(token)}`, { method: 'GET' })
    );

    if (!sessResp.ok) {
      // 404 (not found) or 410 (expired)
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const sessData = await sessResp.json();
    email_hash = sessData.session?.email_hash;
    if (!email_hash) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // PCRegistry DO に email_hash フィルタ付きでリスト要求
  if (!env.PC_REGISTRY) {
    return Response.json({ error: 'pc registry not configured' }, { status: 503 });
  }

  try {
    const doId = env.PC_REGISTRY.idFromName('global');
    const stub = env.PC_REGISTRY.get(doId);
    const listUrl = `http://do/list?email_hash=${encodeURIComponent(email_hash)}`;
    const resp = await stub.fetch(new Request(listUrl, { method: 'GET' }));
    return resp;
  } catch (err) {
    return Response.json({ error: `registry error: ${err.message}` }, { status: 503 });
  }
}
