////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CONSTANTS

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 20;
const FONT_SIZE = 8;
const FONT = "Arial";

// GLOBALS
let selectedItems = []; //used in selection and editing functions to temporarily remember selected items

// DRAWING SCALE IS MEASURED IN CENTIMETERS
const GRID_OPTIONS = {
    size: 50, // in CM
    color: '#dddddd',
    thickness: 1,
    pageSize: 1000, // in CM - - total rendered area is actually 3 times this setting
};


// Initialize Fabric.js canvas
const container = document.getElementById('container');
const canvas = new fabric.Canvas(document.getElementById('paper'), {
    width: container.offsetWidth,
    height: container.offsetHeight,
    imageSmoothingEnabled: false,
    fireMiddleClick : true,
});
canvas.setZoom(1.5);// initial zoom level





////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// DRAWING FUNCTIONS

// Function to draw the grid
function drawGrid() {
    // console.log("drawing grid")
    const lines = [];
    
    for (let i = -GRID_OPTIONS.pageSize; i <= GRID_OPTIONS.pageSize*2; i=i+GRID_OPTIONS.size) {
        const lineVert = new fabric.Line([i, -GRID_OPTIONS.pageSize, i, GRID_OPTIONS.pageSize*2], {
            stroke: GRID_OPTIONS.color,
            strokeWidth: GRID_OPTIONS.thickness,
            selectable: false,
            evented: false,
        });
        lines.push(lineVert);
    }
    for (let i = -GRID_OPTIONS.pageSize; i <= GRID_OPTIONS.pageSize*2; i=i+GRID_OPTIONS.size) {
        const lineVert = new fabric.Line([-GRID_OPTIONS.pageSize, i, GRID_OPTIONS.pageSize*2, i], {
            stroke: GRID_OPTIONS.color,
            strokeWidth: GRID_OPTIONS.thickness,
            selectable: false,
            evented: false,
        });
        lines.push(lineVert);
    }

    const grid = new fabric.Group(lines, {
        selectable: false,
        evented: false,
        width: GRID_OPTIONS.pageSize*2, 
        height: GRID_OPTIONS.pageSize*2,
        objectCaching: false,
    });
    canvas.add(grid);
    grid.sendObjectToBack()
    canvas.renderAll();
}


// Utility function to load SVG from URL and return a promise
function loadSVG(url) {
    // console.log("loading svg", url);
    return new Promise((resolve, reject) => {
        fabric.loadSVGFromURL(url).then(({ objects }) => {
            // console.log("objects", objects)
            try {
                var obj = fabric.util.groupSVGElements(objects);
                resolve(obj);
            } catch (error) {
                console.error("Failed to load SVG", url, error);
                reject(new Error('Failed to load SVG'));
            }
        });
    });
}


async function createFixture(item) {
    // console.log("creating fixture...", item)
    try {
        // Load the main symbol (SVG)
        const symbol = await loadSVG(`/img/symbols/fixtures/${item.shape}.svg`);
        symbol.set({
            left: 0,
            top: 0,
            originX: 'center',
            originY: 'top',
        });

        // Create the number text
        const num = item.number !== undefined ? item.number : '';
        const number = new fabric.Text(String(num), {
            left: 0,
            top: (symbol.height * symbol.scaleY) / 2,
            fontSize: FONT_SIZE-2,
            fontFamily: FONT,
            fill: '#000000',
            originX: 'center',
            originY: 'center',
        });

        // Create the label
        const label = new fabric.Text(item.label, {
            left: 0,
            top: -45,
            fontSize: FONT_SIZE-2,
            fontFamily: FONT,
            fill: '#000000',
            originX: 'center',
            originY: 'center',
        });

        // Load the dimmer symbol (SVG)
        const dimmer = await loadSVG('/img/symbols/util/dimmer.svg');
        dimmer.set({
            left: 0,
            top: 0,
            originX: 'center',
            originY: 'center',
        });

        // Create the dimmer text
        const dimmerText = new fabric.Text(item.dimmer, {
            left: 0,
            top: 0,
            fontSize: FONT_SIZE,
            fontFamily: FONT,
            fill: '#000000',
            originX: 'center',
            originY: 'center',
        });

        // Group dimmer elements together
        const dimmerGroup = new fabric.Group([dimmer, dimmerText], {
            left: 0,
            top: -10,
            originX: 'center',
            originY: 'center',
        });

        // Create the channel symbol (circle)
        const channel = new fabric.Circle({
            left: 0,
            top: 0,
            radius: 10,
            fill: false,
            stroke: 'black',
            strokeWidth: 0.5,
            originX: 'center',
            originY: 'center',
        });

        // Create the channel text
        const channelText = new fabric.Text(item.channel, {
            left: 0,
            top: 0,
            fontSize: FONT_SIZE,
            fontFamily: FONT,
            originX: 'center',
            originY: 'center',
        });

        // Group channel elements together
        const channelGroup = new fabric.Group([channel, channelText], {
            left: 0,
            top: -30,
            originX: 'center',
            originY: 'center',
        });

        // Create the gel text
        const gel = new fabric.Text(item.gel, {
            left: 0,
            top: (symbol.height * symbol.scaleY) + 5,
            fontSize: FONT_SIZE,
            fontFamily: FONT,
            fill: '#000000',
            originX: 'center',
            originY: 'top',
        });

        // Group all elements together
        const group = new fabric.Group([symbol, number, label, dimmerGroup, channelGroup, gel], {
            left: 0,
            top: 0,
            lockScalingX:true,
            lockScalingY:true,
        });

        return group;

    } catch (error) {
        console.error('Error creating fixture:', error);
        return false;
    }
}



