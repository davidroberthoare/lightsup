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
export function applyTextFlip(group) {
    if (!group || !group._objects) return;
    const angle = ((group.angle % 360) + 360) % 360;
    const flipped = angle > 90 && angle < 270;
    group._objects.forEach((sub) => {
        if (sub.type === 'text') {
            sub.set('flipX', flipped);
            sub.set('flipY', flipped);
        }
    });
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

    return new fabric.Group([symbol, number, label, dimmer, dimmerText, channel, channelText, gel], {
        left: 0,
        top: 0,
        lockScalingX: true,
        lockScalingY: true,
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
};

async function createShape(item) {
    const kind = item.shape;
    let main;
    let labelTop;

    if (kind === 'box') {
        const { width, height } = SHAPE_DEFAULTS.box;
        main = new fabric.Rect({
            width, height,
            fill: 'rgba(255,255,255,0.6)',
            stroke: 'black',
            strokeWidth: 1,
            originX: 'center',
            originY: 'center',
        });
        labelTop = height / 2 + 10;
    } else if (kind === 'circle') {
        const { radius } = SHAPE_DEFAULTS.circle;
        main = new fabric.Circle({
            radius,
            fill: 'rgba(255,255,255,0.6)',
            stroke: 'black',
            strokeWidth: 1,
            originX: 'center',
            originY: 'center',
        });
        labelTop = radius + 10;
    } else if (kind === 'line') {
        const { length } = SHAPE_DEFAULTS.line;
        main = new fabric.Line([-length / 2, 0, length / 2, 0], {
            stroke: 'black',
            strokeWidth: 2,
            originX: 'center',
            originY: 'center',
        });
        labelTop = -14;
    } else if (kind === 'arrow') {
        const { length, headSize } = SHAPE_DEFAULTS.arrow;
        const shaft = new fabric.Line([-length / 2, 0, length / 2 - headSize, 0], {
            stroke: 'black',
            strokeWidth: 2,
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
        labelTop = -14;
    } else {
        throw new Error(`Unknown shape: ${kind}`);
    }

    const label = makeText(item.label, {
        left: 0,
        top: labelTop,
        fontSize: FONT_SIZE - 1,
        itemType: 'label',
    });

    return new fabric.Group([main, label], {
        left: 0,
        top: 0,
        itemType: 'shape',
    });
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

    const group = new fabric.Group([symbol, label], {
        left: 0,
        top: 0,
        lockScalingY: true, // pipes stretch horizontally only
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
function attachPositionDragHandlers(group) {
    let childFixtures = [];
    let originalPositions = [];

    group.on('mousedown', () => {
        childFixtures = canvas.getObjects().filter((obj) =>
            obj.id !== group.id && obj.itemType === 'fixture' && group.intersectsWithObject(obj));
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
    });
    applyTextFlip(group);
    canvas.add(group);
    if (group.adjustScaling) group.adjustScaling();
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
}

// Full redraw — only for initial load and show switching.
export async function renderAll(items) {
    renderTokens.clear();
    canvas.clear();
    drawGrid();
    await Promise.all(items.map((item) => renderItem(item)));
    canvas.requestRenderAll();
}

// Updates one text element (number, label, dimmer, channel, gel) in place.
export function updateItemText(id, field, value) {
    const obj = getObjectById(id);
    if (!obj || !obj._objects) return;
    obj._objects.forEach((sub) => {
        if (sub.itemType === field) {
            sub.set('text', String(value ?? ''));
        }
    });
    canvas.requestRenderAll();
}
