////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// CONSTANTS

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 20;
const FONT_SIZE = 8;
const FONT = "Arial";
const MODE = {action: "default", "type": null, "subtype": null}; // action: add, edit, delete, select


// GLOBALS
let selectedItems = []; //used in selection and editing functions to temporarily remember selected items
let childFixtures = []; //used in selection and editing functions to temporarily remember fixtures that intersect with position items

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



const default_show = {
    id: 'default',
    name: "My Show",
    company: "A Great Company",
    venue: "Grand Theatre",
    designer: "D. Signer",
    date: "Jan 1, 2030"
};

var current_show_id = localStorage.getItem('current_show_id') || 'default';

// Save the current_show_id to localStorage whenever it changes
function setCurrentShowId(showId) {
  current_show_id = showId;
  localStorage.setItem('current_show_id', showId);
}





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
            fill: 'white',
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
            itemType: 'number'
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
            itemType: 'label'
        });

        // Load the dimmer symbol (SVG)
        const dimmer = await loadSVG('/img/symbols/util/dimmer.svg');
        dimmer.set({
            left: 0,
            top: -10,
            originX: 'center',
            originY: 'center',
            fill: 'white',
        });

        // Create the dimmer text
        const dimmerText = new fabric.Text(item.dimmer, {
            left: 0,
            top: -10,
            fontSize: FONT_SIZE,
            fontFamily: FONT,
            fill: '#000000',
            originX: 'center',
            originY: 'center',
            itemType: 'dimmer'
        });


        // Create the channel symbol (circle)
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

        // Create the channel text
        const channelText = new fabric.Text(item.channel, {
            left: 0,
            top: -30,
            fontSize: FONT_SIZE,
            fontFamily: FONT,
            originX: 'center',
            originY: 'center',
            itemType: 'channel'
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
            itemType: 'gel'
        });

        // Group all elements together
        const group = new fabric.Group([symbol, number, label, dimmer, dimmerText, channel, channelText, gel], {
            left: 0,
            top: 0,
            lockScalingX:true,
            lockScalingY:true,
            itemType: 'fixture'
        });

        return group;

    } catch (error) {
        console.error('Error creating fixture:', error);
        return false;
    }
}


async function createPosition(item) {
    // console.log("creating fixture...", item)
    try {

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

        // Create the label
        const label = new fabric.Text(item.label, {
            left: 0,
            top: -8,
            fontSize: FONT_SIZE-2,
            fontFamily: FONT,
            fill: '#000000',
            originX: 'center',
            originY: 'center',
            itemType: 'label'
        });


        // Group all elements together
        const group = new fabric.Group([symbol, label], {
            left: 0,
            top: 0,
            // lockScalingX:true,
            lockScalingY:true,
            itemType: 'position'
        });


        group.adjustScaling = () => {
            const inverseScaleX = 1 / group.scaleX;
            const inverseScaleY = 1 / group.scaleY;
            // console.log(`group.scaleX: ${group.scaleX}, group.scaleY: ${group.scaleY} inverseScaleX: ${inverseScaleX}, inverseScaleY: ${inverseScaleY}`);
            label.set({scaleX: inverseScaleX, scaleY: inverseScaleY});
            canvas.renderAll();
        }

        group.on("scaling", () => {
            group.adjustScaling();
        });


        return group;

    } catch (error) {
        console.error('Error creating fixture:', error);
        return false;
    }
}