// add shapes
function drawItem(item) {
    // const newShape = new shapes.custom[item.type]();
    if(item.type=="fixture"){
        createFixture(item).then((f) => {
            f.set({
                left: item.x,
                top: item.y,
                angle: item.angle,
                id: item.id,
            });
            canvas.add(f);
        });
    }

}








////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// DATABASE FUNCTIONS


// Initialize the database
function initDB() {
    alasql('CREATE TABLE IF NOT EXISTS items (id STRING PRIMARY KEY, type STRING, shape STRING, x INT, y INT, angle INT, number INT, label STRING, channel STRING, dimmer STRING, gel STRING)');
    alasql('DELETE FROM items');
}

// Load data from localStorage
function loadData() {
    initDB();
    const data = localStorage.getItem('items');
    if (data) {
        const items = JSON.parse(data);
        items.forEach(item => {
            alasql('INSERT INTO items VALUES ?', [item]);
        });
    }
    drawLayoutFromDB();
}


// Save data to localStorage
function saveData() {
    const items = alasql('SELECT * FROM items');
    console.log("saving data", items);
    localStorage.setItem('items', JSON.stringify(items));
}


// Function to refresh the layout based on DB Positions and Items
function drawLayoutFromDB() {
    canvas.clear();
    drawGrid();
    canvas.renderAll();
    // //then load the new stuff
    const items = alasql('SELECT * FROM items');
    items.forEach(item => {
        drawItem(item);
    });
}

// Function to redraw a single item
function redrawItem(id){
    const item = alasql('SELECT * FROM items WHERE id = ?', [id])[0];
    console.log("redrawing item", id, item);
    canvas.getObjects().forEach(obj => {
        if(obj.id === id){
            canvas.remove(obj);
            drawItem(item);
        }
    });
}

function updateItemPosition(id, x, y, angle) {
    // console.log("updating item position", id, x, y, angle);
    alasql('UPDATE items SET x = ?, y = ?, angle = ? WHERE id = ?', [x, y, angle, id]);
}

function updateItemData(id, name, value) {
    console.log("updating item data", id, name, value);
    alasql(`UPDATE items SET ${name} = ? WHERE id = ?`, [value, id]);
}

