/** Run once per demo member. Stores progress so a retry reuses created resources. */
import { readFile, writeFile } from 'node:fs/promises';
const key = process.env.NESSIE_API_KEY;
const base = process.env.NESSIE_BASE_URL || 'https://api.nessieisreal.com';
const persona = process.argv[2];
if (!key || !['priya','sam','maya'].includes(persona)) throw Error('Set NESSIE_API_KEY and run: node scripts/seed-nessie.mjs priya|sam|maya');
if (!base.startsWith('https://')) throw Error('Use an HTTPS Nessie endpoint');
const file = process.env.NESSIE_SEED_STATE || '.nessie-seed.json';
let state = {};
try { state = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
state[persona] ??= {};
const saved = state[persona];
async function post(path, body) {
  const response = await fetch(`${base}${path}?key=${encodeURIComponent(key)}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`Nessie HTTP ${response.status}. Seed stopped; completed steps are saved. Check provider response locally before retrying an uncertain write.`);
  const result = await response.json();
  if (!result.objectCreated?._id) throw Error('Unexpected Nessie creation response');
  return result.objectCreated._id;
}
async function once(label, path, body) {
  if (saved[label]) return saved[label];
  saved[label] = await post(path, body);
  await writeFile(file, JSON.stringify(state, null, 2), {mode:0o600});
  return saved[label];
}
const customer = await once('customer', '/customers', { first_name: persona[0].toUpperCase()+persona.slice(1), last_name:'Demo', address:{street_number:'123',street_name:'Demo Street',city:'Richardson',state:'TX',zip:'75080'} });
for (const [kind, balance] of [['Checking',4200],['Savings',8500]]) {
  const id = await once(kind, `/customers/${customer}/accounts`, {type:kind,nickname:`Demo ${kind}`,rewards:0,balance});
  if (kind === 'Checking') {
    // Historical records enrich the forecast, while the provider remains balance authority.
    for (const [label, endpoint, amount, date] of [['payday','deposits',2600,'2026-10-16'],['groceries','withdrawals',125,'2026-10-20'],['utilities','withdrawals',180,'2026-10-23']]) {
      await once(label, `/accounts/${id}/${endpoint}`, {medium:'balance',transaction_date:date,status:'completed',amount,description:`Synthetic ${label}`});
    }
  }
}
console.log(`Created/reused synthetic ${persona} customer. Configure server NESSIE_DEMO_CUSTOMERS with this entry (replace PATELS if needed):`);
console.log(JSON.stringify({[`PATELS:${persona}`]:customer}));
console.log('Run the script for other members and combine the entries. Never put NESSIE_API_KEY into VITE_ configuration.');
