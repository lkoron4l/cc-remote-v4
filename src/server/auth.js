// PIN Authentication — CC Remote v4 (P2P, no central auth)
// 2026-04-17: 段階1+2 実装。Google session + PIN token を SQLite に永続化し、
// 信頼端末モード ON 時は Google 認証成功で自動的に PIN を省略して token も同時発行する。
// 既存の Map ベースキャッシュは互換のため残してある（DB 不在時も動く）。
import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import { getDB, saveDB } from './db.js';

const authRoutes = Router();

// PIN brute force 対策: 1分あたり10回 / IP
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ログイン試行が多すぎます。1分後に再試行してください。' },
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '963785499726-v0da2q3hqktflate717q7033snjcht90.apps.googleusercontent.com';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (ALLOWED_EMAILS.length === 0) {
  console.warn('[auth] ALLOWED_EMAILS is empty — all Google logins will be rejected. Set ALLOWED_EMAILS in .env');
}
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// 案1 (2026-04-17): Workers Dispatcher からの link-ticket 引き継ぎ用
// 同一プロセス内のワンショット消費 Set（TTL 5分を超えた entry は lazy 掃除）。
// サーバー再起動で揮発するが、ticket 自体が 2分TTL なのでそれ以上前の ticket は
// どのみち HMAC 検証で expired により弾かれる。
const HMAC_SECRET_RAW = process.env.HMAC_SECRET || '';
const usedLinkTickets = new Map(); // sig -> createdAt
const USED_LINK_TICKET_TTL_MS = 5 * 60 * 1000;
const PC_ID_FOR_LINK = process.env.PC_ID || '';

// In-memory cache (DB ロード後に同期)。Map のままアクセスする既存コードを壊さないため残す。
const googleSessions = new Map();
const activeTokens = new Map();
const GOOGLE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日（Google ログインは30日無音）
const TOKEN_TTL_MS = 60 * 60 * 1000;                    // 1時間（PINは1時間ごとに再入力させる方針）
const PIN_MIN_LENGTH = 4;

// 信頼端末モード（デフォルト ON）。settings テーブルの 'trusted_device_mode' に 'true'/'false' で保存。
const TRUSTED_DEVICE_MODE_KEY = 'trusted_device_mode';

// ---------------------------------------------------------------------------
// Persistence helpers — DB 操作で例外が起きても認証フロー本体を止めない
// ---------------------------------------------------------------------------
function safeDb(fn) {
  try { return fn(getDB()); } catch (e) { console.warn('[auth] DB access failed:', e.message); return null; }
}

function loadGoogleSessionsFromDB() {
  safeDb((db) => {
    const result = db.exec('SELECT token, email, created_at FROM google_sessions');
    if (!result.length) return;
    const now = Date.now();
    for (const row of result[0].values) {
      const [token, email, createdAt] = row;
      if (now - createdAt <= GOOGLE_SESSION_TTL_MS) {
        googleSessions.set(token, { email, createdAt });
      }
    }
    console.log(`[auth] Google session 復元: ${googleSessions.size}件`);
  });
}

function loadActiveTokensFromDB() {
  safeDb((db) => {
    const result = db.exec('SELECT token, created_at FROM auth_tokens');
    if (!result.length) return;
    const now = Date.now();
    for (const row of result[0].values) {
      const [token, createdAt] = row;
      if (now - createdAt <= TOKEN_TTL_MS) {
        activeTokens.set(token, createdAt);
      }
    }
    console.log(`[auth] Auth token 復元: ${activeTokens.size}件`);
  });
}

function persistGoogleSession(token, email, createdAt) {
  safeDb((db) => {
    db.run('INSERT OR REPLACE INTO google_sessions (token, email, created_at) VALUES (?, ?, ?)', [token, email, createdAt]);
    saveDB();
  });
}

function persistActiveToken(token, createdAt) {
  safeDb((db) => {
    db.run('INSERT OR REPLACE INTO auth_tokens (token, created_at) VALUES (?, ?)', [token, createdAt]);
    saveDB();
  });
}

function deleteGoogleSession(token) {
  safeDb((db) => {
    db.run('DELETE FROM google_sessions WHERE token = ?', [token]);
    saveDB();
  });
}

