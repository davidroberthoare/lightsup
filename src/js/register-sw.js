// Not an ES module: registration needs to happen unconditionally on every
// page (index.html and report.html both load this the same way), and doing
// it as early, plain script keeps it independent of the app's own module
// graph — it should still register even if main.js/report-main.js were to
// fail to load.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.error('Service worker registration failed', err);
        });
    });
}