// add shapes
function drawItem(item) {
    // console.log("drawing item", item);
    if(item.type=="fixture"){
        createFixture(item).then((i) => {
            i.set({
                left: item.x,
                top: item.y,
                scaleX: item.scalex || 1,
                scaleY: item.scaley || 1,
                angle: item.angle,
                id: item.id,
                position: item.position
            });

            // flip text if the fixture is upside down
            if(item.angle > 90 && item.angle < 270){
                i._objects.forEach(subObject => {
                    if (subObject.type === 'text') { // Check if the sub-object is of type 'text'
                        subObject.set('flipX', true); 
                        subObject.set('flipY', true); 
                    }
                });
            }


            canvas.add(i);

            // console.log("fixture drawn", i);
        });
    }

    else if(item.type=="position"){
        createPosition(item).then((i) => {
            i.set({
                left: item.x,
                top: item.y,
                scaleX: item.scalex || 1,
                scaleY: item.scaley || 1,
                angle: item.angle,
                id: item.id,
            });

            // flip text if the fixture is upside down
            if(item.angle > 90 && item.angle < 270){
                i._objects.forEach(subObject => {
                    if (subObject.type === 'text') { // Check if the sub-object is of type 'text'
                        subObject.set('flipX', true); 
                        subObject.set('flipY', true); 
                    }
                });
            }

            // functions for moving related child fixtures
            let originalPositions = []; // To store the original positions of childFixtures
            i.on("mousedown", function (event) {
                // console.log("position MouseDOWN Evt", event)
                const position = event.target;
                childFixtures = [];
                // console.log("Checking intersections for position", position)
                canvas.getObjects().forEach(obj => {
                    if(obj.id==position.id) return; //don't include itself
                    if(obj.itemType!='fixture') return; //don't include anything other than fixtures

                    if(position.intersectsWithObject(obj)){
                        // console.log("found intersection!")
                        childFixtures.push(obj); 
                    }
                });
                // console.log("child fixtures", childFixtures)

                // console.log("storing original positions")
                // Store the original positions of childFixtures when movement starts
                originalPositions = childFixtures.map((obj) => ({
                    obj: obj,
                    left: obj.left,
                    top: obj.top,
                }));
            });

            i.on("moving", function(event){
                // console.log("MOVING", event)
                if(childFixtures.length>0){
                    const deltaX = event.transform.target.left - event.transform.original.left;
                    const deltaY = event.transform.target.top - event.transform.original.top;
                    // console.log("deltas", deltaX, deltaY)
                    childFixtures.forEach((obj, index) => {
                        const original = originalPositions[index];
                        obj.left = original.left + deltaX;
                        obj.top = original.top + deltaY;
                        obj.setCoords(); // Update the object's coordinates
                    });
                    canvas.renderAll();
                }
            })

            i.on("mouseup", function(event){
                // console.log("Position MouseUP", event);
                if(childFixtures.length>0){
                    childFixtures.forEach((obj)=>{
                        // console.log("triggering modified object", obj)
                        canvas.fire('object:modified', {target: obj});
                    });
                }
                childFixtures = [];//clear it
                
            })

            canvas.add(i);
            i.adjustScaling();

            // console.log("position drawn", i);
        });
    }

}







////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// DATABASE FUNCTIONS


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

// Function to redraw a single item from DB data
function redrawItem(id){
    const item = alasql('SELECT * FROM items WHERE id = ?', [id])[0];
    console.log("redrawing item", id, item);
    try{
        let obj = getObjectById(id)
        console.log("found item to remove", obj);
        canvas.remove(obj);
        canvas.renderAll();
    }catch(error){
        console.error("Error removing object", id, error);
    }
    drawItem(item);
    canvas.renderAll();
    // console.log("redrew item", item);
}

function updateItemLocation(id, x, y, scalex, scaley, angle) {
    // console.log("updating item position", id, x, y, angle);
    alasql('UPDATE items SET x = ?, y = ?, scalex = ?, scaley = ?, angle = ? WHERE id = ?', [x, y, scalex, scaley, angle, id]);
}

function updateItemData(id, name, value) {
    console.log("updating item data", id, name, value);
    alasql(`UPDATE items SET ${name} = ? WHERE id = ?`, [value, id]);
}

