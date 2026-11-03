import { useState } from 'react';
import { LeadsTab } from './LeadsTab';
import { RunTab } from './RunTab';
import { SettingsTab } from './SettingsTab';

const TABS = ['Run', 'Leads', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>('Run');
  return (
    <main className="mx-auto max-w-2xl">
      <div role="tablist" aria-label="Sections" className="flex border-b border-[var(--line)] bg-[var(--panel)]">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            className="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3 p-3">
        {tab === 'Run' && <RunTab />}
        {tab === 'Leads' && <LeadsTab />}
        {tab === 'Settings' && <SettingsTab />}
      </div>
    </main>
  );
}
