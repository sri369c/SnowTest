-- Copyright (c) 2026 Srinivas Chaturvedula

{#
  `dbt run-operation` is only worth testing if it can fail, so the expected
  count is an argument: a wrong value raises and the step goes red.
#}
{% macro row_count(table_name, expected) %}

{% set result = run_query("select count(*) as n from " ~ table_name) %}
{% if execute %}
{% set actual = result.rows[0][0] %}
{{ log("row_count: " ~ table_name ~ " = " ~ actual, info=True) }}
{% if actual != expected %}
{{ exceptions.raise_compiler_error(
    "row_count for " ~ table_name ~ ": expected " ~ expected ~ ", got " ~ actual) }}
{% endif %}
{% endif %}

{% endmacro %}
