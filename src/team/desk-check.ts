import { readFileSync } from 'node:fs';
import { DEFAULT_PORT, TOKEN_PATH } from '../paths.ts';

// The office opens the report the way the owner's click does (its signed link, without marking it
// read). A room says "it's on your desk" only once this passes, so a report the office can't show
// is never reported as delivered. Returns why it failed, or undefined.
export async function officeOpens(id: string, port = DEFAULT_PORT, tokenPath = TOKEN_PATH): Promise<string | undefined> {
  let token = '';
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return `no office key at ${tokenPath}`;
  }
  const base = `http://127.0.0.1:${port}`;
  const signal = AbortSignal.timeout(8000);
  try {
    const list = await fetch(`${base}/api/desk`, { headers: { authorization: `Bearer ${token}` }, signal });
    if (!list.ok) return `the office's desk list answered ${list.status}`;
    const rep = ((await list.json()) as { reports?: { id: string; link?: string }[] }).reports?.find((r) => r.id === id);
    if (!rep) return "the office's desk list doesn't have it";
    if (!rep.link) return 'the office gave no link for it';
    const page = await fetch(`${base}${rep.link}&peek=1`, { signal });
    const body = await page.text();
    if (page.status !== 200 || !body.trim()) return `opening it gave ${page.status}${body.trim() ? '' : ' and an empty page'}`;
    return undefined;
  } catch (err) {
    return `the office isn't answering on port ${port} (${err instanceof Error ? err.message : err})`;
  }
}
