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

// Which inspector fields apply to which item type.
const INSPECTOR_FIELDS = {
    fixture: ['label', 'dimmer', 'channel', 'gel'],
    position: ['label'],
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
// Persistence of canvas edits

function applyNumberChanges(changes) {
    changes.forEach((c) => render.updateItemText(c.id, 'number', c.number ?? ''));
}

// Saves an object's placement and, for fixtures, re-resolves which position
// it hangs on.
function persistObject(obj) {
    if (!obj.id) return;
    store.updateItemLocation(obj.id, obj.left, obj.top, obj.scaleX, obj.scaleY, obj.angle);

    if (obj.itemType === 'fixture') {
        const position = canvas.getObjects().find(
            (o) => o.itemType === 'position' && obj.intersectsWithObject(o));
        const changes = store.assignFixtureToPosition(obj.id, position ? position.id : null);
        applyNumberChanges(changes);
    }
}

canvas.on('object:modified', (e) => {
    const obj = e.target;
    if (!obj) return;

    // A multi-selection reports child coordinates relative to the selection;
    // discard it first so absolute coordinates are restored, then persist
    // each child individually.
    if (obj instanceof fabric.ActiveSelection) {
        const children = obj.getObjects();
        canvas.discardActiveObject();
        children.forEach((child) => persistObject(child));
        canvas.requestRenderAll();
        return;
    }
    persistObject(obj);
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

    const item = store.createItem({
        show_id: currentShowId,
        type: MODE.type,
        shape: MODE.subtype,
        x: opt.scenePoint.x,
        y: opt.scenePoint.y,
    });
    render.renderItem(item);
});

// ---------------------------------------------------------------------------
// Selection and inspector

function updateInspector(ids) {
    const items = store.getItemsByIds(ids);

    $('#inspector input').val('');

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
        $(`#inspector input[name=${key}]`).val(common[key]);
    }
}

function updateSelection(evt) {
    // Multi-selections are move-only: scaling/rotating a group would corrupt
    // per-item placement data.
    if (evt.selected.length > 1) {
        const group = canvas.getActiveObject();
        group.hasControls = false;
    }
    updateInspector(evt.selected.map((obj) => obj.id));
}

canvas.on('selection:created', updateSelection);
canvas.on('selection:updated', updateSelection);
canvas.on('selection:cleared', () => {
    $('#inspector input').val('');
});

function deleteSelected() {
    const objs = canvas.getActiveObjects();
    if (objs.length === 0) return;
    if (!confirm('Delete selected items?')) return;

    canvas.discardActiveObject();
    objs.forEach((obj) => {
        const changes = store.deleteItem(obj.id);
        render.removeItemObject(obj.id);
        applyNumberChanges(changes);
    });
    canvas.requestRenderAll();
}

// Inspector edits apply to every selected object, restricted to the fields
// that exist for its type.
$('#inspector input').change(function () {
    const name = $(this).attr('name');
    const value = $(this).val();
    canvas.getActiveObjects().forEach((obj) => {
        const item = store.getItem(obj.id);
        if (!item) return;
        const editable = INSPECTOR_FIELDS[item.type] || [];
        if (!editable.includes(name)) return;
        store.updateItemField(obj.id, name, value);
        render.updateItemText(obj.id, name, value);
    });
});

$('#show_inspector input').change(function () {
    const name = $(this).attr('name');
    const value = $(this).val();
    store.updateShowField(currentShowId, name, value);
    if (name === 'name') refreshShowSelect();
});

// ---------------------------------------------------------------------------
// Menus and keyboard

$('#save').click(() => {
    store.saveData();
    statusToast('saved');
});

$('#load').click(() => {
    if (store.isDirty() && !confirm('Discard unsaved changes and reload the last save?')) return;
    boot();
});

$('#new_show').click(() => {
    const name = prompt('New show name:', 'New Show');
    if (!name) return;
    const show = store.createShow({ name });
    switchShow(show.id);
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

$(document).keydown((e) => {
    if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        store.saveData();
        statusToast('saved');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
            deleteSelected();
        }
    } else if (e.key === 'Escape') {
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
