import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The store expects the AlaSQL UMD global, same as in the browser.
import './helpers/alasql-loader.js';

const store = await import('../src/js/store.js');

class FakeStorage {
    constructor(entries = {}) {
        this.map = new Map(Object.entries(entries));
    }
    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
        this.map.set(key, String(value));
    }
    removeItem(key) {
        this.map.delete(key);
    }
}

let storage;

beforeEach(() => {
    storage = new FakeStorage();
    store.loadData(storage);
});

test('first run creates the default show and returns it as current', () => {
    const current = store.loadData(storage);
    assert.equal(current, 'default');
    const shows = store.getShows();
    assert.equal(shows.length, 1);
    assert.equal(shows[0].name, store.DEFAULT_SHOW.name);
});

test('legacy single-show saves are migrated with show_id backfilled', () => {
    const legacy = new FakeStorage({
        shows: JSON.stringify([{ id: 'default', name: 'Old Show', company: '', venue: '', designer: '', date: '' }]),
        items: JSON.stringify([{ id: 'abc123', type: 'fixture', shape: 'par_64', x: 1, y: 2, angle: 0, scalex: 1, scaley: 1, position: '', number: 0, label: 'L', channel: '1', dimmer: '2', gel: 'R60' }]),
        current_show_id: 'default',
    });
    const current = store.loadData(legacy);
    assert.equal(current, 'default');
    assert.equal(store.getShow('default').name, 'Old Show');
    const items = store.getItems('default');
    assert.equal(items.length, 1);
    assert.equal(items[0].show_id, 'default');
});

test('legacy items with no shows key still migrate under the default show', () => {
    const legacy = new FakeStorage({
        items: JSON.stringify([{ id: 'abc123', type: 'fixture', shape: 'par_64', x: 1, y: 2 }]),
    });
    store.loadData(legacy);
    assert.equal(store.getItems('default').length, 1);
});

test('items are scoped to their show', () => {
    const show2 = store.createShow({ name: 'Second Show' });
    store.createItem({ show_id: 'default', type: 'fixture', shape: 'par_64' });
    store.createItem({ show_id: show2.id, type: 'fixture', shape: 'fresnel_6' });
    store.createItem({ show_id: show2.id, type: 'position' });

    assert.equal(store.getItems('default').length, 1);
    assert.equal(store.getItems(show2.id).length, 2);
});

test('new items default to the top of their own show\'s stack, independent of other shows', () => {
    const show2 = store.createShow({ name: 'Second Show' });
    const a = store.createItem({ show_id: 'default', type: 'fixture' });
    const b = store.createItem({ show_id: 'default', type: 'fixture' });
    // A show with items already at high zindex must not push a *different*
    // show's next item's default any higher than its own stack warrants.
    const other = store.createItem({ show_id: show2.id, type: 'fixture' });

    assert.equal(a.zindex, 0);
    assert.equal(b.zindex, 1);
    assert.equal(other.zindex, 0);
    assert.deepEqual(store.getItems('default').map((i) => i.id), [a.id, b.id]);
});

test('setItemsOrder renumbers zindex to match the given order, and getItems reflects it', () => {
    const a = store.createItem({ show_id: 'default', type: 'fixture' });
    const b = store.createItem({ show_id: 'default', type: 'fixture' });
    const c = store.createItem({ show_id: 'default', type: 'fixture' });
    assert.deepEqual(store.getItems('default').map((i) => i.id), [a.id, b.id, c.id]);

    store.setItemsOrder([c.id, a.id, b.id]);

    assert.deepEqual(store.getItems('default').map((i) => i.id), [c.id, a.id, b.id]);
    assert.equal(store.getItem(c.id).zindex, 0);
    assert.equal(store.getItem(a.id).zindex, 1);
    assert.equal(store.getItem(b.id).zindex, 2);
});