function deleteActiveToken(token) {
  safeDb((db) => {
    db.run('DELETE FROM auth_tokens WHERE token = ?', [token]);
    saveDB();
  });
}

function purgeExpiredFromDB() {
  safeDb((db) => {
    const now = Date.now();
    db.run('DELETE FROM google_sessions WHERE ? - created_at > ?', [now, GOOGLE_SESSION_TTL_MS]);
    db.run('DELETE FROM auth_tokens WHERE ? - created_at > ?', [now, TOKEN_TTL_MS]);
    saveDB();
  });
}

// 起動時のロード（initDB 完了後に呼ばれる前提だが、未初期化なら safeDb が黙ってスキップする）
loadGoogleSessionsFromDB();
loadActiveTokensFromDB();

// ---------------------------------------------------------------------------
// PIN hashing (scrypt with SHA-256 legacy fallback for migration)
// ---------------------------------------------------------------------------

function hashPinLegacy(pin, salt) {
  return crypto.createHash('sha256').update(salt + pin).digest('hex');
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getSettingsValue(key) {
  try {
    const db = getDB();
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row.value;
    }
    stmt.free();
    return null;
  } catch {
    return null;
  }
}

function setSettingsValue(key, value) {
  safeDb((db) => {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
    saveDB();
  });
}

function getTrustedDeviceMode() {
  // デフォルト OFF。PIN を 1時間ごとに 1 回入れさせる方針に変更したため。
  // 明示的に 'true' を入れた端末だけ「Google認証成功で PIN も省略」になる。
  const v = getSettingsValue(TRUSTED_DEVICE_MODE_KEY);
  return v === 'true';
}

function getStoredPin() {
  return getSettingsValue('pin_hash'); // "salt:hash"
}

function storePin(pin) {
  const salt = generateSalt();
  const hash = hashPin(pin, salt);
  const value = `${salt}:${hash}`;
  setSettingsValue('pin_hash', value);
}

function verifyPin(pin) {
  const stored = getStoredPin();
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (hashPin(pin, salt) === hash) return true;
  if (hashPinLegacy(pin, salt) === hash) {
    storePin(pin);
    console.log('[Auth] PIN hash migrated from SHA-256 to scrypt');
    return true;
  }
  return false;
}

function isTokenActive(token) {
  if (!token || !activeTokens.has(token)) return false;
  const createdAt = activeTokens.get(token);
  if (Date.now() - createdAt > TOKEN_TTL_MS) {
    activeTokens.delete(token);
    deleteActiveToken(token);
    return false;
  }
  return true;
}

function isGoogleSessionValidInternal(session) {
  if (!session || !googleSessions.has(session)) return false;
  const { createdAt } = googleSessions.get(session);
  if (Date.now() - createdAt > GOOGLE_SESSION_TTL_MS) {
    googleSessions.delete(session);
    deleteGoogleSession(session);
    return false;
  }
  return true;
}

function issueAuthToken() {
  const token = generateToken();
  const now = Date.now();
  activeTokens.set(token, now);
  persistActiveToken(token, now);
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, createdAt] of activeTokens) {
    if (now - createdAt > TOKEN_TTL_MS) activeTokens.delete(token);
  }
  for (const [s, { createdAt }] of googleSessions) {
    if (now - createdAt > GOOGLE_SESSION_TTL_MS) googleSessions.delete(s);
  }
  purgeExpiredFromDB();
}, 60 * 60 * 1000);

function isAuthenticated(req) {
  const token = req.headers['x-pin'];
  return isTokenActive(token);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

authRoutes.get('/status', (req, res) => {
  const hasPin = getStoredPin() !== null;
  // 段階1: クライアントが ?session=xxx で問い合わせ → Google session が生きてるか返す
  const querySession = typeof req.query?.session === 'string' ? req.query.session : '';
  const googleSessionValid = querySession ? isGoogleSessionValidInternal(querySession) : false;
  // PINログイン画面で「どのPCに入ろうとしてるか」を出すための識別ラベル
  const pcLabel = process.env.PC_LABEL || process.env.PC_NAME || '';
  res.json({
    hasPin,
    isAuthenticated: isAuthenticated(req),
    googleSessionValid,
    trustedDeviceMode: getTrustedDeviceMode(),
    pcLabel,
  });
});

authRoutes.post('/setup', (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== 'string' || pin.length < PIN_MIN_LENGTH) {
    return res.status(400).json({ error: `PINは${PIN_MIN_LENGTH}文字以上で入力してください` });
  }
  if (getStoredPin() !== null) {
    return res.status(409).json({ error: 'PINはすでに設定されています' });
  }
  storePin(pin);
  const token = issueAuthToken();
  res.json({ ok: true, token });
});

