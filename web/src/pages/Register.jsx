import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Building2, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ workspace_name: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(form);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-slate-50 dark:bg-slate-950 px-4">
      <div className="pointer-events-none absolute -top-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-brand-400/20 dark:bg-brand-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -left-24 w-[28rem] h-[28rem] rounded-full bg-purple-400/15 dark:bg-purple-500/10 blur-3xl" />

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

        <form onSubmit={submit} className="card p-6 space-y-4 shadow-popover">
          <div>
            <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">Create a new workspace</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">You'll become the admin of this workspace.</p>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-900 rounded-lg px-3 py-2">{error}</div>}

          <div>
            <label className="label">Workspace name</label>
            <input className="input" required value={form.workspace_name} onChange={(e) => setForm({ ...form, workspace_name: e.target.value })} placeholder="e.g. Acme Corp" />
          </div>
          <div>
            <label className="label">Your name</label>
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Building2 size={16} />}
            Create workspace
          </button>

          <div className="text-center text-sm">
            <Link to="/login" className="text-brand-600 hover:text-brand-700 font-medium">Back to sign in</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
