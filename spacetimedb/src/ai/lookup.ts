// Public-reference lookup for the coach. No API key: Wikipedia extracts plus DuckDuckGo's
// instant-answer text. Passages are retrieved at question time and handed to Nemotron as
// untrusted context. This is retrieval, not a number the model is allowed to invent.

import type { HttpLike } from './model';

export interface Passage {
  title: string;
  source: string;
  url: string;
  text: string;
}

export interface LookupResult {
  query: string;
  passages: Passage[];
  note: string;
}

const MAX_PASSAGES = 3;
const MAX_CHARS = 700;

function cleanQuery(query: string): string {
  return query.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Commas keep a large price from looking like an account number to the privacy scan. */
function softenLongIds(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]')
    .replace(/\b\d{8,19}\b/g, n => Number(n).toLocaleString('en-US'));
}

function clip(text: string): string {
  const clean = softenLongIds(text.replace(/\s+/g, ' ').trim());
  return clean.length > MAX_CHARS ? `${clean.slice(0, MAX_CHARS - 1)}…` : clean;
}

function fetchJson(http: HttpLike, url: string): unknown {
  try {
    const res = http.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'TandemDemo/1.0 (household coach)' },
      body: '',
    });
    if (res.status < 200 || res.status >= 300) return null;
    return JSON.parse(res.text());
  } catch {
    return null;
  }
}

function wiki(http: HttpLike, query: string): Passage[] {
  const search = fetchJson(
    http,
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&utf8=1&format=json`,
  ) as { query?: { search?: { title?: string }[] } } | null;
  const titles = (search?.query?.search ?? []).map(row => row.title).filter((t): t is string => !!t).slice(0, 2);
  const out: Passage[] = [];
  for (const title of titles) {
    const page = fetchJson(
      http,
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json`,
    ) as { query?: { pages?: Record<string, { title?: string; extract?: string }> } } | null;
    const hit = Object.values(page?.query?.pages ?? {}).find(p => p.extract);
    const text = clip(hit?.extract ?? '');
    if (!text) continue;
    const shown = hit?.title || title;
    out.push({ title: shown, source: 'Wikipedia', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(shown.replace(/ /g, '_'))}`, text });
  }
  return out;
}

function duckDuckGo(http: HttpLike, query: string): Passage[] {
  const data = fetchJson(http, `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  } | null;
  const out: Passage[] = [];
  const abstract = clip(data?.AbstractText ?? '');
  if (abstract) {
    out.push({ title: data?.Heading || query, source: 'DuckDuckGo', url: data?.AbstractURL || 'https://duckduckgo.com/', text: abstract });
  }
  for (const topic of data?.RelatedTopics ?? []) {
    const text = clip(topic.Text ?? '');
    if (!text) continue;
    out.push({ title: text.slice(0, 80), source: 'DuckDuckGo', url: topic.FirstURL || 'https://duckduckgo.com/', text });
    if (out.length >= 2) break;
  }
  return out;
}

/** Retrieves short public passages for a question. Never includes household records. */
export function lookupInformation(http: HttpLike, query: string): LookupResult {
  const q = cleanQuery(query);
  if (q.length < 3) return { query: q, passages: [], note: 'The lookup query was too short.' };
  const passages = [...wiki(http, q), ...duckDuckGo(http, q)].slice(0, MAX_PASSAGES);
  return {
    query: q,
    passages,
    note: passages.length
      ? 'Untrusted public reference text. Use a number only if it is written in a passage. If the figure you need is missing, ask the member.'
      : 'No public passage came back. Ask the member for the figure instead of guessing.',
  };
}

/** First explicit price in retrieved text: "$3 million" or "$2,800,000". */
export function priceFromPassages(passages: { text: string }[]): number | null {
  const text = passages.map(p => p.text).join('\n');
  const million = /\$?\s?(\d+(?:\.\d+)?)\s*million\b/i.exec(text);
  if (million) {
    const n = Number(million[1]) * 1_000_000;
    if (n >= 100) return Math.round(n);
  }
  const dollars = /\$\s?(\d{1,3}(?:,\d{3})+|\d{3,})(?:\.\d+)?/.exec(text);
  if (dollars) {
    const n = Number(dollars[1].replace(/,/g, ''));
    if (n >= 100) return Math.round(n);
  }
  return null;
}
