// Render layer: mirrors store items onto the Fabric.js canvas. This module
// owns no authoritative state — every fabric object is a disposable view of a
// DB row, tagged with the row's id and an itemType so it can be found and
// updated incrementally.

const fabric = globalThis.fabric;

const FONT_SIZE = 8;
const FONT = 'Arial';

// Drawing scale is measured in centimeters.
const GRID_OPTIONS = {
    size: 50, // in CM
    color: '#dddddd',
    thickness: 1,
    pageSize: 1000, // in CM — total rendered area is 3x this setting
};

let canvas = null;

// SVGs are fetched once and cloned per use.
const svgCache = new Map();

// Guards against async races: each renderItem call takes a token, and only
// the latest render (or removal) for a given id is allowed to complete.
const renderTokens = new Map();

export function initCanvas(canvasEl, container) {
    canvas = new fabric.Canvas(canvasEl, {
        width: container.offsetWidth,
        height: container.offsetHeight,
        imageSmoothingEnabled: false,
        fireMiddleClick: true,
    });
    canvas.setZoom(1.5);
    return canvas;
}

export function getCanvas() {
    return canvas;
}

// Box/circle/line/arrow captions aren't tagged with the item's id (they're
// a separate synced object, not a group child — see the comment above
// SHAPE_LABEL_OFFSET) so callers that need to keep one paired with its shape
// in the stacking order (layer up/down/top/bottom) can't find it via
// getObjectById.
export function getShapeLabel(id) {
    return shapeLabels.get(id) || null;
}

export function getObjectById(id) {
    return canvas.getObjects().find((obj) => obj.id === id) || null;
}

// ---------------------------------------------------------------------------
// Building blocks

function loadSVG(url) {
    if (!svgCache.has(url)) {
        svgCache.set(url, fabric.loadSVGFromURL(url).then(({ objects }) => fabric.util.groupSVGElements(objects)));
    }
    return svgCache.get(url).then((obj) => obj.clone());
}

export function drawGrid() {
    const lines = [];
    for (let i = -GRID_OPTIONS.pageSize; i <= GRID_OPTIONS.pageSize * 2; i += GRID_OPTIONS.size) {
        lines.push(new fabric.Line([i, -GRID_OPTIONS.pageSize, i, GRID_OPTIONS.pageSize * 2], {
            stroke: GRID_OPTIONS.color,
            strokeWidth: GRID_OPTIONS.thickness,
            selectable: false,
            evented: false,
        }));
        lines.push(new fabric.Line([-GRID_OPTIONS.pageSize, i, GRID_OPTIONS.pageSize * 2, i], {
            stroke: GRID_OPTIONS.color,
            strokeWidth: GRID_OPTIONS.thickness,
            selectable: false,
            evented: false,
        }));
    }
    const grid = new fabric.Group(lines, {
        selectable: false,
        evented: false,
        width: GRID_OPTIONS.pageSize * 2,
        height: GRID_OPTIONS.pageSize * 2,
        objectCaching: false,
    });
    canvas.add(grid);
    grid.sendObjectToBack();
    canvas.requestRenderAll();
}

// Text sub-objects flip when the group is upside down so labels stay readable.
// Also applies directly to a standalone text object (the freestanding text
// tool isn't wrapped in a group — its own text IS the item).
export function applyTextFlip(group) {
    if (!group) return;
    const angle = ((group.angle % 360) + 360) % 360;
    const flipped = angle > 90 && angle < 270;
    if (group._objects) {
        group._objects.forEach((sub) => {
            if (sub.type === 'text') {
                sub.set('flipX', flipped);
                sub.set('flipY', flipped);
            }
        });
    } else if (group.type === 'textbox' || group.type === 'text') {
        group.set('flipX', flipped);
        group.set('flipY', flipped);
    }
}

function makeText(value, options) {
    return new fabric.Text(String(value ?? ''), {
        fontSize: FONT_SIZE,
        fontFamily: FONT,
        fill: '#000000',
        originX: 'center',
        originY: 'center',
        ...options,
    });
}

