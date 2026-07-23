import { test } from 'node:test';
import assert from 'node:assert/strict';

import { randomId, escapeHtml } from '../src/js/util.js';

test('randomId returns ids of the requested length and charset', () => {
    assert.equal(randomId().length, 12);
    assert.equal(randomId(6).length, 6);
    assert.match(randomId(50), /^[A-Za-z0-9]{50}$/);
});

test('escapeHtml neutralizes markup', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml(`"quotes" & 'apostrophes'`), '&quot;quotes&quot; &amp; &#39;apostrophes&#39;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
});
