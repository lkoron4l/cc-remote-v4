// CC-Remote v4 — Notifications
// v3 では Firebase Cloud Messaging で push 通知を送っていたが、v4 は中央サーバーなし。
// 2026-04-17: Android TWA リリース向けに Web Push (VAPID + Service Worker) を再導入予定。
// 現状は no-op stub を保持しつつ、VAPIDキー取得後に本実装を有効化する。
//
// ==========================================================================
// Phase 0 完了後の実装手順（VAPIDキー取得後）:
// ==========================================================================
// 1. `.env` に以下を追加:
//      VAPID_PUBLIC_KEY=BG...（Firebase Console → Cloud Messaging → Web設定）
//      VAPID_PRIVATE_KEY=...（同上、Private key）
//      VAPID_EMAIL=mailto:lkoron4l@gmail.com
// 2. `npm install web-push` でライブラリ追加
// 3. Push subscription を受け取るエンドポイント（/api/push/subscribe）を実装
//    - クライアントから Service Worker の subscription オブジェクトを POST 受信
//    - SQLite `push_subscriptions` テーブルに保存（user_id, endpoint, keys.p256dh, keys.auth）
// 4. sendNotification 本実装（下記コメントアウト済サンプル参照）
// 5. クライアント側 `src/client/utils/pushNotifications.js` を作成して登録フローを実装
// ==========================================================================

export async function sendNotification(title, body, opts = {}) {
  console.log(`[Notify] ${title}: ${body}`);
  // TODO Phase 0 完了後: 以下を有効化
  // -----------------------------------------------------------------
  // import webpush from 'web-push';
  // webpush.setVapidDetails(
  //   process.env.VAPID_EMAIL,
  //   process.env.VAPID_PUBLIC_KEY,
  //   process.env.VAPID_PRIVATE_KEY
  // );
  //
  // const subscriptions = await getActiveSubscriptions(opts.userId);
  // const payload = JSON.stringify({
  //   title,
  //   body,
  //   icon: '/icons/icon-192.png',
  //   badge: '/icons/icon-badge.png',
  //   data: { sessionId: opts.sessionId, deeplink: opts.deeplink, ts: Date.now() },
  //   tag: opts.tag || 'task-complete',
  //   renotify: true,
  //   requireInteraction: false,
  // });
  //
  // const results = await Promise.allSettled(
  //   subscriptions.map(sub => webpush.sendNotification(sub, payload, { urgency: 'high', TTL: 86400 }))
  // );
  //
  // // 失効検知: 410 Gone / 404 Not Found は DB から削除
  // for (const [i, r] of results.entries()) {
  //   if (r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode)) {
  //     await deleteSubscription(subscriptions[i].endpoint);
  //   }
  // }
  // return { ok: true, sent: results.filter(r => r.status === 'fulfilled').length };
  // -----------------------------------------------------------------
  return { ok: true, stub: true };
}
