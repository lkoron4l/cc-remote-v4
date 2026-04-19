/**
 * PCRegistry Durable Object
 * PC登録・heartbeat・TTL管理（10分）
 *
 * ストレージ構造（SQLite）:
 *   pc:{pcId} -> JSON { pcId, tunnel_url, email_hash, label?, last_heartbeat_at, registered_at }
 *
 * expire() は heartbeat 受信時に lazy 削除。Alarm API は使用しない。
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export class PCRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    // POST /register
    if (method === 'POST' && url.pathname === '/register') {
      return this._register(request);
    }
    // POST /heartbeat
    if (method === 'POST' && url.pathname === '/heartbeat') {
      return this._heartbeat(request);
    }
    // GET /list
    if (method === 'GET' && url.pathname === '/list') {
      return this._list(url);
    }
    // DELETE /expire (internal: triggered by heartbeat)
    if (method === 'POST' && url.pathname === '/expire') {
      return this._expire();
    }

    return new Response('Not Found', { status: 404 });
  }

  async _register(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const { pcId, tunnel_url, email_hash, label } = body;
    if (!pcId || !tunnel_url || !email_hash) {
      return Response.json({ error: 'pcId, tunnel_url, email_hash required' }, { status: 400 });
    }

    const now = Date.now();
    const key = `pc:${pcId}`;
    const existingRaw = await this.state.storage.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;

    const record = {
      pcId,
      tunnel_url,
      email_hash,
      label: label ?? existing?.label ?? null,
      last_heartbeat_at: now,
      registered_at: existing?.registered_at ?? now,
    };
    await this.state.storage.put(key, JSON.stringify(record));

    return Response.json({ ok: true, registered_at: record.registered_at });
  }

  async _heartbeat(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }

    const { pcId, tunnel_url, label } = body;
    if (!pcId) {
      return Response.json({ error: 'pcId required' }, { status: 400 });
    }

    const key = `pc:${pcId}`;
    const raw = await this.state.storage.get(key);
    if (!raw) {
      return Response.json({ error: 'pc not registered' }, { status: 404 });
    }

    const record = JSON.parse(raw);
    record.last_heartbeat_at = Date.now();
    if (tunnel_url) record.tunnel_url = tunnel_url;
    if (label !== undefined && label !== null) record.label = label;
    await this.state.storage.put(key, JSON.stringify(record));

    // lazy 削除: heartbeat 受信のタイミングで期限切れエントリを掃除
    await this._expireInternal();

    return Response.json({ ok: true, last_heartbeat_at: record.last_heartbeat_at });
  }

  async _list(url) {
    const email_hash = url.searchParams.get('email_hash');
    const all = await this.state.storage.list({ prefix: 'pc:' });
    const now = Date.now();
    const results = [];

    for (const [, raw] of all) {
      const record = JSON.parse(raw);
      // TTL チェック
      if (now - record.last_heartbeat_at > TTL_MS) continue;
      // email_hash フィルタ（指定がある場合のみ）
      if (email_hash && record.email_hash !== email_hash) continue;
      results.push(record);
    }

    return Response.json({ pcs: results });
  }

  async _expire() {
    const deleted = await this._expireInternal();
    return Response.json({ ok: true, deleted });
  }

  async _expireInternal() {
    const all = await this.state.storage.list({ prefix: 'pc:' });
    const now = Date.now();
    const toDelete = [];

    for (const [key, raw] of all) {
      const record = JSON.parse(raw);
      if (now - record.last_heartbeat_at > TTL_MS) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      await this.state.storage.delete(key);
    }

    return toDelete.length;
  }
}