test('save/load roundtrip preserves shows and items in the versioned format', () => {
    const show2 = store.createShow({ name: 'Second Show' });
    const item = store.createItem({ show_id: show2.id, type: 'fixture', shape: 'par_64', x: 42, gel: 'L201' });
    store.saveData(storage);

    const doc = JSON.parse(storage.getItem(store.STORAGE_KEY));
    assert.equal(doc.version, store.DATA_VERSION);

    store.loadData(storage);
    assert.equal(store.getShows().length, 2);
    const reloaded = store.getItem(item.id);
    assert.equal(reloaded.x, 42);
    assert.equal(reloaded.gel, 'L201');
    assert.equal(reloaded.show_id, show2.id);
});

test('updateItemField rejects unknown columns', () => {
    const item = store.createItem({ show_id: 'default', type: 'fixture' });
    assert.throws(() => store.updateItemField(item.id, 'evil; DROP TABLE items', 'x'), /Not an editable item field/);
    store.updateItemField(item.id, 'gel', 'R02');
    assert.equal(store.getItem(item.id).gel, 'R02');
});

test('updateShowField rejects unknown columns', () => {
    assert.throws(() => store.updateShowField('default', 'id', 'hacked'), /Not an editable show field/);
    store.updateShowField('default', 'venue', 'The Barn');
    assert.equal(store.getShow('default').venue, 'The Barn');
});

test('renumberPosition numbers fixtures by descending x, then y', () => {
    const pos = store.createItem({ show_id: 'default', type: 'position' });
    const a = store.createItem({ show_id: 'default', type: 'fixture', x: 10, position: pos.id });
    const b = store.createItem({ show_id: 'default', type: 'fixture', x: 30, position: pos.id });
    const c = store.createItem({ show_id: 'default', type: 'fixture', x: 20, position: pos.id });

    const changes = store.renumberPosition(pos.id);
    assert.deepEqual(changes, [
        { id: b.id, number: 1 },
        { id: c.id, number: 2 },
        { id: a.id, number: 3 },
    ]);
    assert.equal(store.getItem(b.id).number, 1);
});

test('assignFixtureToPosition assigns, moves between, and clears positions', () => {
    const pos1 = store.createItem({ show_id: 'default', type: 'position' });
    const pos2 = store.createItem({ show_id: 'default', type: 'position' });
    const f1 = store.createItem({ show_id: 'default', type: 'fixture', x: 10 });
    const f2 = store.createItem({ show_id: 'default', type: 'fixture', x: 20 });

    store.assignFixtureToPosition(f1.id, pos1.id);
    store.assignFixtureToPosition(f2.id, pos1.id);
    assert.equal(store.getItem(f2.id).number, 1); // higher x
    assert.equal(store.getItem(f1.id).number, 2);

    // Moving f2 to pos2 renumbers both positions.
    store.assignFixtureToPosition(f2.id, pos2.id);
    assert.equal(store.getItem(f2.id).position, pos2.id);
    assert.equal(store.getItem(f2.id).number, 1);
    assert.equal(store.getItem(f1.id).number, 1);

    // Clearing leaves the fixture unnumbered.
    const changes = store.assignFixtureToPosition(f2.id, null);
    assert.equal(store.getItem(f2.id).position, '');
    assert.equal(store.getItem(f2.id).number, null);
    assert.ok(changes.some((c) => c.id === f2.id && c.number === null));
});

test('deleting a position unassigns its fixtures', () => {
    const pos = store.createItem({ show_id: 'default', type: 'position' });
    const f1 = store.createItem({ show_id: 'default', type: 'fixture' });
    store.assignFixtureToPosition(f1.id, pos.id);

    const changes = store.deleteItem(pos.id);
    assert.deepEqual(changes, [{ id: f1.id, number: null }]);
    assert.equal(store.getItem(f1.id).position, '');
    assert.equal(store.getItem(f1.id).number, null);
});

test('deleting a fixture renumbers the position it was on', () => {
    const pos = store.createItem({ show_id: 'default', type: 'position' });
    const f1 = store.createItem({ show_id: 'default', type: 'fixture', x: 10 });
    const f2 = store.createItem({ show_id: 'default', type: 'fixture', x: 20 });
    store.assignFixtureToPosition(f1.id, pos.id);
    store.assignFixtureToPosition(f2.id, pos.id);
    assert.equal(store.getItem(f1.id).number, 2);

    const changes = store.deleteItem(f2.id);
    assert.deepEqual(changes, [{ id: f1.id, number: 1 }]);
});

