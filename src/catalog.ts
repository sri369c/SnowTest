// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Logical catalog: the account-level objects Snowflake clients ask about
 * (databases, schemas, warehouses, roles, stages).
 *
 * Tables, views and columns are *not* mirrored here — DuckDB is the single
 * source of truth for those, and we read them back through `duckdb_tables()`
 * and `duckdb_columns()`. Keeping one source of truth means a table created
 * by a test is visible to `SHOW TABLES` immediately, with no sync step.
 */

export interface SchemaDef {
  name: string;
  comment: string | null;
}

export interface DatabaseDef {
  name: string;
  schemas: Map<string, SchemaDef>;
  comment: string | null;
  createdAt: Date;
}

export interface WarehouseDef {
  name: string;
  size: string;
  state: string;
  autoSuspendSeconds: number;
  autoResume: boolean;
}

export interface StageDef {
  database: string;
  schema: string;
  name: string;
  url: string | null;
  /** Absolute directory backing an internal stage (see stage.ts). */
  directory?: string | null;
}

export interface CatalogInit {
  databases?: Array<{ name: string; schemas?: string[] }>;
  warehouses?: string[];
  roles?: string[];
}

export interface CatalogSnapshot {
  databases: Array<{ name: string; schemas: string[] }>;
  warehouses: string[];
  roles: string[];
  stages: string[];
}

/** Snowflake folds unquoted identifiers to upper case. */
export function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed.toUpperCase();
}

export class Catalog {
  readonly databases = new Map<string, DatabaseDef>();
  readonly warehouses = new Map<string, WarehouseDef>();
  readonly roles = new Map<string, { name: string }>();
  readonly stages = new Map<string, StageDef>();

  constructor(init: CatalogInit = {}) {
    for (const role of init.roles ?? ['ACCOUNTADMIN', 'SYSADMIN', 'PUBLIC']) {
      this.roles.set(normalizeName(role), { name: normalizeName(role) });
    }
    for (const warehouse of init.warehouses ?? ['SNOWTEST_WH']) {
      this.warehouses.set(normalizeName(warehouse), {
        name: normalizeName(warehouse),
        size: 'X-SMALL',
        state: 'STARTED',
        autoSuspendSeconds: 600,
        autoResume: true,
      });
    }
    const databases = init.databases ?? [{ name: 'SNOWTEST', schemas: ['PUBLIC'] }];
    for (const database of databases) {
      this.createDatabase(database.name);
      for (const schema of database.schemas ?? ['PUBLIC']) {
        this.createSchema(database.name, schema);
      }
    }
  }

  createDatabase(name: string): { created: boolean; name: string } {
    const key = normalizeName(name);
    if (this.databases.has(key)) return { created: false, name: key };
    this.databases.set(key, {
      name: key,
      schemas: new Map(),
      comment: null,
      createdAt: new Date(),
    });
    return { created: true, name: key };
  }

  dropDatabase(name: string): boolean {
    return this.databases.delete(normalizeName(name));
  }

  getDatabase(name: string): DatabaseDef | undefined {
    return this.databases.get(normalizeName(name));
  }

  createSchema(database: string, schema: string): { created: boolean; database: string; schema: string } {
    const dbKey = normalizeName(database);
    const db = this.databases.get(dbKey);
    if (!db) {
      throw new Error(`Database '${dbKey}' does not exist.`);
    }
    const schemaKey = normalizeName(schema);
    const existed = db.schemas.has(schemaKey);
    if (!existed) {
      db.schemas.set(schemaKey, { name: schemaKey, comment: null });
    }
    return { created: !existed, database: dbKey, schema: schemaKey };
  }

  dropSchema(database: string, schema: string): boolean {
    const db = this.databases.get(normalizeName(database));
    if (!db) return false;
    return db.schemas.delete(normalizeName(schema));
  }

  getSchema(database: string, schema: string): SchemaDef | undefined {
    return this.databases.get(normalizeName(database))?.schemas.get(normalizeName(schema));
  }

  listSchemas(database: string): SchemaDef[] {
    const db = this.databases.get(normalizeName(database));
    if (!db) return [];
    return [...db.schemas.values()];
  }

  /** First database that declares this schema name, used for two-part names. */
  findDatabaseForSchema(schema: string): string | undefined {
    const key = normalizeName(schema);
    for (const db of this.databases.values()) {
      if (db.schemas.has(key)) return db.name;
    }
    return undefined;
  }

  createWarehouse(name: string): { created: boolean; name: string } {
    const key = normalizeName(name);
    if (this.warehouses.has(key)) return { created: false, name: key };
    this.warehouses.set(key, {
      name: key,
      size: 'X-SMALL',
      state: 'STARTED',
      autoSuspendSeconds: 600,
      autoResume: true,
    });
    return { created: true, name: key };
  }

  dropWarehouse(name: string): boolean {
    return this.warehouses.delete(normalizeName(name));
  }

  createRole(name: string): { created: boolean; name: string } {
    const key = normalizeName(name);
    const existed = this.roles.has(key);
    if (!existed) this.roles.set(key, { name: key });
    return { created: !existed, name: key };
  }

  dropRole(name: string): boolean {
    return this.roles.delete(normalizeName(name));
  }

  createStage(stage: StageDef): void {
    this.stages.set(`${normalizeName(stage.database)}.${normalizeName(stage.schema)}.${normalizeName(stage.name)}`, stage);
  }

  dropStage(database: string, schema: string, name: string): boolean {
    return this.stages.delete(`${normalizeName(database)}.${normalizeName(schema)}.${normalizeName(name)}`);
  }

  snapshot(): CatalogSnapshot {
    return {
      databases: [...this.databases.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((db) => ({
          name: db.name,
          schemas: [...db.schemas.keys()].sort(),
        })),
      warehouses: [...this.warehouses.keys()].sort(),
      roles: [...this.roles.keys()].sort(),
      stages: [...this.stages.keys()].sort(),
    };
  }
}
