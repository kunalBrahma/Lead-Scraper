export type BusinessStatus = 'open' | 'permanently_closed' | 'temporarily_closed';
export type EnrichStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type DeliveryStatus = 'unsent' | 'sent' | 'duplicate' | 'rejected';
export type ScoreTier = 'high' | 'medium' | 'low';

export interface EmailRecord {
  address: string;
  /** Path of the page the address was found on, such as `/contact`. */
  source: string;
  kind: 'business' | 'free';
  role: boolean;
  ownDomain: boolean;
  /** The address looks like it belongs to this business, on any domain. */
  related: boolean;
  /** `null` means the DNS lookup could not be completed. */
  mx: boolean | null;
}

export interface Socials {
  facebook?: string;
  instagram?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
}

export type ContextLevel = 'rich' | 'basic' | 'none';

/** A sentence quoted from the website, with the page it came from. */
export interface ContextHighlight {
  label: string;
  text: string;
  source: string;
}

export interface ContactName {
  name: string;
  /** The page path or email address the name came from. */
  source: string;
  confidence: 'high' | 'medium';
  basis: string;
}

/**
 * What the website's own HTML shows. An empty list or `false` means "not detected",
 * never "does not exist", because tools can load in ways this check cannot see.
 */
export interface WebsiteSignals {
  chatWidgets: string[];
  bookingTools: string[];
  otherTools: string[];
  platform: string | null;
  bookingLink: boolean;
  contactForm: boolean;
  mobileViewport: boolean;
  copyrightYear: number | null;
}

export interface BusinessContext {
  level: ContextLevel;
  summary: string | null;
  summarySource: string | null;
  about: string | null;
  aboutSource: string | null;
  services: string[];
  highlights: ContextHighlight[];
  contactName: ContactName | null;
  https: boolean;
  signals: WebsiteSignals;
  pagesRead: string[];
}

export interface Evidence {
  activeListing: boolean;
  websiteLive: boolean;
  websiteParked: boolean;
  websiteMatch: boolean;
  phoneValid: boolean;
  phoneMatch: boolean;
  emailVerified: boolean;
  emailRelated: boolean;
  emailSource: string | null;
  mxValid: boolean | null;
}

/** Fields read from a Google Maps search response. */
export interface MapsBusiness {
  placeId: string;
  name: string;
  fullAddress: string | null;
  street: string | null;
  city: string | null;
  postalCode: string | null;
  state: string | null;
  country: string | null;
  categories: string[];
  phoneRaw: string | null;
  website: string | null;
  domain: string | null;
  rating: number | null;
  reviewCount: number;
  claimed: boolean;
  businessStatus: BusinessStatus;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  hours: string | null;
}

export interface Lead extends MapsBusiness {
  phone: string | null;
  runId: number;
  keyword: string;
  /** The place that was searched, kept apart from the business's own address. */
  searchArea: string | null;
  /** Domain, email, and phone identifiers shared by listings of one company. */
  companyKeys: string[];
  collectedAt: number;
  emails: EmailRecord[];
  sitePhones: string[];
  socials: Socials;
  metaDescription: string | null;
  /** `null` until the website has been read. */
  context: BusinessContext | null;
  enrichStatus: EnrichStatus;
  enrichError: string | null;
  evidence: Evidence;
  score: number;
  tier: ScoreTier;
  deliveryStatus: DeliveryStatus;
  /** The CRM's reason, such as which detail matched an existing lead. */
  crmNote: string | null;
  crmSentAt: number | null;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type SearchOutcome = 'end_of_list' | 'stalled' | 'no_results' | 'single_place' | 'timeout';

export interface Job {
  id?: number;
  runId: number;
  query: string;
  status: JobStatus;
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  outcome: SearchOutcome | null;
  rows: number;
  newLeads: number;
  visibleCards: number;
}

export type RunStatus =
  | 'running'
  | 'paused'
  | 'paused_blocked'
  | 'completed'
  | 'stopped'
  | 'stopped_parse';

export interface Run {
  id?: number;
  status: RunStatus;
  statusReason: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Time spent collecting, excluding pauses, is `activeMs` plus the open segment. */
  activeMs: number;
  segmentStartedAt: number | null;
  tabId: number | null;
  currentJobId: number | null;
  nextDispatchAt: number;
  delayMultiplier: number;
  cleanStreak: number;
  coverageMisses: number;
  rowsAttempted: number;
  rowsParsed: number;
  responsesUnreadable: number;
  uniqueLeads: number;
  duplicates: number;
  searchesFinished: number;
  captchas: number;
}

export interface MxRecord {
  domain: string;
  valid: boolean | null;
  checkedAt: number;
}

export type SendJobStatus = 'running' | 'done' | 'failed' | 'stopped';

/** One click of "Send to CRM". It is saved first, so a send can resume after a restart. */
export interface SendJob {
  id?: number;
  clientBatchId: string;
  crmBatchId: string | null;
  label: string | null;
  status: SendJobStatus;
  placeIds: string[];
  /** Position of the next lead to send. */
  cursor: number;
  created: number;
  alreadyImported: number;
  duplicates: number;
  rejected: number;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  enrichmentEnabled: boolean;
  crawlConcurrency: number;
  crmUrl: string;
  crmKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enrichmentEnabled: true,
  crawlConcurrency: 5,
  crmUrl: '',
  crmKey: '',
};
