# Copyright (c) 2026 Srinivas Chaturvedula

"""The state the snapshot and freshness checks need, and the cleanup that keeps
the suite re-runnable on an instance it did not create.

    init     drop what accumulates between runs, then recreate the raw tables
    mutate   change one row in each raw table, so a second `dbt snapshot`
             records a second version
    stale    age every raw row, so `dbt source freshness` has something real to
             fail on

The raw tables are not dbt models: they stand in for whatever upstream load a
real project would snapshot, which is what makes the snapshots meaningful.
"""

import os
import sys

import snowflake.connector

PORT = int(os.environ.get("SNOWTEST_PORT", "18081"))
KEY = os.environ["SNOWTEST_DBT_KEY"]

CUSTOMER_STATE = "SNOWTEST.DBT_TEST.CUSTOMER_STATE"
CUSTOMER_REGION = "SNOWTEST.DBT_TEST.CUSTOMER_REGION"

NOW = "cast(current_timestamp() as timestamp_ntz)"


def connect():
    return snowflake.connector.connect(
        account="SNOWTEST",
        user="DBT_SVC",
        authenticator="snowflake_jwt",
        private_key_file=KEY,
        database="SNOWTEST",
        schema="DBT_TEST",
        warehouse="SNOWTEST_WH",
        role="SYSADMIN",
        host="127.0.0.1",
        port=PORT,
        protocol="http",
        login_timeout=10,
    )


def run(*statements: str) -> None:
    """Run the statements in order on one session."""
    with connect() as conn:
        cursor = conn.cursor()
        try:
            for statement in statements:
                cursor.execute(statement)
        finally:
            cursor.close()


def init() -> None:
    """Start from the suite's own baseline.

    `APPEND_LEDGER` gains three rows on every `dbt run`, so a suite re-run on a
    borrowed instance would otherwise start from a count nobody expected; the
    snapshot tables accumulate versions the same way.
    """
    run(
        # This runs before dbt's first run, so the schema it writes into may not
        # exist yet.
        "create schema if not exists SNOWTEST.DBT_TEST",
        "drop table if exists SNOWTEST.DBT_TEST.APPEND_LEDGER",
        "drop table if exists SNOWTEST.DBT_TEST.CUSTOMER_SNAPSHOT",
        "drop table if exists SNOWTEST.DBT_TEST.REGION_SNAPSHOT",
        f"create or replace table {CUSTOMER_STATE} "
        "(customer_id number(10,0), customer_name varchar(64), updated_at timestamp_ntz)",
        f"insert into {CUSTOMER_STATE} values "
        f"(1, 'acme', {NOW}), (2, 'globex', {NOW}), (3, 'initech', {NOW})",
        f"create or replace table {CUSTOMER_REGION} (customer_id number(10,0), region varchar(8))",
        f"insert into {CUSTOMER_REGION} values (1, 'eu'), (2, 'us'), (3, 'us')",
    )
    print("fixture: raw tables recreated; append ledger and snapshot tables dropped")


def mutate() -> None:
    """Change one row in each raw table, and nothing else."""
    run(
        f"update {CUSTOMER_STATE} set customer_name = 'acme-renamed', updated_at = {NOW} "
        "where customer_id = 1",
        f"update {CUSTOMER_REGION} set region = 'apac' where customer_id = 1",
    )
    print("fixture: one row changed in each raw table")


def stale() -> None:
    """Age every row past the source's error_after threshold."""
    run(
        f"update {CUSTOMER_STATE} set updated_at = "
        "cast(dateadd(day, -3, current_timestamp()) as timestamp_ntz)"
    )
    print("fixture: every raw row aged three days")


COMMANDS = {"init": init, "mutate": mutate, "stale": stale}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in COMMANDS:
        print(f"usage: fixture.py {{{'|'.join(COMMANDS)}}}", file=sys.stderr)
        return 2
    COMMANDS[argv[0]]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
