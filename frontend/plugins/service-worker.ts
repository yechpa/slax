/**
 * The service worker's build step (no PWA plugin: this is all it takes). After the app is
 * written, `/sw.js` is built from src/pwa/sw.ts as a classic script (IIFE: every browser can
 * register it, no module workers needed) with two constants baked in:
 *
 * - `__SLAX_PRECACHE__`: what the page loads (index.html, the bundle, fonts, favicon,
 *   manifest), listed from the output directory itself;
 * - `__SLAX_VERSION__`: a hash of those files' contents. Any change to them changes sw.js, so
 *   browsers see a new service worker (and the app offers to reload, see register.ts); an
 *   identical build gives an identical sw.js.
 *
 * Only the production and end-to-end builds get one (not the design-system screenshots).
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { build, type Plugin, type ResolvedConfig } from 'vite'

/** Never precached: the worker itself, source maps, Vite's metadata, other pages, licences, install icons. */
const SKIP = [/^sw\.js$/, /\.map$/, /^\.vite\//, /^icons\//, /\.txt$/, /^(?!index\.html$).*\.html$/]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

export function precacheManifest(outDir: string): { files: string[]; version: string } {
  const entries = walk(outDir)
    .map((path) => ({ path, name: relative(outDir, path).split(sep).join('/') }))
    .filter(({ name }) => !SKIP.some((pattern) => pattern.test(name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const hash = createHash('sha256')
  for (const { path, name } of entries) {
    hash.update(name).update('\0').update(createHash('sha256').update(readFileSync(path)).digest('hex')).update('\0')
  }
  return { files: entries.map(({ name }) => `/${name}`), version: hash.digest('hex').slice(0, 16) }
}

export function serviceWorker(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'slax:service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    async writeBundle() {
      if (config.mode !== 'production' && config.mode !== 'e2e') return
      const outDir = resolve(config.root, config.build.outDir)
      const { files, version } = precacheManifest(outDir)
      await build({
        configFile: false,
        root: config.root,
        mode: config.mode,
        logLevel: 'warn',
        publicDir: false,
        define: {
          __SLAX_PRECACHE__: JSON.stringify(files),
          __SLAX_VERSION__: JSON.stringify(version),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          minify: true,
          lib: { entry: resolve(config.root, 'src/pwa/sw.ts'), formats: ['iife'], name: 'slaxServiceWorker', fileName: () => 'sw.js' },
        },
      })
    },
  }
}
