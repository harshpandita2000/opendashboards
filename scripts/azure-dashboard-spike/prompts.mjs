// Ten realistic dashboard requests over the sample retail dataset (sample-schema.sql).
// Each one is what OpenDashboards' Build agent would hand the dashboard generator:
// the business question, plus the connection to use. The generator has to write the
// SQL itself from the schema, which is stricter than the Build agent's usual prompt
// (that one normally includes the exact queries).
export const CONNECTION_ID = "6f1c2b9e-4d3a-4f7e-9c11-2a8b5e0d7f31";

export const PROMPTS = [
  { id: "exec-overview", title: "Executive overview", prompt: "An executive overview: revenue, orders, average order value and gross margin by month, with KPIs comparing this month to last month." },
  { id: "region-category", title: "Sales by region and category", prompt: "Sales by region and product category over the last 90 days, with a date range filter (7, 30, 90 days) and a region filter." },
  { id: "promo-refunds", title: "Promotions and refunds", prompt: "How much promotions and refunds cost us each month: discount amount, refund amount and refund reasons breakdown." },
  { id: "top-products", title: "Top products", prompt: "Top 15 products by revenue in the last 30 days with units sold, revenue and margin %, plus revenue share by category." },
  { id: "customer-segments", title: "Customer segments", prompt: "Customer segments: number of customers, lifetime revenue and average orders per customer by segment and region; table of the top 20 customers." },
  { id: "target-attainment", title: "Target attainment", prompt: "Monthly revenue target attainment by region for the last 6 months, highlighting regions below 90% of target." },
  { id: "channel-mix", title: "Channel mix", prompt: "Order channel mix (online, store, marketplace, phone): orders and revenue by channel over time, with a channel filter." },
  { id: "order-status", title: "Order fulfilment", prompt: "Order fulfilment health: share of orders completed, shipped, cancelled and returned per week for the last 12 weeks." },
  { id: "store-leaderboard", title: "Store leaderboard", prompt: "A store leaderboard: revenue, orders and average order value per store and city for a selectable period, with a comparison to the previous period." },
  { id: "new-vs-returning", title: "New vs returning", prompt: "New versus returning customers per month: first-time buyers, repeat buyers and revenue from each, for the last 12 months." },
];

// What postgres_tables would return for the sample dataset, as the model sees it.
export const SCHEMA_DESCRIPTION = `PostgreSQL connection "Retail sales" (id ${CONNECTION_ID}). Raw tables in schema retail, ready-made reporting views in schema analytics. Prefer the analytics views for standard metrics.

retail.regions(id int, name text)
retail.stores(id int, name text, region_id int -> regions.id, city text, opened_on date)
retail.products(id int, sku text, name text, category text, unit_price numeric, unit_cost numeric)
retail.customers(id int, name text, email text, segment text ['Consumer','Corporate','Small Business'], region_id int -> regions.id, signed_up_on date)
retail.promotions(id int, name text, discount_pct numeric, starts_on date, ends_on date)
retail.orders(id int, customer_id int -> customers.id, store_id int -> stores.id, channel text ['online','store','marketplace','phone'], status text ['completed','shipped','cancelled','returned'], promotion_id int -> promotions.id nullable, ordered_at timestamptz)
retail.order_items(id int, order_id int -> orders.id, product_id int -> products.id, quantity int, unit_price numeric, discount numeric)  -- line revenue = quantity * unit_price - discount
retail.refunds(id int, order_id int -> orders.id, amount numeric, reason text, refunded_at timestamptz)
retail.sales_targets(month date, region_id int -> regions.id, target_revenue numeric)
analytics.daily_sales_by_region(day date, region text, orders bigint, revenue numeric, gross_margin numeric)  -- excludes cancelled orders
analytics.monthly_business_kpis(month date, orders numeric, revenue numeric, gross_margin numeric, average_order_value numeric)
analytics.customer_summary(customer_id int, name text, segment text, region text, orders bigint, lifetime_revenue numeric, first_order_on date, last_order_on date)
analytics.target_attainment(month date, region text, target_revenue numeric, actual_revenue numeric, attainment numeric)  -- attainment is a ratio (1.0 = 100%)`;
