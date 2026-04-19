/**
 * POST /api/heartbeat
 *
 * リクエスト body: { pcId, workers_token, tunnel_url, email_hash?, label? }
 *   - pcId: PC識別子
 *   - workers_token: HMAC-SHA256 トークン（generateToken で生成）
 *   - tunnel_url: 現在のトンネル URL
 *   - email_hash: SHA-256 ハッシュ済みメールアドレス（初回登録/更新用、省略可）
 *   - label: 表示用 PC 名（省略可、更新時に反映）
 *
 * 処理フロー:
 *   1. HMAC トークン検証（失敗 → 401）
 *   2. PCRegistry DO に heartbeat 送信
 *   3. { ok: true } 返却
 */

import { verifyToken } from '../lib/hmac.js';

/**
 * @param {Request} request
 * @param {Object} env  Workers bindings（PC_REGISTRY, HMAC_SECRET）
 * @returns {Promise<Response>}
 */
export async function handleHeartbeat(request, env) {
  // Content-Type チェック（緩め：body が JSON であれば OK）
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { pcId, workers_token, tunnel_url, email_hash, label } = body;

  if (!pcId || !workers_token || !tunnel_url) {
    return Response.json(
      { error: 'pcId, workers_token, tunnel_url are required' },
      { status: 400 }
    );
  }

  // HMAC トークン検証
  const secret = env.HMAC_SECRET;
  if (!secret) {
    console.error('[heartbeat] HMAC_SECRET is not configured');
    return Response.json({ error: 'server misconfiguration' }, { status: 500 });
  }

  const valid = await verifyToken(workers_token, pcId, secret);
  if (!valid) {
    return Response.json({ error: 'unauthorized: invalid or expired token' }, { status: 401 });
  }

  // PCRegistry DO を呼び出す
  const doId = env.PC_REGISTRY.idFromName('global');
  const stub = env.PC_REGISTRY.get(doId);

  // email_hash が付いている場合は register（upsert）、なければ heartbeat のみ
  if (email_hash) {
    const regResp = await stub.fetch(
      new Request('http://do/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pcId, tunnel_url, email_hash, ...(label ? { label } : {}) }),
      })
    );
    if (!regResp.ok) {
      const err = await regResp.json().catch(() => ({ error: 'unknown' }));
      return Response.json({ error: err.error || 'registry error' }, { status: 502 });
    }
    return Response.json({ ok: true });
  }

  // heartbeat のみ
  const hbResp = await stub.fetch(
    new Request('http://do/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcId, tunnel_url, ...(label ? { label } : {}) }),
    })
  );

  if (!hbResp.ok) {
    const err = await hbResp.json().catch(() => ({ error: 'unknown' }));
    // PC が未登録（404）の場合は 404 をそのまま返す
    return Response.json(
      { error: err.error || 'registry error' },
      { status: hbResp.status === 404 ? 404 : 502 }
    );
  }

  return Response.json({ ok: true });
}
