import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import NeuralBackground from '../components/NeuralBackground.jsx';

// Lands here after the server-side OAuth round-trip with Google/Microsoft
// finishes (see server/src/routes/sso.js's callback handler) -- either a
// `token` this app already issued, or an `error` describing why sign-in
// didn't complete (wrong domain, cancelled, provider error). Never talks to
// the OAuth provider itself; that already happened entirely server-side.
export default function SsoCallback() {
  const { loginWithToken } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState(params.get('error') || '');

  useEffect(() => {
    const token = params.get('token');
    if (!token) return;
    loginWithToken(token)
      .then(() => navigate('/', { replace: true }))
      .catch((e) => setError(e.message || 'Sign-in failed.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden px-4">
      <NeuralBackground />
      <div className="relative card p-6 max-w-sm w-full text-center shadow-popover dark:shadow-popover-dark !rounded-2xl">
        {error ? (
          <>
            <AlertTriangle size={28} className="mx-auto text-red-500 mb-3" />
            <h1 className="text-base font-display font-semibold text-slate-800 dark:text-slate-100 mb-1">Sign-in didn't complete</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{error}</p>
            <Link to="/login" className="btn-primary w-full justify-center">Back to sign in</Link>
          </>
        ) : (
          <>
            <Loader2 size={28} className="mx-auto text-brand-500 animate-spin mb-3" />
            <p className="text-sm text-slate-500 dark:text-slate-400">Finishing sign-in…</p>
          </>
        )}
      </div>
    </div>
  );
}
