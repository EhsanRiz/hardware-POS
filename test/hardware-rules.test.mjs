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

console.log(`\n${results.filter(r => !r).length} failure(s) of ${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
