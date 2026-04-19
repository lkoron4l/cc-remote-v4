/**
 * POST /api/connect
 *
 * PC が Workers に認証・登録するエンドポイント。
 *
 * リクエスト body: { pc_id, email_hash, workers_token, pc_url?, label? }
 *   - pc_id: PC識別子
 *   - workers_token: HMAC-SHA256 トークン（PC側 workers-auth.js で生成）
 *   - email_hash: SHA-256 ハッシュ済みメールアドレス
 *   - pc_url: トンネル URL（省略可）
 *   - label: 表示用 PC 名（省略可、os.hostname() フォールバック）
 *
 * HMAC シークレットモデル:
 *   shared HMAC_SECRET（env.HMAC_SECRET）を使用する。
 *   heartbeat エンドポイント（routes/heartbeat.js）と同じモデル。
 *   PC は .env / pc.env に HMAC_SECRET を持ち、Workers も同値を env binding で保持する。
 *   per-PC シークレットは PCRegistry に PC が既登録であることを前提とするため、
 *   初回登録である /connect では使えない。shared secret が最もシンプルで一貫性がある。
 *
 * 処理フロー:
 *   1. JSON パース（失敗 → 400）
 *   2. 必須フィールドチェック（不足 → 400）
 *   3. HMAC トークン検証（失敗 → 401）
 *   4. PCRegistry DO の /register を呼び出し（upsert）
 *   5. { ok: true } 返却
 */

import { verifyToken } from '../lib/hmac.js';

/**
 * @param {Request} request
 * @param {Object} env  Workers bindings（PC_REGISTRY, HMAC_SECRET）
 * @returns {Promise<Response>}
 */
export async function handleConnect(request, env) {
  // JSON パース
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { pc_id, email_hash, workers_token, pc_url, label } = body;

  // 必須フィールドチェック
  if (!pc_id || !workers_token || !email_hash) {
    return Response.json(
      { error: 'pc_id, workers_token, email_hash are required' },
      { status: 400 }
    );
  }

  // HMAC_SECRET の存在確認
  const secret = env.HMAC_SECRET;
  if (!secret) {
    console.error('[connect] HMAC_SECRET is not configured');
    return Response.json({ error: 'server misconfiguration' }, { status: 500 });
  }

  // HMAC トークン検証
  const valid = await verifyToken(workers_token, pc_id, secret);
  if (!valid) {
    return Response.json({ error: 'unauthorized: invalid or expired token' }, { status: 401 });
  }

  // PCRegistry DO に登録（upsert）
  const doId = env.PC_REGISTRY.idFromName('global');
  const stub = env.PC_REGISTRY.get(doId);

  const regResp = await stub.fetch(
    new Request('http://do/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pcId: pc_id,
        tunnel_url: pc_url || '',
        email_hash,
        ...(label ? { label } : {}),
      }),
    })
  );

  if (!regResp.ok) {
    const err = await regResp.json().catch(() => ({ error: 'unknown' }));
    return Response.json({ error: err.error || 'registry error' }, { status: 502 });
  }

  return Response.json({ ok: true });
}
