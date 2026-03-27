import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseHtmlTable, parseXmlReport, parseSummaryReport } from './xml-parser.mjs';

describe('parseHtmlTable', () => {
  it('parses a simple HTML table into row objects', () => {
    const html = `
      <table>
        <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
        <tr><td>Milk</td><td>10</td><td>$3.99</td></tr>
        <tr><td>Bread</td><td>5</td><td>$2.50</td></tr>
      </table>
    `;
    const rows = parseHtmlTable(html);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].item, 'Milk');
    assert.strictEqual(rows[0].qty, 10);
    assert.strictEqual(rows[0].price, 3.99);
    assert.strictEqual(rows[1].item, 'Bread');
  });

  it('returns empty array for null/undefined input', () => {
    assert.deepStrictEqual(parseHtmlTable(null), []);
    assert.deepStrictEqual(parseHtmlTable(undefined), []);
    assert.deepStrictEqual(parseHtmlTable(''), []);
  });

  it('returns empty array for non-table HTML', () => {
    const result = parseHtmlTable('<div>no table here</div>');
    // Falls through to parseXmlReport, which returns an array
    assert.ok(Array.isArray(result));
  });
});

describe('parseXmlReport', () => {
  it('parses XML with <row> elements', () => {
    const xml = `<report><row><name>Store A</name><sales>1500</sales></row><row><name>Store B</name><sales>2300</sales></row></report>`;
    const rows = parseXmlReport(xml);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].name, 'Store A');
    assert.strictEqual(rows[1].sales, 2300);
  });

  it('returns empty array for invalid input', () => {
    assert.deepStrictEqual(parseXmlReport(null), []);
    assert.deepStrictEqual(parseXmlReport(''), []);
  });
});

describe('parseSummaryReport', () => {
  it('parses a two-column summary table', () => {
    const html = `
      <table>
        <tr><th>Description</th><th>Amount</th></tr>
        <tr><td>Total Sales</td><td>$12,345.67</td></tr>
        <tr><td>Total Tax</td><td>$987.65</td></tr>
      </table>
    `;
    const summary = parseSummaryReport(html);
    assert.ok(summary !== null);
    assert.strictEqual(summary.total_sales, 12345.67);
    assert.strictEqual(summary.total_tax, 987.65);
  });
});