function createItem(type, shape, x, y, angle, number, label, channel, dimmer, gel) {
    console.log("creating item", type, shape, x, y, angle, number, label, channel, dimmer, gel);
    try {
        alasql('INSERT INTO items (id, type, shape, x, y, angle, number, label, channel, dimmer, gel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [generateRandomString(12), type, shape, x, y, angle, number, label, channel, dimmer, gel]);
    }
    catch (error) { console.error("Error creating item", error); }
    
}

function deleteItem(id) {
    alasql('DELETE FROM items WHERE id=?', [id]);
}



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// UI FUNCTIONS

// Delete selected items
function deleteSelected() {   
    if(confirm("Delete selected items?")){
        canvas.getActiveObjects().forEach(obj => {
            deleteItem(obj.id);
            canvas.remove(obj);
        });
        drawLayoutFromDB();   
    }
}

// Update the inspector with the common properties of the selected items
function updateInspector(ids) {
    let id_str = ids.map(id => `'${id}'`).join(', ');
    // console.log("updateInspector", id_str);
    let items = alasql(`SELECT * FROM items WHERE id IN (${id_str})`);
    console.log("found items:", items);

    // Clear the inspector
    $("#inspector input").val("");

    // find common properties
    let common = {};
    items.forEach(item => {
        for (let key in item) {
            if (common[key] === undefined) {
                common[key] = item[key];
            } else if (common[key] !== item[key]) {
                common[key] = "*";
            }
        }
    });

    console.log("common", common);
    // update the inspector with the common values
    for (let key in common) {
        $(`#inspector input[name=${key}]`).val(common[key]);
    }

}


// updates UI when selection is created or updated
function updateSelection(evt) { 
    
    console.log("selection:created or updated", evt);
    selectedItems = [];
    evt.selected.forEach(obj => {
        selectedItems.push(obj.id); 
    });

    // prevent scaling of multiple selected objects
    if(evt.selected.length>1){
        console.log("Multiple objects selected");
        let group = canvas.getActiveObject();
        group.hasControls = false;
    }

    let ids = evt.selected.map(obj => obj.id);
    console.log("Selected items", ids);

    updateInspector(ids);

}



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// EVENTS

// edits in the inspector sends updates to the selected objects
$("#inspector input").change(function () {
    console.log("inspector change", $(this).attr("name"), $(this).val());
    let name = $(this).attr("name");
    let value = $(this).val();
    canvas.getActiveObjects().forEach(obj => {
        updateItemData(obj.id, name, value);
        redrawItem(obj.id);
    });

    setTimeout(() => {
        selectMultipleObjects(selectedItems);
    }, 100);
});


// ////////////////////////////////////////////////////////////////////////////////
// MOUSE EVENTS

// canvas scrolling zoom
canvas.on('mouse:wheel', (opt) => {
    opt.e.preventDefault();
    opt.e.stopPropagation();
    const { deltaY, offsetX, offsetY } = opt.e
    if(opt.e.ctrlKey) {
        let zoom = canvas.getZoom()
        zoom *= 1.01 ** -deltaY
        if (zoom > ZOOM_MAX) zoom = ZOOM_MAX
        if (zoom < ZOOM_MIN) zoom = ZOOM_MIN
        canvas.zoomToPoint({ x: offsetX, y: offsetY }, zoom)
    }
    
    //pan canvas
    canvas.relativePan({ x: -opt.e.deltaX, y: -opt.e.deltaY })
})


// middle mouse button panning
let isPanning = false;
let lastPosX = 0;
let lastPosY = 0;

canvas.on('mouse:down', (opt) => {
    // console.log("mouse down", opt.e.button);
    if (opt.e.button === 1) { // Middle mouse button
        isPanning = true;
        lastPosX = opt.e.clientX;
        lastPosY = opt.e.clientY;
    }
});

canvas.on('mouse:move', (opt) => {
    // console.log("mouse move", opt.e);
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
    // console.log("mouse up", opt.e.button);
    isPanning = false;
});


// when an object is changed, update the DB
canvas.on('object:modified', function (e) {
    console.log("object modified", e.target);
    const obj = e.target;
    updateItemPosition(obj.id, obj.left, obj.top, obj.angle);
});


// canvas.on('mouse:down', function (evt) {
//     console.log("mouse down", evt);
// });

// when items are selected
canvas.on('selection:updated', function(evt) {
    updateSelection(evt);
});
canvas.on('selection:created', function(evt) {
    updateSelection(evt);
});


canvas.on('selection:cleared', function(evt) {
    // Handle deselection here
    // console.log("selection:cleared", evt);
    $("#inspector input").val("");
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MENU EVENTS

// $("#add").click(function () {
//     // createItem("fixture", randomPositionOnPaper().x, randomPositionOnPaper().y, 0);
//     createItem("fixture", 200, 200, 0, "Label", "123", "234", "Gel");
//     drawLayoutFromDB();
// });

$("#save").click(function () {
    saveData();
});

$("#load").click(function () {
    loadData();
});

$("#menu_insert a").click(function () {
    let type = $(this).attr("data-type");
    createItem("fixture", type, 200, 200, 0, 0, "", "", "", "");
    drawLayoutFromDB();
});





// Capture ctrl+s key for SAVE
$(document).keydown(function (e) {
    // console.log("Keydown", e.key);
    if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveData();
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
        if(!$("#inspector input").is(":focus")){
            deleteSelected();
        }
    }
});


$("#toggle-panel").click(function(){
    $("#floating-panel").toggleClass("expanded");
});

$(document).ready(function () {
    console.log("Document ready");
    // initDB();
    loadData();
});



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// UTILITIES

// Function to select multiple objects programmatically
function selectMultipleObjects(ids) {
    // Create an ActiveSelection with the objects
    // console.log("Selecting multiple objects", ids);
    let objects = [];
    let allObjects = canvas.getObjects();
    // console.log("all objects", allObjects);
    allObjects.forEach(obj => {
        // console.log("checking object", obj, obj.id, ids);
        if (ids.includes(obj.id)) {
            console.log("adding object to selection", obj);
            objects.push(obj);
        }
    });
    // console.log("creating active selection", objects);
    const activeSelection = new fabric.ActiveSelection(objects, {
        canvas: canvas
    });

    // Set the active object to the selection
    canvas.setActiveObject(activeSelection);
    canvas.renderAll();
}


function randomPositionOnPaper() {
    let pos = {};
    pos.x = Math.floor(Math.random() * (canvas.width - 100));
    pos.y = Math.floor(Math.random() * (canvas.height - 100));
    return pos;
}

function generateRandomString(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}
