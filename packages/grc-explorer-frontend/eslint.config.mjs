import nextConfig from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'coverage/**',
    ],
  },
  ...nextConfig,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'react/jsx-props-no-spreading': 'off',
      'react/require-default-props': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'import/prefer-default-export': 'off',
      'import/extensions': 'off',
      'no-case-declarations': 'off',
      'jsx-a11y/anchor-is-valid': 'off',
      'no-plusplus': 'off',
      'comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'always-multiline',
      }],
      'import/no-extraneous-dependencies': ['error', {
        devDependencies: [
          'test/**',
          '**/*.{test,spec}.{ts,tsx}',
          'vitest.config.{ts,js}',
          'eslint.config.{mjs,js}',
        ],
      }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'warn',
      // The React-Compiler-aware rules in eslint-plugin-react-hooks v7
      // (Next 16's default) are too strict for code that wasn't written
      // with React Compiler in mind. They flag idiomatic patterns —
      // Date.now() in render, ref reads during render, memoization
      // shapes the compiler can't analyse — that aren't actually broken.
      // Re-evaluate when we adopt React Compiler intentionally.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/use-memo': 'off',
    },
  },
];

export default config;
