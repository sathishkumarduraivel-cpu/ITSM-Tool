import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  LogOut, Mail, Briefcase, Users2, Building2, Calendar, Hash, Loader2, Pencil, Globe, MapPin, Clock, Info, Check,
  UserCircle2, ChevronRight, LayoutDashboard, Ticket, Settings,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useTranslation } from '../i18n/I18nContext.jsx';
import { languageMeta } from '../i18n/languages.js';
import { api } from '../lib/api.js';
import { hasAnyPermission } from '../lib/permissions.js';
import Modal from './Modal.jsx';
import DarkModeToggle from './DarkModeToggle.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import Select from './Select.jsx';

const ROLE_LABEL = { admin: 'Administrator', agent: 'Agent', requester: 'Requester' };

const TIMEZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris / Berlin' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

function timezoneLabel(value) {
  return TIMEZONES.find((t) => t.value === value)?.label || value;
}

// The header's avatar trigger only ever holds what's in the auth context
// (which can be a session or two stale on fields like employee_id/manager --
// login/switch-workspace set it from the JWT payload, not a fresh row), so
// the view modal re-fetches /auth/me on every open to guarantee it's current.
function ProfileEditModal({ initial, onClose, onSaved }) {
  const { updateProfile } = useAuth();
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: initial.name || '',
    email: initial.email || '',
    location: initial.location || '',
    timezone: initial.timezone || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await updateProfile(form);
      onSaved(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit Profile" onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div>
          <label className="label">{t('common.name')}</label>
          <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label">{t('common.email')}</label>
          <input type="email" className="input" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="label flex items-center gap-1"><Clock size={12} /> {t('profile.timezone')}</label>
          <Select
            value={form.timezone} onChange={(v) => setForm({ ...form, timezone: v })}
            options={[{ value: '', label: t('common.notSet') }, ...TIMEZONES]}
          />
        </div>
        <div>
          <label className="label flex items-center gap-1"><MapPin size={12} /> {t('profile.location')}</label>
          <input className="input" placeholder="e.g. Bengaluru, India" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </div>
        <div>
          <label className="label flex items-center gap-1"><Globe size={12} /> {t('profile.language')}</label>
          <LanguageSwitcher className="w-full" />
          <p className="text-xs text-slate-400 mt-1">Applies immediately and follows your account to your next sign-in.</p>
        </div>

        <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
          <Info size={13} className="shrink-0 mt-0.5" />
          Role ({ROLE_LABEL[initial.role] || initial.role}) isn't editable here — an admin can change it under Admin Settings → Users.
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Quick-access dropdown items below "View full profile" -- resolved once
// per render from the current user/role rather than hardcoded, so a
// requester never sees an agent-only shortcut and vice versa (mirrors
// AppShell's own role/permission-filtered nav, just a 3-item subset of it
// for the things worth one click from anywhere in the app).
function quickLinksFor(user) {
  const isRequester = user.role === 'requester';
  const links = [{ to: '/', label: isRequester ? 'My Tickets' : 'Dashboard', icon: LayoutDashboard }];
  if (!isRequester) links.push({ to: '/tickets', label: 'All Tickets', icon: Ticket });
  if (user.role === 'admin' || hasAnyPermission(user)) links.push({ to: '/admin-settings', label: 'Admin Settings', icon: Settings });
  return links;
}

export default function UserMenu() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const refresh = () => {
    setLoading(true);
    return api.get('/auth/me').then(({ user: fresh }) => setProfile(fresh)).catch(() => setProfile(user)).finally(() => setLoading(false));
  };

  // The dropdown itself shows only name/email/role (already on the auth
  // context, no fetch needed to open instantly) -- the network round-trip
  // for the fuller record only happens once "View full profile" is reached,
  // not on every quick-menu open.
  useEffect(() => {
    if (!profileOpen) return;
    refresh();
  }, [profileOpen]);

  useEffect(() => {
    if (!menuOpen || !triggerRef.current) return undefined;
    const measure = () => {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + window.scrollY + 8, right: window.innerWidth - rect.right - window.scrollX });
    };
    measure();
    const onClick = (e) => {
      if (!triggerRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) setMenuOpen(false);
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  if (!user) return null;
  const quickLinks = quickLinksFor(user);
  const initial = user.name?.[0]?.toUpperCase() || '?';
  const shown = profile || user;

  const goTo = (to) => { setMenuOpen(false); navigate(to); };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setMenuOpen((o) => !o)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0 shadow-raised ring-2 ring-white/70 dark:ring-white/10 hover:ring-brand-400/70 dark:hover:ring-brand-400/50 hover:scale-105 active:scale-95 transition-all duration-200"
        style={{ backgroundColor: user.avatar_color || '#6366f1' }}
        title={user.name}
      >
        {initial}
        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white dark:ring-slate-900" />
      </button>

      {createPortal(
        <AnimatePresence>
          {menuOpen && pos && (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{ position: 'absolute', top: pos.top, right: pos.right, width: 280 }}
              className="z-[100] card shadow-popover dark:shadow-popover-dark p-1.5"
            >
              <div className="flex items-center gap-2.5 px-2.5 py-2.5">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white text-base font-semibold shrink-0"
                  style={{ backgroundColor: user.avatar_color || '#6366f1' }}
                >
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{user.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{user.email}</div>
                </div>
              </div>

              <button
                onClick={() => { setMenuOpen(false); setProfileOpen(true); }}
                className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <UserCircle2 size={15} className="text-slate-400 shrink-0" />
                <span className="flex-1 text-left">{t('profile.myProfile')}</span>
                <ChevronRight size={13} className="text-slate-300 dark:text-slate-600" />
              </button>

              <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />

              {quickLinks.map((l) => (
                <button
                  key={l.to}
                  onClick={() => goTo(l.to)}
                  className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <l.icon size={15} className="text-slate-400 shrink-0" /> {l.label}
                </button>
              ))}

              <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />

              <div className="flex items-center justify-between px-2.5 py-1.5">
                <span className="text-sm text-slate-600 dark:text-slate-300">Appearance</span>
                <DarkModeToggle />
              </div>
              <div className="flex items-center justify-between px-2.5 py-1.5 gap-2">
                <span className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1.5 shrink-0"><Globe size={13} className="text-slate-400" /> Language</span>
                <LanguageSwitcher size="xs" align="right" className="!min-w-0 w-28" />
              </div>

              <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />

              <button
                onClick={logout}
                className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                <LogOut size={15} className="shrink-0" /> {t('profile.logOut')}
              </button>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {profileOpen && (
        <Modal
          title={t('profile.myProfile')}
          onClose={() => setProfileOpen(false)}
          maxWidth="max-w-md"
          headerActions={
            <button
              onClick={() => { setProfileOpen(false); setEditOpen(true); }}
              className="btn-secondary text-xs !py-1"
            >
              <Pencil size={12} /> Edit
            </button>
          }
        >
          <div className="flex flex-col items-center text-center pb-4 border-b border-slate-100 dark:border-slate-800">
            <div className="relative">
              <div className="w-20 h-20 rounded-full p-1 bg-gradient-to-br from-brand-400 to-neon-500 shadow-glow-brand">
                <div
                  className="w-full h-full rounded-full flex items-center justify-center text-white text-2xl font-bold"
                  style={{ backgroundColor: user.avatar_color || '#6366f1' }}
                >
                  {initial}
                </div>
              </div>
              <span className="absolute bottom-0.5 right-0.5 w-4 h-4 rounded-full bg-emerald-400 ring-2 ring-white dark:ring-slate-900" title="Online" />
            </div>
            <div className="mt-3 text-lg font-semibold text-slate-800 dark:text-slate-100">{shown.name}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mt-0.5">
              <Mail size={13} /> {shown.email}
            </div>
            <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400 mt-2">
              {ROLE_LABEL[shown.role] || shown.role}
            </span>
          </div>

          {loading ? (
            <div className="py-8 text-center text-slate-400"><Loader2 size={18} className="animate-spin inline" /></div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm py-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1"><Building2 size={12} /> Workspace</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.workspace_name || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1"><Users2 size={12} /> Team</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.team || '—'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1"><Hash size={12} /> Employee ID</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.employee_id || 'Not set'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1"><Briefcase size={12} /> Manager</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.manager_name || 'Not set'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1"><Globe size={12} /> {t('profile.language')}</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.language ? languageMeta(shown.language).nativeName : t('common.notSet')}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1"><Clock size={12} /> {t('profile.timezone')}</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.timezone ? timezoneLabel(shown.timezone) : t('common.notSet')}</div>
              </div>
              <div className="col-span-2">
                <div className="text-xs text-slate-400 flex items-center gap-1"><MapPin size={12} /> {t('profile.location')}</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium truncate">{shown.location || t('common.notSet')}</div>
              </div>
              <div className="col-span-2">
                <div className="text-xs text-slate-400 flex items-center gap-1"><Calendar size={12} /> {t('profile.memberSince')}</div>
                <div className="text-slate-700 dark:text-slate-200 font-medium">
                  {shown.created_at ? new Date(shown.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-4">
            <button onClick={logout} className="btn-danger text-xs"><LogOut size={13} /> {t('profile.logOut')}</button>
          </div>
        </Modal>
      )}

      {editOpen && (
        <ProfileEditModal
          initial={shown}
          onClose={() => { setEditOpen(false); setProfileOpen(true); }}
          onSaved={() => { setEditOpen(false); setProfileOpen(true); refresh(); }}
        />
      )}
    </>
  );
}
