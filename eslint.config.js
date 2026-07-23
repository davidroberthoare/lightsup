export default [
    {
        ignores: ['src/js/*.min.js', 'node_modules/**'],
    },
    {
        files: ['src/js/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // browser
                window: 'readonly',
                URL: 'readonly',
                document: 'readonly',
                localStorage: 'readonly',
                fetch: 'readonly',
                console: 'readonly',
                confirm: 'readonly',
                prompt: 'readonly',
                setTimeout: 'readonly',
                // vendored UMD libraries
                alasql: 'readonly',
                fabric: 'readonly',
                $: 'readonly',
                Tabulator: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            eqeqeq: 'warn',
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },
];
