/**
 * Verifone Commander Data Refresh
 *
 * Builds the payload for WebSocket broadcast and API responses.
 * Reads from CortexDB (populated by auto-sync) and shapes data
 * into the format StorePulse expects.
 */

/**
 * Fetch today's data for a site from CortexDB.
 * @param {import('pg').Pool} pool
 * @param {string} siteId
 * @returns {Promise<object>}
 */
export async function fetchTodayData(pool, siteId) {
  const today = new Date().toISOString().slice(0, 10);

  const [summaryRes, deptRes, pluRes, networkRes, hourlyRes] = await Promise.allSettled([
    pool.query(`SELECT raw_data FROM verifone.data_day_summary WHERE site_id = $1 AND report_date = $2`, [siteId, today]),
    pool.query(`SELECT raw_data FROM verifone.data_department WHERE site_id = $1 AND report_date = $2 AND period_type = 2`, [siteId, today]),
    pool.query(`SELECT raw_data FROM verifone.data_plu WHERE site_id = $1 AND report_date = $2 AND period_type = 2`, [siteId, today]),
    pool.query(`SELECT raw_data FROM verifone.data_network WHERE site_id = $1 AND report_date = $2 AND period_type = 2`, [siteId, today]),
    pool.query(`SELECT raw_data FROM verifone.data_hourly WHERE site_id = $1 AND report_date = $2 AND period_type = 2`, [siteId, today]),
  ]);

  const summary = summaryRes.status === 'fulfilled' ? summaryRes.value.rows[0]?.raw_data : null;
  const departments = deptRes.status === 'fulfilled' ? deptRes.value.rows[0]?.raw_data : [];
  const plu = pluRes.status === 'fulfilled' ? pluRes.value.rows[0]?.raw_data : [];
  const network = networkRes.status === 'fulfilled' ? networkRes.value.rows[0]?.raw_data : [];
  const hourly = hourlyRes.status === 'fulfilled' ? hourlyRes.value.rows[0]?.raw_data : [];

  const summaryData = Array.isArray(summary) ? summary[0] || {} : summary || {};

  return {
    date: today,
    sales: num(summaryData.total_sales || summaryData.net_sales || summaryData.gross_sales),
    cost: num(summaryData.total_cost || summaryData.cost),
    tax: num(summaryData.total_tax || summaryData.tax_collected),
    disc: num(summaryData.total_discount || summaryData.discounts),
    profit: num(summaryData.total_sales || 0) - num(summaryData.total_cost || 0),
    margin: calculateMargin(summaryData),
    txns: num(summaryData.transaction_count || summaryData.total_transactions),
    ticket: calculateTicket(summaryData),
    dept: Array.isArray(departments) ? departments : (typeof departments === 'object' ? [departments] : []),
    plu: Array.isArray(plu) ? plu.slice(0, 50) : [],
    tender: Array.isArray(network) ? network : [],
    hourly: Array.isArray(hourly) ? hourly : [],
  };
}

/**
 * Fetch period data (daily/weekly/monthly) from CortexDB.
 * @param {import('pg').Pool} pool
 * @param {string} siteId
 * @param {'daily'|'weekly'|'monthly'|'quarterly'} period
 * @returns {Promise<object>}
 */
export async function fetchPeriodData(pool, siteId, period) {
  const { from, to } = getPeriodRange(period);

  const res = await pool.query(`
    SELECT report_date, raw_data
    FROM verifone.data_day_summary
    WHERE site_id = $1 AND report_date BETWEEN $2 AND $3
    ORDER BY report_date
  `, [siteId, from, to]);

  if (!res.rows.length) return null;

  // Aggregate across days
  let totalSales = 0, totalCost = 0, totalTax = 0, totalDisc = 0, totalTxns = 0;
  const dailyRows = [];

  for (const row of res.rows) {
    const data = Array.isArray(row.raw_data) ? row.raw_data[0] || {} : row.raw_data || {};
    const sales = num(data.total_sales || data.net_sales || data.gross_sales);
    const cost = num(data.total_cost || data.cost);
    const tax = num(data.total_tax || data.tax_collected);
    const disc = num(data.total_discount || data.discounts);
    const txns = num(data.transaction_count || data.total_transactions);

    totalSales += sales;
    totalCost += cost;
    totalTax += tax;
    totalDisc += disc;
    totalTxns += txns;

    dailyRows.push({
      date: row.report_date,
      sales, cost, tax,
      profit: sales - cost,
      txns,
      ticket: txns > 0 ? sales / txns : 0,
    });
  }

  const profit = totalSales - totalCost;

  return {
    sales: totalSales,
    cost: totalCost,
    tax: totalTax,
    disc: totalDisc,
    profit,
    margin: totalSales > 0 ? (profit / totalSales) * 100 : 0,
    txns: totalTxns,
    ticket: totalTxns > 0 ? totalSales / totalTxns : 0,
    daily: dailyRows,
  };
}

/**
 * Build the full broadcast payload for WebSocket push.
 */
export async function buildPayload(pool, siteId, siteConfig) {
  const [today, daily, weekly, monthly] = await Promise.allSettled([
    fetchTodayData(pool, siteId),
    fetchPeriodData(pool, siteId, 'daily'),
    fetchPeriodData(pool, siteId, 'weekly'),
    fetchPeriodData(pool, siteId, 'monthly'),
  ]);

  return {
    today: today.status === 'fulfilled' ? today.value : null,
    periods: {
      daily: daily.status === 'fulfilled' ? daily.value : null,
      weekly: weekly.status === 'fulfilled' ? weekly.value : null,
      monthly: monthly.status === 'fulfilled' ? monthly.value : null,
    },
    lastUpdated: new Date().toISOString(),
    modules: {
      fuel: siteConfig?.has_fuel ?? true,
      carWash: siteConfig?.has_carwash ?? false,
    },
    isFuelStore: siteConfig?.has_fuel ?? true,
    posType: 'verifone',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function num(val) {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function calculateMargin(data) {
  const sales = num(data.total_sales || data.net_sales || data.gross_sales);
  const cost = num(data.total_cost || data.cost);
  if (sales === 0) return 0;
  return ((sales - cost) / sales) * 100;
}

function calculateTicket(data) {
  const sales = num(data.total_sales || data.net_sales || data.gross_sales);
  const txns = num(data.transaction_count || data.total_transactions);
  if (txns === 0) return 0;
  return sales / txns;
}

function getPeriodRange(period) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  switch (period) {
    case 'daily': {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return { from: yesterday.toISOString().slice(0, 10), to: today };
    }
    case 'weekly': {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      return { from: weekStart.toISOString().slice(0, 10), to: today };
    }
    case 'monthly': {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: monthStart.toISOString().slice(0, 10), to: today };
    }
    case 'quarterly': {
      const qMonth = Math.floor(now.getMonth() / 3) * 3;
      const qStart = new Date(now.getFullYear(), qMonth, 1);
      return { from: qStart.toISOString().slice(0, 10), to: today };
    }
    default:
      return { from: today, to: today };
  }
}
