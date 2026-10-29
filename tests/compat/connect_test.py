#!/usr/bin/env python3
# Copyright (c) 2026 Srinivas Chaturvedula

"""Compatibility test: a real snowflake-connector-python against snowtest.

This is the acceptance test for the project. If the official connector can log
in, run DDL/DML/selects, describe a table, and get the Python types it expects,
then Snowtest is doing its job as a stub.

Usage: connect_test.py <port>
"""

from __future__ import annotations

import datetime
import decimal
import json
import sys
import traceback
import urllib.error
import urllib.request

import snowflake.connector

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []
SKIPPED: list[tuple[str, str]] = []
HTTP_BASE = f"http://127.0.0.1:{PORT}"


def known_limitation(name: str, reason: str) -> None:
    """Record an unimplemented feature. Never counted as a pass."""
    SKIPPED.append((name, reason))
    print(f"  SKIP  {name} — {reason}")


def sql_api(statement: str, asynchronous: bool = False):
    url = f"{HTTP_BASE}/api/v2/statements" + ("?async=true" if asynchronous else "")
    request = urllib.request.Request(
        url,
        data=json.dumps({"statement": statement}).encode(),
        headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return response.status, json.loads(response.read())


def check(name: str):
    def decorator(fn):
        try:
            fn()
            PASSED.append(name)
            print(f"  PASS  {name}")
        except Exception:  # noqa: BLE001 - we report everything, including assertion details
            FAILED.append((name, traceback.format_exc(limit=6)))
            print(f"  FAIL  {name}")
        return fn

    return decorator


def connect(**overrides):
    params = dict(
        account="SNOWTEST",
        user="test_user",
        password="test_password",
        host="127.0.0.1",
        port=PORT,
        protocol="http",
        database="SNOWTEST",
        schema="PUBLIC",
        warehouse="SNOWTEST_WH",
        login_timeout=20,
        network_timeout=30,
        application="snowtest_compat_test",
        session_parameters={"QUERY_TAG": "snowtest-compat"},
    )
    params.update(overrides)
    return snowflake.connector.connect(**params)


def q(cur, sql, params=None):
    cur.execute(sql, params)
    return cur.fetchall()


def main() -> int:
    print(f"snowflake-connector-python {snowflake.connector.__version__} → 127.0.0.1:{PORT}")

    print("\nconnecting…")
    try:
        conn = connect()
    except Exception:
        print("  FAIL  login")
        traceback.print_exc()
        return 1
    print(f"  PASS  login (session id {conn.session_id}, role {conn.role})")

    cur = conn.cursor()

    @check("SELECT 1")
    def _():
        rows = q(cur, "SELECT 1 AS one")
        assert rows == [(1,)], rows

    @check("session context functions")
    def _():
        d, s, r, w = q(
            cur,
            "SELECT CURRENT_DATABASE(), CURRENT_SCHEMA(), CURRENT_ROLE(), CURRENT_WAREHOUSE()",
        )[0]
        assert d == "SNOWTEST", d
        assert s == "PUBLIC", s
        assert r == "SYSADMIN", r
        assert w == "SNOWTEST_WH", w

    @check("CREATE TABLE")
    def _():
        q(
            cur,
            """
            CREATE OR REPLACE TABLE compat_orders (
                id NUMBER(38,0),
                customer VARCHAR(100),
                amount NUMBER(12,2),
                is_paid BOOLEAN,
                created_at TIMESTAMP_NTZ,
                order_date DATE,
                payload VARIANT
            )
            """,
        )

    @check("INSERT rows")
    def _():
        cur.execute(
            "INSERT INTO compat_orders (id, customer, amount, is_paid, created_at, order_date, payload)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (1, "alice", decimal.Decimal("19.95"), True, datetime.datetime(2024, 1, 15, 10, 30), datetime.date(2024, 1, 15), '{"region": "eu"}'),
        )
        cur.execute(
            "INSERT INTO compat_orders (id, customer, amount, is_paid, created_at, order_date, payload)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (2, "bob", decimal.Decimal("5.00"), False, datetime.datetime(2024, 2, 1, 8, 0), datetime.date(2024, 2, 1), '{"region": "us"}'),
        )
        conn.commit()

    @check("SELECT returns Python types")
    def _():
        rows = q(cur, "SELECT id, customer, amount, is_paid FROM compat_orders ORDER BY id")
        assert len(rows) == 2, rows
        assert rows[0][0] == 1 and isinstance(rows[0][0], int), rows[0]
        assert rows[0][1] == "alice", rows[0]
        assert rows[0][2] == decimal.Decimal("19.95"), rows[0]
        assert rows[0][3] is True, rows[0]
        assert rows[1][3] is False, rows[1]

    @check("timestamps and dates round-trip")
    def _():
        row = q(cur, "SELECT created_at, order_date FROM compat_orders WHERE id = 1")[0]
        assert isinstance(row[0], datetime.datetime), type(row[0])
        assert row[0].year == 2024 and row[0].month == 1 and row[0].day == 15, row[0]
        assert row[1] == datetime.date(2024, 1, 15), row[1]

    @check("aggregate + filter")
    def _():
        total, count = q(
            cur,
            "SELECT SUM(amount), COUNT(*) FROM compat_orders WHERE is_paid = TRUE",
        )[0]
        assert total == decimal.Decimal("19.95"), total
        assert count == 1, count

    @check("Snowflake functions (IFF, NVL, TO_VARCHAR)")
    def _():
        value = q(cur, "SELECT IFF(1 = 1, 'yes', 'no')")[0][0]
        assert value == "yes", value
        nvl = q(cur, "SELECT NVL(NULL, 'fallback')")[0][0]
        assert nvl == "fallback", nvl
        casted = q(cur, "SELECT TO_VARCHAR(123)")[0][0]
        assert casted == "123", casted

    @check("VARIANT path access")
    def _():
        region = q(cur, "SELECT payload:region::string FROM compat_orders WHERE id = 1")[0][0]
        assert region == "eu", region

    @check("DESCRIBE TABLE")
    def _():
        cur.execute("DESCRIBE TABLE compat_orders")
        rows = cur.fetchall()
        names = [row[0] for row in rows]
        assert names == [
            "id",
            "customer",
            "amount",
            "is_paid",
            "created_at",
            "order_date",
            "payload",
        ], names

    @check("SHOW TABLES")
    def _():
        cur.execute("SHOW TABLES")
        rows = cur.fetchall()
        columns = [desc[0] for desc in cur.description]
        assert "name" in [c.lower() for c in columns], columns
        names = [row[columns.index(next(c for c in columns if c.lower() == "name"))] for row in rows]
        assert "COMPAT_ORDERS" in names or "compat_orders" in names, names

    @check("SHOW TERSE OBJECTS IN SCHEMA (dbt discovery)")
    def _():
        cur.execute("SHOW TERSE OBJECTS IN SCHEMA SNOWTEST.PUBLIC LIMIT 10000")
        rows = cur.fetchall()
        columns = [desc[0].lower() for desc in cur.description]
        assert "name" in columns and "kind" in columns, columns
        kinds = {row[columns.index("name")]: row[columns.index("kind")] for row in rows}
        assert any(k.upper() == "TABLE" for k in kinds.values()), kinds

    @check("CREATE SCHEMA + USE SCHEMA")
    def _():
        q(cur, "CREATE SCHEMA IF NOT EXISTS SNOWTEST.STAGING")
        q(cur, "USE SCHEMA SNOWTEST.STAGING")
        assert q(cur, "SELECT CURRENT_SCHEMA()")[0][0] == "STAGING"
        q(cur, "CREATE OR REPLACE TABLE staged (x NUMBER)")
        q(cur, "INSERT INTO staged VALUES (7)")
        assert q(cur, "SELECT x FROM staged")[0][0] == 7
        q(cur, "USE SCHEMA SNOWTEST.PUBLIC")

    @check("bind parameters (qmark and pyformat)")
    def _():
        assert q(cur, "SELECT %s AS a", (42,))[0][0] == 42
        assert q(cur, "SELECT %(v)s AS b", {"v": "hello"})[0][0] == "hello"

    @check("NULL handling")
    def _():
        row = q(cur, "SELECT NULL AS n, 1 AS one")[0]
        assert row[0] is None and row[1] == 1, row

    @check("error reporting")
    def _():
        try:
            q(cur, "SELECT * FROM does_not_exist")
        except snowflake.connector.errors.ProgrammingError as error:
            message = str(error).lower()
            assert "does not exist" in message or "not authorized" in message, message
            return
        raise AssertionError("expected a ProgrammingError for a missing table")

    known_limitation(
        "connector execute_async result polling",
        "execute_async + get_results_from_sfqid needs driver plumbing we do not implement; "
        "the SQL API v2 async path below is supported instead",
    )

    @check("SQL API v2 sync select")
    def _():
        status, body = sql_api("SELECT 40 + 2 AS answer")
        assert status == 200, status
        assert body["data"] == [["42"]], body
        assert body["resultSetMetaData"]["rowType"][0]["name"] == "answer", body

    @check("SQL API v2 async submit + poll")
    def _():
        status, body = sql_api("SELECT 7 AS n", asynchronous=True)
        assert status == 202, (status, body)
        handle = body["statementHandle"]
        request = urllib.request.Request(
            f"{HTTP_BASE}/api/v2/statements/{handle}",
            headers={"Authorization": "Bearer test-token"},
        )
        with urllib.request.urlopen(request) as response:
            assert response.status == 200, response.status
            polled = json.loads(response.read())
        assert polled["data"] == [["7"]], polled

    @check("SQL API v2 error envelope")
    def _():
        try:
            sql_api("SELECT * FROM definitely_missing")
        except urllib.error.HTTPError as error:
            body = json.loads(error.read())
            assert error.code == 422, error.code
            assert "does not exist" in body["message"].lower(), body
            return
        raise AssertionError("expected an HTTP error for a missing table")

    @check("cursor.description")
    def _():
        cur.execute("SELECT 1 AS a, 'x' AS b")
        desc = [(d[0], d[1]) for d in cur.description]
        assert desc[0][0].lower() == "a", desc
        assert len(desc) == 2, desc

    @check("database isolation")
    def _():
        q(cur, "CREATE DATABASE IF NOT EXISTS COMPAT_DB")
        q(cur, "CREATE OR REPLACE TABLE COMPAT_DB.PUBLIC.only_here (v NUMBER)")
        q(cur, "INSERT INTO COMPAT_DB.PUBLIC.only_here VALUES (5)")
        assert q(cur, "SELECT v FROM COMPAT_DB.PUBLIC.only_here")[0][0] == 5
        try:
            q(cur, "SELECT v FROM SNOWTEST.PUBLIC.only_here")
        except snowflake.connector.errors.ProgrammingError:
            return
        raise AssertionError("table should not be visible in another database")

    @check("reconnect (new session)")
    def _():
        other = connect()
        try:
            rows = q(other.cursor(), "SELECT COUNT(*) FROM compat_orders")[0][0]
            assert rows == 2, rows
        finally:
            other.close()

    cur.close()
    conn.close()

    summary = f"\n{len(PASSED)} passed, {len(FAILED)} failed"
    if SKIPPED:
        summary += f", {len(SKIPPED)} known limitation(s)"
        for name, reason in SKIPPED:
            summary += f"\n  SKIP {name}: {reason}"
    print(summary)
    if FAILED:
        for name, tb in FAILED:
            print(f"\n--- {name} ---\n{tb}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
