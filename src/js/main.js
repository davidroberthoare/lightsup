// Controller: wires the UI and canvas events to the store (single source of
// truth) and the render layer (visual mirror). Flow is always
// event → store mutation → targeted render update; full redraws happen only
// on load and show switching.

import * as store from './store.js';
import * as render from './render.js';

const $ = globalThis.$;
const fabric = globalThis.fabric;

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 20;
const CLICK_DRAG_THRESHOLD = 4; // px of mouse travel that still counts as a click

// Which inspector fields apply to which item type. 'locked' applies to all —
// it's the one field a locked object still accepts (see the change handler).
const INSPECTOR_FIELDS = {
    fixture: ['label', 'dimmer', 'channel', 'gel', 'locked'],
    position: ['label', 'locked'],
    shape: ['label', 'locked'],
};

const MODE = { action: 'default', type: null, subtype: null };
let currentShowId = null;

const container = document.getElementById('container');
const canvas = render.initCanvas(document.getElementById('paper'), container);

// ---------------------------------------------------------------------------
// Show handling

function switchShow(id) {
    currentShowId = id;
    store.setCurrentShowId(id);
    render.renderAll(store.getItems(id));
    updateShowInspector();
    pasteOffsetCount = 0; // a fresh show is a fresh context for the paste-stagger offset
}

function updateShowInspector() {
    const show = store.getShow(currentShowId);
    if (!show) return;
    for (const key in show) {
        $(`#show_inspector input[name=${key}]`).val(show[key]);
    }
}

function boot() {
    const current = store.loadData();
    switchShow(current);
    refreshHistoryButtons();
    refreshEditMenuState();
}

// ---------------------------------------------------------------------------
// Load-show modal

function formatSavedTime(iso) {
    if (!iso) return 'Never saved';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Never saved';
    return date.toLocaleString();
}

function openLoadShowModal() {
    const $tbody = $('#load_show_table tbody');
    $tbody.empty();
    store.getShows().forEach((show) => {
        const $row = $('<tr>').toggleClass('is-selected', show.id === currentShowId);
        $('<td>').text(show.name).appendTo($row);
        $('<td>').text(formatSavedTime(show.updated_at)).appendTo($row);
        $row.on('click', () => {
            switchShow(show.id);
            closeLoadShowModal();
        });
        $tbody.append($row);
    });
    $('#load_show_modal').addClass('is-active');
}

function closeLoadShowModal() {
    $('#load_show_modal').removeClass('is-active');
}

