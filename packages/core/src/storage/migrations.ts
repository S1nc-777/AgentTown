import { DatabaseSync } from "node:sqlite";
import {
  CORE_SCHEMA_SQL,
  CORE_SCHEMA_V1_SQL,
  CORE_SCHEMA_V2_SQL
} from "./schema.js";

const CURRENT_SCHEMA_VERSION = 2;

type DatabaseRow = Record<string, unknown>;
type SchemaStructure = ReturnType<typeof readSchemaStructure>;

let expectedP1AStructure: SchemaStructure | undefined;
let expectedV2Structure: SchemaStructure | undefined;

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as DatabaseRow;
  const version = row.user_version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new TypeError("PRAGMA user_version did not return an integer");
  }
  return version;
}

function listUserTableNames(database: DatabaseSync): string[] {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as DatabaseRow[];
  return rows.map((row) => {
    if (typeof row.name !== "string") {
      throw new TypeError("sqlite_schema table name must be a string");
    }
    return row.name;
  });
}

function readString(row: DatabaseRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`${column} must be a string`);
  }
  return value;
}

function readNumber(row: DatabaseRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new TypeError(`${column} must be a number`);
  }
  return value;
}

function readNullableString(row: DatabaseRow, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${column} must be a string or null`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function readSchemaStructure(database: DatabaseSync): {
  tables: Array<{
    name: string;
    columns: Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      defaultValue: string | null;
      pk: number;
    }>;
    foreignKeys: Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      onUpdate: string;
      onDelete: string;
      match: string;
    }>;
    indexes: Array<{
      name: string | null;
      unique: number;
      origin: string;
      partial: number;
      columns: Array<{
        seqno: number;
        cid: number;
        name: string | null;
      }>;
    }>;
  }>;
  otherObjects: Array<{
    type: string;
    name: string;
    table: string;
  }>;
} {
  const tables = listUserTableNames(database).map((table) => {
    const quotedTable = quoteIdentifier(table);
    const columns = (
      database.prepare(`PRAGMA table_info(${quotedTable})`).all() as DatabaseRow[]
    ).map((row) => ({
      cid: readNumber(row, "cid"),
      name: readString(row, "name"),
      type: readString(row, "type"),
      notnull: readNumber(row, "notnull"),
      defaultValue: readNullableString(row, "dflt_value"),
      pk: readNumber(row, "pk")
    }));
    const foreignKeys = (
      database.prepare(`PRAGMA foreign_key_list(${quotedTable})`).all() as DatabaseRow[]
    ).map((row) => ({
      id: readNumber(row, "id"),
      seq: readNumber(row, "seq"),
      table: readString(row, "table"),
      from: readString(row, "from"),
      to: readNullableString(row, "to"),
      onUpdate: readString(row, "on_update"),
      onDelete: readString(row, "on_delete"),
      match: readString(row, "match")
    })).sort((left, right) => left.id - right.id || left.seq - right.seq);
    const indexes = (
      database.prepare(`PRAGMA index_list(${quotedTable})`).all() as DatabaseRow[]
    ).map((row) => {
      const indexName = readString(row, "name");
      const origin = readString(row, "origin");
      const quotedIndex = quoteIdentifier(indexName);
      const indexColumns = (
        database.prepare(`PRAGMA index_info(${quotedIndex})`).all() as DatabaseRow[]
      ).map((column) => ({
        seqno: readNumber(column, "seqno"),
        cid: readNumber(column, "cid"),
        name: readNullableString(column, "name")
      }));
      return {
        name: origin === "c" ? indexName : null,
        unique: readNumber(row, "unique"),
        origin,
        partial: readNumber(row, "partial"),
        columns: indexColumns
      };
    }).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
    return { name: table, columns, foreignKeys, indexes };
  });
  const otherObjects = database.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
      AND type NOT IN ('table', 'index')
    ORDER BY type, name
  `).all().map((row) => {
    const object = row as DatabaseRow;
    return {
      type: readString(object, "type"),
      name: readString(object, "name"),
      table: readString(object, "tbl_name")
    };
  });
  return { tables, otherObjects };
}

function canonicalStructure(schemaSql: string): SchemaStructure {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schemaSql);
    return readSchemaStructure(database);
  } finally {
    database.close();
  }
}

function isExpectedStructure(
  database: DatabaseSync,
  expected: SchemaStructure
): boolean {
  return JSON.stringify(readSchemaStructure(database)) === JSON.stringify(expected);
}

function getExpectedP1AStructure(): SchemaStructure {
  expectedP1AStructure ??= canonicalStructure(CORE_SCHEMA_V1_SQL);
  return expectedP1AStructure;
}

function getExpectedV2Structure(): SchemaStructure {
  expectedV2Structure ??= canonicalStructure(CORE_SCHEMA_SQL);
  return expectedV2Structure;
}

function isTrulyEmpty(database: DatabaseSync): boolean {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).get() as DatabaseRow;
  return readNumber(row, "count") === 0;
}

function runMigration(
  database: DatabaseSync,
  schemaSql: string
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(schemaSql);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function migrateCoreSchema(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const version = readUserVersion(database);
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`unsupported future schema version: ${version}`);
    }
    if (version === CURRENT_SCHEMA_VERSION) {
      if (!isExpectedStructure(database, getExpectedV2Structure())) {
        throw new Error("malformed v2 layout");
      }
      return;
    }
    if (version !== 0 && version !== 1) {
      throw new Error(`unsupported schema version: ${version}`);
    }

    if (version === 0 && isTrulyEmpty(database)) {
      runMigration(database, CORE_SCHEMA_SQL);
      return;
    }
    if (!isExpectedStructure(database, getExpectedP1AStructure())) {
      throw new Error(`malformed v1 layout at schema version ${version}`);
    }
    runMigration(database, CORE_SCHEMA_V2_SQL);
  } catch (error) {
    throw new Error("schema migration failed", { cause: error });
  }
}
