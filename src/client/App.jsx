import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import PinLogin from './components/PinLogin';
import Header from './components/Header';
import SessionBar from './components/SessionBar';
import Terminal from './components/Terminal';
import InputArea from './components/InputArea';
import ErrorBoundary from './components/ErrorBoundary';
import ErrorDisplay from './components/ErrorDisplay';
import RoomTabs from './components/RoomTabs';
import Sidebar from './components/Sidebar';
import { useAuth } from './hooks/useAuth';
import { useStageMode } from './hooks/useStageMode';
import { usePcList } from './hooks/usePcList';
import { useFullscreen } from './hooks/useFullscreen';
import { useSession } from './hooks/useSession';
import { soundBoot, soundComplete } from './utils/sounds';
import { setRemoteBase, getApiBase, getAuthHeaders, initApiStore, fetchLinkTicket, dispatcherLink, setToken, setGoogleSession, setActivePcLabel } from './utils/api';
import { findPc } from './utils/pcStore';
import PCTabs from './components/PCTabs';
import AddPCLocal from './components/AddPCLocal';
import { idbGet, idbSet, migrateFromLocalStorage } from './utils/idbStore';
import { initPcStore } from './utils/pcStore';

const DISPATCHER_MODE =
  !!import.meta.env.VITE_DISPATCHER_URL ||
  import.meta.env.VITE_DISPATCHER_MODE === '1';

const DEV_BYPASS =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('dev') === '1';

const Settings = lazy(() => import('./components/Settings'));
const SessionList = lazy(() => import('./components/SessionList'));
const Templates = lazy(() => import('./components/Templates'));
const StatusPage = lazy(() => import('./components/StatusPage'));
const FileBrowser = lazy(() => import('./components/FileBrowser'));
const Dashboard = lazy(() => import('./components/Dashboard'));
const InteractiveTutorial = lazy(() => import('./components/InteractiveTutorial'));
const SchedulePanel = lazy(() => import('./components/SchedulePanel'));

const LazyFallback = (
  <div className="flex-1 flex items-center justify-center">
    <div className="text-txt-muted font-mono text-xs animate-pulse">LOADING...</div>
  </div>
);

