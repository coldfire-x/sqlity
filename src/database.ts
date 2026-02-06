import * as fs from "fs";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import type { TableInfo, ColumnInfo, IndexInfo, QueryResult } from "./types";

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

export class Database {
  private db: SqlJsDatabase | null = null;
  private filePath: string;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /* ── lifecycle ── */

  async open(wasmPath: string): Promise<void> {
    if (!SQL) {
      const wasmBinary = fs.readFileSync(wasmPath);
      SQL = await initSqlJs({ wasmBinary });
    }
    const buffer = fs.readFileSync(this.filePath);
    this.db = new SQL.Database(buffer);
  }

  close(): void {
    if (this.dirty) {
      this.flush();
    }
    this.db?.close();
    this.db = null;
  }

  private flush(): void {
    if (!this.db) return;
    const data = this.db.export();
    fs.writeFileSync(this.filePath, Buffer.from(data));
    this.dirty = false;
  }

  private get conn(): SqlJsDatabase {
    if (!this.db) throw new Error("Database not open");
    return this.db;
  }

  /* ── metadata ── */

  getTables(): TableInfo[] {
    const result = this.conn.exec(`
      SELECT name, type FROM sqlite_master
      WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    if (!result.length) return [];
    return result[0].values.map(([name, type]) => {
      let rowCount = 0;
      try {
        const c = this.conn.exec(`SELECT COUNT(*) FROM "${name}"`);
        rowCount = (c[0]?.values[0]?.[0] as number) ?? 0;
      } catch {
        /* views may fail */
      }
      return { name: name as string, type: type as "table" | "view", rowCount };
    });
  }

  getSchema(table: string): { columns: ColumnInfo[]; indexes: IndexInfo[] } {
    const colRows = this.conn.exec(`PRAGMA table_info("${table}")`);
    const columns: ColumnInfo[] = colRows.length
      ? colRows[0].values.map((r) => ({
          cid: r[0] as number,
          name: r[1] as string,
          type: (r[2] as string) || "",
          notnull: r[3] === 1,
          dflt_value: r[4] as string | null,
          pk: (r[5] as number) > 0,
        }))
      : [];

    const idxRows = this.conn.exec(`PRAGMA index_list("${table}")`);
    const indexes: IndexInfo[] = idxRows.length
      ? idxRows[0].values.map((r) => {
          const idxName = r[1] as string;
          const info = this.conn.exec(`PRAGMA index_info("${idxName}")`);
          return {
            name: idxName,
            unique: r[2] === 1,
            columns: info.length ? info[0].values.map((c) => c[2] as string) : [],
          };
        })
      : [];

    return { columns, indexes };
  }

  getSchemaSQL(): string {
    const tables = this.getTables();
    let out = "";
    for (const t of tables) {
      const { columns, indexes } = this.getSchema(t.name);

      // Foreign keys: { from, table, to }
      const fkRows = this.conn.exec(`PRAGMA foreign_key_list("${t.name}")`);
      const fkMap = new Map<string, { table: string; to: string }>();
      if (fkRows.length) {
        for (const r of fkRows[0].values) {
          fkMap.set(r[3] as string, { table: r[2] as string, to: r[4] as string });
        }
      }

      const defs = columns
        .map((c) => {
          let def = `  ${c.name} ${c.type || "ANY"}`;
          if (c.pk) def += " PRIMARY KEY";
          if (c.notnull) def += " NOT NULL";
          if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
          const fk = fkMap.get(c.name);
          if (fk) def += ` REFERENCES "${fk.table}"("${fk.to}")`;
          return def;
        })
        .join(",\n");

      out += `-- ${t.name} (${t.rowCount.toLocaleString()} rows)\n`;
      out += `CREATE TABLE "${t.name}" (\n${defs}\n);\n`;

      for (const idx of indexes) {
        const unique = idx.unique ? "UNIQUE " : "";
        const cols = idx.columns.map((c) => `"${c}"`).join(", ");
        out += `CREATE ${unique}INDEX "${idx.name}" ON "${t.name}" (${cols});\n`;
      }

      out += "\n";
    }
    return out;
  }

  /* ── query ── */

  executeQuery(sql: string): QueryResult {
    const trimmed = sql.trim();
    const isRead = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);
    const start = performance.now();

    if (isRead) {
      const result = this.conn.exec(trimmed);
      const time = performance.now() - start;
      if (!result.length) return { columns: [], values: [], rowsAffected: 0, time };
      return {
        columns: result[0].columns,
        values: result[0].values as QueryResult["values"],
        rowsAffected: 0,
        time,
      };
    }

    this.conn.run(trimmed);
    const changes = this.conn.getRowsModified();
    const time = performance.now() - start;
    this.dirty = true;
    this.flush();
    return { columns: [], values: [], rowsAffected: changes, time };
  }

  /* ── browse (paginated) ── */

  getTableData(
    table: string,
    page: number,
    pageSize: number,
    orderBy?: string,
    orderDir: "ASC" | "DESC" = "ASC"
  ): { result: QueryResult; totalRows: number } {
    const countRes = this.conn.exec(`SELECT COUNT(*) FROM "${table}"`);
    const totalRows = (countRes[0]?.values[0]?.[0] as number) ?? 0;
    const offset = page * pageSize;

    let sql = `SELECT rowid AS __rowid, * FROM "${table}"`;
    if (orderBy) sql += ` ORDER BY "${orderBy}" ${orderDir}`;
    sql += ` LIMIT ${pageSize} OFFSET ${offset}`;

    const start = performance.now();
    const result = this.conn.exec(sql);
    const time = performance.now() - start;

    if (!result.length) {
      return { result: { columns: [], values: [], rowsAffected: 0, time }, totalRows };
    }
    return {
      result: {
        columns: result[0].columns,
        values: result[0].values as QueryResult["values"],
        rowsAffected: 0,
        time,
      },
      totalRows,
    };
  }

  /* ── CRUD ── */

  updateRow(table: string, rowid: number, column: string, value: unknown): void {
    const parsed = this.castValue(value, this.columnType(table, column));
    this.conn.run(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`, [
      parsed as any,
      rowid,
    ]);
    this.dirty = true;
    this.flush();
  }

