// Data layer: the AlaSQL in-memory tables are the single source of truth for
// all show and item state. The render layer and UI never hold authoritative
// state of their own — they mirror what these functions return.
//
// Persistence is a single versioned JSON document in localStorage
// (STORAGE_KEY). Legacy saves (separate 'shows'/'items' keys from the
// single-show era) are migrated on load.

import { randomId } from './util.js';

const alasql = globalThis.alasql;

export const DATA_VERSION = 2;
export const STORAGE_KEY = 'lightsup:data';
const CURRENT_SHOW_KEY = 'current_show_id';

export const DEFAULT_SHOW = Object.freeze({
    id: 'default',
    name: 'My Show',
    company: 'A Great Company',
    venue: 'Grand Theatre',
    designer: 'D. Signer',
    date: 'Jan 1, 2030',
});

// Only these columns may be set through the generic field-update helpers;
// anything else is a programming error, not data.
const ITEM_FIELDS = new Set(['x', 'y', 'angle', 'scalex', 'scaley', 'position', 'number', 'label', 'channel', 'dimmer', 'gel']);
const SHOW_FIELDS = new Set(['name', 'company', 'venue', 'designer', 'date']);

const ITEM_COLUMNS = ['id', 'show_id', 'type', 'shape', 'x', 'y', 'angle', 'scalex', 'scaley', 'position', 'number', 'label', 'channel', 'dimmer', 'gel'];
const ITEM_DEFAULTS = {
    show_id: '', type: '', shape: '', x: 0, y: 0, angle: 0, scalex: 1, scaley: 1,
    position: '', number: null, label: '', channel: '', dimmer: '', gel: '',
};

// ---------------------------------------------------------------------------
// Dirty tracking (drives the unsaved-changes warning)

let dirty = false;

export function isDirty() {
    return dirty;
}

export function markClean() {
    dirty = false;
}

function markDirty() {
    dirty = true;
}

// ---------------------------------------------------------------------------
// Schema

export function initDB(wipe) {
    if (wipe === true) {
        alasql('DROP TABLE IF EXISTS shows');
        alasql('DROP TABLE IF EXISTS items');
    }
    alasql(`CREATE TABLE IF NOT EXISTS shows (
        id STRING PRIMARY KEY,
        name STRING,
        company STRING,
        venue STRING,
        designer STRING,
        date STRING
        )`);
    alasql(`CREATE TABLE IF NOT EXISTS items (
        id STRING PRIMARY KEY,
        show_id STRING,
        type STRING,
        shape STRING,
        x INT,
        y INT,
        angle INT,
        scalex FLOAT,
        scaley FLOAT,
        position STRING,
        number INT,
        label STRING,
        channel STRING,
        dimmer STRING,
        gel STRING
        )`);
}

// ---------------------------------------------------------------------------
// Persistence

function defaultStorage() {
    return globalThis.localStorage;
}

function parseJSON(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (error) {
        console.error('Could not parse saved data', error);
        return null;
    }
}

// Reads whatever save data exists in storage and normalizes it into a
// current-version document: { version, shows: [], items: [] }.
function readDocument(storage) {
    const doc = parseJSON(storage.getItem(STORAGE_KEY));
    if (doc) {
        doc.shows = Array.isArray(doc.shows) ? doc.shows : [];
        doc.items = Array.isArray(doc.items) ? doc.items : [];
        // Forward-compat hook: per-version upgrades go here as the schema evolves.
        doc.items.forEach((item) => {
            if (item.show_id === undefined) item.show_id = DEFAULT_SHOW.id;
        });
        doc.version = DATA_VERSION;
        return doc;
    }
    return migrateLegacy(storage);
}

// v1 saves used separate 'shows' and 'items' keys and had no show_id on items.
function migrateLegacy(storage) {
    const shows = parseJSON(storage.getItem('shows')) || [];
    const items = parseJSON(storage.getItem('items')) || [];
    let showId = storage.getItem(CURRENT_SHOW_KEY);
    if (!showId || !shows.some((s) => s.id === showId)) {
        showId = shows.length > 0 ? shows[0].id : DEFAULT_SHOW.id;
    }
    if (!shows.some((s) => s.id === showId)) {
        shows.push({ ...DEFAULT_SHOW, id: showId });
    }
    items.forEach((item) => {
        if (item.show_id === undefined) item.show_id = showId;
    });
    return { version: DATA_VERSION, shows, items };
}

// Replaces all in-memory state with the saved data. Returns the id of the
// current show (guaranteed to exist after this call).
export function loadData(storage = defaultStorage()) {
    initDB(true);
    const doc = readDocument(storage);
    doc.shows.forEach((show) => alasql('INSERT INTO shows VALUES ?', [show]));
    doc.items.forEach((item) => alasql('INSERT INTO items VALUES ?', [item]));

    if (getShows().length === 0) {
        alasql('INSERT INTO shows VALUES ?', [{ ...DEFAULT_SHOW }]);
    }

    let current = storage.getItem(CURRENT_SHOW_KEY);
    if (!current || !getShow(current)) {
        current = getShows()[0].id;
        storage.setItem(CURRENT_SHOW_KEY, current);
    }

    markClean();
    return current;
}

