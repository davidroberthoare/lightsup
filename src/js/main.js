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

const SPEED_NUMBER_MIN = 0;
const SPEED_NUMBER_MAX = 1000;
const SPEED_NUMBER_STEP = 1;
const SPEED_NUMBER_BIG_STEP = 10;

// Which inspector fields apply to which item type. 'locked' applies to all —
// it's the one field a locked object still accepts (see the change handler).
// 'layer' ('Background' checkbox) also applies to every type, but — unlike
// 'locked' — a locked item does not accept a layer change either; moving
// layers is a real edit, not an unlock-style escape hatch.
const INSPECTOR_FIELDS = {
    fixture: ['label', 'dimmer', 'channel', 'gel', 'locked', 'layer'],
    position: ['label', 'locked', 'layer'],
    shape: ['label', 'locked', 'layer'],
};

const MODE = { action: 'default', type: null, subtype: null };
let currentShowId = null;

// Which layer is currently interactive — see the "Background layer" section
// below. A fresh/switched show always comes up with the normal (foreground)
// layer active; this is session UI state, not saved show data.
let backgroundEditMode = false;

function activeLayerName() {
    return backgroundEditMode ? 'background' : 'foreground';
}

const container = document.getElementById('container');
const canvas = render.initCanvas(document.getElementById('paper'), container);

// ---------------------------------------------------------------------------
// Show handling

function switchShow(id) {
    currentShowId = id;
    store.setCurrentShowId(id);
    backgroundEditMode = false;
    $('#toggle_background_layer').removeClass('selected');
    render.setActiveLayer('foreground');
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
    const wasSpeedNumber = MODE.action === 'speed-number';
    MODE.action = mode;
    MODE.type = type;
    MODE.subtype = subtype;

    // #toggle_background_layer isn't a MODE — it's an independent toggle
    // that stays on/off across drawing-tool switches — so it's excluded here.
    $('.navbar-item').not('#toggle_background_layer').removeClass('selected');
    canvas.defaultCursor = 'pointer';
    $('#speed_number_badge').hide();

    // Restore selectability once speed-numbering ends — re-applying the
    // current layer's state rather than unconditionally re-enabling
    // everything, so this doesn't fight with background-edit mode leaving
    // the inactive layer non-selectable (see the "Background layer" section).
    if (wasSpeedNumber && mode !== 'speed-number') {
        render.setActiveLayer(activeLayerName());
    }

    if (mode === 'insert') {
        $('#menu_insert').addClass('selected');
        canvas.defaultCursor = 'crosshair';
    } else if (mode === 'speed-number') {
        $('#speed_number_menu_trigger').addClass('selected');
        canvas.defaultCursor = 'crosshair';
        canvas.discardActiveObject();
        // Objects stay evented (so clicks still resolve a target) but not
        // selectable, so rapid-fire clicking through fixtures never shows
        // selection handles or lets one get dragged mid-click.
        setAllSelectable(false);
        updateSpeedNumberBadge();
        $('#speed_number_badge').show();
        canvas.requestRenderAll();
    }
}

function setAllSelectable(selectable) {
    canvas.getObjects().forEach((obj) => { obj.selectable = selectable; });
}

