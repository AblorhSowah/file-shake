import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const bannedProps = ['innerHTML', 'outerHTML', 'insertAdjacentHTML'].map((property) => ({
  property,
  message: `${property} is banned in the webview: build DOM nodes with textContent / setAttribute.`,
}));

export default tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', '*.vsix'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/webview/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-properties': [
        'error',
        ...bannedProps,
        {
          object: 'document',
          property: 'write',
          message: 'document.write is banned in the webview.',
        },
      ],
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'vscode', message: 'The webview bundle must not import vscode.' }] },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'vscode',
            'fs',
            'path',
            'os',
            'child_process',
          ].map((name) => ({ name, message: 'src/core must stay pure (no vscode / node imports).' })),
          patterns: [
            { group: ['node:*'], message: 'src/core must stay pure (no node: imports).' },
          ],
        },
      ],
    },
  },
);
