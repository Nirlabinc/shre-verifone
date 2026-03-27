/**
 * Verifone Commander XML/HTML Report Parser
 *
 * Commander returns reports as HTML tables or XML fragments via CGI.
 * This module normalizes them to plain JSON objects.
 */

import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => ['tr', 'td', 'th', 'row', 'item', 'record'].includes(name),
});

/**
 * Parse Commander HTML table report into array of row objects.
 * Commander reports typically have a <table> with <tr> rows,
 * first row is headers.
 */
export function parseHtmlTable(html) {
  if (!html || typeof html !== 'string') return [];

  // Strip everything outside <table>...</table>
  const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    // Try XML parse as fallback
    return parseXmlReport(html);
  }

  const tableHtml = `<table>${tableMatch[1]}</table>`;
  let parsed;
  try {
    parsed = xmlParser.parse(tableHtml);
  } catch {
    return [];
  }

  const table = parsed?.table;
  if (!table?.tr || !Array.isArray(table.tr) || table.tr.length < 2) return [];

  // First row = headers
  const headerRow = table.tr[0];
  const headers = extractCells(headerRow.th || headerRow.td);
  if (!headers.length) return [];

  // Remaining rows = data
  const rows = [];
  for (let i = 1; i < table.tr.length; i++) {
    const cells = extractCells(table.tr[i].td);
    if (!cells.length) continue;

    const row = {};
    for (let j = 0; j < headers.length && j < cells.length; j++) {
      const key = normalizeHeader(headers[j]);
      row[key] = parseValue(cells[j]);
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Parse Commander XML report (some endpoints return structured XML).
 */
export function parseXmlReport(xml) {
  if (!xml || typeof xml !== 'string') return [];

  try {
    const parsed = xmlParser.parse(xml);
    // Commander XML reports vary — try common structures
    const root = parsed?.report || parsed?.data || parsed?.results || parsed;

    if (root?.row) return Array.isArray(root.row) ? root.row : [root.row];
    if (root?.record) return Array.isArray(root.record) ? root.record : [root.record];
    if (root?.item) return Array.isArray(root.item) ? root.item : [root.item];

    // If it's an array at root level
    const keys = Object.keys(root || {});
    if (keys.length === 1 && Array.isArray(root[keys[0]])) {
      return root[keys[0]];
    }

    // Single object — wrap in array
    if (typeof root === 'object' && root !== null && keys.length > 0) {
      return [root];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Parse period list response from vreportpdlist.
 * Returns array of { period, filename, date, type } objects.
 */
export function parsePeriodList(html) {
  const rows = parseHtmlTable(html);
  if (rows.length) return rows;

  // Fallback: parse as line-delimited filenames
  if (typeof html !== 'string') return [];
  const lines = html.split('\n').map(l => l.trim()).filter(Boolean);
  return lines
    .filter(l => /\d/.test(l))
    .map(l => {
      const match = l.match(/(\w+)\s+(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/);
      return {
        filename: l.replace(/<[^>]+>/g, '').trim(),
        date: match?.[2] || '',
        type: l.toLowerCase().includes('shift') ? 'shift' : 'day',
      };
    });
}

/**
 * Extract summary totals from a Commander summary report.
 * Returns { totalSales, totalRefunds, totalTax, netSales, ... }
 */
export function parseSummaryReport(html) {
  const rows = parseHtmlTable(html);
  if (!rows.length) return null;

  // Summary reports often have label/value pairs
  const summary = {};
  for (const row of rows) {
    // Try key-value layout (Description | Amount)
    const keys = Object.keys(row);
    if (keys.length === 2) {
      const label = normalizeHeader(String(row[keys[0]]));
      summary[label] = parseValue(row[keys[1]]);
    } else {
      // Multi-column — merge all fields
      Object.assign(summary, row);
    }
  }

  return summary;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractCells(cells) {
  if (!cells) return [];
  if (!Array.isArray(cells)) cells = [cells];
  return cells.map(c => {
    if (typeof c === 'string' || typeof c === 'number') return String(c);
    if (c?.['#text'] !== undefined) return String(c['#text']);
    return String(c ?? '');
  });
}

function normalizeHeader(header) {
  return String(header)
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function parseValue(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();

  // Currency: $1,234.56
  if (/^\$[\d,]+\.?\d*$/.test(s)) {
    return parseFloat(s.replace(/[$,]/g, ''));
  }
  // Negative currency: ($1,234.56) or -$1,234.56
  if (/^\(\$[\d,]+\.?\d*\)$/.test(s)) {
    return -parseFloat(s.replace(/[$(),]/g, ''));
  }
  if (/^-\$[\d,]+\.?\d*$/.test(s)) {
    return -parseFloat(s.replace(/[$,\-]/g, ''));
  }
  // Percentage: 12.5%
  if (/^[\d.]+%$/.test(s)) {
    return parseFloat(s) / 100;
  }
  // Plain number
  if (/^-?[\d,]+\.?\d*$/.test(s)) {
    return parseFloat(s.replace(/,/g, ''));
  }

  return s;
}
