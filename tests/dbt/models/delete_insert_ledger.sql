-- Copyright (c) 2026 Srinivas Chaturvedula

-- `delete+insert` deletes the matching keys before inserting, so it stays at
-- three rows however many times it runs -- the opposite of append_ledger, and
-- the reason both exist.
{{ config(materialized='incremental', incremental_strategy='delete+insert', unique_key='order_id') }}

select
    order_id,
    customer_name,
    amount
from {{ ref('stg_orders') }}
