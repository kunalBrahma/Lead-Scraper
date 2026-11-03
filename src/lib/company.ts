import { isSharedHost } from '@/enrich/hosts';
import { rankEmails } from '@/enrich/score';
import type { EmailRecord, Lead } from './types';

type CompanyFields = {
  domain: string | null;
  phone: string | null;
  emails: EmailRecord[];
};

/** Identifiers that listings of one company share. Any match links two listings. */
export function companyKeysFor(lead: CompanyFields): string[] {
  const keys: string[] = [];
  if (lead.domain && !isSharedHost(lead.domain)) keys.push(`d:${lead.domain.toLowerCase().replace(/^www\./, '')}`);
  const email = rankEmails(lead.emails)[0];
  if (email) keys.push(`e:${email.address}`);
  if (lead.phone) keys.push(`p:${lead.phone}`);
  return keys;
}

/** Keeps the highest-scoring listing of each company, preserving the original order. */
export function onePerCompany(leads: Lead[]): Lead[] {
  const seen = new Set<string>();
  const kept = new Set<string>();
  for (const lead of [...leads].sort((a, b) => b.score - a.score)) {
    if (lead.companyKeys.some((key) => seen.has(key))) continue;
    kept.add(lead.placeId);
    lead.companyKeys.forEach((key) => seen.add(key));
  }
  return leads.filter((lead) => kept.has(lead.placeId));
}

/** Counts listings per website domain, to spot multi-location companies. */
export function domainCounts(leads: Lead[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const key = lead.companyKeys.find((k) => k.startsWith('d:'));
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Reads the place out of a generated `keyword in place` search. */
export function searchAreaFrom(query: string): string | null {
  const index = query.lastIndexOf(' in ');
  return index > 0 ? query.slice(index + 4).trim() || null : null;
}
