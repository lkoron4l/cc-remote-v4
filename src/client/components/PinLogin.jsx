// CC-Remote v4 — PinLogin (4-digit screen lock PIN, Google OAuth gates PC registration)
import { useState, useEffect, useRef } from 'react';
import { soundSessionStart, soundError } from '../utils/sounds';
import { setToken, getApiBase, setRemoteBase } from '../utils/api';

const PIN_MIN = 4;
const PIN_MAX = 4;
const GOOGLE_CLIENT_ID = '963785499726-v0da2q3hqktflate717q7033snjcht90.apps.googleusercontent.com';

function PinDots({ pin }) {
  // Show up to PIN_MIN dots; if pin > PIN_MIN, expand
  const total = Math.max(PIN_MIN, pin.length);
  return (
    <div className="pet-frame p-4 mb-5">
      <div className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={`w-9 h-9 rounded border-2 flex items-center justify-center text-base font-mono transition-all duration-200
              ${pin.length > i
                ? 'border-navi-glow bg-navi-glow/10 text-navi-glow shadow-neon-cyan'
                : 'border-cyber-500 bg-cyber-800 text-txt-muted'}`}
          >
            {pin.length > i ? '\u25C6' : '\u25C7'}
          </div>
        ))}
      </div>
    </div>
  );
}

function Numpad({ onNumpad }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 mb-4">
      {[1,2,3,4,5,6,7,8,9,'clear',0,'del'].map((num, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onNumpad(num === 'del' ? 'del' : num === 'clear' ? 'clear' : String(num))}
          className="h-12 rounded text-base font-mono transition-all duration-150 chip-btn active:shadow-neon-cyan active:border-navi-glow"
        >
          {num === 'del' ? 'DEL' : num === 'clear' ? 'CLR' : num}
        </button>
      ))}
    </div>
  );
}