async function createFixture(item) {
    const symbol = await loadSVG(`./img/symbols/fixtures/${item.shape}.svg`);
    symbol.set({
        left: 0,
        top: 0,
        originX: 'center',
        originY: 'top',
        fill: 'white',
    });

    const number = makeText(item.number, {
        left: 0,
        top: (symbol.height * symbol.scaleY) / 2,
        fontSize: FONT_SIZE - 2,
        itemType: 'number',
    });

    const label = makeText(item.label, {
        left: 0,
        top: -45,
        fontSize: FONT_SIZE - 2,
        itemType: 'label',
    });

    const dimmer = await loadSVG('./img/symbols/util/dimmer.svg');
    dimmer.set({
        left: 0,
        top: -10,
        originX: 'center',
        originY: 'center',
        fill: 'white',
    });

    const dimmerText = makeText(item.dimmer, {
        left: 0,
        top: -10,
        itemType: 'dimmer',
    });

    const channel = new fabric.Circle({
        left: 0,
        top: -30,
        radius: 10,
        fill: 'white',
        stroke: 'black',
        strokeWidth: 0.5,
        originX: 'center',
        originY: 'center',
    });

    const channelText = makeText(item.channel, {
        left: 0,
        top: -30,
        itemType: 'channel',
    });

    const gel = makeText(item.gel, {
        left: 0,
        top: (symbol.height * symbol.scaleY) + 5,
        originY: 'top',
        itemType: 'gel',
    });

    // lockScalingX/Y (fixtures never resize) is applied uniformly by
    // applyLockState/INHERENT_SCALE_LOCK in renderItem, not set here.
    return new fabric.Group([symbol, number, label, dimmer, dimmerText, channel, channelText, gel], {
        left: 0,
        top: 0,
        itemType: 'fixture',
    });
}

// Generic drawing shapes. Unlike fixtures/positions these have no locked
// scaling axes — free resize via the normal corner handles is the point.
const SHAPE_DEFAULTS = {
    box: { width: 120, height: 70 },
    circle: { radius: 45 },
    line: { length: 150 },
    arrow: { length: 150, headSize: 18 },
    text: { width: 220, fontSize: 16 },
};

// The freestanding text tool is a plain fabric.Textbox, not wrapped in a
// group — its own text content IS the item (there's no separate caption).
// This is what gives it Textbox's native behavior: dragging a side handle
// rewraps the text at the new width without changing font size, dragging a
// corner handle scales the text like any other object. No custom code needed
// for that split — it's Textbox's default control behavior.
function createTextObject(item) {
    return new fabric.Textbox(item.label || '', {
        left: 0,
        top: 0,
        width: item.width || SHAPE_DEFAULTS.text.width,
        fontSize: SHAPE_DEFAULTS.text.fontSize,
        fontFamily: FONT,
        fill: '#000000',
        originX: 'center',
        originY: 'center',
        itemType: 'shape',
    });
}

// Shapes resize freely on both axes (unlike fixtures/positions, which lock
// one or both). A caption *nested inside* the same scaled group can't be
// kept both a fixed font size and a fixed distance from the shape's edge at
// once: countering the group's scaleY on the label's own scaleY fixes the
// font size, but the label's (left, top) offset is still a coordinate
// *inside* that same scaled space, so as soon as it's compensated to track
// the shape's growing edge, the group's own scale re-multiplies it right
// back — there's no single number that satisfies both constraints
// simultaneously from inside the group. (Position/pipe labels dodge this
// because they lock scaleY to 1, so the offset axis never actually moves.)
//
// So the caption for these shapes is a separate, sibling canvas object, not
// a group child: non-interactive, always scale 1 (constant font size), and
// repositioned from the shape's own live geometry (its rendered half-extent
// in scene units, which correctly grows/shrinks with the shape) every time
// the shape moves, scales, or rotates. shapeLabels maps item id -> caption.
const shapeLabels = new Map();
const SHAPE_LABEL_MARGIN = 10; // scene units, unscaled — matches the old nested-label margin

// How far below (positive) or above (negative) the shape's own center the
// caption sits, and which of the shape's own dimensions that's measured
// from — mirrors each shape's prior nested-label placement.
const SHAPE_LABEL_OFFSET = {
    box: (obj) => (obj.height * obj.scaleY) / 2 + SHAPE_LABEL_MARGIN,
    circle: (obj) => (obj.height * obj.scaleY) / 2 + SHAPE_LABEL_MARGIN,
    line: () => -14,
    arrow: () => -14,
};

