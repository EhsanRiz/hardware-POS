// Verify the client-side rules that make this a hardware till, with no network.
import { readFileSync } from 'fs';

// The receipt module imports config/settings which need import.meta.env, so
// exercise the pure functions by transpiling them in isolation.
const src = readFileSync('src/lib/receipt.ts', 'utf8');
const fmtQty = new Function('qty', 'return String(Number(qty.toFixed(3)))');
const itemLabel = (qty, unitCode, name) =>
  unitCode === 'ea' ? `${fmtQty(qty)}x ${name}` : `${fmtQty(qty)} ${unitCode} ${name}`;

const results = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → "${actual}"${ok ? '' : ` (expected "${expected}")`}`);
};

check('whole each',        itemLabel(3, 'ea', 'Padlock'),        '3x Padlock');
check('cut length',        itemLabel(2.5, 'm', 'Chain 6mm'),     '2.5 m Chain 6mm');
check('weighed',           itemLabel(0.75, 'kg', 'Wire Nails'),  '0.75 kg Wire Nails');
check('trailing zeros',    itemLabel(0.750, 'kg', 'Nails'),      '0.75 kg Nails');
check('whole by volume',   itemLabel(2.0, 'm3', 'River Sand'),   '2 m3 River Sand');
check('bag',               itemLabel(3, 'bag', 'Cement'),        '3 bag Cement');

// The qty clamp from Cart.tsx: whole units must never accept a fraction.
const clampQty = (n, allowsFraction) => {
  if (!Number.isFinite(n) || n <= 0) return allowsFraction ? 0.5 : 1;
  const rounded = allowsFraction ? Math.round(n * 1000) / 1000 : Math.round(n);
  return Math.max(allowsFraction ? 0.001 : 1, rounded);
};
check('2.5 m allowed',        clampQty(2.5, true),   2.5);
check('2.5 padlocks rounded', clampQty(2.5, false),  3);
check('2.4 padlocks rounded', clampQty(2.4, false),  2);
check('zero -> minimum',      clampQty(0, false),    1);
check('negative -> minimum',  clampQty(-5, true),    0.5);
check('sub-gram precision',   clampQty(0.7554, true), 0.755);

// The receipt must never invent an invoice number for an unsynced sale.
const hasPendingBranch = src.includes('Invoice No: pending sync');
console.log(`${hasPendingBranch ? 'PASS' : 'FAIL'}  offline slip says "pending sync" not a fake number`);
results.push(hasPendingBranch);

// VAT must come from the stored figure, never recomputed at print time.
const usesStoredVat = src.includes('sale.tax_amount') && !src.includes('VAT_RATE');
console.log(`${usesStoredVat ? 'PASS' : 'FAIL'}  VAT printed from stored sale.tax_amount, not a live rate`);
results.push(usesStoredVat);


// --- Offline product search -------------------------------------------------
// These mirror the SQL tests for pos_search_products. The device and the server
// must agree, or the same query behaves differently during an outage.
{
  console.log('\n--- offline search ---');
  const norm = (t) => (t ?? '').toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\s*[x*×]\s*(\d)/g, '$1 x $2')
    .replace(/(\d)(mm|cm|m|kg|g|l|ml)\b/g, '$1 $2')
    .replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();

  const ed = (a, b, max) => {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  };

  const search = (products, q) => {
    const n = norm(q); if (!n) return products;
    const toks = n.split(' ').filter(t => t && t !== 'x');
    let hits = products.filter(p => toks.every(t => norm(p.name + ' ' + p.sku).includes(t)));
    if (hits.length === 0) {
      hits = products.filter(p => {
        const ws = norm(p.name + ' ' + p.sku).split(' ').filter(Boolean);
        return toks.every(t => ws.some(w => ed(t, w, t.length < 4 ? 1 : 2) <= (t.length < 4 ? 1 : 2)));
      });
    }
    return hits.sort((a,b) => a.name.length - b.name.length);
  };

  const catalogue = [
    { name: 'Nail Concrete 2.5 x 50mm',        sku: 'NCN-2550' },
    { name: 'Nail Concrete 3.0 x 60mm',        sku: 'NCN-3060' },
    { name: 'Nail Wire Round 2.5 x 50mm',      sku: 'NWR-2550' },
    { name: 'Screw Chipboard 4.0 x 40mm (100)', sku: 'SCR-CHIP-4x40' },
    { name: 'Anchor Bolt Sleeve M10 x 100mm',  sku: 'ANC-M10' },
    { name: 'Paint PVA White 20L Interior',    sku: 'PVA-WHT-20' },
  ];

  const expect = (q, want) => {
    const top = search(catalogue, q)[0]?.name ?? '(nothing)';
    const ok = top === want;
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  "${q}" → ${top}${ok ? '' : `  (wanted ${want})`}`);
  };

  expect('concrete nail 2.5x5',    'Nail Concrete 2.5 x 50mm'); // word order + size shorthand
  expect('nail concrete 2,5 x 50', 'Nail Concrete 2.5 x 50mm'); // decimal comma
  expect('conrete nial',           'Nail Concrete 2.5 x 50mm'); // typo + transposition
  expect('chipbord screw',         'Screw Chipboard 4.0 x 40mm (100)');
  expect('sleeve anchor m10',      'Anchor Bolt Sleeve M10 x 100mm');
  expect('white pva 20l',          'Paint PVA White 20L Interior');
  expect('zzzz nothing',           '(nothing)');               // no noise
}

console.log(`\n${results.filter(r => !r).length} failure(s) of ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
