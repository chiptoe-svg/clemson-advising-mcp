/**
 * HTML-escape for text interpolated into the portal's pages.
 *
 * Escapes the single quote as well as the double, because attribute values
 * here are written with double quotes today and a later edit to single quotes
 * would silently turn an escaped-looking value back into an injection point.
 * (The same omission was found and fixed in the retired CUassistant portal,
 * commit cdda77c — worth not repeating.)
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
