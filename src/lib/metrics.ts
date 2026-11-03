import type { Job, Lead, Run } from './types';

export interface RunMetrics {
  uniqueLeadsPerHour: number | null;
  duplicateRate: number | null;
  parseSuccess: number | null;
  phoneFound: number | null;
  websiteFound: number | null;
  emailFound: number | null;
  websiteProblems: number | null;
  richContext: number | null;
  invalidEmailRate: number | null;
  captchasPer100: number | null;
  webhookDelivery: number | null;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export function activeDurationMs(run: Run, now = Date.now()): number {
  return run.activeMs + (run.segmentStartedAt ? now - run.segmentStartedAt : 0);
}

/** Every rate is `null`, shown as a dash, until there is data to measure. */
export function computeMetrics(run: Run, leads: Lead[], now = Date.now()): RunMetrics {
  const hours = activeDurationMs(run, now) / 3_600_000;
  const withWebsite = leads.filter((lead) => lead.website);
  const crawled = withWebsite.filter((lead) => lead.enrichStatus === 'done' || lead.enrichStatus === 'failed');
  const emails = leads.flatMap((lead) => lead.emails);
  const checkedEmails = emails.filter((email) => email.mx !== null);
  const deliveries = leads.filter((l) => l.deliveryStatus === 'delivered' || l.deliveryStatus === 'failed');

  return {
    uniqueLeadsPerHour: hours > 0 && run.uniqueLeads > 0 ? run.uniqueLeads / hours : null,
    duplicateRate: ratio(run.duplicates, run.uniqueLeads + run.duplicates),
    parseSuccess: ratio(run.rowsParsed, run.rowsAttempted),
    phoneFound: ratio(leads.filter((lead) => lead.phoneRaw).length, leads.length),
    websiteFound: ratio(withWebsite.length, leads.length),
    emailFound: ratio(crawled.filter((lead) => lead.emails.length).length, crawled.length),
    websiteProblems: ratio(crawled.filter((lead) => lead.enrichError).length, crawled.length),
    richContext: ratio(crawled.filter((lead) => lead.context?.level === 'rich').length, crawled.length),
    invalidEmailRate: ratio(checkedEmails.filter((email) => email.mx === false).length, checkedEmails.length),
    captchasPer100: run.searchesFinished > 0 ? (run.captchas / run.searchesFinished) * 100 : null,
    webhookDelivery: ratio(deliveries.filter((l) => l.deliveryStatus === 'delivered').length, deliveries.length),
  };
}

/** True when clearly fewer results were captured than the page showed. */
export function isPartialSearch(job: Pick<Job, 'rows' | 'visibleCards'>): boolean {
  return job.visibleCards > 0 && job.rows < job.visibleCards * 0.8;
}
