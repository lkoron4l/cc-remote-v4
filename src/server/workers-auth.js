/**
 * Workers 認証モジュール（PC側、Node.js）
 *
 * PC が Cloudflare Workers dispatcher に認証・登録するための
 * HMAC トークン生成と /api/connect 呼び出しを提供する。
 *
 * Node.js の crypto モジュール（createHmac）を使用する。
 * Workers 側の hmac.js（WebCrypto）と同一のトークン形式を生成する:
 *   base64url( pcId:expiresAt ) + "." + base64url( HMAC-SHA256 署名 )
 *
 * workers-heartbeat.js の _generateToken と同じ実装（再利用のため共通化）。
 */

import { createHmac } from 'node:crypto';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15分
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * HMAC-SHA256 トークンを生成する（Node.js crypto 版）
 *
 * workers/src/lib/hmac.js の generateToken と互換性のある形式:
 *   payload = base64url(pcId:expiresAt)
 *   sig     = base64url(HMAC-SHA256(key=secret, data=payload))
 *   token   = payload + "." + sig
 *
 * @param {string} pcId
 * @param {string} pcSecret
 * @param {number} [now]  テスト用（省略時は Date.now()）
 * @returns {{ token: string, expires_at: number }}
 */
export function generateWorkersToken(pcId, pcSecret, now = Date.now()) {
  const expires_at = now + TOKEN_TTL_MS;
  const payloadStr = `${pcId}:${expires_at}`;
  const payload = Buffer.from(payloadStr).toString('base64url');
  const hmac = createHmac('sha256', pcSecret);
  hmac.update(payload);
  const sig = hmac.digest('base64url');
  return { token: `${payload}.${sig}`, expires_at };
}

/**
 * Workers dispatcher の /api/connect を呼び出し、PC を登録する。
 *
 * @param {Object} opts
 * @param {string} opts.dispatcherUrl   Workers dispatcher の URL
 * @param {string} opts.pcId            PC 識別子
 * @param {string} opts.pcSecret        HMAC シークレット（env.HMAC_SECRET と同値）
 * @param {string} opts.emailHash       SHA-256 ハッシュ済みメールアドレス
 * @param {string} [opts.pcUrl]         トンネル URL（省略可）
 * @param {string} [opts.label]         表示用 PC 名（省略可）
 * @returns {Promise<{ ok: true }>}
 * @throws {Error} HTTP エラーまたはネットワークエラー時
 */
export async function connectToWorkers({ dispatcherUrl, pcId, pcSecret, emailHash, pcUrl, label }) {
  const { token } = generateWorkersToken(pcId, pcSecret);

  const body = {
    pc_id: pcId,
    email_hash: emailHash,
    workers_token: token,
  };
  if (pcUrl) body.pc_url = pcUrl;
  if (label) body.label = label;

  const resp = await fetch(`${dispatcherUrl}/api/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`[workers-auth] connect failed HTTP ${resp.status}: ${text}`);
  }

  return resp.json();
}
