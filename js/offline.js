// Offline page: retry button + reload when the browser reports the connection is back.
// (No automatic reload on load: "navigator.onLine" can be true while the server is unreachable.)
document.getElementById('retryBtn')?.addEventListener('click', () => location.reload());
window.addEventListener('online', () => location.reload());