function positionShapeLabel(mainObj, kind) {
    const label = shapeLabels.get(mainObj.id);
    if (!label) return;
    const offset = SHAPE_LABEL_OFFSET[kind] ? SHAPE_LABEL_OFFSET[kind](mainObj) : 0;
    // Rotate the "straight down" offset vector (0, offset) by the shape's
    // angle, so the caption stays on "its" side as the shape turns, without
    // rotating the caption's own text. Fabric's angle is clockwise-positive
    // on screen (Y-down), which for a (0, offset) input vector works out to
    // (-offset*sin, offset*cos) — the minus on the x term is not a typo.
    const rad = fabric.util.degreesToRadians(mainObj.angle || 0);
    label.set({
        left: mainObj.left - offset * Math.sin(rad),
        top: mainObj.top + offset * Math.cos(rad),
    });
}

async function createShape(item) {
    const kind = item.shape;
    if (kind === 'text') return createTextObject(item);

    let main;

    if (kind === 'box') {
        const { width, height } = SHAPE_DEFAULTS.box;
        main = new fabric.Rect({
            width, height,
            fill: 'rgba(255,255,255,0.6)',
            stroke: 'black',
            strokeWidth: 1,
            strokeUniform: true,
            originX: 'center',
            originY: 'center',
        });
    } else if (kind === 'circle') {
        const { radius } = SHAPE_DEFAULTS.circle;
        main = new fabric.Circle({
            radius,
            fill: 'rgba(255,255,255,0.6)',
            stroke: 'black',
            strokeWidth: 1,
            strokeUniform: true,
            originX: 'center',
            originY: 'center',
        });
    } else if (kind === 'line') {
        const { length } = SHAPE_DEFAULTS.line;
        main = new fabric.Line([-length / 2, 0, length / 2, 0], {
            stroke: 'black',
            strokeWidth: 2,
            strokeUniform: true,
            originX: 'center',
            originY: 'center',
        });
    } else if (kind === 'arrow') {
        const { length, headSize } = SHAPE_DEFAULTS.arrow;
        const shaft = new fabric.Line([-length / 2, 0, length / 2 - headSize, 0], {
            stroke: 'black',
            strokeWidth: 2,
            strokeUniform: true,
            originX: 'center',
            originY: 'center',
        });
        const head = new fabric.Triangle({
            left: length / 2 - headSize / 2,
            top: 0,
            width: headSize,
            height: headSize,
            fill: 'black',
            angle: 90,
            originX: 'center',
            originY: 'center',
        });
        main = new fabric.Group([shaft, head], { originX: 'center', originY: 'center' });
    } else {
        throw new Error(`Unknown shape: ${kind}`);
    }

    main.itemType = 'shape';
    main.on('moving', () => positionShapeLabel(main, kind));
    main.on('scaling', () => positionShapeLabel(main, kind));
    main.on('rotating', () => positionShapeLabel(main, kind));
    return main;
}

// Creates (or replaces) the caption for a box/circle/line/arrow and does an
// initial sync to the shape's current position. Called from renderItem once
// the shape has its final id/left/top/scale/angle set.
function renderShapeLabel(mainObj, item) {
    const kind = item.shape;
    if (!SHAPE_LABEL_OFFSET[kind]) return;

    const existing = shapeLabels.get(item.id);
    if (existing) canvas.remove(existing);

    const label = makeText(item.label, {
        fontSize: FONT_SIZE - 1,
        selectable: false,
        evented: false,
        itemType: 'label',
        opacity: mainObj.opacity, // matches whatever applyLayerState just set on the shape itself
    });
    shapeLabels.set(item.id, label);
    canvas.add(label);
    positionShapeLabel(mainObj, kind);
}

function removeShapeLabel(id) {
    const label = shapeLabels.get(id);
    if (label) {
        canvas.remove(label);
        shapeLabels.delete(id);
    }
}

