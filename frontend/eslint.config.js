import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'dist-design-system', 'dist-e2e', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts run outside the app (scripts/design-screenshots.mjs runs in the Playwright image;
    // `document` there is inside page.evaluate callbacks).
    files: ['scripts/**/*.mjs'],
    // Buffer runs in Node; DataTransfer, File and DragEvent inside page.evaluate callbacks.
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        DataTransfer: 'readonly',
        File: 'readonly',
        DragEvent: 'readonly',
      },
    },
  },
)
