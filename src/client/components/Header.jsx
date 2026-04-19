// CC-Remote v2 UI — Header
// Phase 2 で中央右エリアに PCDropdown を組み込み。
// Rev（右サイドバー化）: 🔰チュートリアル / ⚙設定 は Sidebar に移動。
// Header 右端は [FULLSCREEN] [☰] の 2 アイテムに整理。
// 互換: onSettingsClick / unreadCount props は受け取るが使わない（破壊的変更を避けるため残置）。
import PCDropdown from './PCDropdown';

export default function Header({
  // 互換保持: 呼び出し側の App.jsx がまだ渡している
  onSettingsClick: _onSettingsClick,
  unreadCount: _unreadCount = 0,
  connected,
  status,
  pcName,
  onFullscreenClick,
  isFullscreen = false,
  // Phase 2: PC 切替ドロップダウン用 props
  pcs = [],
  activePcId = '',
  statuses = {},
  onSelectPC,
  pcListLoading = false,
  pcListAuthError = false,
  pcListNetworkError = false,
  // サイドバー開閉 (2 状態: open/closed) — 右端に配置
  onSidebarToggle,
  sidebarState = 'open',
}) {

  return (
    <header className="bg-gradient-to-r from-cyber-800 to-cyber-900 border-b-2 border-navi px-3 py-2 flex-shrink-0 relative">
      {/* 内枠グロー */}
      <div className="absolute inset-[1px] border border-navi-glow/8 rounded-sm pointer-events-none" />

      <div className="flex items-center gap-2.5">
        {/* 接続インジケータ */}
        <div
          aria-label="接続状態"
          className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border transition-all
          ${connected
            ? 'bg-[#0a0a0b] border-[#22c55e]/40 shadow-[0_0_6px_rgba(34,197,94,0.3)]'
            : 'bg-cyber-700 border-alert-red shadow-neon-red animate-neon-flicker'
          }`}>
          <span className={`text-[8px] font-mono font-bold ${connected ? 'text-[#22c55e]' : 'text-alert-red'}`}>
            {connected ? '>_C' : '!'}
          </span>
        </div>

        {/* Title + Status */}
        <div className="flex-1 min-w-0 relative z-10">
          <div className="text-navi-glow font-pixel text-[10px] tracking-wider truncate">
            CC REMOTE {pcName ? `// ${pcName}` : ''}
          </div>
          {status && (
            <div className="text-exe-yellow text-[10px] animate-pulse font-mono mt-0.5">
              &gt; {status}
            </div>
          )}
        </div>

        {/* PC 切替ドロップダウン (Phase 2) */}
        {onSelectPC && (
          <PCDropdown
            pcs={pcs}
            activePcId={activePcId}
            statuses={statuses}
            onSelect={onSelectPC}
            loading={pcListLoading}
            authError={pcListAuthError}
            networkError={pcListNetworkError}
          />
        )}

        {/* FULLSCREEN トグル */}
        {onFullscreenClick && (
          <button
            type="button"
            aria-label={isFullscreen ? 'フルスクリーン解除' : 'フルスクリーンに切替'}
            aria-pressed={isFullscreen}
            title={isFullscreen ? 'フルスクリーン解除' : 'フルスクリーン'}
            onClick={onFullscreenClick}
            className={`flex-shrink-0 px-3 py-1.5 text-xs font-mono rounded border transition-all leading-none ${
              isFullscreen
                ? 'bg-navi/20 border-navi/50 text-navi-glow shadow-[0_0_4px_rgba(0,232,216,0.4)]'
                : 'bg-cyber-900/40 border-cyber-600/30 text-txt-muted hover:border-navi/40 hover:text-txt-secondary'
            }`}
          >FULLSCREEN</button>
        )}

        {/* サイドバー切替 ☰ — Rev: 右サイドバーに合わせて右端に配置 */}
        {onSidebarToggle && (
          <button
            type="button"
            onClick={onSidebarToggle}
            aria-label={`サイドバー (${sidebarState})`}
            title="サイドバー切替"
            className="flex-shrink-0 w-9 h-9 rounded-lg border border-navi-glow/30 bg-cyber-900/60 flex flex-col items-center justify-center gap-[3px] hover:border-navi-glow hover:shadow-[0_0_6px_rgba(0,232,216,0.3)] transition-all"
          >
            <span className="w-4 h-[2px] bg-navi-glow rounded" />
            <span className="w-4 h-[2px] bg-navi-glow rounded" />
            <span className="w-4 h-[2px] bg-navi-glow rounded" />
          </button>
        )}
      </div>

    </header>
  );
}
