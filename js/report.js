loadData();
// const items = alasql(`
// SELECT p.label as p_label, i.* FROM items as p 
// INNER JOIN items as i ON p.id = i.position AND i.type='fixture'
// WHERE p.type = 'position'
// ORDER BY p_label, i.number
// `);

const items = alasql(`
SELECT 
    i.*, 
    (SELECT p.label FROM items AS p WHERE p.id = i.position AND p.type = 'position') AS p_label
FROM items AS i
WHERE i.type = 'fixture'
ORDER BY p_label, i.number
`);
console.log("items", items);
var table = new Tabulator("#report", {
    data: items,
    // autoColumns: true,
    columns:[
        // {title:"Type", field:"type"},
        // {title:"Position", field:"p_label"},
        {title:"Num", field:"number"},
        {title:"Fixture", field:"shape"},
        {title:"Label", field:"label"},
        {title:"Dimmer", field:"dimmer"},
        {title:"Channel", field:"channel"},
        {title:"Gel", field:"gel"},
    ],
    index: "id",
    height: "calc(100vh - 7em)",
    layout: "fitColumns",
    movableColumns: true, //enable user movable columns
    pagination:true, //enable pagination.
    // printHeader:"",
    // printFooter:"<h4>Example Table Footer<h2>",
    printAsHtml:true,
    // initialSort: [
    //     {column:"type", dir:"asc"},
    //     {column:"number", dir:"asc"},
    // ],
    groupBy:function(data){
        //data - the data object for the row being grouped
        return data.p_label || "(none)"; //groups by data and age
    },
    groupHeader:function(value, count, data, group){
        let str = value + "<span style='color:#666; margin-left:10px;'>(" + count + " items)</span>";
        return str;
    },
});