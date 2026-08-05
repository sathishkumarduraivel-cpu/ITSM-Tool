import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Sparkles, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('admin@itsm.ai');
  const [password, setPassword] = useState('Admin@123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-32 -left-24 w-[28rem] h-[28rem] rounded-full bg-brand-400/25 dark:bg-brand-500/15 blur-3xl animate-floaty" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-purple-400/20 dark:bg-purple-500/15 blur-3xl animate-floaty" style={{ animationDelay: '-3s' }} />

      <div className="relative w-full max-w-sm animate-slide-up">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-glow-brand flex items-center justify-center text-white font-display font-bold">
            IT
          </div>
          <div className="text-left">
            <div className="font-display font-bold text-slate-800 dark:text-slate-100 leading-tight">ITSM AI</div>
            <div className="text-xs text-slate-400">AI-native service desk</div>
          </div>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4 shadow-popover dark:shadow-popover-dark">
          <div>
            <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">Sign in</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Access your service desk workspace</p>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-900 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            Sign in
          </button>

          <div className="text-center text-sm">
            <Link to="/register" className="text-brand-600 hover:text-brand-700 font-medium">Create an account</Link>
          </div>

          <div className="text-xs text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 space-y-1">
            <div className="font-medium text-slate-500 dark:text-slate-400">Demo accounts (after running the seed script):</div>
            <div>admin@itsm.ai / Admin@123 — Admin</div>
            <div>priya@itsm.ai / Agent@123 — Agent</div>
            <div>sam@company.com / User@123 — Requester</div>
          </div>
        </form>
      </div>
    </div>
  );
}
