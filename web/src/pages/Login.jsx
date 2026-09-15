import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Sparkles, Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext.jsx';
import NeuralBackground from '../components/NeuralBackground.jsx';
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';
import { useTranslation } from '../i18n/I18nContext.jsx';
import { api } from '../lib/api.js';

// Tiny inline brand marks -- a login button reads as fake the moment its
// provider icon is a generic shape instead of the real logo, and pulling in
// an icon library just for two logos isn't worth the dependency.
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.5 6 29.5 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.6 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.5 7 29.5 5 24 5c-7.8 0-14.5 4.4-17.7 10.7z" transform="translate(0 -1)"/>
      <path fill="#4CAF50" d="M24 44c5.4 0 10.3-1.8 14.1-5.2l-6.5-5.5C29.5 35 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.6 5.1C9.4 39.5 16.1 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4 5.6l6.5 5.5C39.8 37 44 31.5 44 24c0-1.3-.1-2.7-.4-3.5z"/>
    </svg>
  );
}
function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#f35325" d="M1 1h10v10H1z" />
      <path fill="#81bc06" d="M12 1h10v10H12z" />
      <path fill="#05a6f0" d="M1 12h10v10H1z" />
      <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
  );
}
const PROVIDER_MARK = { google: GoogleMark, microsoft: MicrosoftMark };

const container = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } } };
const field = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 26 } } };

export default function Login() {
  const { login, verifyMfa } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('admin@itsm.ai');
  const [password, setPassword] = useState('Admin@123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoProviders, setSsoProviders] = useState([]);
  // Set only when the account has MFA enrolled -- the password step above
  // already succeeded (see AuthContext.login's mfaRequired branch), so this
  // being non-null is what switches the form below into the code-entry step
  // instead of a separate page/route (keeps the "one wrong step" back-arrow
  // trivial, and there's never a URL a bookmark could land on mid-login).
  const [challenge, setChallenge] = useState(null);
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    api.get('/auth/sso/providers').then((d) => setSsoProviders(d.providers)).catch(() => setSsoProviders([]));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result?.mfaRequired) {
        setChallenge(result.challenge);
      } else {
        navigate(location.state?.from || '/', { replace: true });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const submitMfa = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyMfa(challenge, mfaCode);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const backToPassword = () => {
    setChallenge(null);
    setMfaCode('');
    setError('');
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-32 -left-24 w-[28rem] h-[28rem] rounded-full bg-brand-400/25 dark:bg-brand-500/15 blur-3xl animate-floaty" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-purple-400/20 dark:bg-purple-500/15 blur-3xl animate-floaty" style={{ animationDelay: '-3s' }} />
      {/* Live particle network sits above the soft color blooms — two
          different visual frequencies (large soft blur vs. fine animated
          mesh) layer instead of competing, using the same neon/brand tokens
          as the rest of the app rather than a new color. */}
      <NeuralBackground />

      <div className="absolute top-4 right-4 z-10">
        <LanguageSwitcher align="right" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}
        className="relative w-full max-w-sm"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.05 }}
          className="flex items-center justify-center gap-2.5 mb-8"
        >
          <div className="relative w-11 h-11 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-glow-brand flex items-center justify-center text-white font-display font-bold">
            IT
            <span className="absolute inset-0 rounded-2xl border border-white/30 animate-pulse" />
          </div>
          <div className="text-left">
            <div className="font-display font-bold text-slate-800 dark:text-slate-100 leading-tight">ITSM AI</div>
            <div className="text-xs text-slate-400">AI-native service desk</div>
          </div>
        </motion.div>

        <motion.form
          onSubmit={challenge ? submitMfa : submit}
          variants={container}
          initial="hidden"
          animate="show"
          className="command-glow rounded-2xl"
        >
          <div className="card p-6 space-y-4 shadow-popover dark:shadow-popover-dark !rounded-2xl">
            {challenge ? (
              <>
                <motion.div variants={field} className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center shrink-0">
                    <ShieldCheck size={17} className="text-brand-600 dark:text-brand-400" />
                  </div>
                  <div>
                    <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">Enter your code</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400">From your authenticator app, or a recovery code</p>
                  </div>
                </motion.div>

                {error && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-900 rounded-lg px-3 py-2">
                    {error}
                  </motion.div>
                )}

                <motion.div variants={field}>
                  <input
                    className="input text-center tracking-[0.3em] font-mono text-lg" placeholder="000000" autoFocus
                    value={mfaCode} onChange={(e) => setMfaCode(e.target.value.trim())} required
                  />
                </motion.div>

                <motion.button
                  variants={field}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  type="submit"
                  disabled={loading || !mfaCode}
                  className="btn-primary w-full justify-center"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                  Verify
                </motion.button>

                <motion.button
                  variants={field}
                  type="button"
                  onClick={backToPassword}
                  className="w-full flex items-center justify-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <ArrowLeft size={13} /> Back
                </motion.button>
              </>
            ) : (
              <>
                <motion.div variants={field}>
                  <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">{t('auth.signIn')}</h1>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t('auth.signInDesc')}</p>
                </motion.div>

                {error && (
                  <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-900 rounded-lg px-3 py-2">
                    {error}
                  </motion.div>
                )}

                {ssoProviders.length > 0 && (
                  <motion.div variants={field} className="space-y-2">
                    {ssoProviders.map((p) => {
                      const Mark = PROVIDER_MARK[p.provider];
                      return (
                        <a key={p.id} href={`/api/auth/sso/${p.id}/start`} className="btn-secondary w-full justify-center gap-2.5">
                          {Mark && <Mark />} {t('auth.continueWith', { provider: p.label })}
                        </a>
                      );
                    })}
                    <div className="flex items-center gap-3 pt-1">
                      <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                      <span className="text-xs text-slate-400">{t('auth.orSignInWithEmail')}</span>
                      <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                    </div>
                  </motion.div>
                )}

                <motion.div variants={field}>
                  <label className="label">{t('auth.email')}</label>
                  <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </motion.div>
                <motion.div variants={field}>
                  <label className="label">{t('auth.password')}</label>
                  <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </motion.div>

                <motion.button
                  variants={field}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.98 }}
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full justify-center"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  {t('auth.signIn')}
                </motion.button>

                <motion.div variants={field} className="text-center text-sm">
                  <Link to="/register" className="text-brand-600 hover:text-brand-700 font-medium">{t('auth.createAccount')}</Link>
                </motion.div>
              </>
            )}
          </div>
        </motion.form>

        <p className="text-center text-xs text-slate-400 mt-5">
          <Link to="/privacy" className="hover:text-slate-600 dark:hover:text-slate-300">Privacy Policy</Link>
        </p>
      </motion.div>
    </div>
  );
}
