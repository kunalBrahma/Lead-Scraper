import { useEffect, useState } from 'react';
import { crmPermissionPattern, parseCrmOrigin } from '@/lib/crm';
import { isSendRunning, resetAfterCrmChange } from '@/lib/crmAddress';
import { getSettings, saveSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';
import { send } from './RunTab';

export function SettingsTab() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  const patch = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

  /** Saves settings and asks Chrome for access to the CRM's address. */
  async function save(): Promise<boolean> {
    setMessage(null);
    const crmUrl = settings.crmUrl.trim();
    const origin = crmUrl ? parseCrmOrigin(crmUrl) : null;
    if (crmUrl && !origin) {
      setMessage({ ok: false, text: 'Use an https:// address, or http:// for localhost.' });
      return false;
    }
    // Chrome only shows this prompt directly after a click, so it must run first.
    if (origin && !(await chrome.permissions.request({ origins: [crmPermissionPattern(origin)] }))) {
      setMessage({ ok: false, text: 'Chrome access to the CRM was declined, so nothing was saved.' });
      return false;
    }
    const previous = await getSettings();
    if (origin !== parseCrmOrigin(previous.crmUrl) && (await isSendRunning())) {
      setMessage({ ok: false, text: 'Pause or finish the current send before changing the CRM address.' });
      return false;
    }
    await saveSettings({
      ...settings,
      crmUrl: origin ?? '',
      crmKey: settings.crmKey.trim(),
      crawlConcurrency: Math.min(10, Math.max(1, Math.round(settings.crawlConcurrency) || 1)),
    });
    const reset = await resetAfterCrmChange(previous.crmUrl, origin);
    setMessage({
      ok: true,
      text: reset > 0 ? `Saved. ${reset.toLocaleString()} leads can now be sent to this CRM.` : 'Saved.',
    });
    return true;
  }

  async function test() {
    if (!(await save())) return;
    const result = await send({ type: 'TEST_CRM' });
    setMessage(result.ok ? { ok: true, text: result.detail ?? 'Connected.' } : { ok: false, text: result.error ?? 'Test failed.' });
  }

  return (
    <section className="card flex flex-col gap-3" aria-label="Settings">
      <div>
        <label className="label" htmlFor="crmUrl">CRM address</label>
        <input id="crmUrl" className="input" type="url" placeholder="https://www.yoursite.com"
          value={settings.crmUrl} onChange={(e) => patch({ crmUrl: e.target.value })} />
        <p className="muted mt-1 text-xs">Nothing is sent until you click Send in the Leads tab.</p>
      </div>
      <div>
        <label className="label" htmlFor="crmKey">Import key</label>
        <input id="crmKey" className="input" type="password" autoComplete="off" spellCheck={false}
          value={settings.crmKey} onChange={(e) => patch({ crmKey: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor="crawlConcurrency">Websites at once (1–10)</label>
        <input id="crawlConcurrency" className="input" type="number" min={1} max={10} value={settings.crawlConcurrency}
          onChange={(e) => patch({ crawlConcurrency: Number(e.target.value) })} />
      </div>
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'muted' : 'notice-danger'}>{message.text}</p>
      )}
      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={() => void save()}>Save</button>
        <button className="btn" disabled={!settings.crmUrl.trim() || !settings.crmKey.trim()} onClick={() => void test()}>Test connection</button>
      </div>
    </section>
  );
}
