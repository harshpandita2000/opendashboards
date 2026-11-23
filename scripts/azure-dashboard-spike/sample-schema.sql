-- A small retail dataset for the Azure dashboard spike, shaped like the hosted
-- "Retail sales" demo (config/common.ts demoData): raw tables in `retail`,
-- reporting views in `analytics`. Deterministic (setseed), about 6k orders over
-- the last 365 days, so generated queries return real rows.
DROP SCHEMA IF EXISTS analytics CASCADE;
DROP SCHEMA IF EXISTS retail CASCADE;
CREATE SCHEMA retail;
CREATE SCHEMA analytics;
SELECT setseed(0.42);

CREATE TABLE retail.regions (id int PRIMARY KEY, name text NOT NULL);
INSERT INTO retail.regions VALUES (1,'North'),(2,'South'),(3,'East'),(4,'West'),(5,'Central');

CREATE TABLE retail.stores (id int PRIMARY KEY, name text NOT NULL, region_id int NOT NULL REFERENCES retail.regions(id), city text NOT NULL, opened_on date NOT NULL);
INSERT INTO retail.stores
SELECT g, 'Store ' || g, 1 + (g % 5), (ARRAY['Delhi','Mumbai','Kolkata','Pune','Bengaluru','Chennai','Jaipur','Lucknow'])[1 + g % 8], current_date - (400 + g * 30)
FROM generate_series(1, 16) g;

CREATE TABLE retail.products (id int PRIMARY KEY, sku text NOT NULL, name text NOT NULL, category text NOT NULL, unit_price numeric(10,2) NOT NULL, unit_cost numeric(10,2) NOT NULL);
INSERT INTO retail.products
SELECT g, 'SKU-' || lpad(g::text, 4, '0'), 'Product ' || g,
       (ARRAY['Electronics','Apparel','Home','Grocery','Beauty','Sports'])[1 + g % 6],
       round((5 + random() * 195)::numeric, 2), 0
FROM generate_series(1, 120) g;
UPDATE retail.products SET unit_cost = round(unit_price * (0.45 + random() * 0.3)::numeric, 2);

CREATE TABLE retail.customers (id int PRIMARY KEY, name text NOT NULL, email text NOT NULL, segment text NOT NULL, region_id int NOT NULL REFERENCES retail.regions(id), signed_up_on date NOT NULL);
INSERT INTO retail.customers
SELECT g, 'Customer ' || g, 'customer' || g || '@example.com', (ARRAY['Consumer','Corporate','Small Business'])[1 + g % 3], 1 + (g % 5), current_date - (random() * 720)::int
FROM generate_series(1, 1500) g;

CREATE TABLE retail.promotions (id int PRIMARY KEY, name text NOT NULL, discount_pct numeric(5,2) NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL);
INSERT INTO retail.promotions
SELECT g, 'Promo ' || g, (ARRAY[5,10,15,20,25])[1 + g % 5], current_date - g * 30, current_date - g * 30 + 14
FROM generate_series(1, 12) g;

CREATE TABLE retail.orders (
  id int PRIMARY KEY, customer_id int NOT NULL REFERENCES retail.customers(id), store_id int NOT NULL REFERENCES retail.stores(id),
  channel text NOT NULL, status text NOT NULL, promotion_id int REFERENCES retail.promotions(id), ordered_at timestamptz NOT NULL
);
INSERT INTO retail.orders
SELECT g, 1 + (random() * 1499)::int, 1 + (random() * 15)::int,
       (ARRAY['online','store','marketplace','phone'])[1 + (random() * 3)::int],
       (ARRAY['completed','completed','completed','completed','shipped','cancelled','returned'])[1 + (random() * 6)::int],
       CASE WHEN random() < 0.2 THEN 1 + (random() * 11)::int END,
       now() - (random() * 365 || ' days')::interval
FROM generate_series(1, 6000) g;

