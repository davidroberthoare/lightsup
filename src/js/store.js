// Data layer: the AlaSQL in-memory tables are the single source of truth for
// all show and item state. The render layer and UI never hold authoritative
// state of their own — they mirror what these functions return.
//
// Persistence is a single versioned JSON document in localStorage
// (STORAGE_KEY). Legacy saves (separate 'shows'/'items' keys from the
// single-show era) are migrated on load.

import { randomId } from './util.js';

const alasql = globalThis.alasql;

export const DATA_VERSION = 6;
export const STORAGE_KEY = 'lightsup:data';
const CURRENT_SHOW_KEY = 'current_show_id';

// A per-show export is a different, smaller document than the full
// multi-show STORAGE_KEY document, so it's versioned independently and
// tagged with `kind` — that also lets importShow() reject a file that's
// actually a full backup (or an unrelated JSON file) with a clear error
// instead of silently importing garbage.
export const SHOW_EXPORT_KIND = 'lightsup-show';
export const SHOW_EXPORT_VERSION = 1;

export const DEFAULT_SHOW = Object.freeze({
    id: 'default',
    name: 'My Show',
    company: 'A Great Company',
    venue: 'Grand Theatre',
    designer: 'D. Signer',
    date: 'Jan 1, 2030',
    updated_at: null,
});

// Only these columns may be set through the generic field-update helpers;
// anything else is a programming error, not data.
const ITEM_FIELDS = new Set(['x', 'y', 'angle', 'scalex', 'scaley', 'width', 'position', 'number', 'label', 'channel', 'dimmer', 'gel', 'locked']);
const SHOW_FIELDS = new Set(['name', 'company', 'venue', 'designer', 'date']);

