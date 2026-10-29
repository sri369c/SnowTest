-- Copyright (c) 2026 Srinivas Chaturvedula

{{ config(materialized='table') }}

select
    customer_name,
    sum(amount) as total_amount,
    count(*) as order_count
from {{ ref('stg_orders') }}
group by customer_name
