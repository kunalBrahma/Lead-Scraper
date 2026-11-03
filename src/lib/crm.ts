import type { Lead } from './types';

/** The CRM's import route, added to the site address the user enters. */
export const CRM_IMPORT_PATH = '/api/leads/import';

/** Reads a site address, allowing plain HTTP only on this machine so keys never travel unencrypted. */
export function parseCrmOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function crmImportUrl(origin: string): string {
  return `${origin}${CRM_IMPORT_PATH}`;
}

export function crmPermissionPattern(origin: string): string {
  return `${origin}/*`;
}

/** Only leads not yet accepted by the CRM, with website checks finished, can be sent. */
export function isSendable(lead: Pick<Lead, 'deliveryStatus' | 'enrichStatus'>): boolean {
  return (
    (lead.deliveryStatus === 'unsent' || lead.deliveryStatus === 'rejected') &&
    lead.enrichStatus !== 'pending' &&
    lead.enrichStatus !== 'running'
  );
}