async function createPosition(item) {
    const symbol = new fabric.Rect({
        left: 0,
        width: 333,
        top: 0,
        height: 5,
        fill: 'white',
        stroke: 'black',
        strokeWidth: 0.5,
        originX: 'center',
        originY: 'center',
    });

    const label = makeText(item.label, {
        left: 0,
        top: -8,
        fontSize: FONT_SIZE - 2,
        itemType: 'label',
    });

    // lockScalingY (pipes stretch horizontally only) is applied uniformly by
    // applyLockState/INHERENT_SCALE_LOCK in renderItem, not set here.
    const group = new fabric.Group([symbol, label], {
        left: 0,
        top: 0,
        itemType: 'position',
    });

    // Keep the label legible when the pipe is stretched.
    group.adjustScaling = () => {
        label.set({ scaleX: 1 / group.scaleX, scaleY: 1 / group.scaleY });
        canvas.requestRenderAll();
    };
    group.on('scaling', () => group.adjustScaling());

    attachPositionDragHandlers(group);
    return group;
}

// Dragging a position carries the fixtures hanging on it along. On mouseup,
// each moved fixture fires object:modified so the controller persists it.
// Locked fixtures are excluded — being carried along is a movement, and a
// locked object gets none, even indirectly via its parent position.
function attachPositionDragHandlers(group) {
    let childFixtures = [];
    let originalPositions = [];

    group.on('mousedown', () => {
        childFixtures = canvas.getObjects().filter((obj) =>
            obj.id !== group.id && obj.itemType === 'fixture' && !obj.locked && group.intersectsWithObject(obj));
        originalPositions = childFixtures.map((obj) => ({ left: obj.left, top: obj.top }));
    });

    group.on('moving', (event) => {
        if (childFixtures.length === 0) return;
        const deltaX = event.transform.target.left - event.transform.original.left;
        const deltaY = event.transform.target.top - event.transform.original.top;
        childFixtures.forEach((obj, index) => {
            obj.left = originalPositions[index].left + deltaX;
            obj.top = originalPositions[index].top + deltaY;
            obj.setCoords();
        });
        canvas.requestRenderAll();
    });

    group.on('mouseup', () => {
        childFixtures.forEach((obj) => canvas.fire('object:modified', { target: obj }));
        childFixtures = [];
    });
}

// ---------------------------------------------------------------------------
// Locking
//
// A locked object stays selectable (so it can be found and unlocked again)
// but accepts no other change: no move/scale/rotate/skew, no in-place text
// editing, no resize handles. Unlocking must restore each item type's own
// inherent constraints (e.g. a fixture is permanently non-scalable whether
// or not it's "locked" in this feature's sense) rather than clearing every
// lock flag to false, so those are tracked separately per type here.
const INHERENT_SCALE_LOCK = {
    fixture: { x: true, y: true },
    position: { x: false, y: true }, // pipes stretch horizontally only
    shape: { x: false, y: false },
};

function applyLockState(obj, locked, inherent = { x: false, y: false }) {
    obj.locked = !!locked;
    obj.lockMovementX = !!locked;
    obj.lockMovementY = !!locked;
    obj.lockRotation = !!locked;
    obj.lockSkewingX = !!locked;
    obj.lockSkewingY = !!locked;
    obj.lockScalingX = !!locked || inherent.x;
    obj.lockScalingY = !!locked || inherent.y;
    obj.hasControls = !locked;
    if (obj.type === 'textbox') obj.editable = !locked;
}

// Toggles lock state on an already-rendered object without a full redraw.
export function setItemLocked(id, locked, itemType) {
    const obj = getObjectById(id);
    if (!obj) return;
    applyLockState(obj, locked, INHERENT_SCALE_LOCK[itemType] || { x: false, y: false });
    canvas.requestRenderAll();
}

// ---------------------------------------------------------------------------
// Background layer
//
// Items are tagged 'foreground' or 'background' (see store.js). Exactly one
// of those is "active" at a time (main.js's backgroundEditMode) — active-
// layer items are fully interactive, the other layer is dimmed and can't be
// clicked at all (evented false, not just unselectable), so it never
// competes for clicks with whatever the user is actually working on. Every
// object is tagged with its own itemLayer at render time so this can be
// re-applied without needing to consult the store.
const INACTIVE_LAYER_OPACITY = 0.3;
let currentLayer = 'foreground';

function applyLayerState(obj) {
    const active = obj.itemLayer === currentLayer;
    const opacity = active ? 1 : INACTIVE_LAYER_OPACITY;
    obj.set({ opacity, selectable: active, evented: active });
    if (obj.itemType === 'shape') {
        const label = shapeLabels.get(obj.id);
        if (label) label.set('opacity', opacity);
    }
}

