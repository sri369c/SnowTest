-- Copyright (c) 2026 Srinivas Chaturvedula

{{ config(materialized='incremental', unique_key='order_id') }}

select
    order_id,
    customer_name,
    amount
from {{ ref('stg_orders') }}
{% if is_incremental() %}
where order_id not in (select order_id from {{ this }})
{% endif %}