// Downloads the current show + its items as a self-contained JSON file —
// the intended way to hand a plot to someone else (they Import it back).
function exportCurrentShow() {
    const data = store.exportShow(currentShowId);
    if (!data) return;
    const filename = `${(data.show.name || 'show').replace(/[^\w-]+/g, '_')}.lightsup.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function deleteCurrentShow() {
    if (store.getShows().length <= 1) {
        alert("You can't delete your only show.");
        return;
    }
    const name = store.getShow(currentShowId).name;
    if (!confirm(`Delete "${name}"? This removes all its fixtures and positions. (Ctrl+Z undoes this like any other edit.)`)) return;

    store.checkpoint();
    store.deleteShow(currentShowId);
    switchShow(store.getShows()[0].id);
    refreshHistoryButtons();
}

// ---------------------------------------------------------------------------
// Mode handling

function switchMode(mode, type, subtype) {
    MODE.action = mode;
    MODE.type = type;
    MODE.subtype = subtype;

    $('.navbar-item').removeClass('selected');
    canvas.defaultCursor = 'pointer';

    if (mode === 'insert') {
        $('#menu_insert').addClass('selected');
        canvas.defaultCursor = 'crosshair';
    }
}

// ---------------------------------------------------------------------------
// Undo / redo
//
// One user gesture can produce several store writes — dragging a position
// also moves and re-persists its child fixtures, for instance — so we
// checkpoint once per gesture rather than once per store call. gestureChecked
// tracks whether this mouse-down-to-mouse-up gesture has already taken its
// checkpoint; it resets on every mouse:down.

let gestureChecked = false;

function refreshHistoryButtons() {
    $('#undo_item').toggleClass('is-disabled', !store.canUndo());
    $('#redo_item').toggleClass('is-disabled', !store.canRedo());
}

// After undo/redo the whole dataset may have changed shape (a created show
// undone, fields reverted, items resurrected/removed), so re-derive
// everything the UI shows from the store rather than patching it.
async function afterHistoryChange() {
    canvas.discardActiveObject();
    if (!store.getShow(currentShowId)) {
        currentShowId = store.getShows()[0].id;
        store.setCurrentShowId(currentShowId);
    }
    await render.renderAll(store.getItems(currentShowId));
    updateShowInspector();
    clearInspector();
    refreshHistoryButtons();
    refreshEditMenuState();
}

async function performUndo() {
    if (!store.undo()) return;
    await afterHistoryChange();
}

async function performRedo() {
    if (!store.redo()) return;
    await afterHistoryChange();
}

// ---------------------------------------------------------------------------
// Persistence of canvas edits

function applyNumberChanges(changes) {
    changes.forEach((c) => render.updateItemText(c.id, 'number', c.number ?? ''));
}

// Saves an object's placement and, for fixtures, re-resolves which position
// it hangs on. Also picks up two things unique to the freestanding text
// tool: dragging a side handle changes its wrap width (not scale), and
// double-click-to-edit content changes are only known once editing exits —
// both land here via the same object:modified event as an ordinary move.
function persistObject(obj) {
    if (!obj.id) return;
    // Belt and suspenders: Fabric's lock flags should already have blocked
    // any interactive transform on a locked object, but a locked fixture
    // can still get *carried* by an unlocked position's drag handler via
    // direct property assignment (bypassing Fabric's own lock checks) if
    // that filter ever regresses — so refuse to persist a locked item's
    // geometry here too, at the one place all such changes funnel through.
    const item = store.getItem(obj.id);
    if (item && item.locked) return;

    // Only the freestanding text tool is a bare Textbox (type 'textbox');
    // everything else is a Group whose own .width is just its bounding box
    // and isn't meaningful to persist.
    const width = obj.type === 'textbox' ? obj.width : null;
    store.updateItemLocation(obj.id, obj.left, obj.top, obj.scaleX, obj.scaleY, obj.angle, width);

    if (obj.itemType === 'fixture') {
        const position = canvas.getObjects().find(
            (o) => o.itemType === 'position' && obj.intersectsWithObject(o));
        const changes = store.assignFixtureToPosition(obj.id, position ? position.id : null);
        applyNumberChanges(changes);
    }

    if (typeof obj.text === 'string') {
        store.updateItemField(obj.id, 'label', obj.text);
        $('#inspector input[name=label]').val(obj.text);
    }
}

canvas.on('object:modified', (e) => {
    const obj = e.target;
    if (!obj) return;

    if (!gestureChecked) {
        store.checkpoint();
        gestureChecked = true;
    }

    // A multi-selection reports child coordinates relative to the selection;
    // discard it first so absolute coordinates are restored, then persist
    // each child individually.
    if (obj instanceof fabric.ActiveSelection) {
        const children = obj.getObjects();
        canvas.discardActiveObject();
        children.forEach((child) => persistObject(child));
        canvas.requestRenderAll();
    } else {
        persistObject(obj);
    }
    refreshHistoryButtons();
});

canvas.on('object:rotating', (e) => {
    render.applyTextFlip(e.target);
});

// ---------------------------------------------------------------------------
// Mouse: zoom, pan, insert

canvas.on('mouse:wheel', (opt) => {
    opt.e.preventDefault();
    opt.e.stopPropagation();
    const { deltaY, offsetX, offsetY } = opt.e;
    if (opt.e.ctrlKey) {
        let zoom = canvas.getZoom();
        zoom *= 1.01 ** -deltaY;
        if (zoom > ZOOM_MAX) zoom = ZOOM_MAX;
        if (zoom < ZOOM_MIN) zoom = ZOOM_MIN;
        canvas.zoomToPoint({ x: offsetX, y: offsetY }, zoom);
    }
    canvas.relativePan({ x: -opt.e.deltaX, y: -opt.e.deltaY });
});

let isPanning = false;
let lastPosX = 0;
let lastPosY = 0;
let downInfo = null;

canvas.on('mouse:down', (opt) => {
    gestureChecked = false;
    if (opt.e.button === 1) { // middle mouse button
        isPanning = true;
        lastPosX = opt.e.clientX;
        lastPosY = opt.e.clientY;
    }
    downInfo = {
        x: opt.e.clientX,
        y: opt.e.clientY,
        button: opt.e.button,
        target: opt.target || null,
    };
});

canvas.on('mouse:move', (opt) => {
    if (isPanning) {
        const e = opt.e;
        const vpt = canvas.viewportTransform;
        vpt[4] += e.clientX - lastPosX;
        vpt[5] += e.clientY - lastPosY;
        canvas.requestRenderAll();
        lastPosX = e.clientX;
        lastPosY = e.clientY;
    }
});

canvas.on('mouse:up', (opt) => {
    isPanning = false;
    if (MODE.action !== 'insert' || !downInfo) return;

    // Only insert on a plain left-click on empty canvas — not on drag-ends,
    // pans, or clicks on existing objects.
    const wasClick = downInfo.button === 0
        && !downInfo.target
        && Math.hypot(opt.e.clientX - downInfo.x, opt.e.clientY - downInfo.y) < CLICK_DRAG_THRESHOLD;
    downInfo = null;
    if (!wasClick) return;

    store.checkpoint();
    const item = store.createItem({
        show_id: currentShowId,
        type: MODE.type,
        shape: MODE.subtype,
        x: opt.scenePoint.x,
        y: opt.scenePoint.y,
        // A blank Textbox renders nothing and can't be clicked to edit, so
        // give it a starting caption the way other item types get one for
        // free from their symbol/shape.
        label: MODE.type === 'shape' && MODE.subtype === 'text' ? 'Text' : undefined,
    });
    render.renderItem(item);
    refreshHistoryButtons();
});

// ---------------------------------------------------------------------------
// Selection and inspector

function clearInspector() {
    $('#inspector input[type=text]').val('');
    $('#inspector input[type=checkbox]').prop('checked', false).prop('indeterminate', false);
}

function updateInspector(ids) {
    const items = store.getItemsByIds(ids);

    clearInspector();

    const common = {};
    items.forEach((item) => {
        for (const key in item) {
            if (common[key] === undefined) {
                common[key] = item[key];
            } else if (common[key] !== item[key]) {
                common[key] = '*';
            }
        }
    });

    for (const key in common) {
        const $field = $(`#inspector input[name=${key}]`);
        if ($field.attr('type') === 'checkbox') {
            if (common[key] === '*') {
                $field.prop('indeterminate', true);
            } else {
                $field.prop('checked', !!common[key]);
            }
        } else {
            $field.val(common[key]);
        }
    }
}

