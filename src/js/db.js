////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// GENERIC DATABASE FUNCTIONS

// Initialize the database
function initDB(wipe) {

    if(wipe===true){
        alasql("DROP TABLE shows");
    }
    alasql(`CREATE TABLE IF NOT EXISTS shows (
        id STRING PRIMARY KEY,
        name STRING, 
        company STRING, 
        venue STRING, 
        designer STRING, 
        date STRING
        )`);
    alasql('DELETE FROM shows');
    
    // // create default show if it doesn't exist
    // const show = alasql('SELECT * FROM shows WHERE id = "default"');    
    // if (show.length === 0) {
    //     alasql('INSERT INTO shows VALUES ?', [default_show]);
    // }

// create items table if it doesn't exist
    // and delete all items if wipe is true
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

    const show_data = localStorage.getItem('shows');
    if (show_data) {
        const shows = JSON.parse(show_data);
        shows.forEach(show => {
            alasql('INSERT INTO shows VALUES ?', [show]);
        });
    }


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
    
    const shows = alasql('SELECT * FROM shows');
    console.log("saving data", shows);
    localStorage.setItem('shows', JSON.stringify(shows));

    statusToast("saved");
}

