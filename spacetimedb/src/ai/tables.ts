import { table, t } from 'spacetimedb/server';

// New scheduled table. The published ai_job table cannot gain a schedule on Maincloud.
export const nemotronJob = table({ name: 'nemotron_job' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  runId: t.u64(),
});

// Nemotron feature tables. Private; members read them through the views in ai/module.ts.

export const aiInsight = table({ name: 'ai_insight' }, {
  id: t.u64().primaryKey().autoInc(),
  runId: t.u64().index('btree'),
  householdId: t.u64().index('btree'),
  requesterPersonId: t.u64(),
  audiencePersonId: t.u64(),              // 0 = household feed; else that person's private inbox
  kind: t.string(),                       // twin|ripple|negotiation|stress|life_event|memory|opportunity
  question: t.string(),                   // what the requester typed (shown only to the audience)
  contextJson: t.string(),                // feature inputs, e.g. {"negotiationId": "3"}
  status: t.string(),                     // thinking|done|fallback|blocked|failed
  title: t.string(),
  resultJson: t.string(),                 // InsightResult with tokens mapped back to names
  scenarioId: t.u64(),                    // first draft fork created from the result, 0 if none
  createdAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

export const decisionMemory = table({ name: 'decision_memory' }, {   // append-only decision log
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  day: t.i32(),                           // sim day the decision was made
  scenarioId: t.u64(),
  outcome: t.string(),                    // merged|declined|deferred|note
  title: t.string(),
  reasoning: t.string(),                  // why, in the household's words or the agent's summary
  tags: t.string(),                       // space-separated keywords for retrieval
  amountCents: t.i64(),
  authorPersonId: t.u64(),                // 0 = written by the agent
  createdAt: t.timestamp(),
});

// Sentinel / Household Briefing: a repeating timer, plus what each household was last briefed on.
export const nemotronWatch = table({ name: 'nemotron_watch' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

export const nemotronWatchState = table({ name: 'nemotron_watch_state' }, {
  householdId: t.u64().primaryKey(),
  lastBriefingDay: t.i32(),               // sim day of the last weekly briefing
  lastSentinelDay: t.i32(),               // sim day of the last crunch alert
});

export const negotiation = table({ name: 'negotiation' }, {
  id: t.u64().primaryKey().autoInc(),
  householdId: t.u64().index('btree'),
  topic: t.string(),
  status: t.string(),                     // open|mediating|proposed|closed
  openedByPersonId: t.u64(),
  insightId: t.u64(),                     // latest mediation result
  createdAt: t.timestamp(),
});

export const negotiationPosition = table({ name: 'negotiation_position' }, {
  id: t.u64().primaryKey().autoInc(),
  negotiationId: t.u64().index('btree'),
  householdId: t.u64().index('btree'),
  personId: t.u64(),
  want: t.string(),                       // what this member wants, in their words
  priority: t.u8(),                       // 1 (nice to have) .. 5 (must have)
  updatedAt: t.timestamp(),
});
