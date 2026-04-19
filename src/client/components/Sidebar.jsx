// CC-Remote v2 UI — Sidebar (2 状態トグル: open/closed, 右寄せ)
//
// 2 状態 (デスクトップ): 'open' (240px) / 'closed' (0px)
// モバイル (isMobileWidth()=true): aside は常に 0px。showOverlay=true の時のみ overlay を描画。
// デスクトップでの overlay プレビューは廃止。closed 状態では ☰ で open に戻す。
//
// props:
//   sidebarState: 'open' | 'closed'
//   showOverlay: boolean                 — overlay 表示フラグ（モバイル専用、App が管理）
//   onOverlayClose: () => void
//   sessions: {id, name, status}[]
//   activeSessionId: string | null
//   onSessionSelect: (sessionId) => void
//   onNewSession: () => void
//   onShowSettings: () => void
//   onShowAllSessions?: () => void
//   unreadCount?: number                 — 設定ボタンに表示する未読バッジ（Header から移動）
//
// MUST: A3 transition-[width] duration-200 / B1 stageMode 非依存
import { useEffect, useState } from 'react';
import { isMobileWidth } from '../utils/responsive';

function SidebarContents({
  sessions,
  activeSessionId,
  onSessionSelect,
  onNewSession,
  onShowSettings,
  onShowAllSessions,
  unreadCount = 0,
  query,
  setQuery,
}) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => (s.name || '').toLowerCase().includes(q))
    : sessions;

  return (
    <div className="h-full flex flex-col bg-cyber-900 border-l border-navi/20">
      <div className="p-2 border-b border-navi/10 flex-shrink-0">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ROOM SEARCH"
          className="w-full bg-cyber-800 border border-cyber-600 rounded px-2 py-1 text-[11px] font-mono text-txt-bright placeholder:text-txt-muted focus:outline-none focus:border-navi"
        />
      </div>

      <button
        type="button"
        onClick={onNewSession}
        aria-label="新しいルーム"
        title="新しいルーム"
        className="flex-shrink-0 flex items-center gap-2 px-2 py-2 border-b border-navi/10 text-navi-glow hover:bg-navi/10 transition-all"
      >
        <span className="w-6 h-6 rounded border border-navi/40 flex items-center justify-center text-sm leading-none">+</span>
        <span className="text-[11px] font-mono">新規ルーム</span>
      </button>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-3 text-txt-muted text-[10px] font-mono">NO ROOMS</div>
        ) : (
          filtered.map((s) => {
            const isActive = s.id === activeSessionId;
            const statusColor =
              s.status === 'running' || s.status === '起動中...'
                ? 'bg-exe-green'
                : s.status === 'exited'
                  ? 'bg-alert-red'
                  : 'bg-txt-muted';
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSessionSelect?.(s.id)}
                title={s.name || s.id}
                className={`w-full flex items-center gap-2 px-2 py-2 border-l-2 text-left hover:bg-navi/5 transition-all
                  ${isActive ? 'border-navi bg-navi/10 text-navi-glow' : 'border-transparent text-txt-secondary'}`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />
                <span className="text-[11px] font-mono truncate">{s.name || s.id.slice(0, 8)}</span>
              </button>
            );
          })
        )}
      </div>

      {onShowAllSessions && (
        <button
          type="button"
          onClick={onShowAllSessions}
          className="flex-shrink-0 border-t border-navi/10 flex items-center gap-2 px-2 py-2 text-txt-muted hover:text-txt-secondary hover:bg-cyber-800 transition-all"
          title="全ルーム一覧"
        >
          <span className="w-5 h-5 flex items-center justify-center text-sm">≡</span>
          <span className="text-[11px] font-mono">全ルーム</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('ccr:show-tutorial'))}
        className="flex-shrink-0 border-t border-navi/10 flex items-center gap-2 px-2 py-2 text-txt-muted hover:text-txt-secondary hover:bg-cyber-800 transition-all"
        title="チュートリアルを再生"
      >
        <span className="w-5 h-5 flex items-center justify-center text-sm" role="img" aria-label="チュートリアル">🔰</span>
        <span className="text-[11px] font-mono">チュートリアル</span>
      </button>

      <button
        type="button"
        data-tutorial-id="settings-btn"
        onClick={onShowSettings}
        className="relative flex-shrink-0 border-t border-navi/10 flex items-center gap-2 px-2 py-2 text-txt-muted hover:text-txt-secondary hover:bg-cyber-800 transition-all"
        title="設定"
      >
        <span className="w-5 h-5 flex items-center justify-center text-sm">⚙</span>
        <span className="text-[11px] font-mono">設定</span>
        {unreadCount > 0 && (
          <span className="ml-auto min-w-[18px] h-[18px] px-1 bg-alert-red text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </div>
  );
}

export default function Sidebar({
  sidebarState = 'open',
  showOverlay = false,
  onOverlayClose,
  sessions = [],
  activeSessionId = null,
  onSessionSelect,
  onNewSession,
  onShowSettings,
  onShowAllSessions,
  unreadCount = 0,
}) {
  const [isMobile, setIsMobile] = useState(() => isMobileWidth());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onResize = () => setIsMobile(isMobileWidth());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // モバイル時は常に 0px、overlay のみで表示
  const desktopWidthPx = sidebarState === 'open' ? 240 : 0;
  const effectiveWidth = isMobile ? 0 : desktopWidthPx;
  const renderOverlay = showOverlay && isMobile;

  // overlay 表示中にコールバック経由で画面遷移 (設定/セッション選択/新規ルーム等) した際、
  // 遷移後に overlay を閉じる。モバイル overlay は full-screen 的な UI のため操作完了=閉じる
  // が自然な期待値。overlay を維持したい UI が将来追加されたら個別に wrap を外すこと。
  const wrapCallback = (cb) => (arg) => {
    if (cb) cb(arg);
    if (renderOverlay && onOverlayClose) onOverlayClose();
  };

  return (
    <>
      <aside
        className="flex-shrink-0 overflow-hidden transition-[width] duration-200"
        style={{ width: effectiveWidth }}
        aria-label="サイドバー"
      >
        {!isMobile && sidebarState === 'open' && (
          <SidebarContents
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSessionSelect={onSessionSelect}
            onNewSession={onNewSession}
            onShowSettings={onShowSettings}
            onShowAllSessions={onShowAllSessions}
            unreadCount={unreadCount}
            query={query}
            setQuery={setQuery}
          />
        )}
      </aside>

      {renderOverlay && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40 animate-fade-in"
            onClick={onOverlayClose}
            aria-label="サイドバーを閉じる"
          />
          <div
            className="fixed right-0 top-0 bottom-0 z-50 animate-fade-in"
            style={{ width: 240 }}
          >
            <SidebarContents
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSessionSelect={wrapCallback(onSessionSelect)}
              onNewSession={wrapCallback(onNewSession)}
              onShowSettings={wrapCallback(onShowSettings)}
              onShowAllSessions={onShowAllSessions ? wrapCallback(onShowAllSessions) : null}
              unreadCount={unreadCount}
              query={query}
              setQuery={setQuery}
            />
          </div>
        </>
      )}
    </>
  );
}
