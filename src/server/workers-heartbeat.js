/**
 * Workers Heartbeat モジュール
 *
 * Cloudflare Workers dispatcher に定期的に heartbeat を送信する。
 * 既存の watchdog.js の self-ping（ローカルトンネル死活監視）とは独立した別タイマー。
 *
 * 設定（.env または process.env で指定）:
 *   WORKERS_DISPATCHER_URL : Workers の URL
 *   PC_ID                  : pc-identity.js から自動ロード
 *   HMAC_SECRET            : HMAC-SHA256 シークレット（Workers 側と同値）
 *   WORKERS_EMAIL          : 平文メールアドレス（内部で SHA-256 ハッシュ化して送信）
 *
 * 環境変数が未設定の場合は警告のみ出力して機能無効化。
 * 送信失敗は警告ログのみ（既存機能に影響しない）。
 */

import { createHash, createHmac } from 'node:crypto';

const HEARTBEAT_INTERVAL_MS = 120_000; // 120秒（watchdog.js の TUNNEL_SELFPING とは独立）
const HEARTBEAT_TIMEOUT_MS = 10_000;   // 10秒タイムアウト
const TOKEN_TTL_MS = 15 * 60 * 1000;  // 15分

let _timer = null;
let _isRunning = false;

// --- HMAC トークン生成（Node.js crypto 版、Workers hmac.js と同じ形式） ---

/**
 * @param {string} pcId
 * @param {string} secret
 * @param {number} [now]
 * @returns {{ token: string, expires_at: number }}
 */
function _generateToken(pcId, secret, now = Date.now()) {
  const expires_at = now + TOKEN_TTL_MS;
  const payloadStr = `${pcId}:${expires_at}`;
  const payload = Buffer.from(payloadStr).toString('base64url');
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  const sig = hmac.digest('base64url');
  return { token: `${payload}.${sig}`, expires_at };
}

// --- SHA-256 メールハッシュ ---

function _hashEmail(email) {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

// --- heartbeat 送信 ---

async function _sendHeartbeat(dispatcherUrl, pcId, secret, tunnelUrl, emailHash, label) {
  const { token } = _generateToken(pcId, secret);

  const body = { pcId, workers_token: token, tunnel_url: tunnelUrl };
  if (emailHash) body.email_hash = emailHash;
  if (label) body.label = label;

  const resp = await fetch(`${dispatcherUrl}/api/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  return resp.json();
}

/**
 * Workers heartbeat を開始する
 * watchdog.js の initWatchdog と同様に呼び出す（独立タイマー）
 *
 * @param {Object} [opts]
 * @param {string} [opts.dispatcherUrl]  省略時は process.env.WORKERS_DISPATCHER_URL
 * @param {string} [opts.pcId]           省略時は process.env.PC_ID
 * @param {string} [opts.secret]         省略時は process.env.HMAC_SECRET
 * @param {string} [opts.email]          省略時は process.env.WORKERS_EMAIL（平文、内部でハッシュ化）
 * @param {string} [opts.label]          表示用 PC 名（省略時は process.env.PC_LABEL || os.hostname()）
 * @param {Function} [opts.getTunnelUrl] global.tunnelUrl を返す関数
 */
export function startWorkersHeartbeat(opts = {}) {
  const dispatcherUrl = opts.dispatcherUrl || process.env.WORKERS_DISPATCHER_URL;
  const pcId = opts.pcId || process.env.PC_ID;
  const secret = opts.secret || process.env.HMAC_SECRET;
  const email = opts.email || process.env.WORKERS_EMAIL;
  const label = opts.label || process.env.PC_LABEL || null;
  const getTunnelUrl = opts.getTunnelUrl || (() => global.tunnelUrl || null);

  if (!dispatcherUrl || !pcId || !secret) {
    console.log('[WorkersHB] WORKERS_DISPATCHER_URL / PC_ID / HMAC_SECRET が未設定。Workers heartbeat 無効。');
    return;
  }

  if (_isRunning) {
    console.log('[WorkersHB] 既に起動中。二重起動をスキップ。');
    return;
  }
  _isRunning = true;

  const emailHash = email ? _hashEmail(email) : null;

  async function doHeartbeat() {
    const tunnelUrl = getTunnelUrl();
    if (!tunnelUrl) {
      console.log('[WorkersHB] tunnel URL 未取得、スキップ');
      return;
    }
    try {
      const result = await _sendHeartbeat(dispatcherUrl, pcId, secret, tunnelUrl, emailHash, label);
      console.log(`[WorkersHB] heartbeat 送信成功: ${JSON.stringify(result)}`);
    } catch (e) {
      console.log(`[WorkersHB] heartbeat 送信失敗（続行）: ${e.message}`);
    }
  }

  // 即時1回送信 + 定期タイマー（watchdog.js とは別タイマー）
  doHeartbeat().catch(() => {});
  _timer = setInterval(() => {
    doHeartbeat().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  console.log(`[WorkersHB] Workers heartbeat 開始（${HEARTBEAT_INTERVAL_MS / 1000}秒間隔） dispatcher: ${dispatcherUrl}`);
}

/**
 * URL 変化時の即時 heartbeat 送信
 * tunnel.js の onTunnelUrlChange コールバックから呼び出す
 *
 * @param {string} newUrl 新しいトンネル URL
 */
export function sendImmediateHeartbeat(newUrl) {
  const dispatcherUrl = process.env.WORKERS_DISPATCHER_URL;
  const pcId = process.env.PC_ID;
  const secret = process.env.HMAC_SECRET;
  const email = process.env.WORKERS_EMAIL;
  const label = process.env.PC_LABEL || null;

  if (!dispatcherUrl || !pcId || !secret || !newUrl) return;

  const emailHash = email ? _hashEmail(email) : null;

  _sendHeartbeat(dispatcherUrl, pcId, secret, newUrl, emailHash, label)
    .then((r) => console.log(`[WorkersHB] URL変化 即時 heartbeat 送信成功: ${JSON.stringify(r)}`))
    .catch((e) => console.log(`[WorkersHB] URL変化 即時 heartbeat 失敗（続行）: ${e.message}`));
}

/**
 * Workers heartbeat を停止する
 */
export function stopWorkersHeartbeat() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _isRunning = false;
  console.log('[WorkersHB] Workers heartbeat 停止');
}
