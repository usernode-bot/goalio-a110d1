// i18n utility — lightweight translation system
// Usage: t('key.path') or t('key.path', {param: value})

let currentLanguage = null;
let translations = {};
const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'it', 'de', 'nl', 'zh', 'hi', 'tr'];
const LANGUAGE_NAMES = {
  en: 'England',
  fr: 'Francia',
  es: 'España',
  it: 'Italia',
  de: 'Deutschland',
  nl: 'Nederland',
  zh: '中国',
  hi: 'भारत',
  tr: 'Türkiye'
};

async function loadTranslations(lang) {
  if (translations[lang]) return translations[lang];
  try {
    const response = await fetch(`/locales/${lang}.json`);
    if (!response.ok) throw new Error(`Failed to load ${lang}`);
    translations[lang] = await response.json();
    return translations[lang];
  } catch (e) {
    console.error('i18n load error:', e);
    return {};
  }
}

function t(key, params = {}) {
  if (!currentLanguage) return key;
  const strings = translations[currentLanguage] || {};
  let text = strings[key] || key;

  // Simple parameter substitution: {name} → params.name
  Object.keys(params).forEach(p => {
    text = text.replace(new RegExp(`\\{${p}\\}`, 'g'), params[p]);
  });

  return text;
}

function getLanguage() {
  // Check localStorage
  try {
    const saved = localStorage.getItem('goalio_language');
    if (saved && SUPPORTED_LANGUAGES.includes(saved)) return saved;
  } catch (_) {}

  // Check sessionStorage
  try {
    const saved = sessionStorage.getItem('goalio_language');
    if (saved && SUPPORTED_LANGUAGES.includes(saved)) return saved;
  } catch (_) {}

  // Detect browser language
  const browserLang = navigator.language.split('-')[0];
  if (SUPPORTED_LANGUAGES.includes(browserLang)) return browserLang;

  // Default to English
  return 'en';
}

async function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang)) return;

  currentLanguage = lang;
  await loadTranslations(lang);

  // Save to localStorage
  try { localStorage.setItem('goalio_language', lang); } catch (_) {}

  // Trigger re-render — call the route handler to redraw the current view
  window.route();
}

async function initI18n() {
  currentLanguage = getLanguage();
  await loadTranslations(currentLanguage);
}

window.t = t;
window.setLanguage = setLanguage;
window.getLanguage = getLanguage;
window.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;
window.LANGUAGE_NAMES = LANGUAGE_NAMES;
window.initI18n = initI18n;
