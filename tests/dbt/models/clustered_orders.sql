-- Copyright (c) 2026 Srinivas Chaturvedula

-- `cluster_by` becomes part of the CREATE (`order by (...)` inside it) plus an
-- `alter table ... cluster by`; `automatic_clustering` adds `resume recluster`,
-- but only when a cluster key exists, which is why the two share a model.
{{ config(materialized='table', cluster_by=['order_id'], automatic_clustering=true) }}

select
    order_id,
    customer_name,
    amount
from {{ ref('stg_orders') }}
