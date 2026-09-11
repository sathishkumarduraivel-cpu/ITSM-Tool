// Single source of truth for which languages this app actually ships
// translations for -- deliberately a short, fully-translated list rather
// than a long one where most entries silently fall back to English. Each
// entry's `dir` drives document direction (see I18nContext) for genuine
// RTL support, not just a translated label set.
export const LANGUAGES = [
  { code: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish', dir: 'ltr' },
  { code: 'fr', nativeName: 'Français', englishName: 'French', dir: 'ltr' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German', dir: 'ltr' },
  { code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi', dir: 'ltr' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese', dir: 'ltr' },
  { code: 'ar', nativeName: 'العربية', englishName: 'Arabic', dir: 'rtl' },
];

export function languageMeta(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}
