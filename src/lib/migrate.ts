import { cleanEmail, isEmailRelated } from '@/enrich/emails';
import { isSocialHost } from '@/enrich/hosts';
import { buildEvidence, scoreEvidence, tierFor } from '@/enrich/score';
import { companyKeysFor, searchAreaFrom } from './company';
import type { Lead } from './types';

/** Upgrades a stored lead with no new requests: removes junk emails and rescores it. */
export function migrateLead(lead: Lead): void {
  lead.emails = lead.emails
    .filter((email) => cleanEmail(email.address) !== null)
    .map((email) => ({ ...email, related: isEmailRelated(email.address, lead.name, lead.domain) }));
  const social = isSocialHost(lead.domain);
  lead.evidence = buildEvidence({
    business: lead,
    phone: lead.phone,
    sitePhones: lead.sitePhones,
    websiteLive: lead.evidence.websiteLive && !social,
    websiteParked: lead.evidence.websiteParked,
    websiteMatch: lead.evidence.websiteMatch && !social,
    emails: lead.emails,
  });
  lead.score = scoreEvidence(lead.evidence);
  lead.tier = tierFor(lead.score);
  lead.searchArea = searchAreaFrom(lead.keyword);
  lead.companyKeys = companyKeysFor(lead);
  if (social) lead.enrichError = 'Listed website is a social page';
}
