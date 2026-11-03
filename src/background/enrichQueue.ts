import { crawlWebsite, type CrawlResult } from '@/enrich/crawl';
import { emailDomain, isEmailRelated, isFreeEmail, isOwnDomain, isRoleEmail } from '@/enrich/emails';
import { isSocialHost } from '@/enrich/hosts';
import { lookupMx } from '@/enrich/mx';
import { normalizePhone } from '@/enrich/phone';
import { buildEvidence, scoreEvidence, tierFor } from '@/enrich/score';
import { companyKeysFor } from '@/lib/company';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import type { EmailRecord, Lead } from '@/lib/types';

const MX_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

let active = 0;
let pumping = false;

async function hasWebsiteAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
}

async function cachedMx(domain: string): Promise<boolean | null> {
  const cached = await db.mx.get(domain);
  if (cached && cached.valid !== null && Date.now() - cached.checkedAt < MX_CACHE_MS) return cached.valid;
  const valid = await lookupMx(domain);
  await db.mx.put({ domain, valid, checkedAt: Date.now() });
  return valid;
}

export async function applyCrawl(lead: Lead, crawl: CrawlResult): Promise<Partial<Lead>> {
  const emails: EmailRecord[] = await Promise.all(
    crawl.emails.map(async (email) => ({
      address: email.address,
      source: email.source,
      kind: isFreeEmail(email.address) ? ('free' as const) : ('business' as const),
      role: isRoleEmail(email.address),
      ownDomain: isOwnDomain(email.address, lead.domain),
      related: isEmailRelated(email.address, lead.name, lead.domain),
      mx: await cachedMx(emailDomain(email.address)),
    })),
  );
  const sitePhones = [
    ...new Set(crawl.phones.map((phone) => normalizePhone(phone, lead.country)).filter((p): p is string => !!p)),
  ];
  const evidence = buildEvidence({
    business: lead,
    phone: lead.phone,
    sitePhones,
    websiteLive: crawl.live,
    websiteParked: crawl.parked,
    websiteMatch: crawl.match,
    emails,
  });
  const score = scoreEvidence(evidence);
  return {
    emails,
    sitePhones,
    socials: crawl.socials,
    metaDescription: crawl.metaDescription,
    context: crawl.context,
    evidence,
    score,
    tier: tierFor(score),
    companyKeys: companyKeysFor({ domain: lead.domain, phone: lead.phone, emails }),
  };
}

/** A rechecked lead that already reached the agent is not sent again. */
function afterCheck(lead: Lead): Pick<Lead, 'deliveryStatus' | 'nextDeliveryAt'> {
  return {
    deliveryStatus: lead.deliveryStatus === 'delivered' ? 'delivered' : 'pending',
    nextDeliveryAt: Date.now(),
  };
}

async function enrichOne(lead: Lead): Promise<void> {
  try {
    const crawl = await crawlWebsite(lead.website!, lead.name, lead.domain);
    const patch = await applyCrawl(lead, crawl);
    await db.leads.update(lead.placeId, {
      ...patch,
      enrichStatus: crawl.live || crawl.blockedByRobots ? 'done' : 'failed',
      enrichError: crawl.failure,
      ...afterCheck(lead),
    });
  } catch (error) {
    await db.leads.update(lead.placeId, {
      enrichStatus: 'failed',
      enrichError: error instanceof Error ? error.message : 'Crawl failed',
      ...afterCheck(lead),
    });
  }
}

/** Marks waiting leads as skipped when enrichment is off or website access was not granted. */
async function skipPending(): Promise<void> {
  await db.leads
    .where('enrichStatus')
    .equals('pending')
    .modify({ enrichStatus: 'skipped', deliveryStatus: 'pending', nextDeliveryAt: Date.now() });
}

export async function pumpEnrichment(onSettled: () => void): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const settings = await getSettings();
    if (!settings.enrichmentEnabled || !(await hasWebsiteAccess())) {
      await skipPending();
      onSettled();
      return;
    }
    while (active < settings.crawlConcurrency) {
      const lead = await db.leads.where('enrichStatus').equals('pending').first();
      if (!lead) break;
      await db.leads.update(lead.placeId, { enrichStatus: 'running' });
      active += 1;
      void enrichOne(lead).finally(() => {
        active -= 1;
        onSettled();
        void pumpEnrichment(onSettled);
      });
    }
  } finally {
    pumping = false;
  }
}

/** A stopped service worker loses in-flight crawls, so they go back in the queue on startup. */
export async function recoverEnrichment(): Promise<void> {
  if (active === 0) {
    await db.leads.where('enrichStatus').equals('running').modify({ enrichStatus: 'pending' });
  }
}

/** Queues websites that could not be read for another attempt. */
export async function retryFailedWebsites(): Promise<number> {
  return db.leads.where('enrichStatus').equals('failed').modify({ enrichStatus: 'pending', enrichError: null });
}

/** Queues leads stored before context existed, so their websites are read again. */
export async function queueMissingContext(): Promise<number> {
  return db.leads
    .filter(
      (lead) =>
        Boolean(lead.website) &&
        !lead.context &&
        !isSocialHost(lead.domain) &&
        lead.enrichStatus !== 'pending' &&
        lead.enrichStatus !== 'running',
    )
    .modify({ enrichStatus: 'pending', enrichError: null });
}
