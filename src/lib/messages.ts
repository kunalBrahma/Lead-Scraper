import type { SearchOutcome } from './types';

export interface Assignment {
  jobId: number;
  query: string;
}

/** Messages from the Maps content script to the service worker. */
export type WorkerMessage =
  | { type: 'GET_ASSIGNMENT' }
  | { type: 'CAPTURED'; jobId: number; body: string }
  | {
      type: 'SEARCH_DONE';
      jobId: number;
      outcome: SearchOutcome;
      visibleCards: number;
      temporarilyClosedPlaceIds: string[];
    }
  | { type: 'PUMP' };

/** Messages from the side panel to the service worker. */
export type ControlMessage =
  | { type: 'START_RUN'; keywords: string[]; locations: string[] }
  | { type: 'PAUSE_RUN' }
  | { type: 'RESUME_RUN' }
  | { type: 'STOP_RUN' }
  | { type: 'TEST_WEBHOOK' }
  | { type: 'RETRY_DELIVERIES' }
  | { type: 'RETRY_WEBSITES' }
  | { type: 'COLLECT_CONTEXT' };

export type RuntimeMessage = WorkerMessage | ControlMessage;

export interface ControlResult {
  ok: boolean;
  error?: string;
  detail?: string;
}

export const HOOK_SOURCE = 'lead-scraper-hook';

export interface HookMessage {
  source: typeof HOOK_SOURCE;
  url: string;
  body: string;
}