function updateSelection(evt) {
    // Multi-selections are move-only: scaling/rotating a group would corrupt
    // per-item placement data.
    if (evt.selected.length > 1) {
        const group = canvas.getActiveObject();
        group.hasControls = false;

        // Fabric applies a multi-drag to the ActiveSelection as one unit —
        // individual members' own lock flags aren't consulted for that
        // transform, so if any member is locked, lock the whole batch's
        // movement too rather than let the drag silently drag a locked item.
        const hasLocked = evt.selected.some((obj) => {
            const item = store.getItem(obj.id);
            return item && item.locked;
        });
        group.lockMovementX = hasLocked;
        group.lockMovementY = hasLocked;
    }
    updateInspector(evt.selected.map((obj) => obj.id));
    refreshEditMenuState();
}

canvas.on('selection:created', updateSelection);
canvas.on('selection:updated', updateSelection);
canvas.on('selection:cleared', () => {
    clearInspector();
    refreshEditMenuState();
});

function deleteSelected() {
    // Locked objects accept no change, deletion included — skip them and
    // only delete whatever's left. (See INSPECTOR_FIELDS comment: unlocking
    // is the one way out, via the inspector, not the Delete key.)
    const objs = canvas.getActiveObjects().filter((obj) => {
        const item = store.getItem(obj.id);
        return !(item && item.locked);
    });
    if (objs.length === 0) return;
    if (!confirm('Delete selected items?')) return;

    store.checkpoint();
    canvas.discardActiveObject();
    objs.forEach((obj) => {
        const changes = store.deleteItem(obj.id);
        render.removeItemObject(obj.id);
        applyNumberChanges(changes);
    });
    canvas.requestRenderAll();
    refreshHistoryButtons();
}

