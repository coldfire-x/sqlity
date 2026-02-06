/* ── Shared types for extension ↔ webview messaging ── */

export interface TableInfo {
  name: string;
  type: "table" | "view";
  rowCount: number;
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface QueryResult {
  columns: string[];
  values: (string | number | null | Uint8Array)[][];
  rowsAffected: number;
  time: number;
}

export interface SavedQuery {
  name: string;
  sql: string;
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  timestamp: number;
  rowCount: number;
  pinned: boolean;
}

/* ── Webview → Extension ── */

export type WebviewMessage =
  | { type: "getTables" }
  | { type: "getSchema"; table: string }
  | { type: "executeQuery"; sql: string }
  | {
      type: "getTableData";
      table: string;
      page: number;
      pageSize: number;
      orderBy?: string;
      orderDir?: "ASC" | "DESC";
    }
  | { type: "updateRow"; table: string; rowid: number; column: string; value: unknown }
  | { type: "insertRow"; table: string; values: Record<string, unknown> }
  | { type: "deleteRows"; table: string; rowids: number[] }
  | { type: "exportCSV"; table: string }
  | { type: "exportJSON"; table: string }
  | { type: "importCSV"; table: string }
  | { type: "importJSON"; table: string }
  | { type: "saveQuery"; sql: string }
  | { type: "getSavedQueries" }
  | { type: "deleteSavedQuery"; name: string }
  | { type: "getHistory" }
  | { type: "pinResult"; id: string }
  | { type: "aiAssist"; prompt: string }
  | { type: "aiExecute"; sql: string; msgId: string }
  | { type: "refresh" };

/* ── Extension → Webview ── */

export type ExtensionMessage =
  | { type: "init"; lmAvailable: boolean; dbName: string }
  | { type: "tables"; tables: TableInfo[] }
  | { type: "schema"; table: string; columns: ColumnInfo[]; indexes: IndexInfo[] }
  | { type: "queryResult"; result: QueryResult; sql: string }
  | {
      type: "tableData";
      table: string;
      result: QueryResult;
      page: number;
      totalRows: number;
      pageSize: number;
    }
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  | { type: "savedQueries"; queries: SavedQuery[] }
  | { type: "history"; entries: HistoryEntry[] }
  | { type: "aiGenerating" }
  | { type: "aiResult"; prompt: string; sql: string }
  | { type: "aiQueryResult"; msgId: string; result: QueryResult; sql: string }
  | { type: "lmStatus"; available: boolean };