function createItem(type, shape, x, y, scalex, scaley, angle, number, label, channel, dimmer, gel) {
    console.log("creating item", type, shape, x, y, scalex, scaley, angle, number, label, channel, dimmer, gel);
    try {
        alasql('INSERT INTO items (id, type, shape, x, y, scalex, scaley, angle, position, number, label, channel, dimmer, gel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [generateRandomString(12), type, shape, x, y, scalex, scaley, angle, "", number, label, channel, dimmer, gel]);
    }
    catch (error) { console.error("Error creating item", error); }
    
}

function deleteItem(id) {
    alasql('DELETE FROM items WHERE id=?', [id]);
}


function updateShowData(id, name, value) {
    console.log("updating show data", id, name, value);
    alasql(`UPDATE shows SET ${name} = ? WHERE id = ?`, [value, id]);
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// UI FUNCTIONS

function switchMode(mode, type, subtype){
    console.log("switching mode", mode, type, subtype);
    MODE.action = mode;
    MODE.type = type;
    MODE.subtype = subtype;

    // reset any changeable aspects to 'default' first
    $(".navbar-item").removeClass("selected");
    canvas.defaultCursor = "pointer";
    
    // change the UI based on the new mode
    
    if(mode=="insert"){
        $('#menu_insert').addClass("selected");
        canvas.defaultCursor = "crosshair";
    }
}

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



// Update the inspector with the common properties of the selected items
function updateShowInspector() {
    let show = alasql('SELECT * FROM shows WHERE id = ?', [current_show_id])[0];
    console.log("found show:", show);
    // if there's no show, create a default one
    if(!show) {
        show = default_show;
        console.log("No show found, using default", show);
        alasql('INSERT INTO shows VALUES ?', [show]);
    }
    console.log("show", show);

    // Clear the inspector
    $("#inspector input").val("");

    // update the inspector with the common values
    for (let key in show) {
        $(`#show_inspector input[name=${key}]`).val(show[key]);
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


function updatePositionNumbering(movedFixture, positionId){
    console.log("updating position numbering", movedFixture.position, movedFixture.id, positionId);
    if(positionId){
        const posFixtures = alasql('SELECT * FROM items WHERE position = ? ORDER BY x DESC, y DESC', [positionId]);
        // console.log("fixtures", posFixtures);
        posFixtures.forEach((fixture, index) => {
            alasql('UPDATE items SET number = ? WHERE id = ?', [index+1, fixture.id]);
            redrawItemData(fixture.id, 'number', index+1);
        });
    }else{
        //if this object used to have a position, update the numbering of the remaining fixtures in that position
        if(movedFixture.position){
            console.log("no position found, renumbering fixtures in previous position");
            const posFixtures = alasql('SELECT * FROM items WHERE position = ? ORDER BY x DESC, y DESC', [movedFixture.position]);
            // console.log("fixtures", posFixtures);
            posFixtures.forEach((fixture, index) => {
                alasql('UPDATE items SET number = ? WHERE id = ?', [index+1, fixture.id]);
                redrawItemData(fixture.id, 'number', index+1);
            });
            console.log("setting position to null");
            //and also set this item's position to null
            alasql('UPDATE items SET position = ? WHERE id = ?', ["", movedFixture.id]);
            redrawItemData(movedFixture, 'number', '');
        }else{
            //if this object didn't have a previous position, and is still not intersecting with a position, set its number to "" just to be sure
            console.log("didn't have previous position data")
            alasql('UPDATE items SET number = ? WHERE id = ?', ["", movedFixture.id]);
            redrawItemData(movedFixture, 'number', '');
        }
    }
}



function redrawItemData(obj, name, value){
    if(typeof obj === 'string'){
        obj = getObjectById(obj);
    }
    // console.log("redrawing item data", obj, name, value);
    obj._objects.forEach(subObject => {
        // console.log("subObject", subObject);
        if (subObject.itemType === name) { // Check if the sub-object is of type 'text'
            // console.log("found one!", subObject)
            subObject.set('text', String(value));
        }
    });
    canvas.requestRenderAll();
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
        redrawItemData(obj, name, value);
        // redrawItem(obj.id);
    });

    // setTimeout(() => {
    //     selectMultipleObjects(selectedItems);
    // }, 500);
});

// edits in the inspector sends updates to the selected objects
$("#show_inspector input").change(function () {
    console.log("inspector change", $(this).attr("name"), $(this).val());
    let name = $(this).attr("name");
    let value = $(this).val();
    updateShowData(current_show_id, name, value);
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
        canvas.renderAll();
        lastPosX = e.clientX;
        lastPosY = e.clientY;
    }
});

