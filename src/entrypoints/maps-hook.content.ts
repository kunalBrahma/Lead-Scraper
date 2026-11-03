import { HOOK_SOURCE, type HookMessage } from '@/lib/messages';
import { isMapsSearchRequest } from '@/maps/fieldMap';

/**
 * Runs in the page's own context to read the search responses Maps already loads,
 * so no extra requests reach Google. It only reports them to the content script.
 */
export default defineContentScript({
  matches: ['https://www.google.com/maps/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const report = (url: string, body: string) => {
      const message: HookMessage = { source: HOOK_SOURCE, url, body };
      window.postMessage(message, window.location.origin);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        const url = String(args[1]);
        if (isMapsSearchRequest(url)) {
          this.addEventListener('load', () => {
            try {
              if (this.status === 200 && (this.responseType === '' || this.responseType === 'text')) {
                report(url, this.responseText);
              }
            } catch {
              // Reading a response must never disturb the page.
            }
          });
        }
      } catch {
        // Reading a response must never disturb the page.
      }
      return (originalOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;

    const originalFetch = window.fetch;
    window.fetch = async function (this: typeof globalThis, ...args: Parameters<typeof fetch>) {
      const response = await originalFetch.apply(this, args);
      try {
        const input = args[0];
        const url = input instanceof Request ? input.url : String(input);
        if (response.ok && isMapsSearchRequest(url)) {
          void response.clone().text().then((body) => report(url, body)).catch(() => {});
        }
      } catch {
        // Reading a response must never disturb the page.
      }
      return response;
    } as typeof fetch;
  },
});
