import * as vscode from "vscode";
import * as path from "path";
import { Database } from "./database";
import { generateSQL } from "./lmAssist";
import type { WebviewMessage, SavedQuery, HistoryEntry } from "./types";

/* ── per-database persisted state (in-memory, lives as long as VS Code) ── */

interface DbState {
  savedQueries: SavedQuery[];
  history: HistoryEntry[];
}
const stateStore = new Map<string, DbState>();

/* ── provider ── */

export class SQLiteEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = "sqlity.editor";

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  static register(ctx: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      SQLiteEditorProvider.viewType,
      new SQLiteEditorProvider(ctx),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  /* ── CustomReadonlyEditorProvider ── */

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const dbPath = document.uri.fsPath;
    const wasmPath = path.join(this.ctx.extensionPath, "dist", "sql-wasm.wasm");

    const db = new Database(dbPath);
    await db.open(wasmPath);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "dist")],
    };
    panel.webview.html = this.buildHtml(panel.webview);

    // per-file state
    if (!stateStore.has(dbPath)) {
      stateStore.set(dbPath, { savedQueries: [], history: [] });
    }
    const state = stateStore.get(dbPath)!;

    // Send init — always show AI tab; errors are surfaced when user actually sends.
    panel.webview.postMessage({
      type: "init",
      lmAvailable: true,
      dbName: path.basename(dbPath),
    });

    /* ── message handler ── */

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        switch (msg.type) {
          /* metadata */
          case "getTables":
            panel.webview.postMessage({ type: "tables", tables: db.getTables() });
            break;

          case "getSchema": {
            const { columns, indexes } = db.getSchema(msg.table);
            panel.webview.postMessage({
              type: "schema",
              table: msg.table,
              columns,
              indexes,
            });
            break;
          }

          /* free-form query */
          case "executeQuery": {
            const result = db.executeQuery(msg.sql);
            const entry: HistoryEntry = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              sql: msg.sql,
              timestamp: Date.now(),
              rowCount: result.values.length,
              pinned: false,
            };
            state.history.unshift(entry);
            if (state.history.length > 100) state.history.length = 100;
            panel.webview.postMessage({ type: "queryResult", result, sql: msg.sql });
            break;
          }

          /* paginated browse */
          case "getTableData": {
            const { result, totalRows } = db.getTableData(
              msg.table,
              msg.page,
              msg.pageSize,
              msg.orderBy,
              msg.orderDir
            );
            panel.webview.postMessage({
              type: "tableData",
              table: msg.table,
              result,
              page: msg.page,
              totalRows,
              pageSize: msg.pageSize,
            });
            break;
          }

          /* CRUD */
          case "updateRow":
            db.updateRow(msg.table, msg.rowid, msg.column, msg.value);
            panel.webview.postMessage({ type: "info", message: "Row updated." });
            break;

          case "insertRow":
            db.insertRow(msg.table, msg.values);
            panel.webview.postMessage({ type: "info", message: "Row inserted." });
            break;

          case "deleteRows": {
            const answer = await vscode.window.showWarningMessage(
              `Delete ${msg.rowids.length} row(s)?`,
              { modal: true },
              "Delete"
            );
            if (answer !== "Delete") break;
            db.deleteRows(msg.table, msg.rowids);
            panel.webview.postMessage({
              type: "info",
              message: `${msg.rowids.length} row(s) deleted.`,
            });
            // refresh the grid
            panel.webview.postMessage({ type: "tables", tables: db.getTables() });
            break;
          }

          /* export */
          case "exportCSV": {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(`${msg.table}.csv`),
              filters: { CSV: ["csv"] },
            });
            if (uri) {
              const csv = db.exportCSV(msg.table);
              await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, "utf-8"));
              panel.webview.postMessage({
                type: "info",
                message: `Exported to ${uri.fsPath}`,
              });
            }
            break;
          }

          case "exportJSON": {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(`${msg.table}.json`),
              filters: { JSON: ["json"] },
            });
            if (uri) {
              const json = db.exportJSON(msg.table);
              await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf-8"));
              panel.webview.postMessage({
                type: "info",
                message: `Exported to ${uri.fsPath}`,
              });
            }
            break;
          }

          /* import */
          case "importCSV": {
            const uris = await vscode.window.showOpenDialog({
              filters: { CSV: ["csv"] },
              canSelectMany: false,
            });
            if (uris?.length) {
              const raw = await vscode.workspace.fs.readFile(uris[0]);
              const count = db.importCSV(msg.table, Buffer.from(raw).toString("utf-8"));
              panel.webview.postMessage({
                type: "info",
                message: `Imported ${count} row(s).`,
              });
            }
            break;
          }

          case "importJSON": {
            const uris = await vscode.window.showOpenDialog({
              filters: { JSON: ["json"] },
              canSelectMany: false,
            });
            if (uris?.length) {
              const raw = await vscode.workspace.fs.readFile(uris[0]);
              const count = db.importJSON(msg.table, Buffer.from(raw).toString("utf-8"));
              panel.webview.postMessage({
                type: "info",
                message: `Imported ${count} row(s).`,
              });
            }
            break;
          }

          /* saved queries */
          case "saveQuery": {
            const name = await vscode.window.showInputBox({
              prompt: "Query name",
              placeHolder: "e.g. Active users",
            });
            if (!name) break;
            state.savedQueries = state.savedQueries.filter((q) => q.name !== name);
            state.savedQueries.push({ name, sql: msg.sql, createdAt: Date.now() });
            panel.webview.postMessage({
              type: "savedQueries",
              queries: state.savedQueries,
            });
            break;
          }

          case "getSavedQueries":
            panel.webview.postMessage({
              type: "savedQueries",
              queries: state.savedQueries,
            });
            break;

          case "deleteSavedQuery":
            state.savedQueries = state.savedQueries.filter((q) => q.name !== msg.name);
            panel.webview.postMessage({
              type: "savedQueries",
              queries: state.savedQueries,
            });
            break;

          /* history */
          case "getHistory":
            panel.webview.postMessage({ type: "history", entries: state.history });
            break;

          case "pinResult": {
            const h = state.history.find((e) => e.id === msg.id);
            if (h) h.pinned = !h.pinned;
            panel.webview.postMessage({ type: "history", entries: state.history });
            break;
          }

          /* AI assist */
          case "aiAssist": {
            panel.webview.postMessage({ type: "aiGenerating" });
            const schema = db.getSchemaSQL();
            const sql = await generateSQL(msg.prompt, schema);
            panel.webview.postMessage({ type: "aiResult", prompt: msg.prompt, sql });
            break;
          }

          /* AI execute (run edited SQL from AI tab) */
          case "aiExecute": {
            const result = db.executeQuery(msg.sql);
            const entry: HistoryEntry = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              sql: msg.sql,
              timestamp: Date.now(),
              rowCount: result.values.length,
              pinned: false,
            };
            state.history.unshift(entry);
            if (state.history.length > 100) state.history.length = 100;
            panel.webview.postMessage({ type: "aiQueryResult", msgId: msg.msgId, result, sql: msg.sql });
            break;
          }

          /* refresh */
          case "refresh":
            panel.webview.postMessage({ type: "tables", tables: db.getTables() });
            break;
        }
      } catch (err: any) {
        panel.webview.postMessage({
          type: "error",
          message: err?.message ?? String(err),
        });
      }
    });

    panel.onDidDispose(() => db.close());
  }

  /* ── HTML shell ── */

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview.css")
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>SQLity</title>
</head>
<body>
  <div id="app">
    <!-- toolbar -->
    <header id="toolbar">
      <span id="db-name" class="db-name"></span>
      <div class="toolbar-actions">
        <button id="btn-refresh" title="Refresh tables">Refresh</button>
        <button id="btn-import-csv"  disabled>Import CSV</button>
        <button id="btn-import-json" disabled>Import JSON</button>
        <button id="btn-export-csv"  disabled>Export CSV</button>
        <button id="btn-export-json" disabled>Export JSON</button>
        <button id="btn-saved">Saved</button>
        <button id="btn-history">History</button>
      </div>
    </header>

    <div id="main">
      <!-- sidebar -->
      <aside id="sidebar">
        <h3>Tables</h3>
        <ul id="table-list"></ul>
      </aside>

      <!-- content -->
      <section id="content">
        <nav id="tabs">
          <button class="tab active" data-tab="query">SQL Query</button>
          <button class="tab" data-tab="browse">Browse Data</button>
          <button class="tab" data-tab="schema">Schema</button>
          <button class="tab" data-tab="ai" id="tab-btn-ai">AI Assist</button>
        </nav>

        <!-- SQL query tab -->
        <div id="tab-query" class="tab-panel active">
          <div class="sql-editor-wrap">
            <textarea id="sql-editor" placeholder="SELECT * FROM ..." spellcheck="false"></textarea>
            <div class="editor-actions">
              <button id="btn-run">Run</button>
              <button id="btn-save-query">Save Query</button>
            </div>
          </div>
          <div id="query-result" class="result-area"></div>
        </div>

        <!-- browse tab -->
        <div id="tab-browse" class="tab-panel">
          <div id="browse-toolbar">
            <button id="btn-add-row" disabled>+ Add Row</button>
            <button id="btn-delete-rows" disabled>Delete Selected</button>
            <span id="browse-info"></span>
          </div>
          <div id="browse-grid" class="result-area"></div>
          <div id="browse-pager">
            <button id="btn-prev-page" disabled>&lt; Prev</button>
            <span id="page-info"></span>
            <button id="btn-next-page" disabled>Next &gt;</button>
          </div>
        </div>

        <!-- schema tab -->
        <div id="tab-schema" class="tab-panel">
          <div id="schema-view"></div>
        </div>

        <!-- AI assist tab -->
        <div id="tab-ai" class="tab-panel">
          <div id="ai-messages" class="ai-messages">
            <div class="ai-welcome">Describe what you want to query in natural language.</div>
          </div>
          <div id="ai-loading" class="ai-loading hidden">
            <span class="ai-spinner"></span> Generating SQL&hellip;
          </div>
          <div class="ai-input-wrap">
            <textarea id="ai-input" placeholder="e.g. Show all users created in the last 7 days" spellcheck="false" rows="2"></textarea>
            <button id="btn-ai-send">Send</button>
          </div>
        </div>
      </section>
    </div>

    <!-- modal -->
    <div id="modal-overlay" class="modal-overlay hidden">
      <div class="modal">
        <div class="modal-header">
          <h3 id="modal-title"></h3>
          <button id="modal-close">&times;</button>
        </div>
        <div id="modal-body" class="modal-body"></div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast hidden"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