// Inspector edits apply to every selected object, restricted to the fields
// that exist for its type. A locked object accepts only the 'locked' field
// itself (unlocking) — every other edit is silently skipped while locked.
$('#inspector input').change(function () {
    const name = $(this).attr('name');
    const isCheckbox = $(this).attr('type') === 'checkbox';
    const value = isCheckbox ? $(this).prop('checked') : $(this).val();
    store.checkpoint();
    canvas.getActiveObjects().forEach((obj) => {
        const item = store.getItem(obj.id);
        if (!item) return;
        const editable = INSPECTOR_FIELDS[item.type] || [];
        if (!editable.includes(name)) return;
        if (item.locked && name !== 'locked') return;

        store.updateItemField(obj.id, name, value);
        if (name === 'locked') {
            render.setItemLocked(obj.id, value, item.type);
        } else {
            render.updateItemText(obj.id, name, value);
        }
    });
    refreshHistoryButtons();
});

$('#show_inspector input').change(function () {
    const name = $(this).attr('name');
    const value = $(this).val();
    store.checkpoint();
    store.updateShowField(currentShowId, name, value);
    refreshHistoryButtons();
});

// ---------------------------------------------------------------------------
// Cut / copy / paste
//
// An in-memory clipboard, not the OS clipboard: items are structured data
// (every column, not just a label's text), not something that needs to
// leave the page or interoperate with other apps. Works on any item type —
// copySelected() just snapshots whatever store rows the current selection
// maps to, with no per-type branching.

let clipboard = [];
let pasteOffsetCount = 0;
const PASTE_OFFSET = 20; // scene units per repeated paste, so a paste-paste-paste run fans out visibly

function refreshEditMenuState() {
    const selectedCount = canvas.getActiveObjects().length;
    $('#cut_item, #copy_item').toggleClass('is-disabled', selectedCount === 0);
    $('#paste_item').toggleClass('is-disabled', clipboard.length === 0);
    $('#align_top, #align_middle, #align_bottom, #align_left, #align_center, #align_right')
        .toggleClass('is-disabled', selectedCount < 2);
    $('#distribute_horizontal, #distribute_vertical, #distribute_rotation_horizontal, #distribute_rotation_vertical')
        .toggleClass('is-disabled', selectedCount < 3);
}

function copySelected() {
    const objs = canvas.getActiveObjects();
    if (objs.length === 0) return;
    clipboard = objs.map((obj) => store.getItem(obj.id)).filter(Boolean);
    pasteOffsetCount = 0;
    refreshEditMenuState();
}

