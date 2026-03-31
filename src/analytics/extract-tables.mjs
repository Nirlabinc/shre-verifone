#!/usr/bin/env node
/**
 * Verifone Analytics — Extract Normalized Tables from JSONB
 *
 * Reads raw JSONB data from verifone.data_* tables and normalizes
 * into structured tables in the verifone schema for analytics views.
 *
 * Usage: node src/analytics/extract-tables.mjs
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getInfra } from 'shre-sdk/discovery';

// ─── CortexDB connection ────────────────────────────────────────
let pgHost = '127.0.0.1';
let pgPort = 5433;
try {
  const infra = getInfra('postgres');
  pgPort = infra.port;
  pgHost = process.env.SHRE_NODE_HOST || pgHost;
} catch {
  /* discovery unavailable — use defaults */
}
if (!process.env.POSTGRES_PASSWORD) throw new Error('POSTGRES_PASSWORD env var is required');
let creds = {
  host: pgHost,
  port: pgPort,
  user: process.env.POSTGRES_USER || 'rapidnir',
  password: process.env.POSTGRES_PASSWORD,
  database: 'cortexdb',
};
const vaultPath = join(process.env.HOME || '', '.shre/vault/cortexdb.json');
if (existsSync(vaultPath)) {
  creds = { ...creds, ...JSON.parse(readFileSync(vaultPath, 'utf8')) };
}
const pool = new pg.Pool(creds);

