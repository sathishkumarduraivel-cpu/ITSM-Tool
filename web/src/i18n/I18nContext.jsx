import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { LANGUAGES, languageMeta } from './languages.js';

const I18nContext = createContext(null);
const STORAGE_KEY = 'itsm_lang';
const SUPPORTED = new Set(LANGUAGES.map((l) => l.code));

// Each locale is its own dynamically-imported chunk (see loadBundle) --
// switching languages costs one small network fetch, not extra weight in
// every visitor's initial bundle for languages they'll never use.
const loaders = {
  en: () => import('./locales/en.json'),
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  hi: () => import('./locales/hi.json'),
  ja: () => import('./locales/ja.json'),
  ar: () => import('./locales/ar.json'),
};

function detectInitialLanguage(userLanguage) {
  if (userLanguage && SUPPORTED.has(userLanguage)) return userLanguage;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.has(stored)) return stored;
  } catch { /* localStorage unavailable -- fall through */ }
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED.has(browser) ? browser : 'en';
}

function resolvePath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{{${k}}}`));
}

// `userLanguage` is the signed-in user's saved preference (users.language,
// see server/src/routes/auth.js) -- passed in rather than read from context
// here so this provider has no dependency on AuthContext's own load order.
export function I18nProvider({ userLanguage, onPersist, children }) {
  const [code, setCode] = useState(() => detectInitialLanguage(userLanguage));
  const [bundle, setBundle] = useState(null);
  const [enBundle, setEnBundle] = useState(null); // fallback for keys a non-English bundle hasn't got yet

  // Adopt the account's saved language once it's known (e.g. right after
  // login, when this provider mounted before that value existed) -- but
  // never fight a choice the user just made this session.
  useEffect(() => {
    if (userLanguage && SUPPORTED.has(userLanguage) && userLanguage !== code) setCode(userLanguage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLanguage]);

  useEffect(() => {
    let cancelled = false;
    loaders[code]().then((mod) => { if (!cancelled) setBundle(mod.default); });
    return () => { cancelled = true; };
  }, [code]);

  useEffect(() => {
    if (code === 'en') { setEnBundle(null); return; }
    let cancelled = false;
    loaders.en().then((mod) => { if (!cancelled) setEnBundle(mod.default); });
    return () => { cancelled = true; };
  }, [code]);

  useEffect(() => {
    const meta = languageMeta(code);
    document.documentElement.lang = code;
    document.documentElement.dir = meta.dir;
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  }, [code]);

  const setLanguage = (next) => {
    if (!SUPPORTED.has(next)) return;
    setCode(next);
    onPersist?.(next); // best-effort sync to the account so it follows them to their next session/device
  };

  const t = useMemo(() => {
    return (key, vars) => {
      const fromActive = bundle ? resolvePath(bundle, key) : undefined;
      const fromEnglish = enBundle ? resolvePath(enBundle, key) : undefined;
      const value = fromActive ?? fromEnglish;
      if (value === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key "${key}" for locale "${code}"`);
        return key;
      }
      return typeof value === 'string' ? interpolate(value, vars) : value;
    };
  }, [bundle, enBundle, code]);

  const meta = languageMeta(code);
  const value = { code, dir: meta.dir, meta, setLanguage, t, ready: !!bundle };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useTranslation must be used within I18nProvider');
  return ctx;
}
