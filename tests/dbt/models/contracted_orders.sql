-- Copyright (c) 2026 Srinivas Chaturvedula

-- An enforced contract makes dbt emit a typed column list before the AS, which
-- snowtest answers with a typed CREATE followed by an INSERT rather than a
-- plain CTAS. The declared types live in schema.yml.
{{ config(materialized='table', contract={'enforced': true}) }}

select
    cast(order_id as number(10, 0)) as order_id,
    cast(customer_name as varchar(64)) as customer_name,
    cast(amount as number(10, 2)) as amount
from {{ ref('stg_orders') }}
