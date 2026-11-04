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

/**
 * Every name passed to a Catalog method is a canonical key: `normalizeName` is
 * applied once, where SQL text or configuration enters, never again here.
 */
export class Catalog {
  readonly databases = new Map<string, DatabaseDef>();
  readonly warehouses = new Map<string, WarehouseDef>();
  readonly roles = new Map<string, { name: string }>();
  readonly stages = new Map<string, StageDef>();

  constructor(init: CatalogInit = {}) {
    for (const role of init.roles ?? ['ACCOUNTADMIN', 'SYSADMIN', 'PUBLIC']) {
      this.createRole(role);
    }
    for (const warehouse of init.warehouses ?? ['SNOWTEST_WH']) {
      this.createWarehouse(warehouse);
    }
    const databases = init.databases ?? [{ name: 'SNOWTEST', schemas: ['PUBLIC'] }];
    for (const database of databases) {
      this.createDatabase(database.name);
      for (const schema of database.schemas ?? ['PUBLIC']) {
        this.createSchema(database.name, schema);
      }
    }
  }

  createDatabase(key: string): { created: boolean; name: string } {
    if (this.databases.has(key)) return { created: false, name: key };
    this.databases.set(key, {
      name: key,
      schemas: new Map(),
      comment: null,
      createdAt: new Date(),
    });
    return { created: true, name: key };
  }

  dropDatabase(key: string): boolean {
    return this.databases.delete(key);
  }

  getDatabase(key: string): DatabaseDef | undefined {
    return this.databases.get(key);
  }

  createSchema(database: string, schema: string): { created: boolean; database: string; schema: string } {
    const db = this.databases.get(database);
    if (!db) {
      throw new Error(`Database '${database}' does not exist.`);
    }
    const existed = db.schemas.has(schema);
    if (!existed) {
      db.schemas.set(schema, { name: schema, comment: null });
    }
    return { created: !existed, database, schema };
  }

  dropSchema(database: string, schema: string): boolean {
    const db = this.databases.get(database);
    if (!db) return false;
    return db.schemas.delete(schema);
  }

  getSchema(database: string, schema: string): SchemaDef | undefined {
    return this.databases.get(database)?.schemas.get(schema);
  }

  listSchemas(database: string): SchemaDef[] {
    const db = this.databases.get(database);
    if (!db) return [];
    return [...db.schemas.values()];
  }

  createWarehouse(key: string): { created: boolean; name: string } {
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

  dropWarehouse(key: string): boolean {
    return this.warehouses.delete(key);
  }

  createRole(key: string): { created: boolean; name: string } {
    const existed = this.roles.has(key);
    if (!existed) this.roles.set(key, { name: key });
    return { created: !existed, name: key };
  }

  dropRole(key: string): boolean {
    return this.roles.delete(key);
  }

  createStage(stage: StageDef): void {
    this.stages.set(`${stage.database}.${stage.schema}.${stage.name}`, stage);
  }

  dropStage(database: string, schema: string, name: string): boolean {
    return this.stages.delete(`${database}.${schema}.${name}`);
  }

  /** Remove every stage in a database, or in one of its schemas. */
  dropStagesIn(database: string, schema?: string): void {
    for (const [key, stage] of this.stages) {
      if (stage.database === database && (schema === undefined || stage.schema === schema)) {
        this.stages.delete(key);
      }
    }
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
