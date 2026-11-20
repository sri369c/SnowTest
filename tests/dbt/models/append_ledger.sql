-- Copyright (c) 2026 Srinivas Chaturvedula

-- `append` never deduplicates: two runs leave six rows. fixture.py drops this
-- table first so the count is the suite's own, not the instance's history.
{{ config(materialized='incremental', incremental_strategy='append') }}

select
    order_id,
    customer_name,
    amount
from {{ ref('stg_orders') }}
