# Copyright (c) 2026 Srinivas Chaturvedula

"""Assert what dbt produced, using key-pair auth over the driver protocol.

Reuses the same private key dbt signed with, so a pass here proves both that the
JWT is accepted and that the transformations really ran.
"""

import os
import sys

import snowflake.connector

PORT = int(os.environ.get("SNOWTEST_PORT", "18081"))
KEY = os.environ["SNOWTEST_DBT_KEY"]
BAD_KEY = os.environ.get("SNOWTEST_BAD_KEY", "")

failures: list[str] = []


def assert_eq(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def check(name: str, fn) -> None:
    try:
        fn()
        print(f"ok   - {name}")
    except Exception as error:  # noqa: BLE001 - the assertion text is the output
        failures.append(name)
        print(f"FAIL - {name}: {type(error).__name__}: {error}")


def connect(key_path: str = KEY):
    return snowflake.connector.connect(
        account="SNOWTEST",
        user="DBT_SVC",
        authenticator="snowflake_jwt",
        private_key_file=key_path,
        database="SNOWTEST",
        schema="DBT_TEST",
        warehouse="SNOWTEST_WH",
        role="SYSADMIN",
        host="127.0.0.1",
        port=PORT,
        protocol="http",
        login_timeout=10,
    )


def scalar(conn, sql: str):
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        return cursor.fetchone()[0]
    finally:
        cursor.close()


with connect() as conn:
    check("stg_orders is a view with 3 rows", lambda: assert_eq(scalar(conn, "select count(*) from SNOWTEST.DBT_TEST.STG_ORDERS"), 3, "rows"))
    check("customer_totals is a table", lambda: assert_eq(scalar(conn, "select count(*) from SNOWTEST.DBT_TEST.CUSTOMER_TOTALS"), 3, "rows"))
    check("customer_totals holds the right sum", lambda: assert_eq(str(scalar(conn, "select sum(total_amount) from SNOWTEST.DBT_TEST.CUSTOMER_TOTALS")), "35.75", "total"))
    check("incremental model ran once without duplicating", lambda: assert_eq(scalar(conn, "select count(*) from SNOWTEST.DBT_TEST.ORDER_LEDGER"), 3, "rows"))
    check("incremental model has unique keys", lambda: assert_eq(scalar(conn, "select count(*) from (select order_id from SNOWTEST.DBT_TEST.ORDER_LEDGER group by order_id having count(*) > 1)"), 0, "duplicates"))
    check("dbt seed loaded every row", lambda: assert_eq(scalar(conn, "select count(*) from SNOWTEST.DBT_TEST.SEED_CUSTOMERS"), 3, "rows"))
    check("seed boolean column round-trips", lambda: assert_eq(scalar(conn, "select count(*) from SNOWTEST.DBT_TEST.SEED_CUSTOMERS where is_active = true"), 2, "active rows"))

if BAD_KEY:
    def reject_wrong_key() -> None:
        try:
            connect(BAD_KEY)
        except Exception as error:  # noqa: BLE001
            if "390" in str(error) or "invalid" in str(error).lower():
                return
            raise AssertionError(f"unexpected error for wrong key: {error}") from error
        raise AssertionError("a JWT signed by an unregistered key was accepted")

    check("key-pair login with a different private key is rejected", reject_wrong_key)

print()
if failures:
    print(f"{len(failures)} check(s) failed")
    sys.exit(1)
print("all dbt key-pair checks passed")
