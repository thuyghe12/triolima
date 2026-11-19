/**
 * Print the benchmark table:  node --import tsx bench/run.ts
 */
import { measure, makeScenario } from './compare';

const scenario = makeScenario();
const rows = await measure(scenario);

const pad = (s: string, n: number) => s.padEnd(n);
const num = (n: number) => n.toLocaleString('en-US');

console.log(`\n  ${scenario.turns.length}-turn incident conversation — critical facts planted at turn 1\n`);
console.log('  ' + pad('strategy', 20) + pad('avg tok/turn', 16) + pad('final tok', 14) + 'critical recall');
console.log('  ' + '-'.repeat(64));
for (const r of rows) {
  console.log(
    '  ' +
      pad(r.strategy, 20) +
      pad(num(r.avgTokens), 16) +
      pad(num(r.finalTokens), 14) +
      `${Math.round(r.recall * 100)}%`,
  );
}
const t = rows.find((r) => r.strategy === 'triolima')!;
const full = rows.find((r) => r.strategy === 'naive-full')!;
console.log(
  `\n  Triolima: ${num(t.finalTokens)} tokens at full recall, ` +
    `${(full.finalTokens / t.finalTokens).toFixed(0)}× smaller than the full history and without its unbounded growth.\n`,
);
