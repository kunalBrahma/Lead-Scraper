import { postJson, pumpDelivery, retryFailedDeliveries } from '@/background/deliveryQueue';
import {
  configureEngine,
  getAssignment,
  handleCapture,
  handleSearchDone,
  handleTabRemoved,
  handleTabUpdated,
  pauseRun,
  resumeRun,
  startRun,
  stopRun,
  watchdog,
} from '@/background/engine';
import { pumpEnrichment, queueMissingContext, recoverEnrichment, retryFailedWebsites } from '@/background/enrichQueue';
import type { ControlResult, RuntimeMessage } from '@/lib/messages';
import { getSettings, isAllowedWebhookUrl } from '@/lib/settings';

const WATCHDOG_ALARM = 'watchdog';

function pumpAll(): void {
  void pumpEnrichment(() => void pumpDelivery());
  void pumpDelivery();
}

async function testWebhook(): Promise<ControlResult> {
  const settings = await getSettings();
  if (!isAllowedWebhookUrl(settings.webhookUrl)) {
    return { ok: false, error: 'Use an https:// URL, or http:// for localhost.' };
  }
  try {
    const response = await postJson(settings, { test: true, sent_at: new Date().toISOString() }, `test-${Date.now()}`);
    return response.ok
      ? { ok: true, detail: `Webhook responded with ${response.status}.` }
      : { ok: false, error: `Webhook responded with ${response.status}.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the webhook.' };
  }
}

async function route(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab?.id;
  switch (message.type) {
    case 'GET_ASSIGNMENT':
      return getAssignment(tabId);
    case 'CAPTURED':
      await handleCapture(tabId, message.jobId, message.body);
      return null;
    case 'SEARCH_DONE':
      await handleSearchDone(
        tabId,
        message.jobId,
        message.outcome,
        message.visibleCards,
        message.temporarilyClosedPlaceIds,
      );
      return null;
    case 'PUMP':
      pumpAll();
      return null;
    case 'START_RUN':
      await startRun(message.keywords, message.locations);
      return { ok: true } satisfies ControlResult;
    case 'PAUSE_RUN':
      await pauseRun();
      return { ok: true } satisfies ControlResult;
    case 'RESUME_RUN':
      await resumeRun();
      return { ok: true } satisfies ControlResult;
    case 'STOP_RUN':
      await stopRun();
      return { ok: true } satisfies ControlResult;
    case 'TEST_WEBHOOK':
      return testWebhook();
    case 'RETRY_WEBSITES':
      await retryFailedWebsites();
      pumpAll();
      return { ok: true } satisfies ControlResult;
    case 'COLLECT_CONTEXT':
      await queueMissingContext();
      pumpAll();
      return { ok: true } satisfies ControlResult;
    case 'RETRY_DELIVERIES':
      await retryFailedDeliveries();
      pumpAll();
      return { ok: true } satisfies ControlResult;
  }
}

export default defineBackground(() => {
  configureEngine({ onLeadsAdded: pumpAll });

  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  void chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  void recoverEnrichment().then(pumpAll);

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== WATCHDOG_ALARM) return;
    void watchdog().catch(console.error);
    pumpAll();
  });

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    void handleTabUpdated(tabId, change.url).catch(console.error);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void handleTabRemoved(tabId).catch(console.error);
  });

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    // Only this extension's own pages and content scripts can reach this listener.
    if (sender.id !== chrome.runtime.id) return false;
    route(message, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        console.error(error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Unexpected error' });
      });
    return true;
  });
});