function cutSelected() {
    const objs = canvas.getActiveObjects();
    if (objs.length === 0) return;
    copySelected(); // copy the whole selection regardless of lock — copying isn't a change

    // Deletion still respects locks, same as the Delete key: a locked
    // object accepts no change, cut included.
    const deletable = objs.filter((obj) => {
        const item = store.getItem(obj.id);
        return !(item && item.locked);
    });
    if (deletable.length === 0) return;

    store.checkpoint();
    canvas.discardActiveObject();
    deletable.forEach((obj) => {
        const changes = store.deleteItem(obj.id);
        render.removeItemObject(obj.id);
        applyNumberChanges(changes);
    });
    canvas.requestRenderAll();
    refreshHistoryButtons();
    refreshEditMenuState();
}

async function pasteClipboard() {
    if (clipboard.length === 0) return;
    pasteOffsetCount++;
    const offset = pasteOffsetCount * PASTE_OFFSET;

    store.checkpoint();
    const pasted = clipboard.map((original) => {
        const fields = { ...original };
        delete fields.id;
        fields.show_id = currentShowId; // lets copy-in-one-show, paste-in-another work for free
        fields.x = original.x + offset;
        fields.y = original.y + offset;
        // A pasted fixture starts off its old position/pipe — it's
        // re-resolved below from where it actually landed, same as any
        // freshly placed or dragged fixture.
        fields.position = '';
        fields.number = null;
        fields.locked = false; // a copy of a locked object isn't itself locked
        return store.createItem(fields);
    });

    const rendered = await Promise.all(pasted.map((item) => render.renderItem(item)));

    pasted.forEach((item, i) => {
        const obj = rendered[i];
        if (!obj || item.type !== 'fixture') return;
        const position = canvas.getObjects().find(
            (o) => o.itemType === 'position' && obj.intersectsWithObject(o));
        if (position) {
            const changes = store.assignFixtureToPosition(item.id, position.id);
            applyNumberChanges(changes);
        }
    });

    // Select the pasted objects, matching standard paste behavior and
    // letting the user immediately drag them further if they landed wrong.
    canvas.discardActiveObject();
    const validObjs = rendered.filter(Boolean);
    if (validObjs.length === 1) {
        canvas.setActiveObject(validObjs[0]);
    } else if (validObjs.length > 1) {
        canvas.setActiveObject(new fabric.ActiveSelection(validObjs, { canvas }));
    }
    canvas.requestRenderAll();
    refreshHistoryButtons();
    refreshEditMenuState();
}

$('#cut_item').click(cutSelected);
$('#copy_item').click(copySelected);
$('#paste_item').click(pasteClipboard);

// ---------------------------------------------------------------------------
// Align / distribute
//
// Both work from each object's axis-aligned bounding box in scene coordinates
// (getBoundingRect()) rather than its raw left/top, so rotated and scaled
// objects (and Textbox's center origin) align correctly without per-type
// branching. Locked items are excluded entirely — same as delete/cut, they
// accept no change and don't anchor the target either.

// A multi-selection reports child left/top relative to the selection group
// (see the object:modified handler above); discard it first so this reads
// and writes each object's own absolute placement. Returns both the full
// selection (for restoring it unchanged if there's nothing to do, or
// reselecting once the movable ones have been repositioned) and the locked-
// filtered subset actually eligible to move.
function selectionForEdit() {
    const all = canvas.getActiveObjects();
    canvas.discardActiveObject();
    const movable = all.filter((obj) => {
        const item = store.getItem(obj.id);
        return !(item && item.locked);
    });
    return { all, movable };
}

function reselect(objs) {
    if (objs.length === 1) {
        canvas.setActiveObject(objs[0]);
    } else if (objs.length > 1) {
        canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
    }
    canvas.requestRenderAll();
}

