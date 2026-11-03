import Dexie, { type Table } from 'dexie';
import { migrateLead } from './migrate';
import type { Job, Lead, MxRecord, Run } from './types';

class LeadDatabase extends Dexie {
  leads!: Table<Lead, string>;
  jobs!: Table<Job, number>;
  runs!: Table<Run, number>;
  mx!: Table<MxRecord, string>;

  constructor() {
    super('lead-scraper');
    this.version(1).stores({
      leads:
        'placeId, runId, domain, [domain+phone], enrichStatus, deliveryStatus, tier, score, collectedAt',
      jobs: '++id, runId, [runId+status], status',
      runs: '++id, status, createdAt',
      mx: 'domain',
    });
    this.version(2)
      .stores({
        leads:
          'placeId, runId, domain, [domain+phone], enrichStatus, deliveryStatus, tier, score, collectedAt, *companyKeys',
      })
      .upgrade((tx) => tx.table<Lead, string>('leads').toCollection().modify(migrateLead));
    this.version(3)
      .stores({})
      .upgrade((tx) =>
        tx.table<Lead, string>('leads').toCollection().modify((lead) => {
          lead.context ??= null;
        }),
      );
    // Context from earlier extraction rules had errors, so it is cleared to be collected again.
    this.version(4)
      .stores({})
      .upgrade((tx) =>
        tx.table<Lead, string>('leads').toCollection().modify((lead) => {
          lead.context = null;
        }),
      );
  }
}

export const db = new LeadDatabase();

export const ACTIVE_STATUSES = ['running', 'paused', 'paused_blocked'] as const;

export async function getActiveRun(): Promise<Run | undefined> {
  return db.runs.where('status').anyOf([...ACTIVE_STATUSES]).first();
}

export async function getLatestRun(): Promise<Run | undefined> {
  return db.runs.orderBy('createdAt').last();
}
