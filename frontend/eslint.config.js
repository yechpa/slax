import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts run outside the app (scripts/design-screenshots.mjs runs in the Playwright image;
    // `document` there is inside page.evaluate callbacks).
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', document: 'readonly' } },
  },
)
