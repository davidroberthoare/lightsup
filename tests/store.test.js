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
