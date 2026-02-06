import * as vscode from "vscode";
import { SQLiteEditorProvider } from "./editorProvider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(SQLiteEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand("sqlity.openDatabase", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { "SQLite Database": ["db", "sqlite", "sqlite3"] },
      });
      if (uris?.length) {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          uris[0],
          SQLiteEditorProvider.viewType
        );
      }
    })
  );
}

export function deactivate(): void {}