CREATE TABLE retail.order_items (id serial PRIMARY KEY, order_id int NOT NULL REFERENCES retail.orders(id), product_id int NOT NULL REFERENCES retail.products(id), quantity int NOT NULL, unit_price numeric(10,2) NOT NULL, discount numeric(10,2) NOT NULL DEFAULT 0);
INSERT INTO retail.order_items (order_id, product_id, quantity, unit_price, discount)
SELECT o.id, p.id, 1 + (random() * 3)::int, p.unit_price, CASE WHEN o.promotion_id IS NOT NULL THEN round(p.unit_price * 0.1::numeric, 2) ELSE 0 END
FROM retail.orders o
CROSS JOIN LATERAL (SELECT id, unit_price FROM retail.products ORDER BY random() + o.id * 0 LIMIT 1 + (o.id % 3)) p;

CREATE TABLE retail.refunds (id serial PRIMARY KEY, order_id int NOT NULL REFERENCES retail.orders(id), amount numeric(10,2) NOT NULL, reason text NOT NULL, refunded_at timestamptz NOT NULL);
INSERT INTO retail.refunds (order_id, amount, reason, refunded_at)
SELECT o.id, round((20 + random() * 150)::numeric, 2), (ARRAY['damaged','late','wrong item','changed mind'])[1 + (random() * 3)::int], o.ordered_at + interval '5 days'
FROM retail.orders o WHERE o.status = 'returned';

CREATE TABLE retail.sales_targets (month date NOT NULL, region_id int NOT NULL REFERENCES retail.regions(id), target_revenue numeric(12,2) NOT NULL, PRIMARY KEY (month, region_id));
INSERT INTO retail.sales_targets
SELECT date_trunc('month', current_date - (m || ' months')::interval)::date, r.id, round((90000 + random() * 40000)::numeric, 2)
FROM generate_series(0, 12) m CROSS JOIN retail.regions r;

CREATE VIEW analytics.daily_sales_by_region AS
SELECT o.ordered_at::date AS day, r.name AS region, count(DISTINCT o.id) AS orders,
       sum(oi.quantity * oi.unit_price - oi.discount) AS revenue,
       sum(oi.quantity * (oi.unit_price - p.unit_cost) - oi.discount) AS gross_margin
FROM retail.orders o
JOIN retail.order_items oi ON oi.order_id = o.id
JOIN retail.products p ON p.id = oi.product_id
JOIN retail.stores s ON s.id = o.store_id
JOIN retail.regions r ON r.id = s.region_id
WHERE o.status <> 'cancelled'
GROUP BY 1, 2;

CREATE VIEW analytics.monthly_business_kpis AS
SELECT date_trunc('month', day)::date AS month, sum(orders) AS orders, sum(revenue) AS revenue,
       sum(gross_margin) AS gross_margin, sum(revenue) / nullif(sum(orders), 0) AS average_order_value
FROM analytics.daily_sales_by_region GROUP BY 1;

CREATE VIEW analytics.customer_summary AS
SELECT c.id AS customer_id, c.name, c.segment, r.name AS region, count(DISTINCT o.id) AS orders,
       coalesce(sum(oi.quantity * oi.unit_price - oi.discount), 0) AS lifetime_revenue,
       min(o.ordered_at)::date AS first_order_on, max(o.ordered_at)::date AS last_order_on
FROM retail.customers c
JOIN retail.regions r ON r.id = c.region_id
LEFT JOIN retail.orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
LEFT JOIN retail.order_items oi ON oi.order_id = o.id
GROUP BY 1, 2, 3, 4;

CREATE VIEW analytics.target_attainment AS
SELECT t.month, r.name AS region, t.target_revenue, coalesce(sum(d.revenue), 0) AS actual_revenue,
       coalesce(sum(d.revenue), 0) / t.target_revenue AS attainment
FROM retail.sales_targets t
JOIN retail.regions r ON r.id = t.region_id
LEFT JOIN analytics.daily_sales_by_region d ON d.region = r.name AND date_trunc('month', d.day) = t.month
GROUP BY 1, 2, 3;
