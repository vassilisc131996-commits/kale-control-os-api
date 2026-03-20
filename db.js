// db.js — SQLite setup with better-sqlite3 (synchronous, perfect for single-user)
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'kale.db');
const db = new Database(DB_PATH);

// WAL mode = better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────
// All collections store JSON blobs keyed by a string id.
// This avoids schema migrations and mirrors the localStorage structure exactly.
// One table per collection = easy to query, backup, and export.

const COLLECTIONS = [
'ings', 'recs', 'invs', 'sups', 'waste',
'sales', 'cal_entries', 'debts', 'staff',
'shifts', 'tasks', 'recurring', 'logbook'
];

// Generic collection table: id (text PK) + data (JSON blob) + timestamps
COLLECTIONS.forEach(name => {
db.exec(`CREATE TABLE IF NOT EXISTS ${name} ( id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) )`);
});

// Params = single-row key/value store
db.exec(`CREATE TABLE IF NOT EXISTS params ( key   TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')) )`);

// ─── Generic CRUD helpers ─────────────────────────────────────────────────────

function listAll(table) {
return db.prepare(`SELECT data FROM ${table} ORDER BY created_at ASC`)
.all()
.map(r => JSON.parse(r.data));
}

function getOne(table, id) {
const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
return row ? JSON.parse(row.data) : null;
}

function upsert(table, id, obj) {
const data = JSON.stringify({ ...obj, id });
db.prepare(`INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(id, data);
return JSON.parse(data);
}

function remove(table, id) {
const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
return info.changes > 0;
}

// Bulk replace — used for initial sync from localStorage
function bulkReplace(table, items) {
const tx = db.transaction((rows) => {
db.prepare(`DELETE FROM ${table}`).run();
const stmt = db.prepare(`INSERT INTO ${table} (id, data, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))`);
rows.forEach(row => {
const id = row.id || String(Date.now() + Math.random());
stmt.run(id, JSON.stringify({ ...row, id }));
});
});
tx(items);
return listAll(table);
}

// Params helpers
function getParams() {
const rows = db.prepare(`SELECT key, value FROM params`).all();
return rows.reduce((acc, r) => ({ ...acc, [r.key]: JSON.parse(r.value) }), {});
}

function setParams(obj) {
const tx = db.transaction((o) => {
const stmt = db.prepare(`INSERT INTO params (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
Object.entries(o).forEach(([k, v]) => stmt.run(k, JSON.stringify(v)));
});
tx(obj);
return getParams();
}

module.exports = { listAll, getOne, upsert, remove, bulkReplace, getParams, setParams, COLLECTIONS };
