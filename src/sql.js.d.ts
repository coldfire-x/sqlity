declare module "sql.js" {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string, params?: any[]): QueryExecResult[];
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }

  interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  interface SqlJsOptions {
    locateFile?: (filename: string) => string;
    wasmBinary?: ArrayLike<number> | Buffer;
  }

  export default function initSqlJs(options?: SqlJsOptions): Promise<SqlJsStatic>;
  export type { Database, SqlJsStatic, QueryExecResult };
}
