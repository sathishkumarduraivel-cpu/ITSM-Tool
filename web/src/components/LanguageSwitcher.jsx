import { Globe } from 'lucide-react';
import { useTranslation } from '../i18n/I18nContext.jsx';
import { LANGUAGES } from '../i18n/languages.js';
import Select from './Select.jsx';

// Shown both pre-login (Login.jsx -- a visitor shouldn't have to sign in
// just to read the screen in their own language) and post-login (UserMenu),
// backed by the same I18nContext either way. Options show each language's
// own native name, not its English name/flag emoji -- a Japanese speaker
// scans for "日本語", not for "Japan" or a flag that says nothing about the
// language itself.
export default function LanguageSwitcher({ size = 'sm', className = '', align = 'left' }) {
  const { code, setLanguage } = useTranslation();
  return (
    <Select
      size={size}
      align={align}
      className={`min-w-[130px] ${className}`}
      value={code}
      onChange={setLanguage}
      options={LANGUAGES.map((l) => ({ value: l.code, label: l.nativeName, icon: Globe }))}
    />
  );
}
