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
import { pumpSend, resumeSend, startSend, stopSend, testCrmConnection } from '@/background/sendQueue';
import type { ControlResult, RuntimeMessage } from '@/lib/messages';

const WATCHDOG_ALARM = 'watchdog';

function pumpAll(): void {
  void pumpEnrichment(() => {});
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
    case 'TEST_CRM':
      return testCrmConnection();
    case 'START_SEND':
      return startSend(message.placeIds, message.label);
    case 'STOP_SEND':
      await stopSend();
      return { ok: true } satisfies ControlResult;
    case 'RESUME_SEND':
      return resumeSend();
    case 'RETRY_WEBSITES':
      await retryFailedWebsites();
      pumpAll();
      return { ok: true } satisfies ControlResult;
    case 'COLLECT_CONTEXT':
      await queueMissingContext();
      pumpAll();
      return { ok: true } satisfies ControlResult;
  }
}

export default defineBackground(() => {
  configureEngine({ onLeadsAdded: pumpAll });

  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  void chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  void recoverEnrichment().then(pumpAll);
  void pumpSend().catch(console.error);

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== WATCHDOG_ALARM) return;
    void watchdog().catch(console.error);
    pumpAll();
    // Only continues a send you already started.
    void pumpSend().catch(console.error);
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