  insertRow(table: string, values: Record<string, unknown>): void {
    const { columns } = this.getSchema(table);
    const cols = Object.keys(values);
    const placeholders = cols.map(() => "?").join(", ");
    const vals = cols.map((c) => {
      const col = columns.find((ci) => ci.name === c);
      return this.castValue(values[c], col?.type ?? "TEXT");
    });
    this.conn.run(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      vals as any
    );
    this.dirty = true;
    this.flush();
  }

  deleteRows(table: string, rowids: number[]): void {
    const ph = rowids.map(() => "?").join(", ");
    this.conn.run(`DELETE FROM "${table}" WHERE rowid IN (${ph})`, rowids as any);
    this.dirty = true;
    this.flush();
  }

  /* ── import / export ── */

  exportCSV(table: string): string {
    const result = this.conn.exec(`SELECT * FROM "${table}"`);
    if (!result.length) return "";
    const esc = (v: unknown) => {
      if (v === null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const header = result[0].columns.map(esc).join(",");
    const rows = result[0].values.map((r) => r.map(esc).join(","));
    return [header, ...rows].join("\n");
  }

  exportJSON(table: string): string {
    const result = this.conn.exec(`SELECT * FROM "${table}"`);
    if (!result.length) return "[]";
    const rows = result[0].values.map((row) => {
      const obj: Record<string, unknown> = {};
      result[0].columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });
    return JSON.stringify(rows, null, 2);
  }

  importCSV(table: string, csv: string): number {
    const lines = parseCSV(csv);
    if (lines.length < 2) return 0;
    const headers = lines[0];
    const { columns } = this.getSchema(table);
    const ph = headers.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table}" (${headers.map((h) => `"${h}"`).join(", ")}) VALUES (${ph})`;
    let imported = 0;

    this.conn.run("BEGIN TRANSACTION");
    try {
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].map((v, j) => {
          const col = columns.find((c) => c.name === headers[j]);
          return this.castValue(v === "" ? null : v, col?.type ?? "TEXT");
        });
        this.conn.run(sql, vals as any);
        imported++;
      }
      this.conn.run("COMMIT");
    } catch (e) {
      this.conn.run("ROLLBACK");
      throw e;
    }
    this.dirty = true;
    this.flush();
    return imported;
  }

  importJSON(table: string, json: string): number {
    const rows = JSON.parse(json) as Record<string, unknown>[];
    if (!rows.length) return 0;
    const { columns } = this.getSchema(table);
    const headers = Object.keys(rows[0]);
    const ph = headers.map(() => "?").join(", ");
    const sql = `INSERT INTO "${table}" (${headers.map((h) => `"${h}"`).join(", ")}) VALUES (${ph})`;
    let imported = 0;

    this.conn.run("BEGIN TRANSACTION");
    try {
      for (const row of rows) {
        const vals = headers.map((h) => {
          const col = columns.find((c) => c.name === h);
          return this.castValue(row[h], col?.type ?? "TEXT");
        });
        this.conn.run(sql, vals as any);
        imported++;
      }
      this.conn.run("COMMIT");
    } catch (e) {
      this.conn.run("ROLLBACK");
      throw e;
    }
    this.dirty = true;
    this.flush();
    return imported;
  }

  /* ── helpers ── */

  private columnType(table: string, column: string): string {
    const { columns } = this.getSchema(table);
    return columns.find((c) => c.name === column)?.type ?? "TEXT";
  }

  /**
   * Parse a user-supplied value into the appropriate JS type
   * based on the SQLite column type affinity.
   */
  private castValue(value: unknown, colType: string): string | number | null {
    if (value === null || value === undefined || value === "NULL") return null;
    const t = colType.toUpperCase();

    // INTEGER / BOOLEAN → truncated number
    if (t.includes("INT") || t.includes("BOOL")) {
      if (typeof value === "boolean") return value ? 1 : 0;
      const n = Number(value);
      return isNaN(n) ? String(value) : Math.trunc(n);
    }

    // REAL / FLOAT / DOUBLE / NUMERIC / DECIMAL → float
    if (
      t.includes("REAL") ||
      t.includes("FLOAT") ||
      t.includes("DOUBLE") ||
      t.includes("NUMERIC") ||
      t.includes("DECIMAL")
    ) {
      const n = Number(value);
      return isNaN(n) ? String(value) : n;
    }

    // DATE / DATETIME / TIMESTAMP → ISO string
    if (t.includes("DATE") || t.includes("TIME")) {
      const s = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
      const d = new Date(s);
      return isNaN(d.getTime()) ? s : d.toISOString();
    }

    // TEXT / BLOB / anything else
    return String(value);
  }
}

/* ── CSV parser (handles quoted fields) ── */

function parseCSV(csv: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      current.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      current.push(field);
      field = "";
      if (current.length > 0) rows.push(current);
      current = [];
    } else {
      field += ch;
    }
  }
  if (field || current.length) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}
