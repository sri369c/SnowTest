-- Copyright (c) 2026 Srinivas Chaturvedula

-- Check strategy: no timestamp column, so a changed checked column is what
-- opens a new version.
{% snapshot region_snapshot %}

{{ config(
    target_schema='DBT_TEST',
    unique_key='customer_id',
    strategy='check',
    check_cols=['region'],
) }}

select
    customer_id,
    region
from {{ source('raw', 'customer_region') }}

{% endsnapshot %}
