const DOH_URL = 'https://cloudflare-dns.com/dns-query';

interface DnsAnswer {
  Status: number;
  Answer?: { type: number; data: string }[];
}

const NXDOMAIN = 3;
const MX_TYPE = 15;

/** Reads a DoH answer. A null MX (`0 .`) declares that the domain accepts no mail. */
export function interpretMxAnswer(answer: DnsAnswer): boolean | null {
  if (answer.Status === NXDOMAIN) return false;
  if (answer.Status !== 0) return null;
  const records = (answer.Answer ?? []).filter((record) => record.type === MX_TYPE);
  return records.some((record) => !/^0\s+\.?$/.test(record.data.trim()));
}

/** Returns `null` when the lookup cannot be completed, which is unknown rather than invalid. */
export async function lookupMx(domain: string, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const response = await fetcher(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: 'application/dns-json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return interpretMxAnswer((await response.json()) as DnsAnswer);
  } catch {
    return null;
  }
}
