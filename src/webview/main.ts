/* ── SQLity Webview ── */

declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

/* ── state ── */

let currentTable: string | null = null;
let currentPage = 0;
const pageSize = 50;
let totalRows = 0;
let browseColumns: string[] = [];
let selectedRowids = new Set<number>();
let sortColumn: string | null = null;
let sortDir: "ASC" | "DESC" = "ASC";

/* ── DOM helpers ── */

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => document.querySelectorAll(sel);

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── incoming messages ── */

window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      $("#db-name").textContent = msg.dbName;
      vscode.postMessage({ type: "getTables" });
      break;
    case "tables":
      renderTableList(msg.tables);
      break;
    case "schema":
      renderSchema(msg.table, msg.columns, msg.indexes);
      break;
    case "queryResult":
      renderQueryResult(msg.result, msg.sql);
      break;
    case "tableData":
      currentPage = msg.page;
      totalRows = msg.totalRows;
      renderBrowseGrid(msg.result, msg.table);
      updatePager();
      break;
    case "error":
      aiSetLoading(false);
      aiResetExecButtons();
      showToast(msg.message, "error");
      break;
    case "info":
      showToast(msg.message, "info");
      break;
    case "savedQueries":
      renderSavedQueries(msg.queries);
      break;
    case "history":
      renderHistory(msg.entries);
      break;
    case "aiGenerating":
      aiSetLoading(true);
      break;
    case "aiResult":
      aiSetLoading(false);
      aiAddMessage(msg.prompt, msg.sql);
      break;
    case "aiQueryResult":
      aiRenderResult(msg.msgId, msg.result, msg.sql);
      break;
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Table list                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function renderTableList(tables: any[]) {
  const ul = $("#table-list");
  ul.innerHTML = "";
  tables.forEach((t) => {
    const li = document.createElement("li");
    li.className = "table-item";
    li.innerHTML = `<span class="table-icon">${t.type === "view" ? "&#x1f441;" : "&#x1f4c4;"}</span>
      <span class="table-name">${esc(t.name)}</span>
      <span class="row-count">${t.rowCount}</span>`;
    li.addEventListener("click", () => selectTable(t.name));
    ul.appendChild(li);
  });
}

