/** HTTP runs only inside a Spacetime procedure, never a reducer. */
export interface BankHttp { fetch(url: string, init: any): { status: number; text(): string } }
export function nessieClient(http: BankHttp, base: string, key: string) {
  if (!/^https:\/\//.test(base)) throw Error('Nessie requires an HTTPS base URL');
  return (path: string): any => {
    const response = http.fetch(`${base.replace(/\/$/, '')}${path}?key=${encodeURIComponent(key)}`, {
      method: 'GET', headers: { accept: 'application/json' },
    });
    // This Nessie endpoint uses 404 for an empty transfer history.
    if (response.status === 404 && /^\/accounts\/[^/]+\/transfers$/.test(path)) {
      const text = response.text();
      if (text === 'No transfers found for this account' || text === '"No transfers found for this account"') return [];
    }
    if (response.status < 200 || response.status >= 300) throw Error(`Nessie returned HTTP ${response.status}. Check server configuration.`);
    return JSON.parse(response.text());
  };
}
