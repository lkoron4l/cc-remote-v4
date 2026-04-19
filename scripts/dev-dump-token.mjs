import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

if (process.env.NODE_ENV === 'production') {
  console.error('[dev-dump-token] refused: NODE_ENV=production. This script is for development only.');
  process.exit(1);
}

const DB_PATH = path.join(os.homedir(), 'AppData', 'Local', 'cc-remote', 'cc-remote.db');

const SQL = await initSqlJs({});
const buf = fs.readFileSync(DB_PATH);
const db = new SQL.Database(buf);

const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
console.log('tables:', tables[0]?.values?.flat());

function dump(sql, label) {
  try {
    const r = db.exec(sql);
    console.log(`\n--- ${label} ---`);
    if (r[0]) {
      console.log('columns:', r[0].columns);
      r[0].values.forEach((row, i) => console.log(i, row));
    } else {
      console.log('(empty)');
    }
  } catch (e) { console.log(label, 'ERR', e.message); }
}

dump("SELECT * FROM auth_tokens ORDER BY created_at DESC LIMIT 3", 'auth_tokens');
dump("PRAGMA table_info(google_sessions)", 'google_sessions schema');
dump("SELECT * FROM google_sessions ORDER BY created_at DESC LIMIT 3", 'google_sessions');
dump("PRAGMA table_info(settings)", 'settings schema');
dump("SELECT * FROM settings", 'settings');
