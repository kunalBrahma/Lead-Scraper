import { toPayload } from '@/delivery/payload';
import { db } from '@/lib/db';
import { getSettings, isAllowedWebhookUrl } from '@/lib/settings';
import type { Lead, Settings } from '@/lib/types';

export const MAX_ATTEMPTS = 8;
const BATCH = 25;

let pumping = false;

/** Doubles from 30 seconds, capped at 30 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

async function hasWebhookAccess(url: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
}

export async function postJson(settings: Settings, body: unknown, idempotencyKey: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  };
  if (settings.webhookSecret) headers.authorization = `Bearer ${settings.webhookSecret}`;
  return fetch(settings.webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000),
  });
}

async function deliverOne(lead: Lead, settings: Settings): Promise<void> {
  if (lead.score < settings.webhookMinScore) {
    await db.leads.update(lead.placeId, { deliveryStatus: 'filtered' });
    return;
  }
  const alreadySent = lead.companyKeys.length
    ? await db.leads
        .where('companyKeys')
        .anyOf(lead.companyKeys)
        .filter((other) => other.placeId !== lead.placeId && other.deliveryStatus === 'delivered')
        .first()
    : undefined;
  if (alreadySent) {
    await db.leads.update(lead.placeId, { deliveryStatus: 'duplicate' });
    return;
  }
  const attempts = lead.deliveryAttempts + 1;
  let success = false;
  let permanent = false;
  try {
    const response = await postJson(settings, toPayload(lead), lead.placeId);
    success = response.ok;
    // A client error will not fix itself, except for timeouts and rate limits.
    permanent = response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status);
  } catch {
    success = false;
  }
  if (success) {
    await db.leads.update(lead.placeId, { deliveryStatus: 'delivered', deliveryAttempts: attempts });
  } else if (permanent || attempts >= MAX_ATTEMPTS) {
    await db.leads.update(lead.placeId, { deliveryStatus: 'failed', deliveryAttempts: attempts });
  } else {
    await db.leads.update(lead.placeId, {
      deliveryAttempts: attempts,
      nextDeliveryAt: Date.now() + backoffMs(attempts),
    });
  }
}

export async function pumpDelivery(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const settings = await getSettings();
    if (!settings.webhookUrl || !isAllowedWebhookUrl(settings.webhookUrl)) return;
    if (!(await hasWebhookAccess(settings.webhookUrl))) return;

    for (;;) {
      const now = Date.now();
      const due = await db.leads
        .where('deliveryStatus')
        .equals('pending')
        .filter(
          (lead) =>
            lead.nextDeliveryAt <= now &&
            lead.enrichStatus !== 'pending' &&
            lead.enrichStatus !== 'running',
        )
        .limit(BATCH)
        .toArray();
      if (!due.length) return;
      // One at a time, best first, so each company's strongest listing is the one sent.
      for (const lead of due.sort((a, b) => b.score - a.score)) {
        await deliverOne(lead, settings);
      }
    }
  } finally {
    pumping = false;
  }
}

export async function retryFailedDeliveries(): Promise<number> {
  return db.leads
    .where('deliveryStatus')
    .equals('failed')
    .modify({ deliveryStatus: 'pending', deliveryAttempts: 0, nextDeliveryAt: Date.now() });
}
