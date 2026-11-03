import { parseCrmOrigin } from './crm';
import { db } from './db';

/**
 * "Sent" only means sent to one CRM, so a new address starts every lead fresh.
 * Resending is safe, because the CRM reports leads it already has as duplicates.
 * Returns how many leads can now be sent to the new address.
 */
export async function resetAfterCrmChange(previousUrl: string, nextOrigin: string | null): Promise<number> {
  const previous = parseCrmOrigin(previousUrl);
  if (!previous || !nextOrigin || previous === nextOrigin) return 0;
  return db.transaction('rw', db.leads, db.sendJobs, async () => {
    await db.sendJobs.clear();
    return db.leads
      .where('deliveryStatus')
      .notEqual('unsent')
      .modify({ deliveryStatus: 'unsent', crmNote: null, crmSentAt: null });
  });
}

/** A send in progress must finish or pause before the address changes. */
export async function isSendRunning(): Promise<boolean> {
  return (await db.sendJobs.where('status').equals('running').count()) > 0;
}
