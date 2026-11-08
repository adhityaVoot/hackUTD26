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

export interface PricePoint {
  amount: number; // dollars
  context: string; // the words around the price, so the model can tell a starting price from an average
  source: string;
}

export interface LookupResult {
  query: string;
  passages: Passage[];
  price_points: PricePoint[];
  note: string;
}

const MAX_PASSAGES = 6;
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

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Web search through DuckDuckGo's no-JavaScript results page (no API key). Returns organic results
 * only: sponsored rows and ad links are skipped. Search snippets are where current prices show up.
 */
export function webSearch(http: HttpLike, query: string, limit = 5): Passage[] {
  let page = '';
  try {
    const res = http.fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; TandemDemo/1.0; household coach)' },
      body: '',
    });
    if (res.status < 200 || res.status >= 300) return [];
    page = res.text();
  } catch {
    return [];
  }
  const out: Passage[] = [];
  const anchors = [...page.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g)];
  for (let i = 0; i < anchors.length && out.length < limit; i++) {
    const [whole, href, rawTitle] = anchors[i];
    const target = /uddg=([^&]+)/.exec(href);
    const url = target ? decodeURIComponent(target[1]) : href;
    if (/duckduckgo\.com\/(y\.js|duckduckgo-help-pages)/.test(url) || !/^https?:\/\//.test(url)) continue; // ads
    const start = (anchors[i].index ?? 0) + whole.length;
    const end = anchors[i + 1]?.index ?? page.length;
    const block = page.slice(start, end);
    if (/result-sponsored/.test(page.slice(Math.max(0, (anchors[i].index ?? 0) - 300), anchors[i].index ?? 0))) continue;
    const snippet = /class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/.exec(block);
    const text = clip(decode(snippet?.[1] ?? ''));
    if (!text) continue;
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // keep the raw url
    }
    out.push({ title: decode(rawTitle).slice(0, 120), source: host, url, text });
  }
  return out;
}

/** Every dollar figure in the passages, with the words around it and where it came from. */
export function pricePoints(passages: Passage[], max = 12): PricePoint[] {
  const out: PricePoint[] = [];
  const seen = new Set<number>();
  for (const p of passages) {
    for (const m of p.text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(million|k|thousand)?/gi)) {
      let n = Number(m[1].replace(/,/g, '') + (m[2] ? `.${m[2]}` : ''));
      if (/million/i.test(m[3] ?? '')) n *= 1_000_000;
      else if (/^(k|thousand)$/i.test(m[3] ?? '')) n *= 1_000;
      n = Math.round(n);
      if (!Number.isFinite(n) || n < 20 || seen.has(n)) continue;
      seen.add(n);
      const i = m.index ?? 0;
      out.push({ amount: n, context: p.text.slice(Math.max(0, i - 70), i + m[0].length + 50).trim(), source: p.source });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Retrieves short public passages for a question: web results first, then encyclopedia text. Never includes household records. */
export function lookupInformation(http: HttpLike, query: string): LookupResult {
  const q = cleanQuery(query);
  if (q.length < 3) return { query: q, passages: [], price_points: [], note: 'The lookup query was too short.' };
  const web = webSearch(http, q);
  const passages = [...web, ...wiki(http, q).slice(0, web.length ? 1 : 2), ...(web.length ? [] : duckDuckGo(http, q))].slice(0, MAX_PASSAGES);
  const prices = pricePoints(passages);
  return {
    query: q,
    passages,
    price_points: prices,
    note: passages.length
      ? `Untrusted public reference text. Cite a price only from price_points or a passage${prices.length ? '' : ' (none of these passages state a price; try a more specific search like "<item> price" or "<item> under $X")'}. If the figure you need is missing, ask the member.`
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