function selectTable(name: string) {
  currentTable = name;
  currentPage = 0;
  sortColumn = null;
  sortDir = "ASC";
  selectedRowids.clear();

  $$(".table-item").forEach((el) => el.classList.remove("selected"));
  $$(".table-item").forEach((el) => {
    if (el.querySelector(".table-name")?.textContent === name) el.classList.add("selected");
  });

  (["btn-import-csv", "btn-import-json", "btn-export-csv", "btn-export-json", "btn-add-row"] as string[]).forEach(
    (id) => ((document.getElementById(id) as HTMLButtonElement).disabled = false)
  );

  // Switch to Browse Data tab
  (document.querySelector('.tab[data-tab="browse"]') as HTMLElement)?.click();

  vscode.postMessage({ type: "getSchema", table: name });
  vscode.postMessage({ type: "getTableData", table: name, page: 0, pageSize });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Tabs                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.getAttribute("data-tab")}`)?.classList.add("active");
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  SQL Editor                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

$("#btn-run").addEventListener("click", () => {
  const sql = ($("#sql-editor") as HTMLTextAreaElement).value.trim();
  if (sql) vscode.postMessage({ type: "executeQuery", sql });
});

$("#sql-editor").addEventListener("keydown", (e: Event) => {
  const ke = e as KeyboardEvent;
  if ((ke.ctrlKey || ke.metaKey) && ke.key === "Enter") {
    ke.preventDefault();
    $("#btn-run").click();
  }
});

$("#btn-save-query").addEventListener("click", () => {
  const sql = ($("#sql-editor") as HTMLTextAreaElement).value.trim();
  if (!sql) return;
  vscode.postMessage({ type: "saveQuery", sql });
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Toolbar buttons                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

$("#btn-refresh").addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
  if (currentTable) {
    vscode.postMessage({
      type: "getTableData",
      table: currentTable,
      page: currentPage,
      pageSize,
      orderBy: sortColumn ?? undefined,
      orderDir: sortDir,
    });
  }
});

$("#btn-import-csv").addEventListener("click", () => {
  if (currentTable) vscode.postMessage({ type: "importCSV", table: currentTable });
});
$("#btn-import-json").addEventListener("click", () => {
  if (currentTable) vscode.postMessage({ type: "importJSON", table: currentTable });
});
$("#btn-export-csv").addEventListener("click", () => {
  if (currentTable) vscode.postMessage({ type: "exportCSV", table: currentTable });
});
$("#btn-export-json").addEventListener("click", () => {
  if (currentTable) vscode.postMessage({ type: "exportJSON", table: currentTable });
});
$("#btn-saved").addEventListener("click", () => vscode.postMessage({ type: "getSavedQueries" }));
$("#btn-history").addEventListener("click", () => vscode.postMessage({ type: "getHistory" }));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pager                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

$("#btn-prev-page").addEventListener("click", () => {
  if (currentPage > 0 && currentTable) {
    currentPage--;
    vscode.postMessage({
      type: "getTableData",
      table: currentTable,
      page: currentPage,
      pageSize,
      orderBy: sortColumn ?? undefined,
      orderDir: sortDir,
    });
  }
});

$("#btn-next-page").addEventListener("click", () => {
  if ((currentPage + 1) * pageSize < totalRows && currentTable) {
    currentPage++;
    vscode.postMessage({
      type: "getTableData",
      table: currentTable,
      page: currentPage,
      pageSize,
      orderBy: sortColumn ?? undefined,
      orderDir: sortDir,
    });
  }
});

function updatePager() {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  $("#page-info").textContent = `Page ${currentPage + 1} of ${totalPages} (${totalRows} rows)`;
  ($("#btn-prev-page") as HTMLButtonElement).disabled = currentPage === 0;
  ($("#btn-next-page") as HTMLButtonElement).disabled = (currentPage + 1) * pageSize >= totalRows;
  $("#browse-info").textContent = currentTable ? `Table: ${currentTable}` : "";
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Query result (read-only)                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

function renderQueryResult(result: any, _sql: string) {
  const area = $("#query-result");
  if (result.rowsAffected > 0) {
    area.innerHTML = `<div class="result-info">${result.rowsAffected} row(s) affected (${result.time.toFixed(1)} ms)</div>`;
    return;
  }
  if (!result.columns.length) {
    area.innerHTML = `<div class="result-info">Query executed (${result.time.toFixed(1)} ms). No results.</div>`;
    return;
  }
  area.innerHTML =
    buildTable(result.columns, result.values, false) +
    `<div class="result-info">${result.values.length} row(s) returned (${result.time.toFixed(1)} ms)</div>`;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Browse grid (editable)                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function renderBrowseGrid(result: any, table: string) {
  browseColumns = result.columns;
  selectedRowids.clear();
  ($("#btn-delete-rows") as HTMLButtonElement).disabled = true;

  const area = $("#browse-grid");
  if (!result.columns.length) {
    area.innerHTML = '<div class="result-info">No data.</div>';
    return;
  }
  area.innerHTML = buildTable(result.columns, result.values, true);
  attachGridEvents(table);
}

/* ── shared table builder ── */

function buildTable(columns: string[], rows: any[][], editable: boolean): string {
  const rowidIdx = columns.indexOf("__rowid");
  let h = '<div class="table-scroll"><table class="data-table"><thead><tr>';
  if (editable) h += '<th class="chk-col"><input type="checkbox" id="select-all"></th>';

  columns.forEach((col) => {
    if (col === "__rowid") return;
    const sortable = editable ? ` class="sortable" data-col="${esc(col)}"` : "";
    const arrow = editable && sortColumn === col ? (sortDir === "ASC" ? " &#x25b2;" : " &#x25bc;") : "";
    h += `<th${sortable}>${esc(col)}${arrow}</th>`;
  });
  h += "</tr></thead><tbody>";

  rows.forEach((row, ri) => {
    const rowid = rowidIdx >= 0 ? row[rowidIdx] : ri;
    h += `<tr data-rowid="${rowid}">`;
    if (editable) h += `<td class="chk-col"><input type="checkbox" class="row-chk" data-rowid="${rowid}"></td>`;
    row.forEach((val: any, ci: number) => {
      if (columns[ci] === "__rowid") return;
      const display = val === null ? '<span class="null">NULL</span>' : esc(String(val));
      h += editable
        ? `<td class="editable" data-col="${esc(columns[ci])}" data-rowid="${rowid}">${display}</td>`
        : `<td>${display}</td>`;
    });
    h += "</tr>";
  });

  h += "</tbody></table></div>";
  return h;
}

/* ── grid interactivity ── */

function attachGridEvents(table: string) {
  // select-all
  const selAll = document.getElementById("select-all") as HTMLInputElement | null;
  selAll?.addEventListener("change", () => {
    document.querySelectorAll<HTMLInputElement>(".row-chk").forEach((cb) => {
      cb.checked = selAll.checked;
      const rid = Number(cb.dataset.rowid);
      selAll.checked ? selectedRowids.add(rid) : selectedRowids.delete(rid);
    });
    ($("#btn-delete-rows") as HTMLButtonElement).disabled = selectedRowids.size === 0;
  });

  // individual checkboxes
  document.querySelectorAll<HTMLInputElement>(".row-chk").forEach((cb) => {
    cb.addEventListener("change", () => {
      const rid = Number(cb.dataset.rowid);
      cb.checked ? selectedRowids.add(rid) : selectedRowids.delete(rid);
      ($("#btn-delete-rows") as HTMLButtonElement).disabled = selectedRowids.size === 0;
    });
  });

  // inline edit (double-click)
  document.querySelectorAll<HTMLElement>(".editable").forEach((cell) => {
    cell.addEventListener("dblclick", () => {
      if (cell.querySelector("input")) return;
      const col = cell.dataset.col!;
      const rowid = Number(cell.dataset.rowid);
      const prev = cell.querySelector(".null") ? "" : cell.textContent || "";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "cell-edit";
      input.value = prev;
      cell.textContent = "";
      cell.appendChild(input);
      input.focus();
      input.select();

      const commit = () => {
        const v = input.value;
        const parsed = v === "" || v.toUpperCase() === "NULL" ? null : v;
        vscode.postMessage({ type: "updateRow", table, rowid, column: col, value: parsed });
        cell.innerHTML = parsed === null ? '<span class="null">NULL</span>' : esc(String(parsed));
      };

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ke) => {
        if (ke.key === "Enter") {
          ke.preventDefault();
          input.blur();
        }
        if (ke.key === "Escape") {
          cell.innerHTML = prev ? esc(prev) : '<span class="null">NULL</span>';
        }
      });
    });
  });

  // sortable headers
  document.querySelectorAll<HTMLElement>(".sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col!;
      if (sortColumn === col) {
        sortDir = sortDir === "ASC" ? "DESC" : "ASC";
      } else {
        sortColumn = col;
        sortDir = "ASC";
      }
      currentPage = 0;
      vscode.postMessage({
        type: "getTableData",
        table: currentTable!,
        page: 0,
        pageSize,
        orderBy: sortColumn,
        orderDir: sortDir,
      });
    });
  });

  // delete selected
  $("#btn-delete-rows").onclick = () => {
    if (!selectedRowids.size) return;
    vscode.postMessage({ type: "deleteRows", table, rowids: [...selectedRowids] });
  };

  // add row
  $("#btn-add-row").onclick = () => showAddRowModal(table);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Schema                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function renderSchema(table: string, columns: any[], indexes: any[]) {
  let h = `<h3>${esc(table)}</h3>`;
  h += '<table class="data-table"><thead><tr><th>Column</th><th>Type</th><th>Not Null</th><th>Default</th><th>PK</th></tr></thead><tbody>';
  columns.forEach((c: any) => {
    h += `<tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.type || "ANY")}</td>
      <td>${c.notnull ? "Yes" : "No"}</td>
      <td>${c.dflt_value !== null ? esc(String(c.dflt_value)) : '<span class="null">NULL</span>'}</td>
      <td>${c.pk ? "Yes" : ""}</td></tr>`;
  });
  h += "</tbody></table>";

  if (indexes.length) {
    h += '<h4>Indexes</h4><table class="data-table"><thead><tr><th>Name</th><th>Unique</th><th>Columns</th></tr></thead><tbody>';
    indexes.forEach((idx: any) => {
      h += `<tr><td>${esc(idx.name)}</td><td>${idx.unique ? "Yes" : "No"}</td><td>${idx.columns.map(esc).join(", ")}</td></tr>`;
    });
    h += "</tbody></table>";
  }
  $("#schema-view").innerHTML = h;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Saved queries modal                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function renderSavedQueries(queries: any[]) {
  showModal("Saved Queries", () => {
    if (!queries.length) return "<p>No saved queries.</p>";
    let h = '<ul class="saved-list">';
    queries.forEach((q: any) => {
      h += `<li>
        <button class="saved-load" data-sql="${attr(q.sql)}">${esc(q.name)}</button>
        <button class="saved-delete" data-name="${attr(q.name)}">&times;</button>
      </li>`;
    });
    return h + "</ul>";
  }, () => {
    document.querySelectorAll<HTMLElement>(".saved-load").forEach((btn) => {
      btn.addEventListener("click", () => {
        ($("#sql-editor") as HTMLTextAreaElement).value = btn.dataset.sql || "";
        closeModal();
        (document.querySelector('.tab[data-tab="query"]') as HTMLElement)?.click();
      });
    });
    document.querySelectorAll<HTMLElement>(".saved-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "deleteSavedQuery", name: btn.dataset.name });
      });
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  History modal                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function renderHistory(entries: any[]) {
  showModal("Query History", () => {
    if (!entries.length) return "<p>No query history.</p>";
    let h = '<ul class="history-list">';
    entries.forEach((e: any) => {
      const time = new Date(e.timestamp).toLocaleString();
      const pinLabel = e.pinned ? "Unpin" : "Pin";
      h += `<li class="${e.pinned ? "pinned" : ""}">
        <div class="hist-sql">${esc(e.sql.substring(0, 120))}${e.sql.length > 120 ? "..." : ""}</div>
        <div class="hist-meta">${time} | ${e.rowCount} rows</div>
        <div class="hist-actions">
          <button class="hist-load" data-sql="${attr(e.sql)}">Load</button>
          <button class="hist-pin" data-id="${e.id}">${pinLabel}</button>
        </div>
      </li>`;
    });
    return h + "</ul>";
  }, () => {
    document.querySelectorAll<HTMLElement>(".hist-load").forEach((btn) => {
      btn.addEventListener("click", () => {
        ($("#sql-editor") as HTMLTextAreaElement).value = btn.dataset.sql || "";
        closeModal();
        (document.querySelector('.tab[data-tab="query"]') as HTMLElement)?.click();
      });
    });
    document.querySelectorAll<HTMLElement>(".hist-pin").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "pinResult", id: btn.dataset.id });
      });
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Add-row modal                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function showAddRowModal(table: string) {
  const cols = browseColumns.filter((c) => c !== "__rowid");
  showModal("Add Row", () => {
    let h = '<div class="add-row-form">';
    cols.forEach((col) => {
      h += `<div class="form-row"><label>${esc(col)}</label><input type="text" class="add-row-input" data-col="${esc(col)}" placeholder="NULL"></div>`;
    });
    h += '<button id="btn-confirm-add">Insert</button></div>';
    return h;
  }, () => {
    document.getElementById("btn-confirm-add")?.addEventListener("click", () => {
      const values: Record<string, unknown> = {};
      document.querySelectorAll<HTMLInputElement>(".add-row-input").forEach((inp) => {
        const v = inp.value.trim();
        values[inp.dataset.col!] = v === "" || v.toUpperCase() === "NULL" ? null : v;
      });
      vscode.postMessage({ type: "insertRow", table, values });
      closeModal();
      setTimeout(() => {
        vscode.postMessage({
          type: "getTableData",
          table,
          page: currentPage,
          pageSize,
          orderBy: sortColumn ?? undefined,
          orderDir: sortDir,
        });
        vscode.postMessage({ type: "refresh" });
      }, 150);
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Modal helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function showModal(title: string, bodyFn: () => string, afterRender?: () => void) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = bodyFn();
  $("#modal-overlay").classList.remove("hidden");
  afterRender?.();
}

function closeModal() {
  $("#modal-overlay").classList.add("hidden");
}

$("#modal-close").addEventListener("click", closeModal);
$("#modal-overlay").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id === "modal-overlay") closeModal();
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  AI Assist tab                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function aiSend() {
  const input = $("#ai-input") as HTMLTextAreaElement;
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = "";
  vscode.postMessage({ type: "aiAssist", prompt });
}

$("#btn-ai-send").addEventListener("click", aiSend);
$("#ai-input").addEventListener("keydown", (e: Event) => {
  const ke = e as KeyboardEvent;
  if ((ke.ctrlKey || ke.metaKey) && ke.key === "Enter") {
    ke.preventDefault();
    aiSend();
  }
});

function aiSetLoading(on: boolean) {
  const el = $("#ai-loading");
  if (on) {
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
  ($("#btn-ai-send") as HTMLButtonElement).disabled = on;
  scrollAiToBottom();
}

function aiAddMessage(prompt: string, sql: string) {
  // Remove welcome message if present
  const welcome = document.querySelector(".ai-welcome");
  if (welcome) welcome.remove();

  const container = $("#ai-messages");
  const msgId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const msg = document.createElement("div");
  msg.className = "ai-msg";
  msg.id = `ai-msg-${msgId}`;

  // User prompt
  const userDiv = document.createElement("div");
  userDiv.className = "ai-msg-user";
  userDiv.textContent = prompt;
  msg.appendChild(userDiv);

  // Editable SQL block
  const sqlBlock = document.createElement("div");
  sqlBlock.className = "ai-msg-sql";

  const textarea = document.createElement("textarea");
  textarea.className = "ai-sql-editor";
  textarea.value = sql;
  textarea.spellcheck = false;
  textarea.rows = Math.min(12, sql.split("\n").length + 1);
  sqlBlock.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "ai-msg-actions";

  const btnExec = document.createElement("button");
  btnExec.textContent = "Execute";
  btnExec.id = `btn-exec-${msgId}`;
  btnExec.addEventListener("click", () => {
    const currentSql = textarea.value.trim();
    if (!currentSql) return;
    btnExec.disabled = true;
    btnExec.textContent = "Executing...";
    vscode.postMessage({ type: "aiExecute", sql: currentSql, msgId });
  });

  const btnCopy = document.createElement("button");
  btnCopy.className = "ai-action-secondary";
  btnCopy.textContent = "Copy to SQL Editor";
  btnCopy.addEventListener("click", () => {
    ($("#sql-editor") as HTMLTextAreaElement).value = textarea.value;
    (document.querySelector('.tab[data-tab="query"]') as HTMLElement)?.click();
  });

  actions.appendChild(btnExec);
  actions.appendChild(btnCopy);
  sqlBlock.appendChild(actions);
  msg.appendChild(sqlBlock);

  // Result placeholder (filled after Execute)
  const resultDiv = document.createElement("div");
  resultDiv.className = "ai-msg-result";
  resultDiv.id = `ai-result-${msgId}`;
  msg.appendChild(resultDiv);

  // Ctrl+Enter to execute from the textarea
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      btnExec.click();
    }
  });

  container.appendChild(msg);
  scrollAiToBottom();
}

function aiRenderResult(msgId: string, result: any, _sql: string) {
  // Reset the execute button
  const btn = document.getElementById(`btn-exec-${msgId}`) as HTMLButtonElement | null;
  if (btn) { btn.disabled = false; btn.textContent = "Execute"; }

  const area = document.getElementById(`ai-result-${msgId}`);
  if (!area) return;

  if (result.rowsAffected > 0) {
    area.innerHTML = `<div class="result-info">${result.rowsAffected} row(s) affected (${result.time.toFixed(1)} ms)</div>`;
  } else if (!result.columns.length) {
    area.innerHTML = `<div class="result-info">Query executed (${result.time.toFixed(1)} ms). No results.</div>`;
  } else {
    area.innerHTML =
      buildTable(result.columns, result.values, false) +
      `<div class="result-info">${result.values.length} row(s) returned (${result.time.toFixed(1)} ms)</div>`;
  }
  scrollAiToBottom();
}

function aiResetExecButtons() {
  document.querySelectorAll<HTMLButtonElement>("[id^='btn-exec-']").forEach((btn) => {
    btn.disabled = false;
    btn.textContent = "Execute";
  });
}

function scrollAiToBottom() {
  const el = $("#ai-messages");
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Toast                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function showToast(message: string, type: "info" | "error" = "info") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add("hidden"), 3000);
}