test('dirty flag tracks mutations and saves', () => {
    assert.equal(store.isDirty(), false);
    store.createItem({ show_id: 'default', type: 'fixture' });
    assert.equal(store.isDirty(), true);
    store.saveData(storage);
    assert.equal(store.isDirty(), false);
    store.updateShowField('default', 'name', 'Renamed');
    assert.equal(store.isDirty(), true);
    store.loadData(storage);
    assert.equal(store.isDirty(), false);
});

test('shows default to an unset updated_at and saveData stamps only the current show', () => {
    const show2 = store.createShow({ name: 'Second Show' });
    assert.equal(store.getShow('default').updated_at, null);
    assert.equal(store.getShow(show2.id).updated_at, null);

    store.setCurrentShowId('default', storage);
    store.saveData(storage);
    assert.ok(store.getShow('default').updated_at);
    assert.equal(store.getShow(show2.id).updated_at, null);
});

test('legacy saves and v2 saves without updated_at are migrated to null, not left undefined', () => {
    const legacy = new FakeStorage({
        shows: JSON.stringify([{ id: 'default', name: 'Old Show', company: '', venue: '', designer: '', date: '' }]),
        items: JSON.stringify([]),
    });
    store.loadData(legacy);
    assert.equal(store.getShow('default').updated_at, null);

    const v2 = new FakeStorage({
        [store.STORAGE_KEY]: JSON.stringify({
            version: 2,
            shows: [{ id: 'default', name: 'V2 Show', company: '', venue: '', designer: '', date: '' }],
            items: [],
        }),
    });
    store.loadData(v2);
    assert.equal(store.getShow('default').updated_at, null);
});

test('items saved before zindex existed fall back to their saved array order, not all tied at 0', () => {
    const preZindex = new FakeStorage({
        [store.STORAGE_KEY]: JSON.stringify({
            version: 5,
            shows: [{ id: 'default', name: 'Old Show', company: '', venue: '', designer: '', date: '' }],
            items: [
                { id: 'first', show_id: 'default', type: 'fixture' },
                { id: 'second', show_id: 'default', type: 'fixture' },
                { id: 'third', show_id: 'default', type: 'fixture' },
            ],
        }),
    });
    store.loadData(preZindex);
    assert.deepEqual(store.getItems('default').map((i) => i.id), ['first', 'second', 'third']);
});

test('items default to the foreground layer, and can be moved to background', () => {
    const item = store.createItem({ show_id: 'default', type: 'shape', shape: 'box' });
    assert.equal(item.layer, 'foreground');

    store.updateItemField(item.id, 'layer', 'background');
    assert.equal(store.getItem(item.id).layer, 'background');
});

test('items saved before the background layer existed default to foreground, not undefined', () => {
    const preLayer = new FakeStorage({
        [store.STORAGE_KEY]: JSON.stringify({
            version: 6,
            shows: [{ id: 'default', name: 'Old Show', company: '', venue: '', designer: '', date: '' }],
            items: [{ id: 'abc', show_id: 'default', type: 'shape', shape: 'box' }],
        }),
    });
    store.loadData(preLayer);
    assert.equal(store.getItem('abc').layer, 'foreground');
});

test('deleteShow removes the show and its items, but not other shows\' items', () => {
    const show2 = store.createShow({ name: 'Second Show' });
    store.createItem({ show_id: 'default', type: 'fixture' });
    const show2Item = store.createItem({ show_id: show2.id, type: 'fixture' });

    store.deleteShow(show2.id);
    assert.equal(store.getShow(show2.id), undefined);
    assert.equal(store.getItem(show2Item.id), undefined);
    assert.equal(store.getItems('default').length, 1);
});

