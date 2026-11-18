// Copyright (c) 2026 Srinivas Chaturvedula

/**
 * What a routed statement produced.
 *
 * This lives on its own so both sides of the router — the router itself and the
 * interceptor wrapped around it — can name the type without importing each
 * other. A type-only cycle compiles and even emits cleanly, which is exactly
 * why it is worth avoiding: the day someone adds a value import across that
 * seam, module evaluation order starts deciding whether the server boots.
 */

import type { SnowflakeColumn } from '../http/types.js';

export interface Outcome {
  columns: SnowflakeColumn[];
  /** Values already encoded for the wire. */
  rows: unknown[][];
  statementTypeId: number;
  rowsAffected: number;
  /**
   * PUT/GET are not result sets: the driver protocol answers with a file
   * transfer descriptor (`command`, `stageInfo`, …) that the client acts on
   * itself. The server puts this object in the response `data`.
   */
  fileTransfer?: Record<string, unknown>;
}