// ---------------------------------------------------------------------------
// Background layer
//
// A Word header/footer-style toggle: exactly one layer is "active" at a
// time. The active layer is fully interactive; the other one is dimmed and
// can't be clicked at all, so set-piece drawing (background) never competes
// for clicks with the lighting layout (foreground), or vice versa. New
// items are created on whichever layer is currently active (see the insert
// mouse:up handler); existing items can be moved between layers via the
// inspector's "Background" checkbox.
function toggleBackgroundEditMode() {
    backgroundEditMode = !backgroundEditMode;
    canvas.discardActiveObject(); // a selection from the layer just deactivated no longer applies
    $('#toggle_background_layer').toggleClass('selected', backgroundEditMode);
    render.setActiveLayer(activeLayerName());
    clearInspector();
    refreshEditMenuState();
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

let discardingSelection = false;

canvas.on('object:modified', (e) => {
    // Fabric's own discardActiveObject() checks canvas._currentTransform.target
    // === the object being discarded, and if so runs endCurrentTransform() ->
    // _finalizeCurrentTransform() *before* clearing _currentTransform — which
    // re-fires this very 'object:modified' event on the same ActiveSelection
    // (actionPerformed never gets cleared) for as long as _currentTransform
    // still points at it. Without this guard, calling discardActiveObject()
    // below re-enters this handler synchronously, which calls it again, and
    // so on, until the call stack overflows.
    if (discardingSelection) return;

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
        discardingSelection = true;
        try {
            canvas.discardActiveObject();
        } finally {
            discardingSelection = false;
        }
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
        // /2 halves zoom sensitivity per wheel tick — trackpad ctrl-scroll
        // deltaY can be large per event, making the un-dampened rate feel
        // twitchy on some machines.
        zoom *= 1.01 ** (-deltaY / 8);
        if (zoom > ZOOM_MAX) zoom = ZOOM_MAX;
        if (zoom < ZOOM_MIN) zoom = ZOOM_MIN;
        canvas.zoomToPoint({ x: offsetX, y: offsetY }, zoom);
    } else {
        canvas.relativePan({ x: -opt.e.deltaX, y: -opt.e.deltaY });
    }
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
    // Fabric only finalizes a drag/scale/rotate via a mouseup it actually
    // receives on the canvas element itself — a fast or wide drag easily
    // ends with the pointer over the navbar, the properties panel, or the
    // footer instead (the panel especially, since it now defaults to
    // expanded and overlaps the canvas). When that happens the mouseup goes
    // to whatever's on top instead of the canvas, so Fabric never fires its
    // own 'mouse:up'/'object:modified' — the transform (and, for a
    // multi-selection, the whole ActiveSelection) is left stuck mid-gesture
    // with unconverted relative coordinates, no cursor reset, and no way to
    // finish it. Making that chrome click-through for the gesture's duration
    // guarantees the release always reaches the canvas instead.
    $('.navbar, #floating-panel, #footer').css('pointer-events', 'none');
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
    if (MODE.action === 'speed-number') {
        positionSpeedNumberBadge(opt.e.clientX, opt.e.clientY);
    }
});

canvas.on('mouse:up', (opt) => {
    isPanning = false;
    $('.navbar, #floating-panel, #footer').css('pointer-events', '');
    if (!downInfo) return;
    const info = downInfo;
    downInfo = null;

    const wasClick = info.button === 0
        && Math.hypot(opt.e.clientX - info.x, opt.e.clientY - info.y) < CLICK_DRAG_THRESHOLD;

    if (MODE.action === 'insert') {
        // Only insert on a plain left-click on empty canvas — not on
        // drag-ends, pans, or clicks on existing objects.
        if (!wasClick || info.target) return;
        store.checkpoint();
        const item = store.createItem({
            show_id: currentShowId,
            type: MODE.type,
            shape: MODE.subtype,
            x: opt.scenePoint.x,
            y: opt.scenePoint.y,
            // A blank Textbox renders nothing and can't be clicked to edit,
            // so give it a starting caption the way other item types get one
            // for free from their symbol/shape.
            label: MODE.type === 'shape' && MODE.subtype === 'text' ? 'Text' : undefined,
            layer: activeLayerName(),
        });
        render.renderItem(item);
        refreshHistoryButtons();
    } else if (MODE.action === 'speed-number') {
        // Only a fixture, clicked (not dragged), counts — everything else is
        // silently ignored so a stray click on a position/shape/empty canvas
        // doesn't cost the pending number.
        if (!wasClick || !info.target || info.target.itemType !== 'fixture') return;
        assignSpeedNumber(info.target);
    }
});

// ---------------------------------------------------------------------------
// Speed-numbering — click fixtures in sequence to stamp channel or dimmer
// numbers onto them, incrementing after each one (as on an ETC console's
// speed-numbering mode). MODE.subtype holds which field ('channel' or
// 'dimmer') while this mode is active.

let speedNumberNext = 1;

function updateSpeedNumberBadge() {
    const label = MODE.subtype === 'dimmer' ? 'Dim' : 'Ch';
    $('#speed_number_badge').text(`${label} ${speedNumberNext}`);
}

function positionSpeedNumberBadge(clientX, clientY) {
    $('#speed_number_badge').css({ left: `${clientX}px`, top: `${clientY}px` });
}

function assignSpeedNumber(obj) {
    const item = store.getItem(obj.id);
    if (!item || item.locked) return; // locked accepts no change, same as everywhere else

    const field = MODE.subtype;
    store.checkpoint();
    store.updateItemField(obj.id, field, speedNumberNext);
    render.updateItemText(obj.id, field, speedNumberNext);
    refreshHistoryButtons();

    speedNumberNext = Math.min(SPEED_NUMBER_MAX, speedNumberNext + SPEED_NUMBER_STEP);
    updateSpeedNumberBadge();
}

