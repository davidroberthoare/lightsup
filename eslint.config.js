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
                alert: 'readonly',
                setTimeout: 'readonly',
                Blob: 'readonly',
                navigator: 'readonly',
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
    {
        // The service worker itself: must live at src/sw.js (not src/js/) so
        // its default scope covers the whole app — see the note in sw.js.
        // Runs in the ServiceWorkerGlobalScope, not the DOM, hence its own
        // global set.
        files: ['src/sw.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                self: 'readonly',
                caches: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
                console: 'readonly',
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