canvas.on('mouse:up', (opt) => {
    // console.log("mouse up", opt.e);
    const evt = opt;
    isPanning = false;
    if(MODE.action=="insert"){
        createItem(MODE.type, MODE.subtype, evt.scenePoint.x, evt.scenePoint.y, 1.0, 1.0, 0, 0,  "", "", "", "");
        drawLayoutFromDB();
    }
});


// when an object is changed, update the DB
canvas.on('object:modified', function (e) {
    console.log("object modified", e);
    const obj = e.target;
    updateItemLocation(obj.id, obj.left, obj.top, obj.scaleX, obj.scaleY, obj.angle);

    if(obj.itemType=="fixture"){
        // check if the fixture is intersecting with a position
        const objects = canvas.getObjects();
        var found = false;
        for (let j = 0; j < objects.length; j++) {
            const position = objects[j];
            if(position.itemType != 'position') continue; // don't include anything other than positions
            if(obj.intersectsWithObject(position)){
                console.log("found intersection with Position!");
                console.log("updating position data", obj.id, position.id);
                updateItemData(obj.id, "position", position.id);
                updatePositionNumbering(obj, position.id);
                found = true;
                break; // stop the loop completely
            }
        }
        if(found===false){
            updateItemData(obj.id, "position", "");
            updatePositionNumbering(obj, false);
        }
    }
});

// when an object is rotated, correct the text orientation
canvas.on('object:rotating', function (e) {
    const obj = e.target;
    // flip text if the fixture is upside down
    obj._objects.forEach(subObject => {
        if (subObject.type === 'text') { // Check if the sub-object is of type 'text'
            subObject.set('flipX', (obj.angle > 90 && obj.angle < 270)); 
            subObject.set('flipY', (obj.angle > 90 && obj.angle < 270)); 
        }
    });
});



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
    drawLayoutFromDB();
});

$("#menu_insert").on("click", "a", function () {
    let type = $(this).attr("data-type");
    let subtype = $(this).attr("data-subtype");
    switchMode("insert", type, subtype);
});





// Capture ctrl+s key for SAVE
$(document).keydown(function (e) {
    // console.log("Keydown", e.key);
    if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveData();
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
        if(!$("#inspector input").is(":focus") && !$("#show_inspector input").is(":focus")){
            deleteSelected();
        }
    }
    else if (e.key === 'Escape') {
        switchMode("default", null, null);
    }
});


$("#toggle-panel").click(function(){
    $("#floating-panel").toggleClass("expanded");
});

$(document).ready(function () {
    console.log("Document ready");
    // initDB();
    loadData();
    drawLayoutFromDB();
    updateShowInspector();
});



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// UTILITIES

//fetch a single object by ID
function getObjectById(id) {
    let obj = null;
    canvas.getObjects().forEach((object) => {
        if (object.id === id) {
            obj = object;
        }
    });
    return obj;
}

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


function statusToast(msg, myclass, duration){
    if(duration===undefined) duration = 3000;
    if(myclass===undefined) myclass = 'good';

    $("#status_2").text(msg)
    $("#status_2").addClass(myclass)
    $("#status_2").fadeIn(200)
    setTimeout(function() {
        $("#status_2").fadeOut(200, function() {
            $("#status_2").removeClass(myclass);
        });
    }, duration);
}