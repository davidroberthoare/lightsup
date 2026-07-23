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
    refreshShowSelect();
}

function refreshShowSelect() {
    const select = document.getElementById('show_select');
    select.innerHTML = '';
    store.getShows().forEach((show) => {
        const option = document.createElement('option');
        option.value = show.id;
        option.textContent = show.name;
        option.selected = show.id === currentShowId;
        select.appendChild(option);
    });
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
    refreshShowSelect();
    updateShowInspector();
    clearInspector();
    refreshHistoryButtons();
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
}

canvas.on('selection:created', updateSelection);
canvas.on('selection:updated', updateSelection);
canvas.on('selection:cleared', clearInspector);

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
    if (name === 'name') refreshShowSelect();
    refreshHistoryButtons();
});

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

$('#show_select').change(function () {
    switchShow($(this).val());
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