export default function PinLogin({ onLogin }) {
  const [hasPin, setHasPin] = useState(null);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [jackIn, setJackIn] = useState(false);
  const [googleSession, setGoogleSession] = useState(() => localStorage.getItem('ccr-google-session') || '');
  const [remoteBase, setRemoteBaseState] = useState(() => localStorage.getItem('ccr-remote-base') || '');
  const [tunnelInput, setTunnelInput] = useState('');
  const googleBtnRef = useRef(null);

  // Detect if we're served from a non-API origin (e.g. GitHub Pages)
  const needsRemoteBase = !remoteBase && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(window.location.origin);

  // Fetch PIN status on mount (only when we have a base)
  useEffect(() => {
    if (needsRemoteBase) { setHasPin(false); return; }
    const base = getApiBase();
    fetch(`${base}/auth/status`)
      .then(r => r.ok ? r.json() : { hasPin: false })
      .then(data => setHasPin(!!data.hasPin))
      .catch(() => setHasPin(false));
  }, [remoteBase, needsRemoteBase]);

  const handleSaveTunnel = (e) => {
    e.preventDefault();
    let v = tunnelInput.trim().replace(/\/+$/, '');
    if (!v) { setError('URLを入力してください'); return; }
    if (!/^https?:\/\//.test(v)) v = 'https://' + v;
    if (!/\.trycloudflare\.com$/i.test(v.replace(/^https?:\/\//, '').split('/')[0])) {
      setError('trycloudflare.com の URL を指定してください');
      return;
    }
    setRemoteBase(v);
    setRemoteBaseState(v);
    setError('');
  };

  // Initialize Google Identity Services when no session yet
  useEffect(() => {
    if (googleSession) return;
    let cancelled = false;
    const tryInit = () => {
      if (cancelled) return;
      if (!window.google?.accounts?.id || !googleBtnRef.current) {
        setTimeout(tryInit, 200);
        return;
      }
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        use_fedcm_for_prompt: true,
        itp_support: true,
        callback: async (response) => {
          try {
            const base = getApiBase();
            const res = await fetch(`${base}/auth/google`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential: response.credential }),
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'Google認証に失敗しました');
            }
            const data = await res.json();
            localStorage.setItem('ccr-google-session', data.session);
            setGoogleSession(data.session);
            setError('');
          } catch (err) {
            setError(err.message);
            try { soundError(); } catch {}
          }
        },
      });
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'filled_black',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        locale: 'ja',
        width: 260,
      });
    };
    tryInit();
    return () => { cancelled = true; };
  }, [googleSession]);

  // Auto-submit PIN when fully entered
  useEffect(() => {
    if (!googleSession) return;
    if (pin.length !== PIN_MAX) return;
    if (loading) return;
    const ev = { preventDefault: () => {} };
    handleSubmit(ev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const isSetup = hasPin === false;

  const handleNumpad = (key) => {
    if (key === 'del') setPin(prev => prev.slice(0, -1));
    else if (key === 'clear') setPin('');
    else if (pin.length < PIN_MAX) setPin(prev => prev + key);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (pin.length < PIN_MIN) {
      setError(`PINは${PIN_MIN}桁で入力してください`);
      return;
    }
    if (isSetup && !isConfirming) {
      setPinConfirm(pin);
      setPin('');
      setIsConfirming(true);
      setError('');
      return;
    }
    if (isSetup && isConfirming) {
      if (pin !== pinConfirm) {
        setError('PINが一致しません');
        setPin('');
        setPinConfirm('');
        setIsConfirming(false);
        try { soundError(); } catch {}
        return;
      }
    }
    setLoading(true);
    setError('');
    try {
      const base = getApiBase();
      const endpoint = isSetup ? '/auth/setup' : '/auth/login';
      const res = await fetch(`${base}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'エラー');
      }
      const data = await res.json();
      setToken(data.token);
      if (isSetup) setHasPin(true);
      try { soundSessionStart(); } catch {}
      setJackIn(true);
      setTimeout(() => onLogin?.(), 1000);
    } catch (err) {
      setError(err.message);
      setLoading(false);
      setPin('');
    }
  };

  if (needsRemoteBase) {
    return (
      <div className="flex flex-col items-center justify-center h-full cyber-floor scanlines px-6 animate-fade-in">
        <div className="w-full max-w-xs relative z-10">
          <div className="flex justify-center mb-5">
            <div className="w-14 h-14 rounded-xl bg-[#0a0a0b] border border-cyber-600/30 flex items-center justify-center animate-glow-pulse">
              <span className="text-[#22c55e] text-base font-mono font-bold">&gt;_C</span>
            </div>
          </div>
          <div className="text-center mb-6">
            <h1 className="text-2xl font-pixel text-navi-glow mb-2 tracking-wider animate-neon-flicker">
              CC REMOTE
            </h1>
            <div className="text-txt-muted text-xs font-mono tracking-[0.15em]">
              // PC接続URLを入力
            </div>
          </div>
          {error && (
            <div className="text-alert-red text-center text-xs mb-3 font-mono animate-fade-in">
              ! ERROR: {error}
            </div>
          )}
          <form onSubmit={handleSaveTunnel} className="space-y-3">
            <input
              type="text"
              value={tunnelInput}
              onChange={(e) => setTunnelInput(e.target.value)}
              placeholder="xxx-xxx-xxx.trycloudflare.com"
              className="w-full px-3 py-2 rounded bg-cyber-800 border border-cyber-500 text-txt-bright text-sm font-mono focus:border-navi-glow focus:outline-none"
              autoFocus
            />
            <button
              type="submit"
              className="w-full py-3 rounded-lg font-bold text-sm font-pixel tracking-wider neon-btn text-txt-bright shadow-neon-blue"
            >
              CONNECT
            </button>
          </form>
          <div className="text-txt-muted/60 text-center text-[10px] mt-4 font-mono">
            PCのサーバーログに表示される URL を貼り付け
          </div>
          <div className="text-txt-muted/40 text-center text-[10px] mt-1 font-mono">
            v4.0 // Google + PIN
          </div>
        </div>
      </div>
    );
  }

  if (hasPin === null) {
    return (
      <div className="flex items-center justify-center h-full cyber-floor scanlines">
        <div className="w-12 h-12 rounded-xl bg-[#0a0a0b] border border-cyber-600/30 flex items-center justify-center animate-glow-pulse relative z-10">
          <span className="text-[#22c55e] text-sm font-mono font-bold">&gt;_C</span>
        </div>
      </div>
    );
  }

  if (!googleSession) {
    return (
      <div className="flex flex-col items-center justify-center h-full cyber-floor scanlines px-6 animate-fade-in">
        <div className="w-full max-w-xs relative z-10">
          <div className="flex justify-center mb-5">
            <div className="w-14 h-14 rounded-xl bg-[#0a0a0b] border border-cyber-600/30 flex items-center justify-center animate-glow-pulse">
              <span className="text-[#22c55e] text-base font-mono font-bold">&gt;_C</span>
            </div>
          </div>
          <div className="text-center mb-6">
            <h1 className="text-2xl font-pixel text-navi-glow mb-2 tracking-wider animate-neon-flicker">
              CC REMOTE
            </h1>
            <div className="text-txt-muted text-xs font-mono tracking-[0.15em]">
              // Googleでログイン
            </div>
          </div>
          {error && (
            <div className="text-alert-red text-center text-xs mb-3 font-mono animate-fade-in">
              ! ERROR: {error}
            </div>
          )}
          <div ref={googleBtnRef} className="flex justify-center" />
          <div className="text-txt-muted/40 text-center text-[10px] mt-4 font-mono">
            v4.0 // Google + PIN
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center h-full cyber-floor scanlines px-6 transition-all duration-1000 ${jackIn ? 'scale-[1.3] opacity-0 blur-sm' : 'animate-fade-in scale-100 opacity-100'}`}>
      <div className="w-full max-w-xs relative z-10">
        <div className="flex justify-center mb-5">
          <div className="w-14 h-14 rounded-xl bg-[#0a0a0b] border border-cyber-600/30 flex items-center justify-center animate-glow-pulse">
            <span className="text-[#22c55e] text-base font-mono font-bold">&gt;_C</span>
          </div>
        </div>

        <div className="text-center mb-6">
          <h1 className="text-2xl font-pixel text-navi-glow mb-2 tracking-wider animate-neon-flicker">
            CC REMOTE
          </h1>
          <div className="text-txt-muted text-xs font-mono tracking-[0.15em]">
            {isSetup
              ? (isConfirming ? '// CONFIRM PIN (4 digits)' : '// SET PIN (4 digits)')
              : '// ENTER PIN'}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <PinDots pin={pin} />

          {error && (
            <div className="text-alert-red text-center text-xs mb-3 font-mono animate-fade-in">
              ! ERROR: {error}
            </div>
          )}

          <Numpad onNumpad={handleNumpad} />

          <button
            type="submit"
            disabled={pin.length < PIN_MIN || loading}
            className="w-full py-3 rounded-lg font-bold text-sm font-pixel tracking-wider transition-all
              neon-btn text-txt-bright shadow-neon-blue
              disabled:opacity-20 disabled:cursor-not-allowed"
          >
            {loading
              ? 'CONNECTING...'
              : isSetup
                ? (isConfirming ? 'SET PIN' : 'NEXT')
                : 'PLUG IN'}
          </button>
        </form>

        <div className="text-txt-muted/40 text-center text-[10px] mt-4 font-mono">
          v4.0 // P2P, no central server
        </div>
      </div>
    </div>
  );
}
