////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GENERIC DATABASE FUNCTIONS


// Initialize the database
function initDB(wipe) {
    if(wipe===true){
        alasql("DROP TABLE items");
    }
    alasql(`CREATE TABLE IF NOT EXISTS items (
        id STRING PRIMARY KEY,
        type STRING, 
        shape STRING, 
        x INT, 
        y INT, 
        angle INT, 
        scalex FLOAT, 
        scaley FLOAT,
        position STRING, 
        number INT, 
        label STRING, 
        channel STRING, 
        dimmer STRING, 
        gel STRING
        )`);
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
}


// Save data to localStorage
function saveData() {
    const items = alasql('SELECT * FROM items');
    console.log("saving data", items);
    localStorage.setItem('items', JSON.stringify(items));
}