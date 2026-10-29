// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * Wire envelopes.
 *
 * Two different response dialects share almost no structure:
 *  - the driver protocol wraps everything in `{success, data, message}` where
 *    `data` carries `rowtype`/`rowset`
 *  - the SQL REST API v2 returns a flat object with `resultSetMetaData`
 *
 * Both are built from the same `Outcome`, so the two surfaces never disagree
 * about a query's shape.
 */

import type { Outcome } from './meta.js';
import type { Session } from './session.js';
import { SnowflakeError } from './errors.js';
import { toApiV2Rowset, toApiV2RowType, toDriverRowset, toDriverRowType } from './types.js';

export const SERVER_VERSION = '8.42.0';

export function loginResponse(
  session: Session,
  token: string,
  masterToken: string,
): Record<string, unknown> {
  return {
    success: true,
    data: {
      token,
      validityInSeconds: 3600,
      masterToken,
      masterValidityInSeconds: 14400,
      sessionId: session.id,
      parameters: session.parameterList(),
      sessionInfo: {
        databaseName: session.database,
        schemaName: session.schema,
        warehouseName: session.warehouse,
        roleName: session.role,
      },
      displayUserName: session.user,
      serverVersion: SERVER_VERSION,
      firstLogin: true,
      remMeToken: null,
      remMeValidityInSeconds: 0,
      healthCheckInterval: 45,
      newClientForUpgrade: null,
      idToken: null,
      idTokenValidityInSeconds: 0,
      ssoUrl: null,
      nextAction: null,
      inFlightCtx: null,
    },
    message: null,
  };
}

export function tokenResponse(session: Session, token: string, masterToken: string): Record<string, unknown> {
  return {
    success: true,
    data: {
      sessionToken: token,
      validityInSecondsST: 3600,
      masterToken,
      validityInSecondsMT: 14400,
      masterValidityInSeconds: 14400,
      sessionId: session.id,
    },
    message: null,
  };
}

/** The driver-protocol query result (`/queries/v1/query-request`). */
export function driverQueryResponse(
  session: Session,
  outcome: Outcome,
  queryId: string,
): Record<string, unknown> {
  return {
    success: true,
    data: {
      queryId,
      sqlState: '00000',
      statementTypeId: outcome.statementTypeId,
      version: 1,
      queryResultFormat: 'json',
      rowtype: toDriverRowType(outcome.columns),
      rowset: toDriverRowset(outcome.rows, outcome.columns),
      total: outcome.rows.length,
      returned: outcome.rows.length,
      finalDatabaseName: session.database,
      finalSchemaName: session.schema,
      finalWarehouseName: session.warehouse,
      finalRoleName: session.role,
      numberOfBinds: 0,
      arrayBindSupported: false,
      parameters: [],
      queryContext: { entries: [] },
      sessionId: session.id,
    },
    message: null,
  };
}

/** The SQL REST API v2 result body. */
export function sqlApiResult(
  session: Session,
  outcome: Outcome,
  queryId: string,
  statementHandle: string,
): Record<string, unknown> {
  const data = toApiV2Rowset(outcome.rows, outcome.columns);
  const uncompressed = Buffer.byteLength(
    JSON.stringify(outcome.rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    'utf8',
  );
  return {
    statementHandle,
    statementStatusUrl: `/api/v2/statements/${statementHandle}`,
    queryId,
    sqlState: '00000',
    statementTypeId: outcome.statementTypeId,
    createdOn: new Date().toISOString(),
    message: 'Statement executed successfully.',
    resultSetMetaData: {
      numRows: outcome.rows.length,
      format: 'jsonv2',
      partitionInfo: [{ rowCount: outcome.rows.length, uncompressedSize: uncompressed }],
      rowType: toApiV2RowType(outcome.columns),
    },
    data,
    code: '090001',
    returnedRows: outcome.rows.length,
    sessionDatabase: session.database,
    sessionSchema: session.schema,
    sessionWarehouse: session.warehouse,
    sessionRole: session.role,
  };
}

export function driverErrorResponse(error: SnowflakeError): Record<string, unknown> {
  return {
    success: false,
    code: error.code,
    message: error.message,
    sqlState: error.sqlState,
    data: null,
  };
}

export function sqlApiErrorBody(error: SnowflakeError, statementHandle?: string): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    sqlState: error.sqlState,
    statementHandle: statementHandle ?? null,
    queryId: statementHandle ?? null,
  };
}

export function successEnvelope(data: unknown = null): Record<string, unknown> {
  return { success: true, data, message: null };
}