export function saveData(storage = defaultStorage()) {
    const doc = {
        version: DATA_VERSION,
        shows: alasql('SELECT * FROM shows'),
        items: alasql('SELECT * FROM items'),
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(doc));
    markClean();
}

export function getCurrentShowId(storage = defaultStorage()) {
    return storage.getItem(CURRENT_SHOW_KEY) || DEFAULT_SHOW.id;
}

export function setCurrentShowId(id, storage = defaultStorage()) {
    storage.setItem(CURRENT_SHOW_KEY, id);
}

// ---------------------------------------------------------------------------
// Shows

export function getShows() {
    return alasql('SELECT * FROM shows ORDER BY name');
}

export function getShow(id) {
    return alasql('SELECT * FROM shows WHERE id = ?', [id])[0];
}

export function createShow(fields = {}) {
    const show = { ...DEFAULT_SHOW, ...fields, id: fields.id || randomId() };
    alasql('INSERT INTO shows VALUES ?', [show]);
    markDirty();
    return show;
}

export function updateShowField(id, name, value) {
    if (!SHOW_FIELDS.has(name)) {
        throw new Error(`Not an editable show field: ${name}`);
    }
    alasql(`UPDATE shows SET ${name} = ? WHERE id = ?`, [value, id]);
    markDirty();
}

// ---------------------------------------------------------------------------
// Items

export function getItems(showId) {
    return alasql('SELECT * FROM items WHERE show_id = ?', [showId]);
}

export function getItem(id) {
    return alasql('SELECT * FROM items WHERE id = ?', [id])[0];
}

export function getItemsByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return alasql(`SELECT * FROM items WHERE id IN (${placeholders})`, ids);
}

export function createItem(fields) {
    const item = { id: randomId() };
    for (const col of ITEM_COLUMNS) {
        if (col === 'id') continue;
        item[col] = fields[col] !== undefined ? fields[col] : ITEM_DEFAULTS[col];
    }
    alasql('INSERT INTO items VALUES ?', [item]);
    markDirty();
    return item;
}

export function updateItemLocation(id, x, y, scalex, scaley, angle) {
    alasql('UPDATE items SET x = ?, y = ?, scalex = ?, scaley = ?, angle = ? WHERE id = ?', [x, y, scalex, scaley, angle, id]);
    markDirty();
}

export function updateItemField(id, name, value) {
    if (!ITEM_FIELDS.has(name)) {
        throw new Error(`Not an editable item field: ${name}`);
    }
    alasql(`UPDATE items SET ${name} = ? WHERE id = ?`, [value, id]);
    markDirty();
}

// Deletes an item and cleans up position relationships. Returns a list of
// {id, number} changes the render layer should apply to other items.
export function deleteItem(id) {
    const item = getItem(id);
    if (!item) return [];
    alasql('DELETE FROM items WHERE id = ?', [id]);
    markDirty();

    const changes = [];
    if (item.type === 'position') {
        // Fixtures hanging on a deleted position become unassigned.
        const orphans = alasql('SELECT id FROM items WHERE position = ?', [id]);
        alasql('UPDATE items SET position = ?, number = ? WHERE position = ?', ['', null, id]);
        orphans.forEach((o) => changes.push({ id: o.id, number: null }));
    } else if (item.type === 'fixture' && item.position) {
        changes.push(...renumberPosition(item.position));
    }
    return changes;
}

// Unit numbering runs stage-right to stage-left: highest x gets unit 1.
// Returns the {id, number} assignments so the render layer can update labels.
export function renumberPosition(positionId) {
    const fixtures = alasql('SELECT id FROM items WHERE position = ? ORDER BY x DESC, y DESC', [positionId]);
    const changes = fixtures.map((f, i) => ({ id: f.id, number: i + 1 }));
    changes.forEach((c) => alasql('UPDATE items SET number = ? WHERE id = ?', [c.number, c.id]));
    if (changes.length > 0) markDirty();
    return changes;
}

// Sets (or clears, when positionId is falsy) a fixture's position and
// renumbers every position affected by the move.
export function assignFixtureToPosition(fixtureId, positionId) {
    const item = getItem(fixtureId);
    if (!item) return [];
    const prev = item.position || null;
    const next = positionId || null;

    alasql('UPDATE items SET position = ? WHERE id = ?', [next || '', fixtureId]);
    markDirty();

    const changes = [];
    if (next) {
        changes.push(...renumberPosition(next));
    } else {
        alasql('UPDATE items SET number = ? WHERE id = ?', [null, fixtureId]);
        changes.push({ id: fixtureId, number: null });
    }
    if (prev && prev !== next) {
        changes.push(...renumberPosition(prev));
    }
    return changes;
}

// ---------------------------------------------------------------------------
// Reporting queries

export function getInstrumentSchedule(showId) {
    return alasql(`SELECT
            i.*,
            (SELECT p.label FROM items AS p WHERE p.id = i.position AND p.type = 'position') AS p_label
        FROM items AS i
        WHERE i.type = 'fixture' AND i.show_id = ?
        ORDER BY p_label, i.number`, [showId]);
}
