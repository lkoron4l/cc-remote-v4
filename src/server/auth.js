// PIN Authentication — CC Remote v4 (P2P, no central auth)
// v4 changes vs v3:
//   - Firebase Admin / verifyIdToken / Google login removed
//   - Central server token verification (CLOUD_SERVER_URL) removed
//   - WebAuthn routes removed (retired in v4 MVP — see .trash/_20260413_v4_start/webauthn-snippet.js)
//   - allowed_uids store removed
//   - /api/auth/google removed
//   - /api/auth/remote-verify removed (v4 has no inter-PC validation)
//   - PIN minimum length 4 -> 8 (North Star: PIN 8 桁以上)
//   - authMiddleware: x-pin only
import { Router } from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { getDB, saveDB } from './db.js';

const authRoutes = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '963785499726-v0da2q3hqktflate717q7033snjcht90.apps.googleusercontent.com';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || 'lkoron4l@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const googleSessions = new Map();
const GOOGLE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// In-memory token store: token -> creation timestamp (ms)
const activeTokens = new Map();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PIN_MIN_LENGTH = 4;

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

function getStoredPin() {
  return getSettingsValue('pin_hash'); // "salt:hash"
}

function storePin(pin) {
  const salt = generateSalt();
  const hash = hashPin(pin, salt);
  const value = `${salt}:${hash}`;
  const db = getDB();
  db.run(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('pin_hash', ?)",
    [value]
  );
  saveDB();
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
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, createdAt] of activeTokens) {
    if (now - createdAt > TOKEN_TTL_MS) activeTokens.delete(token);
  }
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
  res.json({
    hasPin,
    isAuthenticated: isAuthenticated(req),
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
  const token = generateToken();
  activeTokens.set(token, Date.now());
  res.json({ ok: true, token });
});

authRoutes.post('/login', (req, res) => {
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
  const token = generateToken();
  activeTokens.set(token, Date.now());
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
  activeTokens.clear();
  res.json({ ok: true });
});

authRoutes.post('/logout', (req, res) => {
  const token = req.headers['x-pin'];
  if (token) activeTokens.delete(token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Google OAuth — verifies ID Token from GIS, gates PC registration by email
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
    googleSessions.set(session, { email, createdAt: Date.now() });
    res.json({ ok: true, session, email });
  } catch (err) {
    console.error('[Auth] Google verify failed:', err.message);
    res.status(401).json({ error: 'Google認証に失敗しました' });
  }
});

export function isGoogleSessionValid(session) {
  if (!session || !googleSessions.has(session)) return false;
  const { createdAt } = googleSessions.get(session);
  if (Date.now() - createdAt > GOOGLE_SESSION_TTL_MS) {
    googleSessions.delete(session);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [s, { createdAt }] of googleSessions) {
    if (now - createdAt > GOOGLE_SESSION_TTL_MS) googleSessions.delete(s);
  }
}, 60 * 60 * 1000);

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
