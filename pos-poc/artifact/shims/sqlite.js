// API mínima de node:sqlite (DatabaseSync) sobre sql.js (SQLite compilado a JavaScript).
let SQL = null;
let initialBytes = null;
export function configureSqlite(sqlJs, bytes) { SQL = sqlJs; initialBytes = bytes || null; }

const norm = params => params.map(v => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

export class DatabaseSync {
  constructor() {
    this.db = initialBytes ? new SQL.Database(initialBytes) : new SQL.Database();
    initialBytes = null;
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    const withStmt = (params, fn) => { const s = db.prepare(sql); try { s.bind(norm(params)); return fn(s); } finally { s.free(); } };
    return {
      get: (...p) => withStmt(p, s => (s.step() ? s.getAsObject() : undefined)),
      all: (...p) => withStmt(p, s => { const rows = []; while (s.step()) rows.push(s.getAsObject()); return rows; }),
      run: (...p) => withStmt(p, s => { s.step(); return { changes: db.getRowsModified() }; }),
    };
  }
  export() { return this.db.export(); }
  close() { this.db.close(); }
}
