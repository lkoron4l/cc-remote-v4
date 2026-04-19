import { handleHeartbeat } from './routes/heartbeat.js';
import { handleConnect } from './routes/connect.js';
import { handleAuthGoogle, handleAuthCallback, handleAuthLogout, handleLinkTicket } from './routes/auth.js';
import { handleInviteCreate, handleInviteAccept } from './routes/invite.js';
import { handleGetPcs } from './routes/pcs.js';

// DO クラスを re-export（wrangler.toml の class_name と一致が必要）
export { PCRegistry } from './do/pc-registry.js';
export { SessionStore } from './do/session-store.js';
export { InviteStore } from './do/invite-store.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ヘルスチェック（/health は Cloudflare 内部予約のため /healthz を使用）
    if (pathname === '/healthz') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    // Android TWA: Digital Asset Links for `com.ccremote.app`
    // Content-Type must be application/json; HTTPS required; no redirect.
    if (request.method === 'GET' && pathname === '/.well-known/assetlinks.json') {
      const uploadSha256 = env.ANDROID_UPLOAD_SHA256 || '';
      const playSha256 = env.ANDROID_PLAY_SHA256 || '';
      const fingerprints = [uploadSha256, playSha256].filter(Boolean);
      const body = [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.ccremote.app',
          sha256_cert_fingerprints: fingerprints,
        },
      }];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // POST /api/heartbeat
    if (request.method === 'POST' && pathname === '/api/heartbeat') {
      return handleHeartbeat(request, env);
    }

    // POST /api/connect  — PC が Workers に認証・登録する
    if (request.method === 'POST' && pathname === '/api/connect') {
      return handleConnect(request, env);
    }

    // POST /api/register  (heartbeat に email_hash 付きで送ることと同義だが別エンドポイントも用意)
    if (request.method === 'POST' && pathname === '/api/register') {
      return handleHeartbeat(request, env);
    }

    // GET /api/pcs  — PC 一覧（Cookie セッション認証必須）
    if (request.method === 'GET' && pathname === '/api/pcs') {
      return handleGetPcs(request, env);
    }

    // GET /api/auth/google — redirect to Google OAuth2 consent screen
    if (request.method === 'GET' && pathname === '/api/auth/google') {
      return handleAuthGoogle(request, env);
    }

    // GET /api/auth/callback — handle OAuth2 callback, issue session token
    if (request.method === 'GET' && pathname === '/api/auth/callback') {
      return handleAuthCallback(request, env);
    }

    // POST /api/auth/logout — revoke session and clear cookie
    if (request.method === 'POST' && pathname === '/api/auth/logout') {
      return handleAuthLogout(request, env);
    }

    // POST /api/auth/link-ticket — Dispatcher Cookie から PC 引き継ぎチケット発行（案1）
    if (request.method === 'POST' && pathname === '/api/auth/link-ticket') {
      return handleLinkTicket(request, env);
    }

    // POST /api/invite/create — 認証済みユーザーが招待URLを発行する
    if (request.method === 'POST' && pathname === '/api/invite/create') {
      return handleInviteCreate(request, env);
    }

    // GET /invite/:token — 招待トークン検証・OAuthリダイレクト
    if (request.method === 'GET' && pathname.startsWith('/invite/')) {
      return handleInviteAccept(request, env);
    }

    // Workers Assets: 上記の API ルートにマッチしなければ静的ファイル配信へ。
    // `not_found_handling = single-page-application` 指定済のため、
    // 存在しないパスは index.html が返り、クライアント側 SPA ルーティングへ委譲される。
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // ASSETS バインディング未設定（開発/ローカル）時のフォールバック
    return new Response('cc-remote-dispatcher', { status: 404 });
  },
};
