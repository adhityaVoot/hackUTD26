// Live check against NVIDIA's hosted Nemotron. Skipped unless NVIDIA_API_KEY is set.
//
//   NVIDIA_API_KEY=nvapi-... npx vitest run src/ai/__tests__/live.nemotron.test.ts
//
// Optional: NEMOTRON_MODEL, NEMOTRON_BASE_URL. Runs the same agent loop the procedure runs,
// over curl (synchronous, like ctx.http.fetch), on the Patel fixture.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../agent';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type HttpLike } from '../model';
import { isoToDay } from '../dates';
import { buildSnapshot } from '../snapshot';
import { newState } from '../tools';
import type { FeatureKind } from '../types';
import { patelInput } from './fixture';

const KEY = process.env.NVIDIA_API_KEY;

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
  ['negotiation', 'Spring spending', { topic: 'Spring spending', positions: [{ member: 'A', want: 'Send Maya $350 a month for rent through May', priority: 4 }, { member: 'B', want: 'Japan trip in March, about $3,200', priority: 3 }] }],
];

describe.skipIf(!KEY)('live Nemotron', () => {
  for (const [feature, q, ctx] of cases) {
    it(
      feature,
      () => {
        const requester = feature === 'negotiation' ? 0n : 1n;
        const s = newState(feature, buildSnapshot(patelInput(requester)), q, memory, ctx ?? {});
        const out = runAgent(s, {
          http: curlHttp,
          primary: { baseUrl: process.env.NEMOTRON_BASE_URL ?? DEFAULT_BASE_URL, apiKey: KEY!, model: process.env.NEMOTRON_MODEL ?? DEFAULT_MODEL, noThink: process.env.NEMOTRON_THINK !== '1' },
          secondary: null,
        });
        console.log(`\n===== ${feature} [${out.status}] ${out.modelCalls} calls, ${out.promptTokens}+${out.completionTokens} tokens`);
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