authRoutes.post('/login', loginLimiter, (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'PINが必要です' });
  }
  if (getStoredPin() === null) {
    return res.status(400).json({ error: 'PINが設定されていません。先にセットアップしてください。' });
  }
  if (!verifyPin(pin)) {
    return res.status(401).json({ error: 'PINが正しくありません' });
  }
  const token = issueAuthToken();
  res.json({ token });
});

authRoutes.post('/change-pin', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '認証が必要です' });
  }
  const { oldPin, newPin } = req.body;
  if (!oldPin || !newPin) {
    return res.status(400).json({ error: 'oldPinとnewPinが必要です' });
  }
  if (typeof newPin !== 'string' || newPin.length < PIN_MIN_LENGTH) {
    return res.status(400).json({ error: `新しいPINは${PIN_MIN_LENGTH}文字以上で入力してください` });
  }
  if (!verifyPin(oldPin)) {
    return res.status(401).json({ error: '現在のPINが正しくありません' });
  }
  storePin(newPin);
  // PIN 変更時は全 token を無効化（DB側も全削除）
  activeTokens.clear();
  safeDb((db) => { db.run('DELETE FROM auth_tokens'); saveDB(); });
  res.json({ ok: true });
});

authRoutes.post('/logout', (req, res) => {
  const token = req.headers['x-pin'];
  if (token) {
    activeTokens.delete(token);
    deleteActiveToken(token);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Google OAuth — verifies ID Token from GIS, gates PC registration by email.
// 段階1+2: Google session を SQLite に永続化。
// trustedDeviceMode ON のときは PIN を省略して token も同時発行する。
// ---------------------------------------------------------------------------
authRoutes.post('/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'credentialが必要です' });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = String(payload?.email || '').toLowerCase();
    if (!email || !payload?.email_verified) {
      return res.status(401).json({ error: 'メール認証が確認できません' });
    }
    if (!ALLOWED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'このアカウントは許可されていません' });
    }
    const session = generateToken();
    const now = Date.now();
    googleSessions.set(session, { email, createdAt: now });
    persistGoogleSession(session, email, now);

    // 信頼端末モード ON なら同時に auth token も発行 → クライアントは PIN 画面をスキップ可能
    let token = null;
    const trustedDeviceMode = getTrustedDeviceMode();
    if (trustedDeviceMode) {
      token = issueAuthToken();
    }

    res.json({ ok: true, session, email, token, trustedDeviceMode });
  } catch (err) {
    console.error('[Auth] Google verify failed:', err.message);
    res.status(401).json({ error: 'Google認証に失敗しました' });
  }
});

// 段階1: 既存の Google session を IDB に持っているクライアントが
// PIN を打たずに token を取り直すための「無音再ログイン」エンドポイント。
authRoutes.post('/auto-login', (req, res) => {
  const session = (req.body && req.body.session) || '';
  if (!session || typeof session !== 'string') {
    return res.status(400).json({ error: 'sessionが必要です' });
  }
  if (!isGoogleSessionValidInternal(session)) {
    return res.status(401).json({ error: 'Googleセッションが無効です' });
  }
  if (!getTrustedDeviceMode()) {
    return res.status(403).json({ error: '信頼端末モードがOFFです' });
  }
  const token = issueAuthToken();
  res.json({ ok: true, token });
});

// ---------------------------------------------------------------------------
// 案1: Dispatcher Cookie 引き継ぎ — POST /api/auth/dispatcher-link
// body: { ticket }
// Workers が発行した HMAC 署名済みチケットを検証して google_session + token を発行。
// ・payload = base64url(JSON.stringify({pc_id, email, exp}))
// ・sig     = base64url(HMAC-SHA256(HMAC_SECRET, payload))
// ・TTL は payload.exp（2分）、PC側で使用済み sig を 5分保持してリプレイを封じる
// ---------------------------------------------------------------------------