function alignSelection(edge) {
    const { all, movable: objs } = selectionForEdit();
    if (objs.length < 2) {
        reselect(all);
        return;
    }

    const boxes = objs.map((obj) => ({ obj, box: obj.getBoundingRect() }));
    const left = Math.min(...boxes.map(({ box }) => box.left));
    const right = Math.max(...boxes.map(({ box }) => box.left + box.width));
    const top = Math.min(...boxes.map(({ box }) => box.top));
    const bottom = Math.max(...boxes.map(({ box }) => box.top + box.height));
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;

    const moves = boxes.map(({ obj, box }) => {
        let dx = 0;
        let dy = 0;
        switch (edge) {
            case 'left': dx = left - box.left; break;
            case 'right': dx = right - (box.left + box.width); break;
            case 'center': dx = centerX - (box.left + box.width / 2); break;
            case 'top': dy = top - box.top; break;
            case 'bottom': dy = bottom - (box.top + box.height); break;
            case 'middle': dy = centerY - (box.top + box.height / 2); break;
        }
        return { obj, dx, dy };
    }).filter(({ dx, dy }) => dx || dy);

    if (moves.length > 0) {
        store.checkpoint();
        moves.forEach(({ obj, dx, dy }) => {
            obj.set({ left: obj.left + dx, top: obj.top + dy });
            obj.setCoords();
            persistObject(obj);
        });
        refreshHistoryButtons();
    }

    reselect(all);
    refreshEditMenuState();
}

// Equalizes the gaps between bounding-box edges along one axis, keeping the
// first and last object (by that axis) fixed in place.
function distributeSelection(axis) {
    const { all, movable: objs } = selectionForEdit();
    if (objs.length < 3) {
        reselect(all);
        return;
    }

    const key = axis === 'x' ? 'left' : 'top';
    const size = axis === 'x' ? 'width' : 'height';
    const boxes = objs
        .map((obj) => ({ obj, box: obj.getBoundingRect() }))
        .sort((a, b) => a.box[key] - b.box[key]);

    const first = boxes[0].box;
    const last = boxes[boxes.length - 1].box;
    const span = (last[key] + last[size]) - first[key];
    const sumSizes = boxes.reduce((sum, { box }) => sum + box[size], 0);
    const gap = (span - sumSizes) / (boxes.length - 1);

    let cursor = first[key];
    const moves = [];
    boxes.forEach(({ obj, box }) => {
        const delta = cursor - box[key];
        if (delta) moves.push({ obj, delta });
        cursor += box[size] + gap;
    });

    if (moves.length > 0) {
        store.checkpoint();
        moves.forEach(({ obj, delta }) => {
            obj.set({ [key]: obj[key] + delta });
            obj.setCoords();
            persistObject(obj);
        });
        refreshHistoryButtons();
    }

    reselect(all);
    refreshEditMenuState();
}

// Spreads rotation angle linearly across the selection, ordered by position
// along the given axis. The first and last object (by that axis) keep their
// current angle as the two ends of the spread; everything in between is
// interpolated by its rank in that order.
function distributeRotation(axis) {
    const { all, movable: objs } = selectionForEdit();
    if (objs.length < 3) {
        reselect(all);
        return;
    }

    const ordered = objs
        .map((obj) => {
            const box = obj.getBoundingRect();
            return { obj, center: axis === 'x' ? box.left + box.width / 2 : box.top + box.height / 2 };
        })
        .sort((a, b) => a.center - b.center)
        .map(({ obj }) => obj);

    const startAngle = ordered[0].angle || 0;
    const endAngle = ordered[ordered.length - 1].angle || 0;
    const step = (endAngle - startAngle) / (ordered.length - 1);

    if (step) {
        store.checkpoint();
        ordered.forEach((obj, i) => {
            if (i === 0 || i === ordered.length - 1) return;
            obj.set({ angle: startAngle + step * i });
            obj.setCoords();
            render.applyTextFlip(obj);
            persistObject(obj);
        });
        refreshHistoryButtons();
    }

    reselect(all);
    refreshEditMenuState();
}

