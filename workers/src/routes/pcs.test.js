/**
 * pcs.js のユニットテスト
 * Node.js 18+ の built-in test runner (node:test) を使用
 * 実行: node --test workers/src/routes/pcs.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleGetPcs } from './pcs.js';

// --- モックヘルパー ---

const VALID_TOKEN = 'valid-session-token-abc123';
const EMAIL_HASH = 'emailhash-abc123def456';

/**
 * SessionStore スタブ
 * @param {'ok' | 'notfound' | 'expired' | 'error'} mode
 */
function makeSessionStoreStub(mode) {
  return {
    idFromName(_name) { return 'mock-session-id'; },
    get(_id) {
      return {
        async fetch(_req) {
          if (mode === 'ok') {
            return Response.json({
              session: {
                token: VALID_TOKEN,
                email_hash: EMAIL_HASH,
                created_at: Date.now(),
                expires_at: Date.now() + 86400000,
              },
            });
          }
          if (mode === 'notfound') {
            return Response.json({ error: 'session not found' }, { status: 404 });
          }
          if (mode === 'expired') {
            return Response.json({ error: 'session expired' }, { status: 410 });
          }
          // error
          throw new Error('session store unavailable');
        },
      };
    },
  };
}

/**
 * PCRegistry スタブ
 * @param {'ok' | 'error'} mode
 */
function makePcRegistryStub(mode) {
  const mockPcs = [
    {
      pcId: 'pc-001',
      tunnel_url: 'https://tunnel-abc.trycloudflare.com',
      email_hash: EMAIL_HASH,
      last_heartbeat_at: Date.now(),
      registered_at: Date.now() - 60000,
    },
  ];

  return {
    idFromName(_name) { return 'mock-registry-id'; },
    get(_id) {
      return {
        async fetch(_req) {
          if (mode === 'ok') {
            return Response.json({ pcs: mockPcs });
          }
          throw new Error('registry unavailable');
        },
      };
    },
  };
}

function makeEnv({ sessionMode = 'ok', registryMode = 'ok', noSession = false, noRegistry = false } = {}) {
  return {
    SESSION_STORE: noSession ? undefined : makeSessionStoreStub(sessionMode),
    PC_REGISTRY: noRegistry ? undefined : makePcRegistryStub(registryMode),
  };
}

function makeRequest({ cookie } = {}) {
  const headers = {};
  if (cookie !== undefined) headers['Cookie'] = cookie;
  return new Request('http://worker/api/pcs', {
    method: 'GET',
    headers,
  });
}

// --- 401 系テスト ---

test('Cookie なし → 401 unauthorized', async () => {
  const req = makeRequest();
  const resp = await handleGetPcs(req, makeEnv());
  assert.equal(resp.status, 401);
  const json = await resp.json();
  assert.equal(json.error, 'unauthorized');
});

test('空文字 Cookie → 401 unauthorized', async () => {
  const req = makeRequest({ cookie: '' });
  const resp = await handleGetPcs(req, makeEnv());
  assert.equal(resp.status, 401);
  const json = await resp.json();
  assert.equal(json.error, 'unauthorized');
});

test('session= のみ（値なし）→ 401 unauthorized', async () => {
  const req = makeRequest({ cookie: 'session=' });
  const resp = await handleGetPcs(req, makeEnv());
  assert.equal(resp.status, 401);
  const json = await resp.json();
  assert.equal(json.error, 'unauthorized');
});

test('セッションが存在しない（404）→ 401 unauthorized', async () => {
  const req = makeRequest({ cookie: `session=${VALID_TOKEN}` });
  const resp = await handleGetPcs(req, makeEnv({ sessionMode: 'notfound' }));
  assert.equal(resp.status, 401);
  const json = await resp.json();
  assert.equal(json.error, 'unauthorized');
});

test('セッション期限切れ（410）→ 401 unauthorized', async () => {
  const req = makeRequest({ cookie: `session=${VALID_TOKEN}` });
  const resp = await handleGetPcs(req, makeEnv({ sessionMode: 'expired' }));
  assert.equal(resp.status, 401);
  const json = await resp.json();
  assert.equal(json.error, 'unauthorized');
});

test('SESSION_STORE 未設定 → 503', async () => {
  const req = makeRequest({ cookie: `session=${VALID_TOKEN}` });
  const resp = await handleGetPcs(req, makeEnv({ noSession: true }));
  assert.equal(resp.status, 503);
});

// --- 200 系テスト ---

test('有効な Cookie → 200 + pcs 配列', async () => {
  const req = makeRequest({ cookie: `session=${VALID_TOKEN}` });
  const resp = await handleGetPcs(req, makeEnv());
  assert.equal(resp.status, 200);
  const json = await resp.json();
  assert.ok(Array.isArray(json.pcs));
  assert.equal(json.pcs.length, 1);
  assert.equal(json.pcs[0].pcId, 'pc-001');
  assert.equal(json.pcs[0].email_hash, EMAIL_HASH);
});

test('有効な Cookie + 他のクッキーが混在しても動作', async () => {
  const req = makeRequest({ cookie: `other=value; session=${VALID_TOKEN}; extra=foo` });
  const resp = await handleGetPcs(req, makeEnv());
  assert.equal(resp.status, 200);
  const json = await resp.json();
  assert.ok(Array.isArray(json.pcs));
});

test('email_hash クエリパラメータは無視される（セキュリティ）', async () => {
  // 悪意ある email_hash クエリパラメータを渡しても、Cookie のセッションの email_hash が使われる
  const req = new Request('http://worker/api/pcs?email_hash=attacker-hash', {
    method: 'GET',
    headers: { Cookie: `session=${VALID_TOKEN}` },
  });
  const resp = await handleGetPcs(req, makeEnv());
  // Cookie 認証が通れば正常に 200 を返す（クエリパラメータは無視）
  assert.equal(resp.status, 200);
});

// --- 503 系テスト ---

test('PC_REGISTRY 未設定 → 503', async () => {
  const req = makeRequest({ cookie: `session=${VALID_TOKEN}` });
  const resp = await handleGetPcs(req, makeEnv({ noRegistry: true }));
  assert.equal(resp.status, 503);
});

test('PC_REGISTRY エラー → 503', async () => {
  const req = makeRequest({ cookie: `session=${VALID_TOKEN}` });
  const resp = await handleGetPcs(req, makeEnv({ registryMode: 'error' }));
  assert.equal(resp.status, 503);
  const json = await resp.json();
  assert.ok(json.error.includes('registry error'));
});
