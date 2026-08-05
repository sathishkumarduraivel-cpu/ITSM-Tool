import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white font-bold">
            IT
          </div>
          <div className="text-left">
            <div className="font-semibold text-slate-800">ITSM AI</div>
            <div className="text-xs text-slate-400">AI-native service desk</div>
          </div>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Sign in</h1>
            <p className="text-sm text-slate-500">Access your service desk workspace</p>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
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

          <div className="text-xs text-slate-400 bg-slate-50 rounded-lg p-3 space-y-1">
            <div className="font-medium text-slate-500">Demo accounts (after running the seed script):</div>
            <div>admin@itsm.ai / Admin@123 — Admin</div>
            <div>priya@itsm.ai / Agent@123 — Agent</div>
            <div>sam@company.com / User@123 — Requester</div>
          </div>
        </form>
      </div>
    </div>
  );
}