test('deleteShow refuses to delete the only remaining show', () => {
    assert.equal(store.getShows().length, 1);
    assert.throws(() => store.deleteShow('default'), /only show/);
    assert.ok(store.getShow('default'));
});

test('exportShow returns null for an unknown show, and a self-contained document for a real one', () => {
    assert.equal(store.exportShow('nope'), null);

    const pos = store.createItem({ show_id: 'default', type: 'position', label: 'Electric 1' });
    store.createItem({ show_id: 'default', type: 'fixture', label: 'A', position: pos.id });
    store.createShow({ name: 'Other show' }); // must NOT leak into the export

    const doc = store.exportShow('default');
    assert.equal(doc.kind, 'lightsup-show');
    assert.equal(doc.exportVersion, store.SHOW_EXPORT_VERSION);
    assert.equal(doc.show.id, 'default');
    assert.equal(doc.items.length, 2);
    assert.ok(doc.exportedAt);
});

test('importShow rejects files that are not a valid show export', () => {
    assert.throws(() => store.importShow(null), /not a valid/);
    assert.throws(() => store.importShow({}), /not a valid/);
    assert.throws(() => store.importShow({ kind: 'lightsup-show', show: {} }), /not a valid/); // items missing
    assert.throws(() => store.importShow({ show: {}, items: [] }), /not a valid/); // kind missing
    // The FULL multi-show backup format (STORAGE_KEY's shape) must also be
    // rejected here, not silently misinterpreted as a single-show export.
    assert.throws(() => store.importShow({ version: 5, shows: [], items: [] }), /not a valid/);
});

test('importShow creates a new show with fresh ids, never reusing the file\'s ids', () => {
    const pos = store.createItem({ show_id: 'default', type: 'position', label: 'Electric 1' });
    const fixture = store.createItem({ show_id: 'default', type: 'fixture', label: 'A', position: pos.id, gel: 'R60' });
    const doc = store.exportShow('default');

    const imported = store.importShow(doc);
    assert.notEqual(imported.id, 'default');
    // 'default' is still named 'My Show' too, so this collides and gets
    // de-duplicated — see the dedicated dedup test below for that behavior.
    assert.equal(imported.name, 'My Show (2)');

    const importedItems = store.getItems(imported.id);
    assert.equal(importedItems.length, 2);
    assert.ok(importedItems.every((i) => i.id !== pos.id && i.id !== fixture.id));
});

test('importShow remaps position references to the new item ids', () => {
    const pos = store.createItem({ show_id: 'default', type: 'position', label: 'Electric 1' });
    store.createItem({ show_id: 'default', type: 'fixture', label: 'A', position: pos.id });
    const doc = store.exportShow('default');

    const imported = store.importShow(doc);
    const importedItems = store.getItems(imported.id);
    const importedPos = importedItems.find((i) => i.type === 'position');
    const importedFixture = importedItems.find((i) => i.type === 'fixture');
    assert.equal(importedFixture.position, importedPos.id);
});

test('importShow de-duplicates a colliding show name instead of overwriting', () => {
    const doc = store.exportShow('default'); // name: 'My Show'
    const first = store.importShow(doc);
    assert.equal(first.name, 'My Show (2)');
    const second = store.importShow(doc);
    assert.equal(second.name, 'My Show (3)');

    // The original 'default' show must be untouched.
    assert.equal(store.getShow('default').name, 'My Show');
    assert.equal(store.getShows().length, 3);
});

test('importShow backfills missing columns from an older export format', () => {
    const doc = {
        kind: 'lightsup-show',
        exportVersion: 1,
        show: { id: 'old', name: 'Sparse Show' }, // no company/venue/etc
        items: [{ id: 'old-item', type: 'fixture', shape: 'par_64' }], // no x/y/label/etc
    };
    const imported = store.importShow(doc);
    assert.equal(imported.company, store.DEFAULT_SHOW.company);
    const [item] = store.getItems(imported.id);
    assert.equal(item.x, 0);
    assert.equal(item.label, '');
    assert.equal(item.locked, false);
});

