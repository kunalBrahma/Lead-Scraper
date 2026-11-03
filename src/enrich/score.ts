import type { EmailRecord, Evidence, MapsBusiness, ScoreTier } from '@/lib/types';

export const WEIGHTS = { listing: 25, website: 25, phone: 20, email: 30, relatedEmail: 15 } as const;
export const HIGH_SCORE = 80;
export const MEDIUM_SCORE = 50;

export function tierFor(score: number): ScoreTier {
  if (score >= HIGH_SCORE) return 'high';
  if (score >= MEDIUM_SCORE) return 'medium';
  return 'low';
}

export interface EvidenceInput {
  business: Pick<MapsBusiness, 'businessStatus' | 'reviewCount'>;
  phone: string | null;
  sitePhones: string[];
  websiteLive: boolean;
  websiteParked: boolean;
  websiteMatch: boolean;
  emails: EmailRecord[];
}

/** Best email first: own domain, working mail server, then named over role addresses. */
export function rankEmails(emails: EmailRecord[]): EmailRecord[] {
  const rank = (email: EmailRecord) =>
    (email.ownDomain ? 8 : 0) +
    (email.related ? 16 : 0) +
    (email.mx === true ? 4 : 0) +
    (email.kind === 'business' ? 2 : 0) +
    (email.role ? 0 : 1);
  return [...emails].sort((a, b) => rank(b) - rank(a));
}

export function buildEvidence(input: EvidenceInput): Evidence {
  const best = rankEmails(input.emails)[0];
  return {
    activeListing: input.business.businessStatus === 'open' && input.business.reviewCount > 0,
    websiteLive: input.websiteLive,
    websiteParked: input.websiteParked,
    websiteMatch: input.websiteLive && !input.websiteParked && input.websiteMatch,
    phoneValid: input.phone !== null,
    phoneMatch: input.phone !== null && input.sitePhones.includes(input.phone),
    emailVerified: best !== undefined && best.ownDomain && best.mx === true,
    emailRelated: best !== undefined && best.related && best.mx === true,
    emailSource: best?.source ?? null,
    mxValid: best?.mx ?? null,
  };
}

export function scoreEvidence(evidence: Evidence): number {
  return (
    (evidence.activeListing ? WEIGHTS.listing : 0) +
    (evidence.websiteMatch ? WEIGHTS.website : 0) +
    (evidence.phoneValid && evidence.phoneMatch ? WEIGHTS.phone : 0) +
    (evidence.emailVerified ? WEIGHTS.email : evidence.emailRelated ? WEIGHTS.relatedEmail : 0)
  );
}
