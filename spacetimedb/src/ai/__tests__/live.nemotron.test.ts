// Live check against NVIDIA's hosted Nemotron. Skipped unless NVIDIA_API_KEY is set.
//
//   npm run test:live        (key from spacetimedb/.env or NVIDIA_API_KEY)
//
// Optional: NEMOTRON_MODEL, NEMOTRON_BASE_URL. Runs the same agent loop the procedure runs,
// over curl (synchronous, like ctx.http.fetch), on the Patel fixture.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeCoach, runAgent } from '../agent';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type HttpLike } from '../model';
import { isoToDay } from '../dates';
import { buildSnapshot } from '../snapshot';
import { newState } from '../tools';
import type { FeatureKind } from '../types';
import { patelInput } from './fixture';

// Load spacetimedb/.env if present (Node 20.12+). Values already in the shell win.
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname);
} catch {
  // no .env file: rely on the shell environment
}
const KEY = process.env.NVIDIA_API_KEY || undefined;

const curlHttp: HttpLike = {
  fetch(url, init) {
    // Headers go through a private temp file so the key never shows in the process list.
    const dir = mkdtempSync(join(tmpdir(), 'nemotron-'));
    const headerFile = join(dir, 'h');
    writeFileSync(headerFile, Object.entries(init.headers).map(([k, v]) => `${k}: ${v}`).join('\n'), { mode: 0o600 });
    try {
      const out = execFileSync('curl', ['-sS', '-X', init.method, url, '-H', `@${headerFile}`, '--data-binary', '@-', '--max-time', '90', '-w', '\n%{http_code}'], {
        input: init.body,
        maxBuffer: 20 * 1024 * 1024,
      }).toString();
      const nl = out.lastIndexOf('\n');
      return { status: Number(out.slice(nl + 1)), text: () => out.slice(0, nl) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

const memory = [
  { id: 1n, day: isoToDay('2025-11-12')!, outcome: 'declined', title: 'Buy a second car', reasoning: 'Declined because the car payment would have pushed debt-to-income above 40% and delayed the house down payment by about five months. Agreed to revisit once the car loan is paid off.', tags: 'car vehicle auto', amountCents: 2_800_000n, scenarioId: 0n },
  { id: 2n, day: isoToDay('2026-08-10')!, outcome: 'deferred', title: 'Japan trip in spring', reasoning: 'Deferred until after the holiday season.', tags: 'japan trip travel', amountCents: 320_000n, scenarioId: 0n },
];

const cases: [FeatureKind, string, Record<string, unknown>?][] = [
  ['twin', 'Can we afford to move to a bigger apartment in June? Rent would go up $600 a month.'],
  ['ripple', 'Buying a $1,500 laptop next week'],
  ['stress', 'What happens if Sam loses his job for two months?'],
  ['life_event', "We're planning to get married next year. What should we prepare for?"],
  ['memory', 'Why did we decide against buying a car last November?'],
  ['opportunity', 'Find opportunities in our accounts and bills'],
  ['health', 'How is our financial health?'],
  ['briefing', 'Weekly briefing', { mode: 'weekly' }],
  ['briefing', 'Overdraft risk is high. What should we do?', { mode: 'sentinel' }],
  ['coach', 'What if we did the Japan trip in July instead of March?', { history: [{ question: 'Can we afford a $3,200 Japan trip in March?', answer: 'Yes, with trade-offs: the house goal moves 28 days later.' }] }],
  ['negotiation', 'Spring spending', { topic: 'Spring spending', positions: [{ member: 'A', want: 'Send Maya $350 a month for rent through May', priority: 4 }, { member: 'B', want: 'Japan trip in March, about $3,200', priority: 3 }] }],
];

// Opt-in only, so ordinary test runs never spend API credits.
const LIVE = !!KEY && process.env.NEMOTRON_LIVE === '1';

describe.skipIf(!LIVE)('live Nemotron', () => {
  for (const [feature, q, ctx] of cases) {
    const label = ctx?.mode === 'sentinel' ? 'sentinel' : feature;
    it(
      label,
      () => {
        const deps = {
          http: curlHttp,
          primary: { baseUrl: process.env.NEMOTRON_BASE_URL ?? DEFAULT_BASE_URL, apiKey: KEY!, model: process.env.NEMOTRON_MODEL ?? DEFAULT_MODEL, noThink: process.env.NEMOTRON_THINK !== '1' },
          secondary: null,
          // Wait out free-tier rate limits like the procedure does with ctx.sleep.
          sleep: (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
        };
        const householdView = feature === 'negotiation' || feature === 'briefing';
        // Sentinel needs a crunch: a cash-strapped version of the household.
        const input = patelInput(householdView ? 0n : 1n);
        if (label === 'sentinel') {
          input.accounts = input.accounts.map(a => (a.id === 10n ? { ...a, balanceCents: 90_000n } : a.id === 11n ? { ...a, balanceCents: 20_000n } : a.id === 13n ? { ...a, balanceCents: 10_000n } : a));
        }
        const snap = buildSnapshot(input);
        let run: FeatureKind = feature;
        let request = q;
        const pre: string[] = [];
        if (feature === 'coach') {
          const route = routeCoach(q, (ctx?.history as { question: string; answer: string }[]) ?? [], snap.map.nameToToken, deps);
          run = route.feature;
          request = route.request;
          pre.push(...route.steps.map(x => `  ${x.step}: ${x.detail}`));
        }
        const s = newState(run, snap, request, memory, feature === 'coach' ? {} : ctx ?? {});
        const out = runAgent(s, deps);
        console.log(`\n===== ${label}${feature === 'coach' ? ` -> ${run}` : ''} [${out.status}] ${out.modelCalls} calls, ${out.promptTokens}+${out.completionTokens} tokens`);
        for (const line of pre) console.log(line);
        for (const st of out.steps) console.log(`  ${st.flagged ? '!' : ' '} ${st.step}: ${st.detail}`);
        console.log(`  -> ${out.result.title}${out.result.verdict ? ` [${out.result.verdict}]` : ''}\n  ${out.result.answer}`);
        for (const sec of out.result.sections) console.log(`  # ${sec.heading}\n${sec.items.map(i => `    - ${i}`).join('\n')}`);
        expect(out.result.answer.length).toBeGreaterThan(10);
        expect(out.status).not.toBe('blocked');
      },
      240_000,
    );
  }
});
