#!/usr/bin/env node
/**
 * Verifone Analytics — Materialized View Creator
 *
 * Creates materialized views in verifone_analytics schema.
 * Follows the same pattern as shre-rapidrms/src/analytics/create-views.mjs.
 *
 * Usage:
 *   node src/analytics/create-views.mjs            # Create only
 *   node src/analytics/create-views.mjs --refresh   # Create + refresh
 *   node src/analytics/create-views.mjs --recreate  # Drop + recreate
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

const RECREATE = process.argv.includes('--recreate') || process.argv.includes('--force');
const REFRESH = process.argv.includes('--refresh') || RECREATE;

// ── View Definitions ─────────────────────────────────────────────

const VIEWS = [
  // Daily sales aggregate
  {
    name: 'daily_sales',
    sql: `
      SELECT
        site_id,
        report_date,
        total_sales,
        total_refunds,
        total_tax,
        total_discount,
        net_sales,
        total_cost,
        gross_profit,
        transaction_count,
        avg_ticket,
        CASE WHEN total_sales > 0 THEN (gross_profit / total_sales * 100) ELSE 0 END AS margin_pct
      FROM verifone.summary_report
      ORDER BY site_id, report_date DESC
    `,
  },

  // Weekly sales rollup
  {
    name: 'weekly_sales',
    sql: `
      SELECT
        site_id,
        date_trunc('week', report_date)::date AS week_start,
        SUM(total_sales) AS total_sales,
        SUM(total_refunds) AS total_refunds,
        SUM(total_tax) AS total_tax,
        SUM(total_discount) AS total_discount,
        SUM(net_sales) AS net_sales,
        SUM(total_cost) AS total_cost,
        SUM(gross_profit) AS gross_profit,
        SUM(transaction_count) AS transaction_count,
        CASE WHEN SUM(transaction_count) > 0 THEN SUM(total_sales) / SUM(transaction_count) ELSE 0 END AS avg_ticket,
        CASE WHEN SUM(total_sales) > 0 THEN (SUM(gross_profit) / SUM(total_sales) * 100) ELSE 0 END AS margin_pct
      FROM verifone.summary_report
      GROUP BY site_id, date_trunc('week', report_date)
      ORDER BY site_id, week_start DESC
    `,
  },

  // Monthly sales rollup
  {
    name: 'monthly_sales',
    sql: `
      SELECT
        site_id,
        date_trunc('month', report_date)::date AS month_start,
        SUM(total_sales) AS total_sales,
        SUM(total_refunds) AS total_refunds,
        SUM(total_tax) AS total_tax,
        SUM(total_discount) AS total_discount,
        SUM(net_sales) AS net_sales,
        SUM(total_cost) AS total_cost,
        SUM(gross_profit) AS gross_profit,
        SUM(transaction_count) AS transaction_count,
        CASE WHEN SUM(transaction_count) > 0 THEN SUM(total_sales) / SUM(transaction_count) ELSE 0 END AS avg_ticket,
        CASE WHEN SUM(total_sales) > 0 THEN (SUM(gross_profit) / SUM(total_sales) * 100) ELSE 0 END AS margin_pct
      FROM verifone.summary_report
      GROUP BY site_id, date_trunc('month', report_date)
      ORDER BY site_id, month_start DESC
    `,
  },

  // Department performance
  {
    name: 'department_performance',
    sql: `
      SELECT
        site_id,
        dept_name,
        SUM(sales_amount) AS total_sales,
        SUM(item_count) AS total_items,
        SUM(refund_amount) AS total_refunds,
        COUNT(DISTINCT report_date) AS days_active,
        CASE WHEN COUNT(DISTINCT report_date) > 0
          THEN SUM(sales_amount) / COUNT(DISTINCT report_date) ELSE 0 END AS avg_daily_sales
      FROM verifone.department_sales
      WHERE period_type = 2
      GROUP BY site_id, dept_name
      ORDER BY total_sales DESC
    `,
  },

  // Department trend (daily by department)
  {
    name: 'department_trend',
    sql: `
      SELECT
        site_id,
        report_date,
        dept_name,
        sales_amount,
        item_count,
        refund_amount
      FROM verifone.department_sales
      WHERE period_type = 2
      ORDER BY site_id, report_date DESC, sales_amount DESC
    `,
  },

  // Hourly traffic patterns
  {
    name: 'hourly_traffic',
    sql: `
      SELECT
        site_id,
        hour,
        AVG(sales_amount) AS avg_sales,
        AVG(transaction_count) AS avg_transactions,
        AVG(item_count) AS avg_items,
        SUM(sales_amount) AS total_sales,
        SUM(transaction_count) AS total_transactions,
        COUNT(*) AS days_sampled
      FROM verifone.hourly_sales
      GROUP BY site_id, hour
      ORDER BY site_id, hour
    `,
  },

  // PLU (item) ranking
  {
    name: 'plu_ranking',
    sql: `
      SELECT
        site_id,
        plu_code,
        plu_name,
        dept_name,
        SUM(quantity) AS total_quantity,
        SUM(sales_amount) AS total_sales,
        AVG(unit_price) AS avg_price,
        COUNT(DISTINCT report_date) AS days_sold
      FROM verifone.plu_sales
      WHERE period_type = 2
      GROUP BY site_id, plu_code, plu_name, dept_name
      ORDER BY total_sales DESC
    `,
  },

  // Payment profile (network/tender breakdown)
  {
    name: 'payment_profile',
    sql: `
      SELECT
        site_id,
        network_name,
        SUM(transaction_count) AS total_transactions,
        SUM(sales_amount) AS total_sales,
        SUM(refund_amount) AS total_refunds,
        SUM(net_amount) AS net_amount,
        COUNT(DISTINCT report_date) AS days_active
      FROM verifone.network_totals
      GROUP BY site_id, network_name
      ORDER BY total_sales DESC
    `,
  },

  // Fuel daily sales (c-store specific)
  {
    name: 'fuel_daily',
    sql: `
      SELECT
        site_id,
        report_date,
        grade_name,
        gallons,
        sales_amount,
        price_per_gallon,
        transaction_count
      FROM verifone.fuel_sales
      ORDER BY site_id, report_date DESC, grade_name
    `,
  },

  // Fuel grade mix (aggregate by grade)
  {
    name: 'fuel_grade_mix',
    sql: `
      SELECT
        site_id,
        grade_name,
        SUM(gallons) AS total_gallons,
        SUM(sales_amount) AS total_sales,
        AVG(price_per_gallon) AS avg_price,
        SUM(transaction_count) AS total_transactions,
        COUNT(DISTINCT report_date) AS days_active,
        CASE WHEN SUM(gallons) > 0
          THEN SUM(sales_amount) / SUM(gallons) ELSE 0 END AS effective_ppg
      FROM verifone.fuel_sales
      GROUP BY site_id, grade_name
      ORDER BY total_gallons DESC
    `,
  },

  // Deal/combo performance
  {
    name: 'deal_performance',
    sql: `
      SELECT
        site_id,
        deal_name,
        SUM(deal_count) AS total_count,
        SUM(sales_amount) AS total_sales,
        SUM(discount_amount) AS total_discount,
        COUNT(DISTINCT report_date) AS days_active,
        CASE WHEN COUNT(DISTINCT report_date) > 0
          THEN SUM(deal_count) / COUNT(DISTINCT report_date) ELSE 0 END AS avg_daily_count
      FROM verifone.deal_sales
      GROUP BY site_id, deal_name
      ORDER BY total_sales DESC
    `,
  },

  // Tax summary
  {
    name: 'tax_summary',
    sql: `
      SELECT
        site_id,
        tax_name,
        AVG(tax_rate) AS avg_rate,
        SUM(taxable_amount) AS total_taxable,
        SUM(tax_amount) AS total_tax,
        COUNT(DISTINCT report_date) AS days_collected
      FROM verifone.tax_collected
      GROUP BY site_id, tax_name
      ORDER BY total_tax DESC
    `,
  },
];

// ── Execution ────────────────────────────────────────────────────

async function run() {
  console.log('── Verifone Analytics: Materialized Views ──');

  // Ensure schema
  await pool.query('CREATE SCHEMA IF NOT EXISTS verifone_analytics');

  // Create refresh log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verifone_analytics.refresh_log (
      view_name   TEXT PRIMARY KEY,
      refreshed_at TIMESTAMPTZ,
      row_count   INTEGER,
      duration_ms INTEGER
    )
  `);

  // Drop if recreating (reverse order for dependencies)
  if (RECREATE) {
    console.log('  Dropping existing views...');
    for (const view of [...VIEWS].reverse()) {
      await pool.query(`DROP MATERIALIZED VIEW IF EXISTS verifone_analytics.${view.name} CASCADE`);
    }
  }

  // Create views
  for (const view of VIEWS) {
    try {
      await pool.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS verifone_analytics.${view.name} AS
        ${view.sql}
      `);
      console.log(`  ✓ ${view.name}`);
    } catch (err) {
      console.error(`  ✗ ${view.name}: ${err.message}`);
    }
  }

  // Create indexes
  const INDEXES = [
    { view: 'daily_sales', cols: 'site_id, report_date DESC' },
    { view: 'weekly_sales', cols: 'site_id, week_start DESC' },
    { view: 'monthly_sales', cols: 'site_id, month_start DESC' },
    { view: 'department_performance', cols: 'site_id, total_sales DESC' },
    { view: 'department_trend', cols: 'site_id, report_date DESC' },
    { view: 'hourly_traffic', cols: 'site_id, hour' },
    { view: 'plu_ranking', cols: 'site_id, total_sales DESC' },
    { view: 'payment_profile', cols: 'site_id, total_sales DESC' },
    { view: 'fuel_daily', cols: 'site_id, report_date DESC' },
    { view: 'fuel_grade_mix', cols: 'site_id, total_gallons DESC' },
    { view: 'deal_performance', cols: 'site_id, total_sales DESC' },
    { view: 'tax_summary', cols: 'site_id, total_tax DESC' },
  ];

  for (const idx of INDEXES) {
    try {
      const idxName = `idx_vfn_${idx.view}`;
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${idxName} ON verifone_analytics.${idx.view} (${idx.cols})`,
      );
    } catch {
      /* skip if view doesn't exist */
    }
  }

  // Refresh if requested
  if (REFRESH) {
    console.log('\n  Refreshing views...');
    for (const view of VIEWS) {
      try {
        const start = Date.now();
        await pool.query(`REFRESH MATERIALIZED VIEW verifone_analytics.${view.name}`);
        const duration = Date.now() - start;
        const countRes = await pool.query(`SELECT COUNT(*) FROM verifone_analytics.${view.name}`);
        const rowCount = parseInt(countRes.rows[0].count, 10);

        await pool.query(
          `
          INSERT INTO verifone_analytics.refresh_log (view_name, refreshed_at, row_count, duration_ms)
          VALUES ($1, now(), $2, $3)
          ON CONFLICT (view_name) DO UPDATE SET refreshed_at = now(), row_count = EXCLUDED.row_count, duration_ms = EXCLUDED.duration_ms
        `,
          [view.name, rowCount, duration],
        );

        console.log(`  ✓ ${view.name}: ${rowCount} rows (${duration}ms)`);
      } catch (err) {
        console.error(`  ✗ ${view.name}: ${err.message}`);
      }
    }
  }

  // Print summary
  console.log('\n── View Summary ──');
  for (const view of VIEWS) {
    try {
      const res = await pool.query(`SELECT COUNT(*) FROM verifone_analytics.${view.name}`);
      console.log(`  ${view.name}: ${res.rows[0].count} rows`);
    } catch {
      console.log(`  ${view.name}: (not available)`);
    }
  }

  await pool.end();
  console.log('\n✅ Views complete');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
