-- Copyright (c) 2026 Srinivas Chaturvedula

-- Both decorations land in the same CREATE: `create or replace transient table
-- ... copy grants as ( ... )`. Kept apart from the clustering config so a
-- failure names one thing.
{{ config(materialized='table', transient=true, copy_grants=true) }}

select
    order_id,
    customer_name
from {{ ref('stg_orders') }}
