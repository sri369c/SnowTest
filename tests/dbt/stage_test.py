# Copyright (c) 2026 Srinivas Chaturvedula

"""PUT / LIST / COPY INTO / GET against snowtest, using key-pair auth.

This is the staged-file path: the connector uploads with PUT, the server loads
with COPY INTO, and GET brings a file back.
"""

import os
import sys
import tempfile

import snowflake.connector

PORT = int(os.environ.get("SNOWTEST_PORT", "18081"))
KEY = os.environ["SNOWTEST_DBT_KEY"]

failures: list[str] = []


def assert_eq(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def check(name: str, fn) -> None:
    try:
        fn()
        print(f"ok   - {name}")
    except Exception as error:  # noqa: BLE001 - assertion text is the output
        failures.append(name)
        print(f"FAIL - {name}: {type(error).__name__}: {error}")


conn = snowflake.connector.connect(
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
cur = conn.cursor()


def q(sql, params=None):
    cur.execute(sql, params)
    return cur.fetchall()


source = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False)
source.write("order_id,customer_name,amount\n10,acme,19.95\n11,globex,5.00\n")
source.close()

cur.execute("create or replace stage SNOWTEST.DBT_TEST.STAGED_FILES")
cur.execute("remove @SNOWTEST.DBT_TEST.STAGED_FILES")
cur.execute("create or replace table SNOWTEST.DBT_TEST.STAGED_ORDERS (order_id number, customer_name text, amount float)")


def put_file() -> None:
    rows = q(f"put file://{source.name} @SNOWTEST.DBT_TEST.STAGED_FILES/data/ auto_compress=false")
    assert rows, "PUT returned no rows"
    assert all(row[-2] == "UPLOADED" for row in rows), rows


def list_stage() -> None:
    rows = q("list @SNOWTEST.DBT_TEST.STAGED_FILES")
    names = [row[0] for row in rows]
    assert any(name.endswith(os.path.basename(source.name)) for name in names), names


def copy_into() -> None:
    rows = q(
        "copy into SNOWTEST.DBT_TEST.STAGED_ORDERS from @SNOWTEST.DBT_TEST.STAGED_FILES/data/ "
        "file_format = (type = csv skip_header = 1)"
    )
    assert rows and rows[0][1] == "LOADED", rows
    assert int(rows[0][3]) == 2, rows


def verify_rows() -> None:
    assert_eq(q("select count(*) from SNOWTEST.DBT_TEST.STAGED_ORDERS")[0][0], 2, "rows")
    assert_eq(
        q("select customer_name from SNOWTEST.DBT_TEST.STAGED_ORDERS where order_id = 10")[0][0],
        "acme",
        "lookup",
    )


def get_file() -> None:
    target = tempfile.mkdtemp()
    cur.execute(f"get @SNOWTEST.DBT_TEST.STAGED_FILES/data/ file://{target}/")
    names = os.listdir(target)
    assert names, f"GET downloaded nothing into {target}"
    with open(os.path.join(target, names[0]), encoding="utf-8") as handle:
        assert "acme" in handle.read(), "downloaded file has no data"


def remove_file() -> None:
    q("remove @SNOWTEST.DBT_TEST.STAGED_FILES/data/")
    assert q("list @SNOWTEST.DBT_TEST.STAGED_FILES") == [], "stage not empty after REMOVE"


check("PUT uploads a file to an internal stage", put_file)
check("LIST shows the staged file", list_stage)
check("COPY INTO loads the staged file", copy_into)
check("loaded rows are queryable", verify_rows)
check("GET downloads the file back", get_file)
check("REMOVE clears the stage", remove_file)

print()
if failures:
    print(f"{len(failures)} check(s) failed")
    sys.exit(1)
print("all stage checks passed")
