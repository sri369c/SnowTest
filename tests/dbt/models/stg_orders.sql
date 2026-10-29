-- Copyright (c) 2026 Srinivas Chaturvedula

select
    order_id,
    customer_name,
    cast(amount as number(10, 2)) as amount,
    cast(amount * 1.1 as number(10, 2)) as amount_with_tax,
    iff(amount > 10, 'large', 'small') as size_band
from (
    values
        (1, 'acme', 10.50),
        (2, 'globex', 20.00),
        (3, 'initech', 5.25)
) as t(order_id, customer_name, amount)
