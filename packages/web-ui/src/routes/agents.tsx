import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, type AgentSummary } from '../lib/api';
import { formatAbsolute, formatRelative } from '../lib/format';

interface OwnerGroup {
  key: string;
  label: string;
  agents: AgentSummary[];
  kind: 'owner' | 'unknown';
}

// Pure client-side bucket: split the flat /api/agents list by ownerName.
// Empty ownerName (cred revoked / missing) goes into one synthetic group.
// Presentation only — server's read response is shown verbatim, just re-grouped.
function bucketAgents(agents: AgentSummary[]): OwnerGroup[] {
  const byOwner = new Map<string, AgentSummary[]>();
  const unknown: AgentSummary[] = [];
  for (const a of agents) {
    if (!a.ownerName) {
      unknown.push(a);
      continue;
    }
    const arr = byOwner.get(a.ownerName) ?? [];
    arr.push(a);
    byOwner.set(a.ownerName, arr);
  }
  const owners: OwnerGroup[] = [...byOwner.entries()]
    .map(([name, list]) => ({ key: name, label: name, agents: list, kind: 'owner' as const }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (unknown.length) {
    owners.push({ key: '__unknown__', label: '(unknown owner)', agents: unknown, kind: 'unknown' });
  }
  return owners;
}

export function AgentsList() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    let live = true;
    api.listAgents()
      .then(({ agents }) => { if (live) setAgents(agents); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return;
        if (live) setErr(e instanceof Error ? e.message : 'failed');
      });
    return () => { live = false; };
  }, []);

  const groups = useMemo(() => (agents ? bucketAgents(agents) : []), [agents]);

  const params = new URLSearchParams(loc.search);
  const selectedKey = params.get('o') || groups[0]?.key || null;
  const selectedGroup = groups.find((g) => g.key === selectedKey) ?? groups[0] ?? null;

  return (
    <div className="main">
      <aside className="sidebar">
        <div className="sidebar-section">
          <span>owners</span>
          <span className="count">{groups.length || '—'}</span>
        </div>
        {err && <div className="sidebar-section">registry unavailable · {err}</div>}
        {!err && !agents && <div className="sidebar-section">loading…</div>}
        {!err && agents && (
          <ul className="user-group-list">
            {groups.map((g) => {
              const active = g.key === selectedGroup?.key;
              return (
                <li
                  key={g.key}
                  className={'user-group-row' + (active ? ' active' : '') + (g.kind === 'unknown' ? ' shared' : '')}
                  onClick={() => nav(`/agents?o=${encodeURIComponent(g.key)}`)}
                  role="button"
                >
                  <span className="chev">{active ? '›' : '·'}</span>
                  <span className="name">{g.label}</span>
                  <span className="count">{g.agents.length}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div style={{ padding: '0 18px', marginTop: 12, color: 'var(--bone-300)', fontSize: 11, lineHeight: 1.6 }}>
          read-only registry. register / hide / talk via the <code style={{ color: 'var(--amber)' }}>metabot</code> CLI.
          grouping is presentation-only — every <code style={{ color: 'var(--amber)' }}>@xvi</code> user sees the same set.
        </div>
      </aside>
      <div className="content">
        <div className="page-head">
          <div>
            <div className="kicker">registry · by owner</div>
            <h1>{selectedGroup?.label ?? 'agents'}</h1>
          </div>
          <span className="crumbs">/ agents / {selectedGroup?.label ?? ''}</span>
        </div>
        {err && <div className="state err">{err}</div>}
        {!err && !agents && <div className="state"><span className="cursor">loading</span></div>}
        {!err && agents && agents.length === 0 && (
          <div className="state">no agents registered · run <code>metabot agents register</code> from a bot host</div>
        )}
        {!err && agents && agents.length > 0 && selectedGroup && (
          <AgentsTable agents={selectedGroup.agents} />
        )}
      </div>
    </div>
  );
}

function AgentsTable({ agents }: { agents: AgentSummary[] }) {
  return (
    <table className="agents-table">
      <thead>
        <tr>
          <th className="idx">#</th>
          <th>name</th>
          <th>url</th>
          <th>last seen</th>
          <th>visibility</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a, i) => (
          <tr key={a.botName}>
            <td className="idx">{String(i + 1).padStart(3, '0')}</td>
            <td className="name">{a.botName}</td>
            <td className="url"><code>{a.url}</code></td>
            <td className="ts" title={formatAbsolute(a.lastSeenAt)}>{formatRelative(a.lastSeenAt)}</td>
            <td>
              <span className={`badge ${a.visible ? 'vis-published' : 'vis-private'}`}>
                {a.visible ? 'visible' : 'hidden'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