async function run() {
  console.log('── Verifone Extract Tables ──');

  // Phase 1: Summary report → normalized daily summary
  await extractPhase(
    'Phase 1: summary_report',
    `
    CREATE TABLE IF NOT EXISTS verifone.summary_report (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      total_sales     NUMERIC(12,2),
      total_refunds   NUMERIC(12,2),
      total_tax       NUMERIC(12,2),
      total_discount  NUMERIC(12,2),
      net_sales       NUMERIC(12,2),
      total_cost      NUMERIC(12,2),
      gross_profit    NUMERIC(12,2),
      transaction_count INTEGER,
      avg_ticket      NUMERIC(10,2),
      PRIMARY KEY (site_id, report_date)
    );

    INSERT INTO verifone.summary_report (site_id, report_date, total_sales, total_refunds, total_tax, total_discount, net_sales, total_cost, gross_profit, transaction_count, avg_ticket)
    SELECT
      site_id,
      report_date,
      COALESCE((raw_data->0->>'total_sales')::numeric, (raw_data->0->>'gross_sales')::numeric, (raw_data->0->>'net_sales')::numeric, 0),
      COALESCE((raw_data->0->>'total_refunds')::numeric, (raw_data->0->>'refunds')::numeric, 0),
      COALESCE((raw_data->0->>'total_tax')::numeric, (raw_data->0->>'tax_collected')::numeric, 0),
      COALESCE((raw_data->0->>'total_discount')::numeric, (raw_data->0->>'discounts')::numeric, 0),
      COALESCE((raw_data->0->>'net_sales')::numeric, (raw_data->0->>'total_sales')::numeric, 0),
      COALESCE((raw_data->0->>'total_cost')::numeric, (raw_data->0->>'cost')::numeric, 0),
      COALESCE((raw_data->0->>'total_sales')::numeric, 0) - COALESCE((raw_data->0->>'total_cost')::numeric, 0),
      COALESCE((raw_data->0->>'transaction_count')::int, (raw_data->0->>'total_transactions')::int, 0),
      CASE WHEN COALESCE((raw_data->0->>'transaction_count')::int, 0) > 0
        THEN COALESCE((raw_data->0->>'total_sales')::numeric, 0) / (raw_data->0->>'transaction_count')::int
        ELSE 0 END
    FROM verifone.data_day_summary
    ON CONFLICT (site_id, report_date) DO UPDATE SET
      total_sales = EXCLUDED.total_sales,
      total_refunds = EXCLUDED.total_refunds,
      total_tax = EXCLUDED.total_tax,
      total_discount = EXCLUDED.total_discount,
      net_sales = EXCLUDED.net_sales,
      total_cost = EXCLUDED.total_cost,
      gross_profit = EXCLUDED.gross_profit,
      transaction_count = EXCLUDED.transaction_count,
      avg_ticket = EXCLUDED.avg_ticket;
  `,
  );

  // Phase 2: Department sales
  await extractPhase(
    'Phase 2: department_sales',
    `
    CREATE TABLE IF NOT EXISTS verifone.department_sales (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      period_type     SMALLINT NOT NULL,
      dept_name       TEXT NOT NULL,
      dept_id         TEXT,
      sales_amount    NUMERIC(12,2),
      item_count      INTEGER,
      refund_amount   NUMERIC(12,2),
      PRIMARY KEY (site_id, report_date, period_type, dept_name)
    );

    INSERT INTO verifone.department_sales (site_id, report_date, period_type, dept_name, dept_id, sales_amount, item_count, refund_amount)
    SELECT
      d.site_id,
      d.report_date,
      d.period_type,
      COALESCE(r->>'department_name', r->>'name', r->>'description', 'Unknown'),
      r->>'department_id',
      COALESCE((r->>'sales_amount')::numeric, (r->>'amount')::numeric, (r->>'sales')::numeric, 0),
      COALESCE((r->>'item_count')::int, (r->>'qty')::int, (r->>'quantity')::int, 0),
      COALESCE((r->>'refund_amount')::numeric, (r->>'refunds')::numeric, 0)
    FROM verifone.data_department d, jsonb_array_elements(d.raw_data) r
    ON CONFLICT (site_id, report_date, period_type, dept_name) DO UPDATE SET
      sales_amount = EXCLUDED.sales_amount,
      item_count = EXCLUDED.item_count,
      refund_amount = EXCLUDED.refund_amount;
  `,
  );

  // Phase 3: PLU (item) sales
  await extractPhase(
    'Phase 3: plu_sales',
    `
    CREATE TABLE IF NOT EXISTS verifone.plu_sales (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      period_type     SMALLINT NOT NULL,
      plu_code        TEXT NOT NULL,
      plu_name        TEXT,
      dept_name       TEXT,
      quantity        NUMERIC(10,2),
      sales_amount    NUMERIC(12,2),
      unit_price      NUMERIC(10,2),
      PRIMARY KEY (site_id, report_date, period_type, plu_code)
    );

    INSERT INTO verifone.plu_sales (site_id, report_date, period_type, plu_code, plu_name, dept_name, quantity, sales_amount, unit_price)
    SELECT
      p.site_id,
      p.report_date,
      p.period_type,
      COALESCE(r->>'plu_code', r->>'code', r->>'item_code', r->>'plu', 'UNKNOWN'),
      COALESCE(r->>'plu_name', r->>'name', r->>'description', r->>'item_name'),
      r->>'department',
      COALESCE((r->>'quantity')::numeric, (r->>'qty')::numeric, (r->>'count')::numeric, 0),
      COALESCE((r->>'sales_amount')::numeric, (r->>'amount')::numeric, (r->>'sales')::numeric, 0),
      COALESCE((r->>'unit_price')::numeric, (r->>'price')::numeric, 0)
    FROM verifone.data_plu p, jsonb_array_elements(p.raw_data) r
    ON CONFLICT (site_id, report_date, period_type, plu_code) DO UPDATE SET
      plu_name = EXCLUDED.plu_name,
      quantity = EXCLUDED.quantity,
      sales_amount = EXCLUDED.sales_amount,
      unit_price = EXCLUDED.unit_price;
  `,
  );

  // Phase 4: Hourly sales
  await extractPhase(
    'Phase 4: hourly_sales',
    `
    CREATE TABLE IF NOT EXISTS verifone.hourly_sales (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      hour            SMALLINT NOT NULL,
      sales_amount    NUMERIC(12,2),
      transaction_count INTEGER,
      item_count      INTEGER,
      PRIMARY KEY (site_id, report_date, hour)
    );

    INSERT INTO verifone.hourly_sales (site_id, report_date, hour, sales_amount, transaction_count, item_count)
    SELECT
      h.site_id,
      h.report_date,
      COALESCE((r->>'hour')::int, 0),
      COALESCE((r->>'sales_amount')::numeric, (r->>'amount')::numeric, (r->>'sales')::numeric, 0),
      COALESCE((r->>'transaction_count')::int, (r->>'txns')::int, (r->>'transactions')::int, 0),
      COALESCE((r->>'item_count')::int, (r->>'items')::int, 0)
    FROM verifone.data_hourly h, jsonb_array_elements(h.raw_data) r
    WHERE h.period_type = 2
    ON CONFLICT (site_id, report_date, hour) DO UPDATE SET
      sales_amount = EXCLUDED.sales_amount,
      transaction_count = EXCLUDED.transaction_count,
      item_count = EXCLUDED.item_count;
  `,
  );

  // Phase 5: Tax collected
  await extractPhase(
    'Phase 5: tax_collected',
    `
    CREATE TABLE IF NOT EXISTS verifone.tax_collected (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      tax_name        TEXT NOT NULL,
      tax_rate        NUMERIC(6,4),
      taxable_amount  NUMERIC(12,2),
      tax_amount      NUMERIC(12,2),
      PRIMARY KEY (site_id, report_date, tax_name)
    );

    INSERT INTO verifone.tax_collected (site_id, report_date, tax_name, tax_rate, taxable_amount, tax_amount)
    SELECT
      t.site_id,
      t.report_date,
      COALESCE(r->>'tax_name', r->>'name', r->>'description', 'Tax'),
      COALESCE((r->>'tax_rate')::numeric, (r->>'rate')::numeric, 0),
      COALESCE((r->>'taxable_amount')::numeric, (r->>'taxable')::numeric, 0),
      COALESCE((r->>'tax_amount')::numeric, (r->>'amount')::numeric, (r->>'tax')::numeric, 0)
    FROM verifone.data_tax t, jsonb_array_elements(t.raw_data) r
    WHERE t.period_type = 2
    ON CONFLICT (site_id, report_date, tax_name) DO UPDATE SET
      tax_rate = EXCLUDED.tax_rate,
      taxable_amount = EXCLUDED.taxable_amount,
      tax_amount = EXCLUDED.tax_amount;
  `,
  );

  // Phase 6: Network (payment) totals
  await extractPhase(
    'Phase 6: network_totals',
    `
    CREATE TABLE IF NOT EXISTS verifone.network_totals (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      network_name    TEXT NOT NULL,
      transaction_count INTEGER,
      sales_amount    NUMERIC(12,2),
      refund_amount   NUMERIC(12,2),
      net_amount      NUMERIC(12,2),
      PRIMARY KEY (site_id, report_date, network_name)
    );

    INSERT INTO verifone.network_totals (site_id, report_date, network_name, transaction_count, sales_amount, refund_amount, net_amount)
    SELECT
      n.site_id,
      n.report_date,
      COALESCE(r->>'network_name', r->>'name', r->>'card_type', r->>'tender_type', 'Unknown'),
      COALESCE((r->>'transaction_count')::int, (r->>'count')::int, (r->>'txns')::int, 0),
      COALESCE((r->>'sales_amount')::numeric, (r->>'amount')::numeric, (r->>'sales')::numeric, 0),
      COALESCE((r->>'refund_amount')::numeric, (r->>'refunds')::numeric, 0),
      COALESCE((r->>'net_amount')::numeric, (r->>'net')::numeric,
        COALESCE((r->>'sales_amount')::numeric, 0) - COALESCE((r->>'refund_amount')::numeric, 0), 0)
    FROM verifone.data_network n, jsonb_array_elements(n.raw_data) r
    WHERE n.period_type = 2
    ON CONFLICT (site_id, report_date, network_name) DO UPDATE SET
      transaction_count = EXCLUDED.transaction_count,
      sales_amount = EXCLUDED.sales_amount,
      refund_amount = EXCLUDED.refund_amount,
      net_amount = EXCLUDED.net_amount;
  `,
  );

  // Phase 7: Fuel sales (extracted from department data where department is fuel-related)
  await extractPhase(
    'Phase 7: fuel_sales',
    `
    CREATE TABLE IF NOT EXISTS verifone.fuel_sales (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      grade_name      TEXT NOT NULL,
      gallons         NUMERIC(12,3),
      sales_amount    NUMERIC(12,2),
      price_per_gallon NUMERIC(8,4),
      transaction_count INTEGER,
      PRIMARY KEY (site_id, report_date, grade_name)
    );

    INSERT INTO verifone.fuel_sales (site_id, report_date, grade_name, gallons, sales_amount, price_per_gallon, transaction_count)
    SELECT
      d.site_id,
      d.report_date,
      COALESCE(r->>'department_name', r->>'name', r->>'description', 'Fuel'),
      COALESCE((r->>'gallons')::numeric, (r->>'volume')::numeric, (r->>'quantity')::numeric, 0),
      COALESCE((r->>'sales_amount')::numeric, (r->>'amount')::numeric, (r->>'sales')::numeric, 0),
      CASE WHEN COALESCE((r->>'gallons')::numeric, 0) > 0
        THEN COALESCE((r->>'sales_amount')::numeric, 0) / (r->>'gallons')::numeric
        ELSE COALESCE((r->>'price_per_gallon')::numeric, (r->>'price')::numeric, 0) END,
      COALESCE((r->>'transaction_count')::int, (r->>'count')::int, 0)
    FROM verifone.data_department d, jsonb_array_elements(d.raw_data) r
    WHERE d.period_type = 2
      AND (
        LOWER(COALESCE(r->>'department_name', r->>'name', r->>'description', '')) ~ '(fuel|gas|diesel|unleaded|premium|regular|mid.?grade|e85|kerosene)'
        OR LOWER(COALESCE(r->>'department_id', r->>'dept_id', '')) IN ('fuel', 'gas')
      )
    ON CONFLICT (site_id, report_date, grade_name) DO UPDATE SET
      gallons = EXCLUDED.gallons,
      sales_amount = EXCLUDED.sales_amount,
      price_per_gallon = EXCLUDED.price_per_gallon,
      transaction_count = EXCLUDED.transaction_count;
  `,
  );

  // Phase 8: Deal/combo sales
  await extractPhase(
    'Phase 8: deal_sales',
    `
    CREATE TABLE IF NOT EXISTS verifone.deal_sales (
      site_id         TEXT NOT NULL,
      report_date     DATE NOT NULL,
      deal_name       TEXT NOT NULL,
      deal_count      INTEGER,
      sales_amount    NUMERIC(12,2),
      discount_amount NUMERIC(12,2),
      PRIMARY KEY (site_id, report_date, deal_name)
    );

    INSERT INTO verifone.deal_sales (site_id, report_date, deal_name, deal_count, sales_amount, discount_amount)
    SELECT
      d.site_id,
      d.report_date,
      COALESCE(r->>'deal_name', r->>'name', r->>'description', 'Deal'),
      COALESCE((r->>'deal_count')::int, (r->>'count')::int, (r->>'quantity')::int, 0),
      COALESCE((r->>'sales_amount')::numeric, (r->>'amount')::numeric, (r->>'sales')::numeric, 0),
      COALESCE((r->>'discount_amount')::numeric, (r->>'discount')::numeric, (r->>'savings')::numeric, 0)
    FROM verifone.data_deal d, jsonb_array_elements(d.raw_data) r
    WHERE d.period_type = 2
    ON CONFLICT (site_id, report_date, deal_name) DO UPDATE SET
      deal_count = EXCLUDED.deal_count,
      sales_amount = EXCLUDED.sales_amount,
      discount_amount = EXCLUDED.discount_amount;
  `,
  );

  // Print row counts
  console.log('\n── Row Counts ──');
  for (const table of [
    'verifone.summary_report',
    'verifone.department_sales',
    'verifone.plu_sales',
    'verifone.hourly_sales',
    'verifone.tax_collected',
    'verifone.network_totals',
    'verifone.fuel_sales',
    'verifone.deal_sales',
  ]) {
    try {
      const res = await pool.query(`SELECT COUNT(*) FROM ${table}`);
      console.log(`  ${table}: ${res.rows[0].count} rows`);
    } catch {
      console.log(`  ${table}: (not yet created)`);
    }
  }

  await pool.end();
  console.log('\n✅ Extract complete');
}

async function extractPhase(name, sql) {
  try {
    await pool.query(sql);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