function enterSpeedNumberMode(field) {
    speedNumberNext = 1;
    switchMode('speed-number', null, field);
}

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
            } else if (key === 'layer') {
                // 'layer' is a 'foreground'/'background' string, not a bool —
                // truthiness alone would show every item as checked.
                $field.prop('checked', common[key] === 'background');
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
    const rawValue = isCheckbox ? $(this).prop('checked') : $(this).val();
    // 'layer' is stored as a 'foreground'/'background' string, not the raw
    // checkbox boolean.
    const value = name === 'layer' ? (rawValue ? 'background' : 'foreground') : rawValue;
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
        } else if (name === 'layer') {
            render.setItemLayer(obj.id, value);
        } else {
            render.updateItemText(obj.id, name, value);
        }
    });
    // Moving the selection to the inactive layer just made it non-selectable
    // out from under itself — drop the (now stale) selection rather than
    // leave selection handles on an object that can no longer be reselected.
    if (name === 'layer' && value !== activeLayerName()) {
        canvas.discardActiveObject();
        canvas.requestRenderAll();
        clearInspector();
        refreshEditMenuState();
    }
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
    $('#layer_up, #layer_down, #layer_top, #layer_bottom')
        .toggleClass('is-disabled', selectedCount === 0);
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
        delete fields.zindex; // let createItem put the copy on top, not wherever its source was stacked
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

// ---------------------------------------------------------------------------
// Layer order
//
// The canvas's own stacking order IS the z-order — there's no separate
// z-index property to keep in sync, just each item's position in
// canvas.getObjects(). The grid (added first, never tagged with an id) stays
// fixed at the very back; everything below reorders only among the tagged
// items themselves so a layer command can never push something under it.

// Bottom-to-top, matching store.getItems()'s zindex order (see render.js's
// renderAll, which restacks to this same order after a full redraw).
function itemObjectsInOrder() {
    return canvas.getObjects().filter((obj) => obj.id);
}

function applyLayerOrder(order) {
    let cursor = 1; // index 0 is the grid
    order.forEach((obj) => {
        canvas.moveObjectTo(obj, cursor);
        cursor += 1;
        // A box/circle/line/arrow's caption is a sibling object, not a group
        // child (see render.js's SHAPE_LABEL_OFFSET comment) — without this
        // it would stay wherever it was, and could end up buried under some
        // other shape that just moved in front of it.
        if (obj.itemType === 'shape') {
            const label = render.getShapeLabel(obj.id);
            if (label) {
                canvas.moveObjectTo(label, cursor);
                cursor += 1;
            }
        }
    });
    canvas.requestRenderAll();
    store.setItemsOrder(order.map((obj) => obj.id));
}