$('#align_top').click(() => alignSelection('top'));
$('#align_middle').click(() => alignSelection('middle'));
$('#align_bottom').click(() => alignSelection('bottom'));
$('#align_left').click(() => alignSelection('left'));
$('#align_center').click(() => alignSelection('center'));
$('#align_right').click(() => alignSelection('right'));

$('#distribute_horizontal').click(() => distributeSelection('x'));
$('#distribute_vertical').click(() => distributeSelection('y'));
$('#distribute_rotation_horizontal').click(() => distributeRotation('x'));
$('#distribute_rotation_vertical').click(() => distributeRotation('y'));

// ---------------------------------------------------------------------------
// Menus and keyboard

$('#save').click(() => {
    store.saveData();
    statusToast('saved');
});

$('#load').click(() => {
    if (store.isDirty() && !confirm('Discard unsaved changes and reload the last save?')) return;
    const current = store.loadData();
    switchShow(current);
    refreshHistoryButtons();
    openLoadShowModal();
});

$('#load_show_modal_close, #load_show_modal .modal-background').click(closeLoadShowModal);

$('#new_show').click(() => {
    const name = prompt('New show name:', 'New Show');
    if (!name) return;
    store.checkpoint();
    const show = store.createShow({ name });
    switchShow(show.id);
    refreshHistoryButtons();
});

$('#export_show').click(exportCurrentShow);
$('#delete_show').click(deleteCurrentShow);

$('#import_show').click(() => {
    document.getElementById('import_show_file').click();
});

$('#import_show_file').on('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // reset so importing the same file twice still fires 'change'
    if (!file) return;

    try {
        const data = JSON.parse(await file.text());
        store.checkpoint();
        const show = store.importShow(data);
        switchShow(show.id);
        refreshHistoryButtons();
        statusToast(`Imported "${show.name}"`);
    } catch (error) {
        console.error('Import failed', error);
        alert(`Could not import that file: ${error.message}`);
    }
});

$('#menu_insert').on('click', 'a[data-type]', function () {
    switchMode('insert', $(this).attr('data-type'), $(this).attr('data-subtype'));
});

$('#toggle-panel').click(() => {
    $('#floating-panel').toggleClass('expanded');
});

$('#undo_item').click(performUndo);
$('#redo_item').click(performRedo);

$(document).keydown((e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA';

    if (e.ctrlKey && !e.shiftKey && !inField && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        performUndo();
    } else if (!inField && ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z') || (e.ctrlKey && e.key.toLowerCase() === 'y'))) {
        e.preventDefault();
        performRedo();
    } else if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        store.saveData();
        statusToast('saved');
    } else if (e.ctrlKey && !inField && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelected();
    } else if (e.ctrlKey && !inField && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        cutSelected();
    } else if (e.ctrlKey && !inField && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteClipboard();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !inField) {
        deleteSelected();
    } else if (e.key === 'Escape') {
        closeLoadShowModal();
        switchMode('default', null, null);
    }
});

window.addEventListener('beforeunload', (e) => {
    if (store.isDirty()) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// ---------------------------------------------------------------------------
// Boot

async function loadFixturesMenu() {
    try {
        const res = await fetch('./config/fixtures.json');
        const data = await res.json();
        const menu = document.getElementById('fixtures_menu');
        data.forEach((fixture) => {
            const a = document.createElement('a');
            a.className = 'dropdown-item';
            a.dataset.type = 'fixture';
            a.dataset.subtype = fixture.symbol;
            a.textContent = fixture.name;
            menu.appendChild(a);
        });
    } catch (error) {
        console.error('Error loading fixtures.json', error);
    }
}

function statusToast(msg, myclass = 'good', duration = 3000) {
    $('#status_2').text(msg);
    $('#status_2').addClass(myclass);
    $('#status_2').fadeIn(200);
    setTimeout(() => {
        $('#status_2').fadeOut(200, () => {
            $('#status_2').removeClass(myclass);
        });
    }, duration);
}

$(() => {
    loadFixturesMenu();
    boot();
});