test('shapes (box/circle/line/arrow) store and round-trip through the generic item columns', () => {
    const box = store.createItem({ show_id: 'default', type: 'shape', shape: 'box', x: 10, y: 20, label: 'Set piece' });
    assert.equal(store.getItem(box.id).type, 'shape');
    assert.equal(store.getItem(box.id).label, 'Set piece');
    // Shapes are not fixtures, so they never appear on the instrument schedule.
    assert.equal(store.getInstrumentSchedule('default').some((r) => r.id === box.id), false);
});

test('checkpoint/undo/redo restores and reapplies a prior snapshot', () => {
    const item = store.createItem({ show_id: 'default', type: 'fixture', label: 'A' });

    store.checkpoint();
    store.updateItemField(item.id, 'label', 'B');
    assert.equal(store.getItem(item.id).label, 'B');

    assert.equal(store.undo(), true);
    assert.equal(store.getItem(item.id).label, 'A');

    assert.equal(store.redo(), true);
    assert.equal(store.getItem(item.id).label, 'B');
});

test('undo/redo are no-ops with empty stacks', () => {
    assert.equal(store.canUndo(), false);
    assert.equal(store.undo(), false);
    assert.equal(store.canRedo(), false);
    assert.equal(store.redo(), false);
});

test('a new checkpoint clears the redo stack', () => {
    const item = store.createItem({ show_id: 'default', type: 'fixture', label: 'A' });
    store.checkpoint();
    store.updateItemField(item.id, 'label', 'B');
    store.undo();
    assert.equal(store.canRedo(), true);

    store.checkpoint();
    store.updateItemField(item.id, 'label', 'C');
    assert.equal(store.canRedo(), false);
    assert.equal(store.redo(), false);
});

test('undo restores cascading changes (position renumbering) from a single checkpoint', () => {
    const pos = store.createItem({ show_id: 'default', type: 'position' });
    const f1 = store.createItem({ show_id: 'default', type: 'fixture', x: 10 });
    const f2 = store.createItem({ show_id: 'default', type: 'fixture', x: 20 });

    store.checkpoint(); // one checkpoint for the whole gesture, as main.js does
    store.assignFixtureToPosition(f1.id, pos.id);
    store.assignFixtureToPosition(f2.id, pos.id);
    assert.equal(store.getItem(f1.id).number, 2);
    assert.equal(store.getItem(f2.id).number, 1);

    store.undo();
    assert.equal(store.getItem(f1.id).position, '');
    assert.equal(store.getItem(f1.id).number, null);
    assert.equal(store.getItem(f2.id).position, '');
});

test('undo can remove a show created after the checkpoint', () => {
    assert.equal(store.getShows().length, 1);
    store.checkpoint();
    const show2 = store.createShow({ name: 'Second Show' });
    assert.equal(store.getShows().length, 2);

    store.undo();
    assert.equal(store.getShows().length, 1);
    assert.equal(store.getShow(show2.id), undefined);
});

test('loadData resets undo/redo history', () => {
    store.createItem({ show_id: 'default', type: 'fixture' });
    store.checkpoint();
    store.createItem({ show_id: 'default', type: 'fixture' });
    assert.equal(store.canUndo(), true);

    store.loadData(storage);
    assert.equal(store.canUndo(), false);
    assert.equal(store.canRedo(), false);
});

test('getInstrumentSchedule returns only fixtures for the given show, with position labels', () => {
    const show2 = store.createShow({ name: 'Second Show' });
    const pos = store.createItem({ show_id: 'default', type: 'position', label: 'Electric 1' });
    const f1 = store.createItem({ show_id: 'default', type: 'fixture', x: 10 });
    store.assignFixtureToPosition(f1.id, pos.id);
    store.createItem({ show_id: 'default', type: 'fixture', x: 99 }); // unpositioned
    store.createItem({ show_id: show2.id, type: 'fixture' }); // other show

    const schedule = store.getInstrumentSchedule('default');
    assert.equal(schedule.length, 2);
    const onPosition = schedule.find((r) => r.id === f1.id);
    assert.equal(onPosition.p_label, 'Electric 1');
});
