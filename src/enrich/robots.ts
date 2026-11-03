interface Rule {
  allow: boolean;
  path: string;
}

/** Reads the most specific group that applies to our agent, falling back to `*`. */
export function parseRobots(text: string, agent = 'leadscraper'): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (field === 'allow' || field === 'disallow') {
      collectingAgents = false;
      if (current && value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(rulePath: string, target: string): boolean {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(target);
}

/** The longest matching rule wins, and `allow` wins a tie, as in RFC 9309. */
export function isPathAllowed(rules: Rule[], target: string): boolean {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, target)) continue;
    const longer = !best || rule.path.length > best.path.length;
    const tieAllow = best && rule.path.length === best.path.length && rule.allow;
    if (longer || tieAllow) best = rule;
  }
  return best ? best.allow : true;
}
