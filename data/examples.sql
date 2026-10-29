CREATE SCHEMA IF NOT EXISTS SNOWTEST.EXAMPLES;

CREATE OR REPLACE TABLE SNOWTEST.EXAMPLES.STORES (
    store_id INTEGER,
    store_name VARCHAR,
    city VARCHAR,
    region VARCHAR,
    opened_on DATE
);

INSERT INTO SNOWTEST.EXAMPLES.STORES VALUES
    (1, 'Downtown', 'Seattle', 'WEST', '2019-03-01'),
    (2, 'Lakeside', 'Chicago', 'CENTRAL', '2020-06-15'),
    (3, 'Harbor', 'Boston', 'EAST', '2018-11-20'),
    (4, 'Midtown', 'Austin', 'CENTRAL', '2021-02-10'),
    (5, 'Bayview', 'San Diego', 'WEST', '2022-08-05');

CREATE OR REPLACE TABLE SNOWTEST.EXAMPLES.PRODUCTS (
    product_id INTEGER,
    product_name VARCHAR,
    category VARCHAR,
    unit_price NUMBER(10, 2),
    is_active BOOLEAN
);

INSERT INTO SNOWTEST.EXAMPLES.PRODUCTS VALUES
    (1, 'Espresso Beans 1kg', 'COFFEE', 24.50, TRUE),
    (2, 'Green Tea 100g', 'TEA', 8.75, TRUE),
    (3, 'Ceramic Mug', 'ACCESSORIES', 12.00, TRUE),
    (4, 'French Press', 'EQUIPMENT', 35.00, TRUE),
    (5, 'Paper Filters x100', 'ACCESSORIES', 4.25, TRUE),
    (6, 'Decaf Beans 500g', 'COFFEE', 14.90, FALSE),
    (7, 'Hand Grinder', 'EQUIPMENT', 49.99, TRUE),
    (8, 'Chai Blend 250g', 'TEA', 11.40, TRUE);

CREATE OR REPLACE TABLE SNOWTEST.EXAMPLES.CUSTOMERS (
    customer_id INTEGER,
    first_name VARCHAR,
    last_name VARCHAR,
    email VARCHAR,
    home_store_id INTEGER,
    signed_up_on DATE
);

INSERT INTO SNOWTEST.EXAMPLES.CUSTOMERS VALUES
    (1, 'Ada', 'Lovelace', 'ada@example.com', 1, '2023-01-04'),
    (2, 'Alan', 'Turing', 'alan@example.com', 3, '2023-02-11'),
    (3, 'Grace', 'Hopper', 'grace@example.com', 2, '2023-03-19'),
    (4, 'Edsger', 'Dijkstra', 'edsger@example.com', 4, '2023-05-02'),
    (5, 'Barbara', 'Liskov', 'barbara@example.com', 5, '2023-07-23'),
    (6, 'Donald', 'Knuth', 'donald@example.com', 1, '2023-09-30');

CREATE OR REPLACE TABLE SNOWTEST.EXAMPLES.ORDERS (
    order_id INTEGER,
    customer_id INTEGER,
    store_id INTEGER,
    ordered_at TIMESTAMP_NTZ,
    status VARCHAR
);

INSERT INTO SNOWTEST.EXAMPLES.ORDERS VALUES
    (1, 1, 1, '2024-01-05 09:12:00', 'COMPLETED'),
    (2, 2, 3, '2024-01-06 14:30:00', 'COMPLETED'),
    (3, 3, 2, '2024-01-08 11:05:00', 'COMPLETED'),
    (4, 1, 1, '2024-01-15 16:45:00', 'RETURNED'),
    (5, 4, 4, '2024-02-01 10:00:00', 'COMPLETED'),
    (6, 5, 5, '2024-02-03 13:20:00', 'COMPLETED'),
    (7, 6, 1, '2024-02-10 08:55:00', 'PENDING'),
    (8, 2, 3, '2024-02-14 17:10:00', 'COMPLETED'),
    (9, 3, 2, '2024-03-01 12:40:00', 'CANCELLED'),
    (10, 5, 5, '2024-03-07 15:15:00', 'COMPLETED');

CREATE OR REPLACE TABLE SNOWTEST.EXAMPLES.ORDER_ITEMS (
    order_item_id INTEGER,
    order_id INTEGER,
    product_id INTEGER,
    quantity INTEGER,
    unit_price NUMBER(10, 2)
);

INSERT INTO SNOWTEST.EXAMPLES.ORDER_ITEMS VALUES
    (1, 1, 1, 2, 24.50),
    (2, 1, 3, 1, 12.00),
    (3, 2, 2, 3, 8.75),
    (4, 3, 4, 1, 35.00),
    (5, 3, 5, 2, 4.25),
    (6, 4, 7, 1, 49.99),
    (7, 5, 1, 1, 24.50),
    (8, 5, 8, 2, 11.40),
    (9, 6, 2, 1, 8.75),
    (10, 6, 3, 2, 12.00),
    (11, 7, 6, 1, 14.90),
    (12, 8, 4, 1, 35.00),
    (13, 8, 5, 1, 4.25),
    (14, 9, 7, 1, 49.99),
    (15, 10, 1, 3, 24.50);
