/** Locale selection must come from explicitly supplied values, never the host environment. */
export function normalizeLocale(value){if(value==null)return null;const raw=String(value).trim();return raw?raw.split(':')[0].split('@')[0].split('.')[0].replaceAll('_','-').toLowerCase():null}
export function resolveInteractionLocale(locale=null,{configuredLocale=null,previousLocale=null}={}){return normalizeLocale(locale)||normalizeLocale(configuredLocale)||normalizeLocale(previousLocale)||'en'}
export function resolveInteractionLanguage(locale=null){return resolveInteractionLocale(locale).split('-')[0]}
export function resolvePromptLanguage(locale=null){return resolveInteractionLanguage(locale)==='zh'?'zh':'en'}