function App() {
  const { isAuthenticated, token, login, logout } = useAuth();
  const { stageMode, isFirstReduceApplied } = useStageMode();
  // Phase 2: PC 一覧は App で単一購読し、Header (PCDropdown) / PCTabs に props で配布する。
  const pcListState = usePcList();
  const [unreadCount, setUnreadCount] = useState(0);
  // Phase 3: fullscreen は useFullscreen に抽出
  const { isFullscreen, toggle: handleFullscreenClick } = useFullscreen();
  // v4: useNotification と useFirebasePCs は廃止（中央サーバーなし、各PCはlocalStorage管理）
  const [booting, setBooting] = useState(true);
  const [activeSession, setActiveSession] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [showAddPC, setShowAddPC] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [sseState, setSseState] = useState({ connected: false, status: '' });
  const [appError, setAppError] = useState(null);
  const [pcName, setPcName] = useState('');

  const [quotedText, setQuotedText] = useState('');
  const [suggestedText, setSuggestedText] = useState('');
  // IndexedDB から読み込む（非同期）。起動中は空文字で待機。
  const [activePC, setActivePC] = useState('');
  const autoCreated = useRef(false);

  // Phase 3: セッション一覧を App で保持し、RoomTabs / Sidebar に配布する。
  // SessionBar は hidden 化後もコンポーネント内部で独自に useSession を回して動作する（非表示だが副作用は継続）。
  const sessionsHook = useSession(token);
  const sessionsList = sessionsHook.sessions;

  // サイドバー状態（2 状態トグル: open/closed）と overlay open 管理。
  const [sidebarState, setSidebarState] = useState('open');
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const sidebarHydratedRef = useRef(false);

  // 起動時: IDB から sidebarState を復元 + 旧 3 状態値 (full/icon/hidden) を正規化
  useEffect(() => {
    (async () => {
      const saved = await idbGet('ccr-sidebar-state', 'open');
      // 旧値マイグレーション: full→open, icon|hidden→closed
      const normalized =
        saved === 'open' || saved === 'full' ? 'open' :
        saved === 'closed' || saved === 'icon' || saved === 'hidden' ? 'closed' :
        'open';
      setSidebarState(normalized);
      sidebarHydratedRef.current = true;
      // IDB の旧値 (full/icon/hidden) / キー不存在 (defaultValue が返った場合) を
      // 新値 (open/closed) で永続化する。React が同値で re-render を省略した場合に
      // write useEffect (下) が不発になるのを補う。idbSet は冪等なので無条件実行。
      idbSet('ccr-sidebar-state', normalized);
    })();
  }, []);

  // sidebarState 変更時に IDB 保存（復元後のみ）
  useEffect(() => {
    if (!sidebarHydratedRef.current) return;
    idbSet('ccr-sidebar-state', sidebarState);
  }, [sidebarState]);

  const handleSidebarToggle = useCallback(() => {
    // AC-2S-05: モバイル時は overlay を「開く」だけ (冪等: 既に open でも true のまま)。
    // close 経路は backdrop click / close button 経由で onOverlayClose() のみ。
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      setSidebarOverlay(true);
      return;
    }
    // AC-2S-02, AC-2S-06: デスクトップ open ⇄ closed の 2 状態トグル。
    setSidebarState((prev) => (prev === 'open' ? 'closed' : 'open'));
  }, []);

  const handleNewRoomFromSidebar = useCallback(async () => {
    try {
      const s = await sessionsHook.createSession();
      setActiveSession(s.id);
    } catch (e) {
      console.error('[App] createSession failed', e);
    }
  }, [sessionsHook]);

  const handleCloseRoomTab = useCallback(async (sessionId) => {
    try {
      await sessionsHook.deleteSession(sessionId);
      if (activeSession === sessionId) {
        // 残セッションから次の active を決める
        const remaining = sessionsList.filter((s) => s.id !== sessionId);
        setActiveSession(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (e) {
      console.error('[App] deleteSession failed', e);
    }
  }, [sessionsHook, activeSession, sessionsList]);

  // 起動時: localStorage→IndexedDB マイグレーション → api ストア初期化 → pcStore 初期化 → activePC 復元
  useEffect(() => {
    migrateFromLocalStorage()
      .then(() => initApiStore())
      .then(() => initPcStore())
      .then(() => {
        // PCTabs の listPcs() キャッシュを再ロードさせる
        window.dispatchEvent(new Event('cc-remote:pcs-changed'));
        // dispatcher モードでは PC 選択を毎回ディスパッチャ画面から始める
        if (DISPATCHER_MODE) {
          setRemoteBase(null);
          return '';
        }
        return idbGet('ccr-active-pc', '');
      })
      .then(setActivePC);
  }, []);

  const [claudeReady, setClaudeReady] = useState(false);
  const handleSseState = useCallback((connected, status, ready) => {
    setSseState({ connected, status });
    if (ready !== undefined) setClaudeReady(ready);
  }, []);

  // 隠しコマンド: コナミコマンド（上上下下左右左右BA）
  const konamiRef = useRef([]);
  const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
  useEffect(() => {
    const handler = (e) => {
      konamiRef.current.push(e.key);
      konamiRef.current = konamiRef.current.slice(-10);
      if (konamiRef.current.join(',') === KONAMI.join(',')) {
        document.documentElement.style.setProperty('--navi-glow', '#ff00ff');
        document.documentElement.style.setProperty('--navi-blue', '#9b30ff');
        document.title = 'CC Remote // SECRET MODE';
        alert('SECRET MODE ACTIVATED!');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ディープリンク: URLパラメータ or SW通知からセッション切替
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('session');
    if (sid) { setActiveSession(sid); window.history.replaceState({}, '', '/'); }

    const handler = (event) => {
      if (event.data?.type === 'navigate-session' && event.data.sessionId) {
        setActiveSession(event.data.sessionId);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  }, []);

  // PC名取得 — v4: localStorage の label を使う（中央レジストリなし）
  const fetchPcName = useCallback(async () => {
    if (!activePC) { setPcName(''); return; }
    const pc = findPc(activePC);
    if (pc) setPcName(pc.label || '');
  }, [activePC]);

  // PC切り替え — v4: 選択された PC の tunnel URL を remoteBase にセット
  // 2026-04-17 案1 (シームレス化): dispatcher-link をここで直接実行し、成功時は token+activePC
  // を同一 commit でセット → PinLogin を一切マウントさせずに main app へ遷移（PIN画面の
  // 一瞬表示・jackIn アニメ待ちを完全に排除）。
  // 失敗時のみ従来どおり PinLogin を通す（Google OAuth フォールバック）。
  const handleSelectPC = useCallback(async (pcId, pcUrl, pcLabel) => {
    const isLocal = !pcUrl || pcUrl === window.location.origin;

    // 1. pcLabel を先にセット → IDB の token キーが `ccr-token-{pcLabel}` で安定する
    //    （PinLogin が /auth/status で再取得するのを待たずに、新PCの既存 token を参照できる）
    if (pcLabel) setActivePcLabel(pcLabel);

    // 2. Workers からチケット取得（dispatcher Cookie 有効時のみ ~200ms）
    let ticket = null;
    try {
      const entry = await fetchLinkTicket(pcId);
      if (entry) ticket = entry.ticket;
    } catch {}

    // 3. remoteBase をモジュール変数に確定（後続 API が新PCを指す）
    setRemoteBase(isLocal ? null : pcUrl);

    // 4. dispatcher-link 実行（成功すれば token + google session が返る）
    let linkSucceeded = false;
    if (ticket) {
      try {
        const linkRes = await dispatcherLink(ticket);
        if (linkRes && linkRes.token && linkRes.session) {
          await setGoogleSession(linkRes.session);
          setToken(linkRes.token);  // pcLabel 別 IDB キーに保存
          linkSucceeded = true;
        }
      } catch {
        // 404（会社PC 未更新）/ 401 などは PinLogin の Google OAuth フォールバックに任せる
      }
    }

    // 5. login/activePC/session リセットを同一 React バッチに入れる（自動 batching で 1 commit）
    if (linkSucceeded) login();  // isAuthenticated=true を立てる
    setActivePC(pcId);
    idbSet('ccr-active-pc', pcId);
    setActiveSession(null);
    autoCreated.current = false;
    fetchPcName();
  }, [fetchPcName, login]);

  useEffect(() => {
    if (isAuthenticated && token) fetchPcName();
  }, [isAuthenticated, token, fetchPcName]);

  // /notifications/unread ポーリング（Header.jsx から App.jsx に昇格 — ADR-04）
  useEffect(() => {
    if (!isAuthenticated || !token) { setUnreadCount(0); return; }
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const res = await fetch(`${getApiBase()}/notifications/unread`, { headers: getAuthHeaders() });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setUnreadCount(data.count || 0);
      } catch {}
    };
    fetchUnread();
    const timer = setInterval(fetchUnread, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isAuthenticated, token, activePC]);

  // セッション0個 or 全部exited なら自動作成
  useEffect(() => {
    if (!isAuthenticated || !token || autoCreated.current) return;
    (async () => {
      try {
        const base = getApiBase();
        const headers = getAuthHeaders();
        const res = await fetch(`${base}/sessions`, { headers, mode: 'cors' });
        if (!res.ok) return;
        const sessions = await res.json();
        const running = sessions.find(s => s.status !== 'exited');
        if (running) {
          setActiveSession(running.id);
        } else {
          autoCreated.current = true;
          const createHeaders = { 'Content-Type': 'application/json', ...getAuthHeaders() };
          const createRes = await fetch(`${base}/sessions`, {
            method: 'POST',
            headers: createHeaders,
            mode: 'cors',
            body: JSON.stringify({ name: 'Session 1' }),
          });
          if (createRes.ok) {
            const session = await createRes.json();
            setActiveSession(session.id);
          }
        }
      } catch (e) {
        setAppError(e);
      }
    })();
  }, [isAuthenticated, token, activePC]);

  // 初回自動起動: ログイン済み かつ チュートリアル未視聴 → インタラクティブチュートリアル表示。
  useEffect(() => {
    if (!isAuthenticated) return;
    idbGet('ccr-tutorial-seen', null).then((seen) => {
      if (!seen) setShowTutorial(true);
    });
  }, [isAuthenticated]);

  // Settings などからの再生要求を受けてチュートリアルを再起動する。
  useEffect(() => {
    const handler = () => setShowTutorial(true);
    window.addEventListener('ccr:show-tutorial', handler);
    return () => window.removeEventListener('ccr:show-tutorial', handler);
  }, []);

  // Rev 5: チュートリアルがモーダルを閉じる要求を発行する
  useEffect(() => {
    const closeSessions = () => setShowSessions(false);
    const closeSettings = () => setShowSettings(false);
    window.addEventListener('ccr:close-session-list', closeSessions);
    window.addEventListener('ccr:close-settings', closeSettings);
    return () => {
      window.removeEventListener('ccr:close-session-list', closeSessions);
      window.removeEventListener('ccr:close-settings', closeSettings);
    };
  }, []);

  // ブート演出（2.5秒）
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 2500);
    return () => clearTimeout(t);
  }, []);


  if (booting) {
    return (
      <div className="flex flex-col items-center justify-center h-full cyber-floor relative">
        <div className="relative z-10 text-center">
          <div className="mx-auto mb-5 w-20 h-20 rounded-2xl bg-[#0a0a0b] flex items-center justify-center border border-cyber-600/30" style={{animation: 'glow-pulse 1s ease-in-out infinite'}}>
            <span className="text-[#22c55e] text-2xl font-mono font-bold">&gt;_C</span>
          </div>
          <div className="text-navi-glow font-pixel text-sm tracking-[0.25em] mb-3" style={{animation: 'fade-in 0.5s ease-out'}}>
            CC REMOTE
          </div>
          <div className="text-txt-muted font-mono text-[10px] mb-1" style={{animation: 'fade-in 0.8s ease-out'}}>
            v3.0 // NAVI SYSTEM
          </div>
          <div className="text-exe-green/60 font-mono text-[9px] animate-pulse mt-2">
            JACK IN...
          </div>
          <div className="mt-5 mx-auto w-40 h-1.5 bg-cyber-700 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-navi to-exe-green rounded-full" style={{animation: 'boot-bar 2.5s ease-in-out forwards'}} />
          </div>
        </div>
        <style>{`
          @keyframes boot-bar {
            0% { width: 0%; }
            30% { width: 40%; }
            60% { width: 70%; }
            90% { width: 95%; }
            100% { width: 100%; }
          }
        `}</style>
      </div>
    );
  }

  if (DISPATCHER_MODE && !activePC && !DEV_BYPASS) {
    return (
      <div className="flex flex-col h-full cyber-floor scanlines">
        <div className="text-center py-6 relative z-10">
          <div className="mx-auto mb-3 w-14 h-14 rounded-xl bg-[#0a0a0b] border border-cyber-600/30 flex items-center justify-center animate-glow-pulse">
            <span className="text-[#22c55e] text-base font-mono font-bold">&gt;_C</span>
          </div>
          <h1 className="text-2xl font-pixel text-navi-glow tracking-wider animate-neon-flicker">
            CC REMOTE
          </h1>
          <div className="text-txt-muted text-xs font-mono tracking-[0.15em] mt-2">
            // 操作するPCを選んでください
          </div>
        </div>
        <div className="relative z-10">
          <PCTabs activePC={null} onSelectPC={handleSelectPC} onAddPC={() => {}} pcListState={pcListState} />
        </div>
      </div>
    );
  }

  if (!isAuthenticated && !DEV_BYPASS) {
    return <PinLogin onLogin={login} />;
  }

  // Rev 5: tutorial を早期 return でも維持するためのオーバーレイ
  const tutorialOverlay = showTutorial ? (
    <Suspense fallback={null}>
      <InteractiveTutorial onClose={() => setShowTutorial(false)} />
    </Suspense>
  ) : null;

  if (showSettings) {
    return (
      <>
        <Suspense fallback={LazyFallback}>
          <Settings onClose={() => setShowSettings(false)} onLogout={logout} token={token} onPcChange={fetchPcName}
            onShowStatus={() => { setShowSettings(false); setShowStatus(true); }}
            onShowFiles={() => { setShowSettings(false); setShowFiles(true); }}
            onShowDashboard={() => { setShowSettings(false); setShowDashboard(true); }}
          />
        </Suspense>
        {tutorialOverlay}
      </>
    );
  }

  if (showStatus) {
    return (
      <>
        <Suspense fallback={LazyFallback}>
          <StatusPage token={token} onClose={() => setShowStatus(false)} />
        </Suspense>
        {tutorialOverlay}
      </>
    );
  }

  if (showFiles) {
    return (
      <>
        <Suspense fallback={LazyFallback}>
          <FileBrowser token={token} onClose={() => setShowFiles(false)} />
        </Suspense>
        {tutorialOverlay}
      </>
    );
  }

  if (showDashboard) {
    return (
      <>
        <Suspense fallback={LazyFallback}>
          <Dashboard token={token} onClose={() => setShowDashboard(false)} />
        </Suspense>
        {tutorialOverlay}
      </>
    );
  }

  return (
    <div className="flex flex-col h-full scanlines">
      {appError && (
        <ErrorDisplay
          error={appError}
          onRetry={() => { setAppError(null); window.location.reload(); }}
        />
      )}
      <Header
        onSettingsClick={() => setShowSettings(true)}
        connected={sseState.connected}
        status={sseState.status}
        pcName={pcName}
        unreadCount={unreadCount}
        onFullscreenClick={handleFullscreenClick}
        isFullscreen={isFullscreen}
        pcs={pcListState.pcs}
        activePcId={activePC}
        statuses={pcListState.statuses}
        onSelectPC={handleSelectPC}
        pcListLoading={pcListState.loading}
        pcListAuthError={pcListState.authError}
        pcListNetworkError={pcListState.networkError}
        onSidebarToggle={handleSidebarToggle}
        sidebarState={sidebarState}
      />
      {/* Phase 2: PCTabs はヘッダーの PCDropdown に置換済。コードは残し hidden で非表示化。 */}
      <div className="hidden">
        <PCTabs activePC={activePC} onSelectPC={handleSelectPC} onAddPC={() => setShowAddPC(true)} pcListState={pcListState} />
      </div>
      {showAddPC && (
        <AddPCLocal
          onClose={() => setShowAddPC(false)}
          onAdded={(pc) => {
            setShowAddPC(false);
            window.dispatchEvent(new Event('cc-remote:pcs-changed'));
            if (pc) {
              handleSelectPC(pc.id, pc.url, pc.label);
            }
          }}
        />
      )}
      <div className="flex flex-1 min-h-0">
        <main className="flex-1 flex flex-col min-h-0">
          <RoomTabs
            sessions={sessionsList}
            activeSessionId={activeSession}
            unreadCounts={{}}
            onSelect={setActiveSession}
            onAdd={handleNewRoomFromSidebar}
            onClose={handleCloseRoomTab}
            pcId={activePC}
          />
          {/* Phase 3: SessionBar は RoomTabs に機能統合済、非表示のまま副作用のみ維持 (AC-04h) */}
          <div className="hidden">
            <SessionBar
              activeSession={activeSession}
              onSelect={setActiveSession}
              token={token}
              onShowList={() => setShowSessions(true)}
            />
          </div>
          {showSessions && (
            <Suspense fallback={LazyFallback}>
              <SessionList
                activeSession={activeSession}
                onSelect={setActiveSession}
                token={token}
                onClose={() => setShowSessions(false)}
              />
            </Suspense>
          )}
          {showTemplates && (
            <Suspense fallback={LazyFallback}>
              <Templates
                token={token}
                activeSessionId={activeSession}
                onClose={() => setShowTemplates(false)}
                onExecute={async (prompt) => {
                  if (activeSession) {
                    const hdrs = { 'Content-Type': 'application/json', ...getAuthHeaders() };
                    await fetch(`${getApiBase()}/sessions/${activeSession}/input`, {
                      method: 'POST',
                      headers: hdrs,
                      mode: 'cors',
                      body: JSON.stringify({ text: prompt + '\r' }),
                    });
                    setShowTemplates(false);
                  }
                }}
              />
            </Suspense>
          )}
          <Terminal
            sessionId={activeSession}
            token={token}
            onSseState={handleSseState}
            onAuthError={logout}
            onQuote={setQuotedText}
            onSuggest={setSuggestedText}
            stageMode={stageMode}
            isFirstReduceApplied={isFirstReduceApplied}
          />
          <InputArea sessionId={activeSession} token={token} onShowTemplates={() => setShowTemplates(true)} onShowSchedule={() => setShowSchedule(true)} quotedText={quotedText} onQuoteClear={() => setQuotedText('')} suggestedText={suggestedText} onSuggestClear={() => setSuggestedText('')} claudeReady={claudeReady} />
        </main>
        <Sidebar
          sidebarState={sidebarState}
          showOverlay={sidebarOverlay}
          onOverlayClose={() => setSidebarOverlay(false)}
          sessions={sessionsList}
          activeSessionId={activeSession}
          onSessionSelect={setActiveSession}
          onNewSession={handleNewRoomFromSidebar}
          onShowSettings={() => setShowSettings(true)}
          onShowAllSessions={() => setShowSessions(true)}
          unreadCount={unreadCount}
        />
      </div>

      {/* インタラクティブチュートリアル (初回自動 + Header 若葉マーク起動) */}
      {showTutorial && (
        <Suspense fallback={null}>
          <InteractiveTutorial onClose={() => setShowTutorial(false)} />
        </Suspense>
      )}

      {/* Rev 6: スケジュールパネル (旧タスクキュー置換) */}
      {showSchedule && (
        <Suspense fallback={null}>
          <SchedulePanel
            token={token}
            activeSessionId={activeSession}
            onClose={() => setShowSchedule(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default function AppWithBoundary() {
  return <ErrorBoundary><App /></ErrorBoundary>;
}
