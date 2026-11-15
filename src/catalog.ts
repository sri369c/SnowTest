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

import { objectNotFound } from './errors.js';

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
  /** When the stage was created; `DESCRIBE STAGE` reports it and it never moves. */
  createdAt?: Date;
}

/**
 * A named `CREATE FILE FORMAT`. Snowflake lets a format be created, shown and
 * described; here it is recorded so those two answers are not invented. Kept in
 * memory like roles and warehouses, so a restart forgets it.
 */
export interface FileFormatDef {
  database: string;
  schema: string;
  name: string;
  /** Upper-case `TYPE`, defaulting to CSV the way Snowflake does. */
  type: string;
  /** The option list exactly as written, `TYPE` included. */
  options: string;
  owner: string;
  createdAt: Date;
}

/**
 * One `GRANT`. Access control is recorded, never enforced: there is no
 * privilege model here, so these rows exist to let `SHOW GRANTS` answer honestly
 * about what a client said rather than about what it may do.
 *
 * A role grant is the same shape as a privilege grant — `USAGE` on a `ROLE` —
 * which is how Snowflake reports it too.
 */
export interface GrantDef {
  /** The privilege itself, or `USAGE` for `GRANT ROLE a TO b`. */
  privilege: string;
  /** Object kind (`TABLE`, `DATABASE`, `ACCOUNT`) or `ROLE` for a role grant. */
  grantedOn: string;
  /** Canonical object name; null for an account-wide grant. */
  name: string | null;
  grantedTo: 'ROLE' | 'USER';
  granteeName: string;
  grantOption: boolean;
  /** The role that issued the grant. */
  grantedBy: string;
  createdAt: Date;
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
  readonly fileFormats = new Map<string, FileFormatDef>();
  /**
   * The `START` each sequence was created with. DuckDB keeps only the next value,
   * and rewriting a sequence for `ALTER … RESTART WITH n` replaces that, so the
   * value a bare `RESTART` returns to is remembered here.
   */
  readonly sequenceStarts = new Map<string, number>();
  /**
   * When each sequence was created, so `SHOW SEQUENCES` and `DESCRIBE SEQUENCE`
   * report a `created_on` that does not move. DuckDB keeps no such thing.
   */
  readonly sequenceCreatedAt = new Map<string, Date>();
  readonly grants: GrantDef[] = [];

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
      // Same shape as every other missing object, so callers get a Snowflake error
      // instead of a generic 500 from a bare `Error`.
      throw objectNotFound('DATABASE', database);
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

  /** A dropped role takes its grants with it, as in Snowflake. */
  dropRole(key: string): boolean {
    const dropped = this.roles.delete(key);
    for (let index = this.grants.length - 1; index >= 0; index -= 1) {
      const grant = this.grants[index];
      const asGrantee = grant.grantedTo === 'ROLE' && grant.granteeName === key;
      const asGrantedRole = grant.grantedOn === 'ROLE' && grant.name === key;
      if (asGrantee || asGrantedRole) this.grants.splice(index, 1);
    }
    return dropped;
  }

  /** Record a grant, replacing an identical one so `WITH GRANT OPTION` can be re-granted. */
  addGrant(grant: GrantDef): void {
    const same = (other: GrantDef): boolean =>
      other.privilege === grant.privilege &&
      other.grantedOn === grant.grantedOn &&
      other.name === grant.name &&
      other.grantedTo === grant.grantedTo &&
      other.granteeName === grant.granteeName;
    const existing = this.grants.findIndex(same);
    if (existing >= 0) this.grants.splice(existing, 1);
    this.grants.push(grant);
  }

  /**
   * Forget every grant recorded on an object, and on the objects beneath it —
   * dropping a schema or a database drops the grants inside it too. Returns how
   * many went.
   */
  purgeGrantsFor(name: string): number {
    const before = this.grants.length;
    const kept = this.grants.filter(
      (grant) => grant.name !== name && !(grant.name?.startsWith(`${name}.`) ?? false),
    );
    this.grants.length = 0;
    this.grants.push(...kept);
    return before - kept.length;
  }

  /** Remove matching grants, ignoring any field left undefined; returns how many went. */
  removeGrants(match: {
    privilege?: string;
    grantedOn?: string;
    name?: string | null;
    grantedTo: 'ROLE' | 'USER';
    granteeName: string;
  }): number {
    const before = this.grants.length;
    const kept = this.grants.filter(
      (grant) =>
        !(
          (match.privilege === undefined || grant.privilege === match.privilege) &&
          (match.grantedOn === undefined || grant.grantedOn === match.grantedOn) &&
          (match.name === undefined || grant.name === match.name) &&
          grant.grantedTo === match.grantedTo &&
          grant.granteeName === match.granteeName
        ),
    );
    this.grants.length = 0;
    this.grants.push(...kept);
    return before - kept.length;
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

  /** Record or replace a named file format; `DESCRIBE FILE FORMAT` reads it back. */
  defineFileFormat(format: FileFormatDef): void {
    this.fileFormats.set(`${format.database}.${format.schema}.${format.name}`, format);
  }

  getFileFormat(database: string, schema: string, name: string): FileFormatDef | undefined {
    return this.fileFormats.get(`${database}.${schema}.${name}`);
  }

  dropFileFormat(database: string, schema: string, name: string): boolean {
    return this.fileFormats.delete(`${database}.${schema}.${name}`);
  }

  /** Remove every file format in a database, or in one of its schemas. */
  dropFileFormatsIn(database: string, schema?: string): void {
    for (const [key, format] of this.fileFormats) {
      if (format.database === database && (schema === undefined || format.schema === schema)) {
        this.fileFormats.delete(key);
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