// direction: 'up'/'down' nudge one step, 'top'/'bottom' go all the way.
// Multiple selected objects move as a block, keeping their relative order —
// for the one-step cases that means walking the selection bottom-first for
// 'up' and top-first for 'down', so an object already moved doesn't get
// leapfrogged by the next one still waiting its turn.
function layerSelection(direction) {
    const selected = new Set(canvas.getActiveObjects().filter((obj) => {
        const item = store.getItem(obj.id);
        return !(item && item.locked);
    }));
    if (selected.size === 0) return;

    let order = itemObjectsInOrder();

    if (direction === 'top' || direction === 'bottom') {
        const selectedItems = order.filter((obj) => selected.has(obj));
        const others = order.filter((obj) => !selected.has(obj));
        order = direction === 'top' ? [...others, ...selectedItems] : [...selectedItems, ...others];
    } else {
        const step = direction === 'up' ? 1 : -1;
        const selectedInOrder = order.filter((obj) => selected.has(obj));
        const sequence = direction === 'up' ? selectedInOrder : [...selectedInOrder].reverse();
        sequence.forEach((obj) => {
            const i = order.indexOf(obj);
            const j = i + step;
            if (j < 0 || j >= order.length) return;
            [order[i], order[j]] = [order[j], order[i]];
        });
    }

    store.checkpoint();
    applyLayerOrder(order);
    refreshHistoryButtons();
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

$('#speed_number_channel').click(() => enterSpeedNumberMode('channel'));
$('#speed_number_dimmer').click(() => enterSpeedNumberMode('dimmer'));

$('#layer_up').click(() => layerSelection('up'));
$('#layer_down').click(() => layerSelection('down'));
$('#layer_top').click(() => layerSelection('top'));
$('#layer_bottom').click(() => layerSelection('bottom'));

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

$('#toggle_background_layer').click(toggleBackgroundEditMode);

$('#toggle-panel').click(() => {
    $('#floating-panel').toggleClass('expanded');
});

// Bulma's navbar-burger is markup/CSS only — it doesn't wire up its own
// click-to-toggle, that's left to the page. Toggles both the burger itself
// (for its own active styling) and the menu it points at via data-target.
$('.navbar-burger').click(function () {
    const opening = !$(this).hasClass('is-active');
    $(this).toggleClass('is-active');
    $('#' + $(this).data('target')).toggleClass('is-active');
    // Start from fully collapsed every time the menu reopens, rather than
    // however it happened to be left last time.
    if (!opening) $('.navbar-item.has-dropdown, .nested.dropdown').removeClass('is-active');
});

// On mobile, both Bulma's own dropdowns (File/Edit/Insert) and this app's
// nested flyout submenus (Align/Distribute/... under Edit, Fixtures/... under
// Insert) are built around :hover, which doesn't exist on touch — see the
// matching CSS in styles.css. Below the desktop breakpoint they're driven as
// closed-by-default accordions instead; above it, hover already works and
// these handlers deliberately do nothing so desktop behavior is untouched.
function isMobileMenu() {
    return window.matchMedia('(max-width: 1023px)').matches;
}

$('.navbar-item.has-dropdown > .navbar-link').click(function (e) {
    if (!isMobileMenu()) return;
    e.preventDefault();
    const $item = $(this).parent();
    const wasActive = $item.hasClass('is-active');
    $('.navbar-item.has-dropdown').removeClass('is-active'); // only one top-level section open at a time
    $item.toggleClass('is-active', !wasActive);
});

$('.nested.dropdown > .navbar-item').click(function (e) {
    if (!isMobileMenu()) return;
    e.preventDefault();
    e.stopPropagation();
    const $nested = $(this).parent();
    const wasActive = $nested.hasClass('is-active');
    $nested.siblings('.nested.dropdown').removeClass('is-active'); // only one flyout open at a time within its parent
    $nested.toggleClass('is-active', !wasActive);
});

// Picking an actual action (as opposed to opening a File/Edit/Insert or
// Align/Distribute/... header) closes the whole mobile menu, the way a
// mobile nav is expected to behave — otherwise the user has to go dismiss it
// by hand after every tap.
$('#main_nav').on('click', 'a', function () {
    if (!isMobileMenu()) return;
    const isTrigger = $(this).hasClass('navbar-link') || $(this).siblings('.dropdown-menu').length > 0;
    if (isTrigger) return;
    $('.navbar-burger, #main_nav').removeClass('is-active');
    $('.navbar-item.has-dropdown, .nested.dropdown').removeClass('is-active');
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
    } else if (!inField && e.key === 'PageUp') {
        e.preventDefault();
        layerSelection(e.shiftKey ? 'top' : 'up');
    } else if (!inField && e.key === 'PageDown') {
        e.preventDefault();
        layerSelection(e.shiftKey ? 'bottom' : 'down');
    } else if (MODE.action === 'speed-number' && !inField
        && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const delta = { ArrowUp: SPEED_NUMBER_STEP, ArrowDown: -SPEED_NUMBER_STEP, ArrowRight: SPEED_NUMBER_BIG_STEP, ArrowLeft: -SPEED_NUMBER_BIG_STEP }[e.key];
        speedNumberNext = Math.min(SPEED_NUMBER_MAX, Math.max(SPEED_NUMBER_MIN, speedNumberNext + delta));
        updateSpeedNumberBadge();
    } else if (e.key === 'Escape') {
        closeLoadShowModal();
        switchMode('default', null, null);
    }
});

// Belt and suspenders for the pointer-events toggle above: a window-level
// listener restores it on literally any mouseup, bubbling or not, even one
// Fabric's own canvas-scoped listener never sees (e.g. the button released
// outside the browser viewport entirely) — so the chrome can never be left
// stuck click-through.
window.addEventListener('mouseup', () => {
    $('.navbar, #floating-panel, #footer').css('pointer-events', '');
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
