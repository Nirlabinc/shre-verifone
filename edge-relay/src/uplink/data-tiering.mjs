/**
 * Data Tiering — Tier 1/2/3 classification for uplink
 *
 * Tier 1 (always): Aggregated sales/dept/hourly — anonymized metrics
 * Tier 2 (recommended): Skill performance, query patterns, error rates
 * Tier 3 (opt-in): E2E encrypted full transaction data
 */

const TIER_1_REPORTS = new Set(['summary', 'department', 'hourly', 'network']);
const TIER_2_REPORTS = new Set([
  'plu',
  'tax',
  'category',
  'deal',
  'carWash',
  'cashAcc',
  'networkTotals',
]);
// Tier 3 = transaction_logs (handled separately)

/**
 * Classify reports into tiers.
 * @param {Array<{ report_type: string }>} reports
 */
export function classifyReports(reports) {
  const tier1 = [];
  const tier2 = [];

  for (const report of reports) {
    if (TIER_1_REPORTS.has(report.report_type)) {
      tier1.push(report);
    } else if (TIER_2_REPORTS.has(report.report_type)) {
      tier2.push(report);
    } else {
      // Unknown types go to tier 2
      tier2.push(report);
    }
  }

  return { tier1, tier2 };
}

/**
 * Anonymize tier 1 metrics (strip identifiable fields).
 */
export function anonymizeMetrics(data) {
  if (!data || typeof data !== 'object') return data;

  // Remove customer-level PII if present
  const redactKeys = new Set(['customer_name', 'card_number', 'phone', 'email', 'address']);
  const cleaned = {};

  for (const [key, value] of Object.entries(data)) {
    if (redactKeys.has(key.toLowerCase())) {
      cleaned[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map((item) =>
        typeof item === 'object' ? anonymizeMetrics(item) : item,
      );
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}
