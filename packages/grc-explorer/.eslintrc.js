module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'airbnb-base',
    'plugin:@typescript-eslint/recommended', // Uses the recommended rules from the @typescript-eslint/eslint-plugin
  ],
  rules: {
    'no-plusplus': 0,
    'class-methods-use-this': 0,
    'no-underscore-dangle': 0,
    'no-continue': 0,
    'no-param-reassign': 0,
    'no-bitwise': 0,
    'import/no-unresolved': 0,
    'import/prefer-default-export': 0,
    'import/extensions': 0,
    '@typescript-eslint/interface-name-prefix': 0,
    'func-names': 0,
    'no-console': 0,
    'no-await-in-loop': 0,
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': ['error'],
    'no-useless-constructor': 0,
    '@typescript-eslint/no-useless-constructor': ['error'],
    // Underscore-prefixed args/vars are an explicit "intentionally unused"
    // marker (Express error handlers, type-only generic stubs, etc.).
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
    }],
    // `void someAsyncFn()` is the idiomatic fire-and-forget marker; the
    // statement form is what we want, not the expression form.
    'no-void': ['error', { allowAsStatement: true }],
    // Singleton/private-constructor pattern keeps the empty body.
    'no-empty-function': 'off',
    '@typescript-eslint/no-empty-function': ['error', { allow: ['constructors', 'private-constructors'] }],
    // airbnb's no-restricted-syntax bans for-of/for-in to push readers
    // toward array iterators. In modern V8 + TS those are idiomatic and
    // the codebase uses them throughout (especially in indexer hot
    // paths where `await` inside the loop is the point). Keep the
    // genuinely-bad targets, drop the for-of ban.
    'no-restricted-syntax': ['error', 'WithStatement', 'LabeledStatement'],
    // TS hoists types + function declarations; the codebase reads
    // top-down with helpers underneath the main flow, which airbnb
    // flags by default. The TS-aware rule understands type-only refs
    // (`typedefs: false`) so `interface X { ref: Y }` plus `type Y =
    // ...` below works.
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': ['error', {
      functions: false, classes: false, variables: true, typedefs: false, enums: false, allowNamedExports: true,
    }],
    // 100 is tight for typed signatures + chain-of-method calls. 120
    // matches the family default and keeps PR diffs readable on
    // modern editors.
    'max-len': ['error', {
      code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true,
    }],
    // presenters/index.ts is a barrel of one-class-per-resource Yayson
    // presenters; co-locating them is the point of the file.
    'max-classes-per-file': 'off',
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
    },
    {
      files: '*.spec.js',
      rules: {
        'no-unused-expressions': 'off',
      },
    },
  ],
};