function base64urlDecodeToBuffer(str) {
  if (typeof str !== 'string') throw new Error('not a string');
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(pad), 'base64');
}

function verifyLinkTicketNode(ticket, secret) {
  if (!ticket || typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [payload, sigStr] = parts;
  let claims;
  try {
    claims = JSON.parse(base64urlDecodeToBuffer(payload).toString('utf-8'));
  } catch { return null; }
  if (!claims || !claims.pc_id || !claims.email || !claims.exp) return null;
  if (Date.now() > Number(claims.exp)) return null;

  // HMAC-SHA256 再計算 & constant-time 比較
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  let actual;
  try { actual = base64urlDecodeToBuffer(sigStr); } catch { return null; }
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  return { claims, sig: sigStr };
}

function purgeUsedTickets() {
  const now = Date.now();
  for (const [sig, createdAt] of usedLinkTickets) {
    if (now - createdAt > USED_LINK_TICKET_TTL_MS) usedLinkTickets.delete(sig);
  }
}

authRoutes.post('/dispatcher-link', loginLimiter, (req, res) => {
  if (!HMAC_SECRET_RAW) {
    return res.status(500).json({ error: 'HMAC_SECRET 未設定' });
  }
  const ticket = req.body && typeof req.body.ticket === 'string' ? req.body.ticket : '';
  if (!ticket) return res.status(400).json({ error: 'ticketが必要です' });

  purgeUsedTickets();

  const verified = verifyLinkTicketNode(ticket, HMAC_SECRET_RAW);
  if (!verified) {
    return res.status(401).json({ error: 'チケットが無効または期限切れです' });
  }
  const { claims, sig } = verified;

  // pc_id 一致チェック（別PC向けチケットのリプレイ防止）
  if (PC_ID_FOR_LINK && claims.pc_id !== PC_ID_FOR_LINK) {
    return res.status(403).json({ error: 'このPC向けチケットではありません' });
  }

  // ALLOWED_EMAILS 二重チェック（dispatcher と PC で設定差があっても PC 側で確実に弾く）
  const email = String(claims.email || '').toLowerCase();
  if (!ALLOWED_EMAILS.includes(email)) {
    return res.status(403).json({ error: 'このアカウントは許可されていません' });
  }

  // ワンショット消費（同じ ticket の再利用を禁止）
  if (usedLinkTickets.has(sig)) {
    return res.status(401).json({ error: 'チケットはすでに使用済みです' });
  }
  usedLinkTickets.set(sig, Date.now());

  // 成功 → google session + auth token を発行
  const session = generateToken();
  const now = Date.now();
  googleSessions.set(session, { email, createdAt: now });
  persistGoogleSession(session, email, now);
  const token = issueAuthToken();
  res.json({ ok: true, session, token, email });
});

// 信頼端末モードの参照・切り替え（後日 Settings UI から触れるように）
authRoutes.get('/trusted-mode', (req, res) => {
  res.json({ enabled: getTrustedDeviceMode() });
});

authRoutes.post('/trusted-mode', (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: '認証が必要です' });
  }
  const enabled = !!(req.body && req.body.enabled);
  setSettingsValue(TRUSTED_DEVICE_MODE_KEY, enabled ? 'true' : 'false');
  res.json({ ok: true, enabled });
});

// 既存の他モジュール（pc-control 等）から使われているので互換維持
export function isGoogleSessionValid(session) {
  return isGoogleSessionValidInternal(session);
}

// initDB 完了後に呼ばれる想定。起動順の都合で auth.js がロードされた時点では
// DB が未初期化なため、index.js の initDB() 完了後に呼び戻して同期するためのフック。
export function reloadAuthFromDB() {
  loadGoogleSessionsFromDB();
  loadActiveTokensFromDB();
  purgeExpiredFromDB();
}

// ---------------------------------------------------------------------------
// authMiddleware — v4: x-pin only (no Firebase, no central server)
// ---------------------------------------------------------------------------
export function authMiddleware(req, res, next) {
  const token = req.headers['x-pin'];
  if (isTokenActive(token)) {
    return next();
  }
  return res.status(401).json({ error: '認証が必要です' });
}

export function isTokenValid(token) {
  return isTokenActive(token);
}

export { authRoutes };
