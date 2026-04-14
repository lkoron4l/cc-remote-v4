import 'dotenv/config';
// Rev 6: マシンローカル (%LOCALAPPDATA%) の pc.env で PC_ID/PC_SECRET を上書き。
// dotenv の後に import することで shared .env の値より優先される。
import './pc-identity.js';
import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';
import { checkFirstRun, runFirstTimeSetup, runFirstTimeSetupCLI } from './first-run.js';
import { initDB } from './db.js';
import { authMiddleware, authRoutes } from './auth.js';
import { sessionRoutes } from './sessions.js';
import { sseRoutes } from './sse.js';
import { chatworkRoutes } from './chatwork.js';
import { scheduleRoutes, startScheduleRunner } from './schedule.js';
import { initWatchdog } from './watchdog.js';
import { initSleepControl, disableSleep, restoreSleep, isSleepDisabled } from './sleep-control.js';
import { startTunnel, getTunnelUrl, onTunnelUrlChange } from './tunnel.js';
import { printQR } from '../../scripts/qr.js';
import { getDB, saveDB } from './db.js';
import { execSync, spawn } from 'child_process';
import { getAllSessions, sendInput } from './pty-manager.js';

// pkg-compatible directory resolution.
// Do NOT use `import.meta.url` — pkg's babel parser fails on it.
// Do NOT name this `__dirname` — in pkg's CJS output, __dirname is already defined
// by the CJS runtime, causing "Identifier '__dirname' has already been declared".
const APP_ROOT = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve('src/server');
const app = express();
const PORT = process.env.PORT || 3737;

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/ https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data: blob: https://*.googleusercontent.com; connect-src 'self' https://*.trycloudflare.com https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; font-src 'self'");
  next();
});

// CORS — restrict origins (no wildcard fallback)
const ALLOWED_ORIGIN_PATTERN = /\.trycloudflare\.com$|^https?:\/\/localhost(:\d+)?$|^https:\/\/(lkoron4l|innovationinnovation8)\.github\.io$/i;
app.use((req, res, next) => {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGIN_PATTERN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // Only set these headers when origin is allowed
  if (res.getHeader('Access-Control-Allow-Origin')) {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pin, X-PIN-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    return res.getHeader('Access-Control-Allow-Origin') ? res.sendStatus(200) : res.sendStatus(403);
  }
  next();
});

// 静的ファイル（ビルド後のフロントエンド）— キャッシュ無効化
// distPath: in exe mode it's `<exe_dir>/dist` (populated by build-exe.js step 4);
// in dev mode it's `<project_root>/dist` relative to APP_ROOT (src/server).
const distPath = process.pkg
  ? path.join(APP_ROOT, 'dist')
  : path.join(APP_ROOT, '..', '..', 'dist');
