import { TimeDuration } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';

export interface PlaidHttp {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; timeout: ReturnType<typeof TimeDuration.fromMillis> }): { status: number; text(): string };
}

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  host: 'sandbox' | 'production';
}

export function plaidRequest(http: PlaidHttp, credentials: PlaidCredentials, path: string, body: Record<string, unknown>): any {
  let response;
  try {
    response = http.fetch(`https://${credentials.host}.plaid.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: credentials.clientId, secret: credentials.secret, ...body }),
      timeout: TimeDuration.fromMillis(20000),
    });
  } catch {
    throw new SenderError('Plaid could not be reached.');
  }
  const text = response.text();
  if (response.status < 200 || response.status >= 300) {
    let code = '';
    try { code = JSON.parse(text).error_code ?? ''; } catch { /* ignore */ }
    throw new SenderError(code ? `Plaid rejected the request (${code}).` : `Plaid returned HTTP ${response.status}.`);
  }
  return JSON.parse(text);
}
