import initSqlJs from 'sql.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Note: `__dirname` removed — it was unused and `import.meta.url` breaks pkg bundling.
// OneDrive同期による競合を避けるため、ローカルに保存
const DB_PATH = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cc-remote'), 'cc-remote', 'cc-remote.db');

let db = null;

export async function initDB() {
  const SQL = await initSqlJs();

  // 既存DBファイルがあれば読み込む
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // テーブル作成
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'New Session',
      memo TEXT DEFAULT '',
      status TEXT DEFAULT 'running',
      output_history TEXT DEFAULT '[]',
      scrollback TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pcs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      is_current INTEGER DEFAULT 0,
      last_seen INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shortcuts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      command TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      category TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      context TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    )
  `);

  // 段階1+2: Google セッションと PIN トークンを永続化（PC再起動・ブラウザ再起動を超えて保持）
  db.run(`
    CREATE TABLE IF NOT EXISTS google_sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);

  // Rev 6: スケジュールテーブル (cron or 単発 datetime で PC Claude に指示投入)
  //   kind: 'once' | 'cron'
  //   trigger_at: ミリ秒 UTC (once のとき) / cron 式 (cron のとき)
  //   next_run: 次回実行予定 (ミリ秒 UTC)
  //   last_run: 最終実行 (ミリ秒 UTC)
  //   status: 'pending' | 'done' | 'error' | 'disabled'
  db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      session_id TEXT DEFAULT '',
      kind TEXT DEFAULT 'once',
      trigger_at TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      last_error TEXT DEFAULT ''
    )
  `);

  // Rev 5: Chatwork 通知設定 (単一ユーザー想定 → key/value ペア)
  // key: token, room_id, enabled, events (JSON array)
  // settings テーブルに格納するので別テーブル不要。

  // sessions テーブルにピン留め・アーカイブ列追加（ALTER TABLE は IF NOT EXISTS できないので try）
  try { db.run('ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0'); } catch (_) {}
  try { db.run('ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0'); } catch (_) {}
  try { db.run('ALTER TABLE sessions ADD COLUMN approval_level TEXT DEFAULT "easy"'); } catch (_) {}
  try { db.run('ALTER TABLE sessions ADD COLUMN tags TEXT DEFAULT ""'); } catch (_) {}

  saveDB();
  console.log('[DB] 初期化完了:', DB_PATH);
  return db;
}

export function getDB() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

// Debounced async DB save — avoids blocking the event loop
let _saveTimer = null;
let _saving = false;
let _dirty = false;

export function saveDB() {
  _dirty = true;
  // Debounce: schedule a save 500ms from now (coalesces rapid writes)
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 500);
}

function _doSave() {
  _saveTimer = null;
  if (!db || _saving) return;
  _saving = true;
  _dirty = false;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = Buffer.from(db.export());
  // Write to temp file first, then rename (atomic on same filesystem)
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFile(tmpPath, data, (err) => {
    _saving = false;
    // If dirty during save, schedule another save
    if (_dirty) saveDB();
    if (err) {
      console.error('[DB] Save error:', err.message);
      return;
    }
    fs.rename(tmpPath, DB_PATH, (renameErr) => {
      if (renameErr) {
        console.error('[DB] Rename error:', renameErr.message);
        // Fallback: try direct write
        try { fs.writeFileSync(DB_PATH, data); } catch {}
      }
    });
  });
}

// Periodic save (every 10 seconds) as safety net
setInterval(() => saveDB(), 10000);

// Ensure final save on shutdown
process.on('beforeExit', () => {
  if (db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  }
});
