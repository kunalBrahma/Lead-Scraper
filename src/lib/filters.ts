import { rankEmails } from '@/enrich/score';
import { domainCounts, onePerCompany } from './company';
import type { Lead } from './types';

export interface LeadFilters {
  search: string;
  status: 'any' | 'open' | 'closed';
  minRating: number;
  minReviews: number;
  /** `null` means no upper limit. */
  maxReviews: number | null;
  category: string;
  onePerCompany: boolean;
  hideMultiLocation: boolean;
  claimed: 'any' | 'claimed' | 'unclaimed';
  requirePhone: boolean;
  requireWebsite: boolean;
  requireEmail: boolean;
  richContextOnly: boolean;
  crmStatus: 'any' | Lead['deliveryStatus'];
  emailKind: 'any' | 'business' | 'free';
  emailRole: 'any' | 'role' | 'named';
  minScore: number;
  runId: number | null;
}

export const DEFAULT_FILTERS: LeadFilters = {
  search: '',
  status: 'any',
  minRating: 0,
  minReviews: 0,
  maxReviews: null,
  category: 'any',
  onePerCompany: true,
  hideMultiLocation: false,
  claimed: 'any',
  requirePhone: false,
  requireWebsite: false,
  requireEmail: false,
  richContextOnly: false,
  crmStatus: 'any',
  emailKind: 'any',
  emailRole: 'any',
  minScore: 0,
  runId: null,
};

export function bestEmail(lead: Pick<Lead, 'emails'>) {
  return rankEmails(lead.emails)[0] ?? null;
}

export function matchesFilters(lead: Lead, filters: LeadFilters): boolean {
  if (filters.runId !== null && lead.runId !== filters.runId) return false;
  if (filters.status === 'open' && lead.businessStatus !== 'open') return false;
  if (filters.status === 'closed' && lead.businessStatus === 'open') return false;
  if ((lead.rating ?? 0) < filters.minRating) return false;
  if (lead.reviewCount < filters.minReviews) return false;
  if (filters.maxReviews !== null && lead.reviewCount > filters.maxReviews) return false;
  if (filters.category !== 'any' && lead.categories[0] !== filters.category) return false;
  if (filters.claimed === 'claimed' && !lead.claimed) return false;
  if (filters.claimed === 'unclaimed' && lead.claimed) return false;
  if (filters.requirePhone && !lead.phoneRaw) return false;
  if (filters.requireWebsite && !lead.website) return false;
  if (filters.requireEmail && !lead.emails.length) return false;
  if (filters.richContextOnly && lead.context?.level !== 'rich') return false;
  if (filters.crmStatus !== 'any' && lead.deliveryStatus !== filters.crmStatus) return false;
  if (filters.emailKind !== 'any' && !lead.emails.some((e) => e.kind === filters.emailKind)) return false;
  if (filters.emailRole === 'role' && !lead.emails.some((e) => e.role)) return false;
  if (filters.emailRole === 'named' && !lead.emails.some((e) => !e.role)) return false;
  if (lead.score < filters.minScore) return false;

  const search = filters.search.trim().toLowerCase();
  if (search) {
    const haystack = [lead.name, lead.city, lead.state, lead.fullAddress, lead.keyword, lead.searchArea, ...lead.categories]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

export const MULTI_LOCATION_LISTINGS = 3;

/** Applies per-lead filters, then the filters that compare leads with each other. */
export function applyFilters(leads: Lead[], filters: LeadFilters): Lead[] {
  let result = leads.filter((lead) => matchesFilters(lead, filters));
  if (filters.hideMultiLocation) {
    const counts = domainCounts(leads);
    result = result.filter(
      (lead) => !lead.companyKeys.some((key) => (counts.get(key) ?? 0) >= MULTI_LOCATION_LISTINGS),
    );
  }
  return filters.onePerCompany ? onePerCompany(result) : result;
}

/** Main categories, most common first, for the category filter. */
export function categoryOptions(leads: Lead[]): string[] {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    const category = lead.categories[0];
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category]) => category);
}
