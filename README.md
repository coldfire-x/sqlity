# SQLity — VS Code Extension Spec

## Overview

SQLity is a local SQLite database viewer and editor that runs entirely inside VS Code. It registers a **custom editor** for `.db`, `.sqlite`, and `.sqlite3` files, presenting a modern webview UI for schema browsing, SQL querying, CRUD editing, and import/export — with optional AI-powered SQL generation via the VS Code Language Model API.

## Features

| Category | Details |
|---|---|
| **Custom Editor** | Click any `.db/.sqlite/.sqlite3` file to open it in SQLity (custom binary editor) |
| **Table Browser** | Left sidebar listing all tables and views with row counts |
| **Schema Viewer** | Column names, types, NOT NULL, defaults, primary keys, and indexes |
| **SQL Editor** | Free-form SQL editor with Ctrl/Cmd+Enter to execute; syntax-highlighted textarea |
| **Results Grid** | Paginated, sortable, read-only result table for arbitrary queries |
| **CRUD Data Grid** | Browse tab with inline cell editing (double-click), row insertion, multi-row deletion |
| **Type-Safe Editing** | NULL / integer / real / date / boolean parsing based on column type affinity |
| **Import / Export** | Per-table CSV and JSON import/export via native OS file dialogs |
| **Saved Queries** | Name and persist queries per database; load from modal |
| **Query History** | Auto-logged history (last 100 queries) with pin/unpin support |
| **AI SQL Assist** | Natural language to SQL via `vscode.lm` API; button hidden when no LM provider is available |

## Architecture

```
┌─────────────────────────┐        postMessage         ┌────────────────────────┐
│    Webview (browser)    │  ◄──────────────────────►  │  Extension (Node.js)   │
│  main.ts + style.css    │                            │  editorProvider.ts     │
│  - table list           │                            │  database.ts (sql.js)  │
│  - SQL editor           │                            │  lmAssist.ts           │
│  - data grid / schema   │                            │                        │
└─────────────────────────┘                            └────────────────────────┘
```

- **sql.js** (WebAssembly SQLite) runs on the Node.js side — no native compilation required.
- The webview communicates with the extension host via `postMessage`.
- CRUD writes are saved to disk immediately after each mutation.

## Install / Build

```sh
git clone <repo-url>
cd sqlity
npm install          # install deps (sql.js, esbuild, typescript, vsce)
npm run compile      # bundle extension + webview via esbuild, copy WASM
vsce package         # produces sqlity-<version>.vsix
code --install-extension sqlity-*.vsix
```

## Debug

1. Open the `sqlity/` folder in VS Code.
2. Press **F5** — this launches the **Extension Development Host** (pre-configured in `.vscode/launch.json`).
3. In the new window, open any `.db` / `.sqlite` / `.sqlite3` file.
4. The SQLity editor opens automatically.

For continuous development, run `npm run watch` in a terminal — esbuild will rebuild on every file change.

## Notes

| Topic | Detail |
|---|---|
| **VS Code LM API** | Requires VS Code >= 1.90 and a language model provider (e.g. GitHub Copilot). If no model is detected, the AI Assist button is hidden — all other features work normally. |
| **Custom Editor priority** | SQLity registers with `"priority": "default"`. If a `.db` file opens as hex/binary instead, right-click the tab → **Reopen With...** → select **SQLity Editor**. |
| **File writes** | CRUD operations write directly to the SQLite file on disk. There is no VS Code undo/redo integration — the database is the source of truth. |
| **Memory** | sql.js loads the entire database into memory. This is fine for typical development databases (< ~100 MB). For very large files, consider a dedicated DB tool. |
| **Packaging** | `sql.js` is marked as an external dependency and shipped inside the `.vsix` under `node_modules/sql.js/`. No native compilation step is needed. |
