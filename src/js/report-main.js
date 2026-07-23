// Report page controller: reads the saved data for the current show and
// renders the instrument schedule with Tabulator.

import * as store from './store.js';
import { escapeHtml } from './util.js';

const Tabulator = globalThis.Tabulator;

store.loadData();
const showId = store.getCurrentShowId();
const items = store.getInstrumentSchedule(showId);

new Tabulator('#report', {
    data: items,
    columns: [
        { title: 'Num', field: 'number' },
        { title: 'Fixture', field: 'shape' },
        { title: 'Label', field: 'label' },
        { title: 'Dimmer', field: 'dimmer' },
        { title: 'Channel', field: 'channel' },
        { title: 'Gel', field: 'gel' },
    ],
    index: 'id',
    height: 'calc(100vh - 7em)',
    layout: 'fitColumns',
    movableColumns: true,
    pagination: true,
    printAsHtml: true,
    groupBy: (data) => data.p_label || '(none)',
    groupHeader: (value, count) =>
        `${escapeHtml(value)}<span style='color:#666; margin-left:10px;'>(${count} items)</span>`,
});

const show = store.getShow(showId);
if (show) {
    document.title = `${show.name} - Report`;
    document.querySelectorAll('#title_block div[data-id]').forEach((el) => {
        el.textContent = show[el.dataset.id] ?? '';
    });
} else {
    console.error(`No show found with id: ${showId}`);
}
