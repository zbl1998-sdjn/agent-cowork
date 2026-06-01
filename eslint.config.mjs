import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const resourceBrowserGlobals = {
  AbortController: 'readonly',
  TextDecoder: 'readonly',
  btoa: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  requestAnimationFrame: 'readonly',
  setTimeout: 'readonly',
  window: 'readonly',
};

const typedSourceFiles = [
  'apps/host/*.ts',
  'apps/host/scripts/**/*.ts',
  'apps/host/src/**/*.ts',
  'apps/host/test/**/*.ts',
  'eval/**/*.ts',
  'scripts/**/*.ts',
  'apps/windows-client/resources-src/**/*.ts',
  'apps/windows-client/ui/src/**/*.{ts,tsx}',
  'apps/windows-client/ui/vite.config*.ts',
];

const typedStrictConfigs = [
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
].map((config) => ({
  ...config,
  files: typedSourceFiles,
}));

export default tseslint.config(
  {
    ignores: [
      '**/build/**',
      '**/dist/**',
      'node_modules/**',
      'apps/windows-client/ui-dist/**',
      'apps/windows-client/ui/node_modules/**',
      'apps/windows-client/resources/python-embedded/**',
      'apps/windows-client/src-tauri/target/**',
      'reports/**',
      'releases/**',
      '**/*.d.ts',
      '**/*.d.mts',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['apps/windows-client/resources/*.js'],
  },
  ...typedStrictConfigs,
  {
    files: ['apps/windows-client/resources/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: resourceBrowserGlobals,
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['apps/windows-client/resources-src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: resourceBrowserGlobals,
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: typedSourceFiles.filter((pattern) => pattern !== 'apps/windows-client/resources-src/**/*.ts'),
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.host-checkjs.json',
          './tsconfig.host-test.json',
          './tsconfig.eval.json',
          './tsconfig.scripts.json',
          './apps/windows-client/ui/tsconfig.json',
          './apps/windows-client/ui/tsconfig.node.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: [
      'apps/windows-client/ui/src/**/*.test.{ts,tsx}',
      'apps/windows-client/ui/src/**/__tests__/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
