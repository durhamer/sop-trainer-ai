/**
 * Minimal i18n helper.
 *
 * Adding a new locale:
 *   1. Create src/lib/i18n/en.ts (or ja.ts, etc.) with the same keys.
 *   2. Import it here and add it to `locales`.
 *   3. Change `DEFAULT_LOCALE` or wire up a locale-picker to `setLocale()`.
 */

import zhTW from "./zh-TW"

type Messages = typeof zhTW
type MessageKey = keyof Messages

const locales: Record<string, Messages> = {
  "zh-TW": zhTW,
}

let currentLocale: string = "zh-TW"

/** Switch locale at runtime (e.g. from a locale-picker component). */
export function setLocale(locale: string): void {
  if (locales[locale]) currentLocale = locale
}

/**
 * Translate a message key with optional parameter interpolation.
 *
 * @example
 *   t("sops.review.pendingBadge", { count: 3 })  // "3 項待確認"
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dict = locales[currentLocale] ?? zhTW
  let str: string = dict[key]
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{${k}}`, String(v))
    }
  }
  return str
}
