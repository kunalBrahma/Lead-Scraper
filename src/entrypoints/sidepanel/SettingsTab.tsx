import { useEffect, useState } from 'react';
import { db } from '@/lib/db';
import { getSettings, isAllowedWebhookUrl, saveSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';
import { send } from './RunTab';

export function SettingsTab() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    void getSettings().then(setSettings);
    void db.leads.where('deliveryStatus').equals('failed').count().then(setFailed);
  }, []);

  const patch = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

  /** Saves settings and asks Chrome for access to the webhook's address. */
  async function save(): Promise<boolean> {
    setMessage(null);
    if (settings.webhookUrl && !isAllowedWebhookUrl(settings.webhookUrl)) {
      setMessage({ ok: false, text: 'Use an https:// URL, or http:// for localhost.' });
      return false;
    }
    if (settings.webhookUrl) {
      const origin = `${new URL(settings.webhookUrl).origin}/*`;
      if (!(await chrome.permissions.request({ origins: [origin] }))) {
        setMessage({ ok: false, text: 'Chrome access to the webhook was declined, so nothing was saved.' });
        return false;
      }
    }
    await saveSettings({
      ...settings,
      crawlConcurrency: Math.min(10, Math.max(1, Math.round(settings.crawlConcurrency) || 1)),
    });
    await send({ type: 'RETRY_DELIVERIES' });
    setFailed(0);
    setMessage({ ok: true, text: 'Saved.' });
    return true;
  }

  async function test() {
    if (!(await save())) return;
    const result = await send({ type: 'TEST_WEBHOOK' });
    setMessage(result.ok ? { ok: true, text: result.detail ?? 'Webhook works.' } : { ok: false, text: result.error ?? 'Test failed.' });
  }

  return (
    <section className="card flex flex-col gap-3" aria-label="Settings">
      <div>
        <label className="label" htmlFor="webhookUrl">Webhook URL for your agent</label>
        <input id="webhookUrl" className="input" type="url" placeholder="https://your-agent.example/leads"
          value={settings.webhookUrl} onChange={(e) => patch({ webhookUrl: e.target.value.trim() })} />
        <p className="muted mt-1 text-xs">Each lead is sent as JSON once it's checked, including leads already collected.</p>
      </div>
      <div>
        <label className="label" htmlFor="webhookSecret">Bearer token (optional)</label>
        <input id="webhookSecret" className="input" type="password" autoComplete="off"
          value={settings.webhookSecret} onChange={(e) => patch({ webhookSecret: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="webhookMinScore">Minimum score to send</label>
          <input id="webhookMinScore" className="input" type="number" min={0} max={100} value={settings.webhookMinScore}
            onChange={(e) => patch({ webhookMinScore: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label" htmlFor="crawlConcurrency">Websites at once (1–10)</label>
          <input id="crawlConcurrency" className="input" type="number" min={1} max={10} value={settings.crawlConcurrency}
            onChange={(e) => patch({ crawlConcurrency: Number(e.target.value) })} />
        </div>
      </div>
      {failed > 0 && <p className="notice-warn">{failed.toLocaleString()} failed deliveries will be retried when you save.</p>}
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'muted' : 'notice-danger'}>{message.text}</p>
      )}
      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={() => void save()}>Save</button>
        <button className="btn" disabled={!settings.webhookUrl} onClick={() => void test()}>Send test</button>
      </div>
    </section>
  );
}