const ITEM_COLUMNS = ['id', 'show_id', 'type', 'shape', 'x', 'y', 'angle', 'scalex', 'scaley', 'width', 'position', 'number', 'label', 'channel', 'dimmer', 'gel', 'locked', 'zindex'];
const ITEM_DEFAULTS = {
    show_id: '', type: '', shape: '', x: 0, y: 0, angle: 0, scalex: 1, scaley: 1, width: null,
    position: '', number: null, label: '', channel: '', dimmer: '', gel: '', locked: false, zindex: 0,
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
        date STRING,
        updated_at STRING
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
        width FLOAT,
        position STRING,
        number INT,
        label STRING,
        channel STRING,
        dimmer STRING,
        gel STRING,
        locked BOOLEAN,
        zindex INT
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

// Reads whatever save data exists in storage, in whatever legacy shape it's
// in, and returns a plain { shows: [], items: [] } document.
function readDocument(storage) {
    const doc = parseJSON(storage.getItem(STORAGE_KEY));
    if (doc) {
        doc.shows = Array.isArray(doc.shows) ? doc.shows : [];
        doc.items = Array.isArray(doc.items) ? doc.items : [];
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
    return { shows, items };
}

// Backfills item columns added in later schema versions. Shared by the
// full-document load path and importShow(), so an old export file (or one
// missing fields for any other reason) still loads with sane defaults
// instead of storing `undefined`.
function normalizeItemFields(item) {
    if (item.width === undefined) item.width = null;
    if (item.locked === undefined) item.locked = false;
    return item;
}

// Backfills columns added in later schema versions. Runs on every load
// regardless of source, so it's the single place per-version upgrades go.
function normalizeDoc(doc) {
    doc.items.forEach((item, index) => {
        if (item.show_id === undefined) item.show_id = DEFAULT_SHOW.id;
        // Pre-zindex saves have no stacking order recorded; falling back to
        // each item's position in the saved array preserves whatever order
        // it already rendered in rather than tying everything at 0.
        if (item.zindex === undefined) item.zindex = index;
        normalizeItemFields(item);
    });
    doc.shows.forEach((show) => {
        if (show.updated_at === undefined) show.updated_at = null;
    });
    return doc;
}

// Replaces all in-memory state with the saved data. Returns the id of the
// current show (guaranteed to exist after this call).
export function loadData(storage = defaultStorage()) {
    initDB(true);
    const doc = normalizeDoc(readDocument(storage));
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
    resetHistory();
    return current;
}

// Saving stamps the *current* show's updated_at — the show whose plot was
// actually being edited in this session — even though every show's data is
// serialized into the one localStorage document each time.
export function saveData(storage = defaultStorage()) {
    const currentId = getCurrentShowId(storage);
    if (getShow(currentId)) {
        alasql('UPDATE shows SET updated_at = ? WHERE id = ?', [new Date().toISOString(), currentId]);
    }
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
// Undo / redo
//
// The store snapshots its own tables rather than the canvas: the DB is the
// source of truth (see the module comment at the top of this file), so an
// undo step is "restore a prior copy of shows+items", and the render layer
// just does a full redraw afterwards. This also means one snapshot captures
// cascading effects (position renumbering, orphaned fixtures, etc.) for free
// instead of needing to be replayed as a sequence of inverse operations.
//
// Snapshots are whole-table copies, not diffs. That's wasteful for huge
// datasets, but a lighting plot is at most a few hundred rows, so it's cheap
// and it sidesteps an entire class of "the diff didn't capture X" bugs.
//
// Checkpointing is caller-driven (checkpoint() is exported, not automatic)
// because one user gesture often produces several store calls — dragging a
// position drags its child fixtures with it, for instance — and those must
// collapse into a single undo step. Callers checkpoint once per gesture.

const MAX_HISTORY = 50;
let undoStack = [];
let redoStack = [];
let suspendHistory = false; // true while undo()/redo() is restoring a snapshot

function snapshotState() {
    return {
        shows: alasql('SELECT * FROM shows'),
        items: alasql('SELECT * FROM items'),
    };
}

function restoreState(state) {
    alasql('DELETE FROM shows');
    alasql('DELETE FROM items');
    state.shows.forEach((show) => alasql('INSERT INTO shows VALUES ?', [show]));
    state.items.forEach((item) => alasql('INSERT INTO items VALUES ?', [item]));
}

// Records the current state as an undo point. Call once before whatever
// store mutations make up a single user-visible action.
export function checkpoint() {
    if (suspendHistory) return;
    undoStack.push(snapshotState());
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
}

export function canUndo() {
    return undoStack.length > 0;
}

export function canRedo() {
    return redoStack.length > 0;
}

export function undo() {
    if (undoStack.length === 0) return false;
    const current = snapshotState();
    const prev = undoStack.pop();
    redoStack.push(current);
    suspendHistory = true;
    restoreState(prev);
    suspendHistory = false;
    markDirty();
    return true;
}

export function redo() {
    if (redoStack.length === 0) return false;
    const current = snapshotState();
    const next = redoStack.pop();
    undoStack.push(current);
    suspendHistory = true;
    restoreState(next);
    suspendHistory = false;
    markDirty();
    return true;
}

// Called on loadData(): a freshly loaded document has nothing to undo to.
export function resetHistory() {
    undoStack = [];
    redoStack = [];
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

// Deleting the only remaining show would leave the app with nothing to
// display or switch to, so it's disallowed — same reasoning as loadData()
// always ensuring at least one show exists.
export function deleteShow(id) {
    if (getShows().length <= 1) {
        throw new Error('Cannot delete the only show');
    }
    alasql('DELETE FROM items WHERE show_id = ?', [id]);
    alasql('DELETE FROM shows WHERE id = ?', [id]);
    markDirty();
}

// Returns `name`, or `name (2)`, `name (3)`, ... — whichever is the first
// not already used by an existing show. Used so importing never silently
// overwrites/collides with a same-named show.
function uniqueShowName(name) {
    const existing = new Set(getShows().map((s) => s.name));
    if (!existing.has(name)) return name;
    let n = 2;
    while (existing.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
}

// A self-contained snapshot of one show and its items — meant to be saved
// to a file and handed to someone else, unlike STORAGE_KEY's full
// multi-show document.
export function exportShow(id) {
    const show = getShow(id);
    if (!show) return null;
    return {
        kind: SHOW_EXPORT_KIND,
        exportVersion: SHOW_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        show,
        items: getItems(id),
    };
}

// Imports a show from exportShow()'s format as a brand-new show: fresh ids
// throughout (never reusing the file's ids, which could collide with an
// existing show in this browser) and a de-duplicated name (never silently
// overwriting an existing show with the same name). Returns the new show.
export function importShow(data) {
    if (!data || data.kind !== SHOW_EXPORT_KIND || !data.show || !Array.isArray(data.items)) {
        throw new Error('This file is not a valid LightsUP show export.');
    }

    const newShowId = randomId();
    const newShow = {
        ...DEFAULT_SHOW,
        ...data.show,
        id: newShowId,
        name: uniqueShowName(data.show.name || 'Imported Show'),
        updated_at: null, // not yet saved in this browser
    };

    // Items reference each other via `position` (a fixture pointing at its
    // pipe/truss's item id), so ids have to be remapped consistently, not
    // just regenerated independently per item.
    const idMap = new Map();
    data.items.forEach((item) => idMap.set(item.id, randomId()));

    // Same per-column defaulting as createItem(), so a sparse or older-format
    // export still inserts cleanly instead of storing `undefined` for
    // whatever columns it happens to be missing.
    const newItems = data.items.map((item) => {
        const copy = { id: idMap.get(item.id) };
        for (const col of ITEM_COLUMNS) {
            if (col === 'id') continue;
            copy[col] = item[col] !== undefined ? item[col] : ITEM_DEFAULTS[col];
        }
        copy.show_id = newShowId;
        copy.position = item.position && idMap.has(item.position) ? idMap.get(item.position) : '';
        return copy;
    });

    alasql('INSERT INTO shows VALUES ?', [newShow]);
    newItems.forEach((item) => alasql('INSERT INTO items VALUES ?', [item]));
    markDirty();
    return newShow;
}

// ---------------------------------------------------------------------------
// Items

// Ordered bottom-to-top so callers (renderAll) can render/stack items in the
// same order they'll actually be drawn in — see setItemsOrder for how that
// order is changed (layer up/down/top/bottom).
export function getItems(showId) {
    return alasql('SELECT * FROM items WHERE show_id = ? ORDER BY zindex', [showId]);
}

export function getItem(id) {
    return alasql('SELECT * FROM items WHERE id = ?', [id])[0];
}

export function getItemsByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return alasql(`SELECT * FROM items WHERE id IN (${placeholders})`, ids);
}

// A show's items with no zindex yet default to 0 (see ITEM_DEFAULTS), so the
// top of the stack is just the highest zindex currently in use for that show.
function nextZIndex(showId) {
    const rows = alasql('SELECT MAX(zindex) AS maxz FROM items WHERE show_id = ?', [showId]);
    const max = rows[0] && rows[0].maxz;
    return (typeof max === 'number' ? max : -1) + 1;
}

export function createItem(fields) {
    const item = { id: randomId() };
    for (const col of ITEM_COLUMNS) {
        if (col === 'id') continue;
        item[col] = fields[col] !== undefined ? fields[col] : ITEM_DEFAULTS[col];
    }
    // A fresh item — including a pasted copy, which deletes its source's
    // zindex before calling in here — always starts on top of its show,
    // never wherever ITEM_DEFAULTS' plain 0 would land it.
    if (fields.zindex === undefined) item.zindex = nextZIndex(item.show_id);
    alasql('INSERT INTO items VALUES ?', [item]);
    markDirty();
    return item;
}

// Persists a new bottom-to-top stacking order for a show: ids is every item
// in that show, in the order the render layer settled on after a layer
// up/down/top/bottom command. Renumbers everything to keep zindex values
// small and contiguous rather than accumulating gaps or drift over time.
export function setItemsOrder(ids) {
    ids.forEach((id, index) => {
        alasql('UPDATE items SET zindex = ? WHERE id = ?', [index, id]);
    });
    markDirty();
}

// width is only meaningful for the text tool (a Textbox's independent wrap
// width, as opposed to its scaleX/scaleY) but is accepted generically here
// since every item shares one table; other item types just store null.
export function updateItemLocation(id, x, y, scalex, scaley, angle, width = null) {
    alasql('UPDATE items SET x = ?, y = ?, scalex = ?, scaley = ?, angle = ?, width = ? WHERE id = ?', [x, y, scalex, scaley, angle, width, id]);
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
