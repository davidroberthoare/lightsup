// Small shared helpers with no dependencies.

const ID_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(length = 12) {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += ID_CHARACTERS.charAt(Math.floor(Math.random() * ID_CHARACTERS.length));
    }
    return result;
}

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
