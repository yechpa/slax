/**
 * Public, per-deployment values the browser needs: the Turnstile site key and Reverb's app
 * key. Neither is a secret (both are sent to every visitor anyway).
 *
 * A deployed build is one image for every environment, so they cannot be compiled in: the
 * web server writes them into index.html at start, as `<meta name="slax:…" content="…">`
 * (docker/web/entrypoint.sh). The development server and the end-to-end build have no such
 * tags and keep using the Vite environment (VITE_TURNSTILE_SITE_KEY, VITE_REVERB_APP_KEY).
 */
export type PublicConfigName = 'turnstile-site-key' | 'reverb-app-key'

/** The value of `<meta name="slax:<name>">`, or undefined when the page has none (or an empty one). */
export function publicConfig(name: PublicConfigName): string | undefined {
  const value = document.head.querySelector<HTMLMetaElement>(`meta[name="slax:${name}"]`)?.content.trim()
  return value ? value : undefined
}