app.use(express.static(distPath, {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    // HTML/JSは毎回サーバーに確認
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Auth rate limiter (10 requests per minute per IP)
const _authAttempts = new Map();
function authRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = _authAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  _authAttempts.set(ip, entry);
  if (entry.count > 10) {
    return res.status(429).json({ error: 'Too many auth requests, try again later' });
  }
  next();
}
// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _authAttempts) {
    if (now > entry.resetAt) _authAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

// 認証なしルート
app.use('/api/auth', authRateLimiter, authRoutes);

// SSEは認証ヘッダーで個別チェック
app.use('/sse', sseRoutes);

// トンネルURL取得（認証不要）
app.get('/api/tunnel', (req, res) => {
  res.json({ url: getTunnelUrl() });
});

// PCヘルスチェック（認証不要 — 他PCからの生存確認用）
app.get('/api/pcs/health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// トンネル自己死活監視用 ping（認証不要、HEAD/GET 両対応）
app.get('/api/ping', (_req, res) => {
  res.status(200).json({ ok: true });
});
app.head('/api/ping', (_req, res) => {
  res.status(200).end();
});

// 認証ミドルウェア
app.use('/api', authMiddleware);

// APIルート
app.use('/api/sessions', sessionRoutes);
// v4: /api/pcs (multi-pc registry) と /api/notifications (Firebase) は廃止
// Rev 6: Chatwork 通知設定 + スケジュール機能 (旧 task queue は廃止)
app.use('/api/chatwork', chatworkRoutes);
app.use('/api/schedules', scheduleRoutes);

// 未読通知カウント API
app.get('/api/notifications/unread', (req, res) => {
  try {
    const db = getDB();
    const since = Date.now() - 60 * 60 * 1000; // 過去1時間
    const fbResult = db.exec('SELECT COUNT(*) FROM feedback WHERE created_at >= ?', [since]);
    const feedbackCount = fbResult.length > 0 ? (fbResult[0].values[0]?.[0] || 0) : 0;
    // Rev 6: active session 数を除外。純粋な未読通知数だけ返す。
    res.json({ count: feedbackCount });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ショートカット API
app.get('/api/shortcuts', (req, res) => {
  try {
    const db = getDB();
    const result = db.exec('SELECT id, label, command, sort_order FROM shortcuts ORDER BY sort_order ASC');
    const rows = result.length > 0 ? result[0].values.map(r => ({ id: r[0], label: r[1], command: r[2], sortOrder: r[3] })) : [];
    res.json(rows);
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/shortcuts', (req, res) => {
  try {
    const { label, command } = req.body;
    if (!label || !command) return res.status(400).json({ error: 'label and command required' });
    if (label.length > 200 || command.length > 2000)
      return res.status(400).json({ error: 'label/command too long' });
    const db = getDB();
    db.run('INSERT INTO shortcuts (label, command, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM shortcuts))',
      [label, command]);
    const result = db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];
    saveDB();
    res.json({ id, label, command });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});
app.delete('/api/shortcuts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getDB();
    db.run('DELETE FROM shortcuts WHERE id = ?', [id]);
    const changed = db.exec('SELECT changes()');
    if (changed[0].values[0][0] === 0) return res.status(404).json({ error: 'not found' });
    saveDB();
    res.json({ ok: true });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// テンプレート API
app.get('/api/templates', (req, res) => {
  try {
    const db = getDB();
    const result = db.exec('SELECT id, name, prompt, category, sort_order FROM templates ORDER BY sort_order ASC, created_at DESC');
    const rows = result.length > 0 ? result[0].values.map(r => ({ id: r[0], name: r[1], prompt: r[2], category: r[3], sortOrder: r[4] })) : [];
    res.json(rows);
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/templates', (req, res) => {
  try {
    const { name, prompt, category } = req.body;
    if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
    if (name.length > 200 || prompt.length > 10000)
      return res.status(400).json({ error: 'name/prompt too long' });
    const db = getDB();
    db.run('INSERT INTO templates (name, prompt, category, sort_order, created_at) VALUES (?, ?, ?, 0, ?)',
      [name, prompt, category || '', Date.now()]);
    const result = db.exec('SELECT last_insert_rowid()');
    const id = result[0].values[0][0];
    saveDB();
    res.json({ id, name, prompt, category: category || '' });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});
app.delete('/api/templates/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getDB();
    db.run('DELETE FROM templates WHERE id = ?', [id]);
    const changed = db.exec('SELECT changes()');
    if (changed[0].values[0][0] === 0) return res.status(404).json({ error: 'not found' });
    saveDB();
    res.json({ ok: true });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// フィードバック API + Chatwork通知
app.post('/api/feedback', async (req, res) => {
  try {
    const { sessionId, rating, context } = req.body;
    if (!sessionId || rating === undefined) return res.status(400).json({ error: 'sessionId and rating required' });
    if (typeof sessionId === 'string' && sessionId.length > 200) return res.status(400).json({ error: 'sessionId too long' });
    if (context !== undefined && typeof context === 'string' && context.length > 2000) return res.status(400).json({ error: 'context too long' });
    const db = getDB();
    db.run('INSERT INTO feedback (session_id, rating, context, created_at) VALUES (?, ?, ?, ?)',
      [sessionId, rating, context || '', Date.now()]);
    saveDB();

    // Chatwork通知
    const CW_TOKEN = process.env.CHATWORK_TOKEN;
    const CW_ROOM = process.env.CHATWORK_ROOM_ID;
    if (CW_TOKEN && CW_ROOM) {
      let parsed = {};
      try { parsed = JSON.parse(context || '{}'); } catch (_) {}
      const typeLabel = parsed.type === 'bug' ? 'BUG' : parsed.type === 'feature' ? 'REQUEST' : 'OTHER';
      const msg = `[info][title]CC Remote フィードバック (${typeLabel})[/title]${parsed.text || context || '(no text)'}[/info]`;
      try {
        const body = `body=${encodeURIComponent(msg)}`;
        const cwReq = https.request({
          hostname: 'api.chatwork.com',
          path: `/v2/rooms/${CW_ROOM}/messages`,
          method: 'POST',
          headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        cwReq.write(body);
        cwReq.end();
      } catch (_) {}
    }

    res.json({ ok: true });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// 自動バックアップ（5分ごとにDBファイルをコピー）
// Note: fs/os/https are now imported at the top of the file (pkg compatibility)
const DB_PATH = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cc-remote'), 'cc-remote', 'cc-remote.db');
const BACKUP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cc-remote'), 'cc-remote', 'backups');
setInterval(() => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `cc-remote-${ts}.db`));
    // 古いバックアップ削除（10個保持）
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
    for (const f of files.slice(10)) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch (e) { console.error('[Backup] エラー:', e.message); }
}, 5 * 60 * 1000);

// v4: /api/notification-settings は Firebase 通知ロジック廃止に伴い削除

// エンタイトルメント API（RevenueCat統合前は全ユーザーPro）
app.get('/api/entitlements', (req, res) => {
  res.json({
    plan: 'pro',
    features: {
      unlimitedSessions: true,
      multiPc: true,
      templates: true,
      schedule: true,
      fileBrowser: process.env.CC_REMOTE_FILE_BROWSER === '1',
      dashboard: true,
      themes: true,
      aiCharacter: true,
      voiceInput: true,
    },
  });
});

// 就寝モード API
app.post('/api/sleep-mode', (req, res) => {
  const { enabled } = req.body;
  if (enabled) { disableSleep(); } else { restoreSleep(); }
  res.json({ ok: true, sleepDisabled: isSleepDisabled() });
});
app.get('/api/sleep-mode', (req, res) => {
  res.json({ sleepDisabled: isSleepDisabled() });
});

// ステータスページ API（CPU/メモリ/ディスク）
app.get('/api/status', (req, res) => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = os.uptime();
  const load = cpus.reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return sum + ((total - cpu.times.idle) / total);
  }, 0) / cpus.length;

  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: Math.floor(uptime),
    cpu: { cores: cpus.length, usage: Math.round(load * 100) },
    memory: { total: totalMem, free: freeMem, used: totalMem - freeMem, percent: Math.round(((totalMem - freeMem) / totalMem) * 100) },
    node: process.version,
    tunnelUrl: getTunnelUrl(),
  });
});

// ファイルブラウザ API（読み取り専用、ホームディレクトリ配下に制限）
const ALLOWED_BASE = os.homedir();
const UPLOAD_DIR = path.join(os.tmpdir(), 'cc-remote-uploads');
function isPathSafe(p) {
  try {
    // Resolve symlinks to prevent traversal via junctions/symlinks
    const resolved = fs.realpathSync(path.resolve(p));
    return resolved.startsWith(ALLOWED_BASE) || resolved.startsWith(UPLOAD_DIR);
  } catch {
    // realpathSync failure = path doesn't exist or inaccessible — deny access
    return false;
  }
}

// v4: FileBrowser は opt-in のみ（CC_REMOTE_FILE_BROWSER=1 で有効化）
// 受信側が明示的に許可するまでは /api/files* は登録されない
const FILE_BROWSER_ENABLED = process.env.CC_REMOTE_FILE_BROWSER === '1';
if (FILE_BROWSER_ENABLED) {
  console.log('[Server] FileBrowser 有効（CC_REMOTE_FILE_BROWSER=1）');

  app.get('/api/files', (req, res) => {
    const dir = req.query.path || os.homedir();
    try {
      const safePath = path.resolve(dir);
      if (!isPathSafe(safePath)) return res.status(403).json({ error: 'アクセス禁止のパスです' });
      const entries = fs.readdirSync(safePath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .slice(0, 100)
        .map(e => ({
          name: e.name,
          isDir: e.isDirectory(),
          path: path.join(safePath, e.name),
        }));
      res.json({ path: safePath, items, parent: path.dirname(safePath) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/files/read', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const safePath = path.resolve(filePath);
      if (!isPathSafe(safePath)) return res.status(403).json({ error: 'アクセス禁止のパスです' });
      const stat = fs.statSync(safePath);
      if (stat.size > 1024 * 1024) return res.status(400).json({ error: 'ファイルが大きすぎます（1MB上限）' });
      const content = fs.readFileSync(safePath, 'utf-8');
      res.json({ path: safePath, content, size: stat.size });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/files/image', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const ext = path.extname(filePath).toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
    if (!allowed.includes(ext)) return res.status(400).json({ error: '画像ファイルのみ対応しています' });
    try {
      const safePath = path.resolve(filePath);
      if (!isPathSafe(safePath)) return res.status(403).json({ error: 'アクセス禁止のパスです' });
      const stat = fs.statSync(safePath);
      if (stat.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'ファイルが大きすぎます（10MB上限）' });
      res.sendFile(safePath);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

// リモートPC制御 API
app.post('/api/pc-control', (req, res) => {
  const { action } = req.body;
  try {
    if (action === 'sleep') {
      execSync('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { stdio: 'ignore' });
      res.json({ ok: true, action: 'sleep' });
    } else if (action === 'shutdown') {
      execSync('shutdown /s /t 60 /c "CC Remote: 60秒後にシャットダウンします"', { stdio: 'ignore' });
      res.json({ ok: true, action: 'shutdown', message: '60秒後にシャットダウン' });
    } else if (action === 'cancel-shutdown') {
      execSync('shutdown /a', { stdio: 'ignore' });
      res.json({ ok: true, action: 'cancel-shutdown' });
    } else if (action === 'lock') {
      execSync('rundll32.exe user32.dll,LockWorkStation', { stdio: 'ignore' });
      res.json({ ok: true, action: 'lock' });
    } else if (action === 'open-app') {
      const { appPath } = req.body;
      if (!appPath) return res.status(400).json({ error: 'appPath required' });
      // コマンドインジェクション防止: 危険な文字を拒否（%^も含む）
      if (/[&|;`$(){}%^"']/.test(appPath)) return res.status(400).json({ error: '不正な文字が含まれています' });
      const isUrl = /^https?:\/\/[a-zA-Z0-9._\-\/:?#@=~]+$/.test(appPath);
      const isExe = /^[a-zA-Z]:\\[^&|;`$%^]+\.(exe)$/i.test(appPath);
      if (!isUrl && !isExe) return res.status(400).json({ error: 'URL or .exe パスのみ許可されています' });
      if (isExe) {
        // exeパスはpath.resolveで正規化し、パストラバーサルを防止
        const resolved = path.resolve(appPath);
        if (!resolved.startsWith(ALLOWED_BASE) && !resolved.match(/^[A-Z]:\\Program Files/i)) {
          return res.status(403).json({ error: '許可されたディレクトリ外のexeは実行できません' });
        }
      }
      // shell: true を使わず、start コマンドを直接実行
      spawn('cmd.exe', ['/c', 'start', '""', appPath], { stdio: 'ignore', detached: true }).unref();
      res.json({ ok: true, action: 'open-app', appPath });
    } else {
      res.status(400).json({ error: 'Unknown action. Use: sleep, shutdown, cancel-shutdown, lock, open-app' });
    }
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// サンプルテンプレート自動登録
async function seedTemplates() {
  const db = getDB();
  const result = db.exec('SELECT COUNT(*) FROM templates');
  const count = result[0]?.values[0]?.[0] || 0;
  if (count > 0) return;

  const samples = [
    { name: '日報作成', prompt: '今日の作業内容を日報形式でまとめてください', category: '業務' },
    { name: 'メール作成', prompt: '以下の内容でビジネスメールを作成してください。\n\n【宛先】\n【件名】\n【用件・依頼内容】\n\n', category: '業務' },
    { name: '議事録作成', prompt: '以下の会議メモを議事録形式に整理してください：\n\n', category: '業務' },
    { name: '翻訳（日→英）', prompt: '以下を自然な英語に翻訳してください：\n\n', category: 'ツール' },
    { name: '要約', prompt: '上記の内容を箇条書き3点で要約してください', category: 'ツール' },
    { name: 'ファイル整理', prompt: 'このフォルダ内のファイルを整理したいです。以下の状況を教えてください：\n\n【フォルダの場所・目的】\n【現在の状況・困っていること】\n\n整理の方針と手順を提案してください。', category: '業務' },
    { name: 'Excel処理', prompt: 'Excelファイルの処理について手伝ってください。\n\n【やりたいこと】\n【現在のデータの状態】\n\n具体的な手順を教えてください。', category: '業務' },
    { name: '契約書チェック', prompt: '以下の契約書・文書の内容を確認してください。気になる点、注意すべき条項、リスクがあれば指摘してください：\n\n', category: 'ツール' },
  ];

  for (const s of samples) {
    db.run('INSERT INTO templates (name, prompt, category, sort_order, created_at) VALUES (?, ?, ?, 0, ?)',
      [s.name, s.prompt, s.category, Date.now()]);
  }
  saveDB();
  console.log('[Templates] サンプルテンプレート登録完了');
}

// AIキャラ設定 API
const AI_CHARACTERS = {
  default: { name: 'デフォルト', prefix: '' },
  polite: { name: '丁寧語', prefix: '\u200B[Reply in polite Japanese keigo]\u200B' },
  casual: { name: 'カジュアル', prefix: '\u200B[Reply in casual friendly Japanese]\u200B' },
  butler: { name: '執事', prefix: '\u200B[Reply as a butler, address user as goshujin-sama]\u200B' },
  navi: { name: 'ナビ', prefix: '\u200B[Reply as a cyber navigator, address user as Operator]\u200B' },
  sensei: { name: '先生', prefix: '\u200B[Reply as a kind teacher in Japanese]\u200B' },
};

let currentCharacter = 'default';

app.get('/api/ai-character', (req, res) => {
  res.json({ current: currentCharacter, characters: AI_CHARACTERS });
});

app.post('/api/ai-character', (req, res) => {
  const { character } = req.body;
  if (AI_CHARACTERS[character]) {
    currentCharacter = character;
    res.json({ ok: true, current: character });
  } else {
    res.status(400).json({ error: 'Unknown character' });
  }
});

// AIキャラのprefixを取得（pty-managerから使う）
export function getCharacterPrefix() {
  return AI_CHARACTERS[currentCharacter]?.prefix || '';
}

// Rev 6: 旧 in-memory スケジュール API は削除。
// 現行は schedule.js の scheduleRoutes (DB 永続化 + 20s polling runner) が担当。
// line 143 の `app.use('/api/schedules', scheduleRoutes)` で mount 済み。

// ファイルアップロード API
app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '10mb' }), (req, res) => {
  try {
    const rawFilename = decodeURIComponent(req.headers['x-filename'] || `upload-${Date.now()}`);
    const filename = path.basename(rawFilename); // パストラバーサル防止
    // ファイル拡張子制限（実行可能ファイルを拒否）
    const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.msi', '.scr', '.com', '.pif'];
    const ext = path.extname(filename).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ error: '実行可能ファイルはアップロードできません' });
    }
    const uploadDir = path.join(os.tmpdir(), 'cc-remote-uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    // ファイル名衝突回避
    const uniqueName = `${Date.now()}-${filename}`;
    const savedPath = path.join(uploadDir, uniqueName);
    fs.writeFileSync(savedPath, req.body);
    res.json({ ok: true, path: savedPath, filename: uniqueName });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// ダッシュボード統計 API
app.get('/api/dashboard', (req, res) => {
  try {
    const db = getDB();
    const sessions = getAllSessions();

    // セッション統計
    const sessResult = db.exec('SELECT COUNT(*), SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) FROM sessions');
    const totalSessions = sessResult.length > 0 ? (sessResult[0].values[0]?.[0] || 0) : 0;
    const archivedSessions = sessResult.length > 0 ? (sessResult[0].values[0]?.[1] || 0) : 0;
    const activeSessions = sessions.filter(s => s.status && s.status !== 'exited').length;

    // フィードバック統計
    const fbResult = db.exec('SELECT COUNT(*), SUM(CASE WHEN rating>0 THEN 1 ELSE 0 END), SUM(CASE WHEN rating<=0 THEN 1 ELSE 0 END) FROM feedback');
    const totalFeedback = fbResult.length > 0 ? (fbResult[0].values[0]?.[0] || 0) : 0;
    const positiveFeedback = fbResult.length > 0 ? (fbResult[0].values[0]?.[1] || 0) : 0;
    const negativeFeedback = fbResult.length > 0 ? (fbResult[0].values[0]?.[2] || 0) : 0;

    // 推定トークン使用量（outputHistory文字数合計 / 4）
    const histResult = db.exec('SELECT output_history FROM sessions');
    let totalChars = 0;
    if (histResult.length > 0) {
      for (const row of histResult[0].values) {
        const h = row[0] || '[]';
        totalChars += h.length;
      }
    }
    const estimatedTokens = Math.floor(totalChars / 4);

    // テンプレート数
    const tplResult = db.exec('SELECT COUNT(*) FROM templates');
    const templateCount = tplResult.length > 0 ? (tplResult[0].values[0]?.[0] || 0) : 0;

    // ショートカット数
    const scResult = db.exec('SELECT COUNT(*) FROM shortcuts');
    const shortcutCount = scResult.length > 0 ? (scResult[0].values[0]?.[0] || 0) : 0;

    res.json({
      sessions: { total: totalSessions, active: activeSessions, archived: archivedSessions },
      feedback: { total: totalFeedback, positive: positiveFeedback, negative: negativeFeedback },
      estimatedTokens,
      templateCount,
      shortcutCount,
      serverUptime: Math.floor(process.uptime()),
    });
  } catch (e) { console.error('[Server]', e.message); res.status(500).json({ error: 'Internal server error' }); }
});

// SPA フォールバック (Express 5: wildcard requires named param)
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

export async function start() {
  await initDB();
  initSleepControl();
  // 自走化対応: 起動時点で自動スリープ無効化（3PC並列自走の前提条件）
  // CC_REMOTE_NO_AUTO_SLEEP_DISABLE=1 で無効化可能
  if (process.env.CC_REMOTE_NO_AUTO_SLEEP_DISABLE !== '1') {
    try {
      disableSleep();
      console.log('[Server] 自動スリープ無効化（自走化モード）');
    } catch (e) {
      console.log(`[Server] disableSleep失敗: ${e.message}`);
    }
  }
  initWatchdog(PORT);
  // v4: registerSelfPC 廃止（multi-pc registry なし、各PCは独立P2P）
  seedTemplates(); // サンプルテンプレート自動登録
  startScheduleRunner(); // Rev 6: スケジュール実行ランナー起動

  app.listen(PORT, async () => {
    console.log(`[Server] CC Remote v4 起動: http://localhost:${PORT}`);

    // ChatWork にトンネル URL を通知する共通ヘルパ（PWA URL も併記）
    const PWA_URL = 'https://innovationinnovation8.github.io/cc-remote-v4/';
    const notifyTunnelUrl = (url, title) => {
      try {
        const CW_TOKEN = process.env.CHATWORK_TOKEN;
        const CW_ROOM = process.env.CHATWORK_ROOM_ID;
        if (!CW_TOKEN || !CW_ROOM) return;
        const msg = `アプリ: ${PWA_URL}\nPC接続URL: ${url}`;
        const body = `body=${encodeURIComponent(`[info][title]${title}[/title]${msg}[/info]`)}`;
        const req = https.request({
          hostname: 'api.chatwork.com',
          path: `/v2/rooms/${CW_ROOM}/messages`,
          method: 'POST',
          headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
        }, (res) => { console.log(`[Chatwork] 送信完了 (${res.statusCode})`); });
        req.on('error', (err) => console.log(`[Chatwork] 送信失敗: ${err.message}`));
        req.write(body);
        req.end();
      } catch (e) { console.log(`[Chatwork] 通知エラー: ${e.message}`); }
    };

    // v4: トンネル URL 変化を global.tunnelUrl に反映 + QR 再表示 + ChatWork 通知
    onTunnelUrlChange(async (newUrl) => {
      console.log(`[Server] トンネルURL変化検出: ${newUrl}`);
      global.tunnelUrl = newUrl;
      await printQR(newUrl).catch(() => {});
      notifyTunnelUrl(newUrl, 'CC Remote v4 トンネルURL更新');
    });

    // Cloudflareトンネル自動起動
    const tunnelUrl = await startTunnel(PORT);
    if (tunnelUrl) global.tunnelUrl = tunnelUrl;

    if (tunnelUrl) {
      // 起動時 QR 表示（スマホからの初回接続用）
      await printQR(tunnelUrl).catch(() => {});
      console.log(`[Server] トンネルURL: ${tunnelUrl}`);
      // Chatwork通知（ヘルパ経由で起動時 URL を送信）
      notifyTunnelUrl(tunnelUrl, 'CC Remote v4 トンネルURL');
    }
  });
}

// Entry point logic.
// - In dev mode (`node src/server/index.js`): skip first-run, just start().
// - In exe (pkg) mode: run first-run wizard if .env is missing, then start().
//
// Why the first-run check moved here (from exe-entry.js): pkg fails to resolve
// `require('./index.js')` from a separate entry file. By making index.js itself
// the pkg entry, we avoid the module resolution bug entirely (Rev 4 Block A BLOCKER fix).

function parseCLIArgs() {
  const argv = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pc-name')      result.pcName = argv[i + 1];
    // v4: --cloud-url / --pairing-code は廃止
    if (argv[i] === '--auto-startup') result.autoStartup = true;
    if (argv[i] === '--force')        result.force = true;
  }
  return result;
}

async function _main() {
  const cliArgs = parseCLIArgs();
  const hasCLISetup = cliArgs.pcName || cliArgs.pairingCode || cliArgs.cloudUrl;
  const isFirstRun = checkFirstRun();

  if (isFirstRun || (hasCLISetup && cliArgs.force)) {
    if (hasCLISetup) {
      await runFirstTimeSetupCLI(cliArgs);
    } else if (process.pkg) {
      await runFirstTimeSetup();  // 従来の readline モード（exe のみ）
    }
  }
  await start();
}

_main().catch((err) => {
  console.error('[Server] 起動エラー:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  if (process.pkg) {
    console.log('\nEnterキーで終了...');
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
});

// シャットダウン
// v4: 中央レジストリへの offline 通知は廃止（各PCは独立P2P）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[Server] ${sig} 受信 — シャットダウン中...`);
    process.exit(0);
  });
}

export { app };
