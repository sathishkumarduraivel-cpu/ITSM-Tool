import { useState } from 'react';
import { ShieldCheck, ShieldOff, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

function CopyableSecret({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (permissions/non-secure context) -- the
      // code is still shown on screen for manual copy, nothing to recover.
    }
  };
  return (
    <button
      type="button" onClick={copy}
      className="font-mono text-xs bg-slate-100 dark:bg-slate-800 rounded-lg px-2.5 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors inline-flex items-center gap-1.5"
      title="Copy to clipboard"
    >
      {value} {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} className="text-slate-400" />}
    </button>
  );
}

// Drives the whole authenticator-app lifecycle from one modal: set up (QR +
// manual key) -> confirm with a real code -> show one-time recovery codes,
// or, when already enabled, a single password-gated disable step. See
// routes/auth.js's /mfa/* handlers -- this component is a thin form layer
// over exactly those four calls, no client-side TOTP logic of its own.
export default function MfaModal({ enabled, onClose, onChanged }) {
  const [step, setStep] = useState(enabled ? 'disable' : 'start');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [password, setPassword] = useState('');

  const beginSetup = async () => {
    setLoading(true); setError('');
    try {
      const data = await api.post('/auth/mfa/setup');
      setSetup(data);
      setStep('scan');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const confirmEnable = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const data = await api.post('/auth/mfa/enable', { token: code });
      setRecoveryCodes(data.recoveryCodes);
      setStep('recovery');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // The one moment this modal must call onChanged() even if the caller
  // dismisses it via the header's X rather than the explicit button below --
  // MFA is already ON at this point (the server call already succeeded), so
  // the parent's status badge needs to refresh regardless of how the modal
  // closes.
  const finish = () => { onChanged(); onClose(); };

  const confirmDisable = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.post('/auth/mfa/disable', { password });
      onChanged();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const copyAllCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
    } catch {
      // Clipboard API unavailable -- codes remain visible for manual copy.
    }
  };

  return (
    <Modal title="Two-Factor Authentication" onClose={step === 'recovery' ? finish : onClose} maxWidth="max-w-md">
      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2 mb-3">{error}</div>}

      {step === 'start' && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-brand-50 dark:bg-brand-500/10 rounded-xl px-3.5 py-3">
            <ShieldCheck size={18} className="text-brand-600 dark:text-brand-400 shrink-0 mt-0.5" />
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Protect your account with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password). Once enabled, you'll enter a 6-digit code every time you sign in, on top of your password.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">Not now</button>
            <button type="button" onClick={beginSetup} disabled={loading} className="btn-primary">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Set up
            </button>
          </div>
        </div>
      )}

      {step === 'scan' && setup && (
        <form onSubmit={confirmEnable} className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">Scan this QR code with your authenticator app, then enter the 6-digit code it shows.</p>
          <div className="flex justify-center">
            <img src={setup.qrCode} alt="Scannable QR code for authenticator app enrollment" className="w-44 h-44 rounded-lg border border-slate-200 dark:border-slate-700 bg-white p-2" />
          </div>
          <div className="text-center space-y-1">
            <div className="text-xs text-slate-400">Can't scan? Enter this key manually:</div>
            <CopyableSecret value={setup.secret} />
          </div>
          <div>
            <label className="label">6-digit code</label>
            <input
              className="input text-center tracking-[0.4em] font-mono text-lg" maxLength={6} inputMode="numeric" autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={loading || code.length !== 6} className="btn-primary">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Verify & enable
            </button>
          </div>
        </form>
      )}

      {step === 'recovery' && recoveryCodes && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 rounded-xl px-3.5 py-3">
            <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Save these recovery codes somewhere safe. Each works once, to sign in if you ever lose access to your authenticator app — they won't be shown again.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3">
            {recoveryCodes.map((c) => (
              <div key={c} className="font-mono text-sm text-slate-700 dark:text-slate-200 text-center">{c}</div>
            ))}
          </div>
          <div className="flex justify-between gap-2">
            <button type="button" onClick={copyAllCodes} className="btn-secondary text-xs"><Copy size={12} /> Copy all</button>
            <button type="button" onClick={finish} className="btn-primary"><Check size={14} /> I've saved these codes</button>
          </div>
        </div>
      )}

      {step === 'disable' && (
        <form onSubmit={confirmDisable} className="space-y-4">
          <div className="flex items-start gap-3 bg-red-50 dark:bg-red-500/10 rounded-xl px-3.5 py-3">
            <ShieldOff size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Turning this off makes your account reachable with only a password. Confirm your password to continue.
            </p>
          </div>
          <div>
            <label className="label">Password</label>
            <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={loading} className="btn-danger">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <ShieldOff size={14} />} Disable
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
