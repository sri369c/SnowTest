-- Copyright (c) 2026 Srinivas Chaturvedula

-- Timestamp strategy: a changed `updated_at` is what opens a new version.
{% snapshot customer_snapshot %}

{{ config(
    target_schema='DBT_TEST',
    unique_key='customer_id',
    strategy='timestamp',
    updated_at='updated_at',
) }}

select
    customer_id,
    customer_name,
    updated_at
from {{ source('raw', 'customer_state') }}

{% endsnapshot %}