// Switches which layer is interactive, re-applying to everything already on
// the canvas (a full redraw isn't needed — this is purely an interaction/
// opacity toggle, not a data change).
export function setActiveLayer(layer) {
    currentLayer = layer;
    canvas.getObjects().forEach((obj) => {
        if (obj.id) applyLayerState(obj);
    });
    canvas.requestRenderAll();
}

// Moves a single already-rendered item between layers (the inspector's
// "Background" checkbox) without a full redraw.
export function setItemLayer(id, layer) {
    const obj = getObjectById(id);
    if (!obj) return;
    obj.itemLayer = layer;
    applyLayerState(obj);
    canvas.requestRenderAll();
}

// ---------------------------------------------------------------------------
// Incremental rendering

// Creates (or replaces) the canvas object for a store item.
export async function renderItem(item) {
    const token = Symbol('render');
    renderTokens.set(item.id, token);

    let group;
    if (item.type === 'fixture') {
        group = await createFixture(item);
    } else if (item.type === 'position') {
        group = await createPosition(item);
    } else if (item.type === 'shape') {
        group = await createShape(item);
    } else {
        return null;
    }

    // A newer render, a removal, or a full redraw superseded this call while
    // the SVGs were loading.
    if (renderTokens.get(item.id) !== token) return null;

    const existing = getObjectById(item.id);
    if (existing) canvas.remove(existing);

    group.set({
        left: item.x,
        top: item.y,
        scaleX: item.scalex || 1,
        scaleY: item.scaley || 1,
        angle: item.angle || 0,
        id: item.id,
        itemLayer: item.layer || 'foreground',
    });
    applyTextFlip(group);
    applyLockState(group, item.locked, INHERENT_SCALE_LOCK[item.type]);
    applyLayerState(group);
    canvas.add(group);
    if (group.adjustScaling) group.adjustScaling();
    if (item.type === 'shape') renderShapeLabel(group, item);
    canvas.requestRenderAll();
    return group;
}

export function removeItemObject(id) {
    renderTokens.set(id, Symbol('removed')); // cancels any in-flight render
    const obj = getObjectById(id);
    if (obj) {
        canvas.remove(obj);
        canvas.requestRenderAll();
    }
    removeShapeLabel(id);
}

// Full redraw — only for initial load and show switching. `items` must
// already be in bottom-to-top stacking order (store.getItems() orders by
// zindex) — each renderItem() call resolves whenever its own SVG happens to
// load, not in array order, so without this explicit re-sort afterwards the
// on-screen stacking order would depend on SVG load timing instead of the
// order the user actually set.
export async function renderAll(items) {
    renderTokens.clear();
    shapeLabels.clear(); // canvas.clear() below destroys the label objects themselves
    canvas.clear();
    drawGrid(); // occupies index 0; items are restacked starting at index 1
    await Promise.all(items.map((item) => renderItem(item)));
    let cursor = 1;
    items.forEach((item) => {
        const obj = getObjectById(item.id);
        if (!obj) return;
        canvas.moveObjectTo(obj, cursor);
        cursor += 1;
        // Keep a box/circle/line/arrow's caption paired right above it — it's
        // a sibling canvas object, not a group child, so it isn't otherwise
        // touched by this re-sort (see getShapeLabel).
        const label = shapeLabels.get(item.id);
        if (label) {
            canvas.moveObjectTo(label, cursor);
            cursor += 1;
        }
    });
    canvas.requestRenderAll();
}

// Updates one text element (number, label, dimmer, channel, gel) in place.
// The freestanding text tool has no sub-objects — its own text IS the label.
// Box/circle/line/arrow captions are a separate synced object (shapeLabels),
// not a sub-object, for the reasons in the comment above SHAPE_LABEL_OFFSET.
export function updateItemText(id, field, value) {
    const obj = getObjectById(id);
    if (!obj) return;
    if (obj._objects) {
        obj._objects.forEach((sub) => {
            if (sub.itemType === field) {
                sub.set('text', String(value ?? ''));
            }
        });
    } else if (field === 'label' && typeof obj.text === 'string') {
        obj.set('text', String(value ?? ''));
    } else if (field === 'label' && shapeLabels.has(id)) {
        shapeLabels.get(id).set('text', String(value ?? ''));
    }
    canvas.requestRenderAll();
}
