import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UserPlus, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAuth } from '../context/AuthContext.jsx';
import NeuralBackground from '../components/NeuralBackground.jsx';

const container = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } } };
const field = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 300, damping: 26 } } };

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
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
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden px-4">
      <div className="pointer-events-none absolute -top-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-brand-400/25 dark:bg-brand-500/15 blur-3xl animate-floaty" />
      <div className="pointer-events-none absolute -bottom-32 -left-24 w-[28rem] h-[28rem] rounded-full bg-purple-400/20 dark:bg-purple-500/15 blur-3xl animate-floaty" style={{ animationDelay: '-3s' }} />
      <NeuralBackground />

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
          onSubmit={submit}
          variants={container}
          initial="hidden"
          animate="show"
          className="command-glow rounded-2xl"
        >
          <div className="card p-6 space-y-4 shadow-popover dark:shadow-popover-dark !rounded-2xl">
            <motion.div variants={field}>
              <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">Create an account</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">You'll be added to the default workspace as a requester — an admin can move you to a different workspace or change your role later.</p>
            </motion.div>

            {error && (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-900 rounded-lg px-3 py-2">
                {error}
              </motion.div>
            )}

            <motion.div variants={field}>
              <label className="label">Your name</label>
              <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </motion.div>
            <motion.div variants={field}>
              <label className="label">Email</label>
              <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </motion.div>
            <motion.div variants={field}>
              <label className="label">Password</label>
              <input className="input" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </motion.div>

            <motion.button
              variants={field}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.98 }}
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
              Create account
            </motion.button>

            <motion.div variants={field} className="text-center text-sm">
              <Link to="/login" className="text-brand-600 hover:text-brand-700 font-medium">Back to sign in</Link>
            </motion.div>
          </div>
        </motion.form>
      </motion.div>
    </div>
  );
}
