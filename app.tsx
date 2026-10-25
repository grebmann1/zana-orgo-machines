import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc } from '@zana-ai/zcc-plugin-sdk/app';
import type { Action, Machine, Snapshot } from './server.js';
import type { ConnectionState } from './connection.js';

const names: Record<Action, string> = { start: 'Start', stop: 'Stop', restart: 'Restart', suspend: 'Suspend', resume: 'Resume' };
const options = (m: Machine): Action[] => !m.canManage ? [] : m.status === 'running' ? (m.os === 'linux' ? ['restart', 'suspend', 'stop'] : m.os === 'windows' ? ['restart', 'stop'] : ['restart']) : m.status === 'suspended' ? ['resume'] : ['frozen', 'stopped', 'error'].includes(m.status) ? ['start'] : [];
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'The request failed.';

export function MachinesPanel() {
  const rpc = useRpc();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<{ id: string; action: Action } | null>(null);
  const [ssh, setSsh] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current; setLoading(true);
    try { const value = await rpc.call('list') as Snapshot; if (request === sequence.current) { setSnapshot(value); setError(''); } const states = await rpc.call('connections') as Record<string, ConnectionState>; if (request === sequence.current) setConnections(states); }
    catch (e) { if (request === sequence.current) setError(errorMessage(e)); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [rpc]);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => void refresh(), 15_000);
    return () => { clearInterval(timer); sequence.current++; };
  }, [refresh]);
  const isConnecting = Object.values(connections).some(c => c.status === 'connecting');
  useEffect(() => {
    if (!isConnecting) return;
    let disposed = false; let checking = false;
    const timer = setInterval(async () => {
      if (checking) return; checking = true;
      try { const states = await rpc.call('connections') as Record<string, ConnectionState>; if (!disposed) setConnections(states); }
      catch (e) { if (!disposed) setError(errorMessage(e)); }
      finally { checking = false; }
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [isConnecting, rpc]);
  useEffect(() => {
    if (!Object.keys(operations).length) return;
    let disposed = false; let checking = false;
    const timer = setInterval(async () => {
      if (checking) return; checking = true;
      try {
        for (const [id, operationId] of Object.entries(operations)) {
          const result = await rpc.call('operation', { id, operationId }) as { status: string };
          if (disposed || !['succeeded', 'failed', 'needs_review'].includes(result.status)) continue;
          setOperations(current => { const next = { ...current }; delete next[id]; return next; });
          setNotice(result.status === 'succeeded' ? 'Computer operation completed.' : result.status === 'needs_review' ? 'Orgo is checking an interrupted operation. Wait before retrying.' : 'Operation failed. Open the Orgo dashboard for details.');
          void refresh();
        }
      } catch (e) { if (!disposed) setError(errorMessage(e)); }
      finally { checking = false; }
    }, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [operations, rpc, refresh]);
  async function run(m: Machine, action: Action) {
    setPending(null); setBusy(m.id); setError(''); setNotice('');
    try {
      const result = await rpc.call('action', { id: m.id, action }) as { operationId: string | null };
      if (result.operationId) setOperations(current => ({ ...current, [m.id]: result.operationId! }));
      setNotice(`${names[action]} requested for ${m.name}.`); await refresh();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function showSsh(m: Machine) {
    setBusy(m.id); setError('');
    try {
      const result = await rpc.call('ssh', { id: m.id }) as { enabled: boolean; command: string | null };
      setSsh(current => ({ ...current, [m.id]: result.enabled && result.command ? result.command : 'Enable SSH in this computer’s Orgo settings.' }));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function connect(m: Machine) {
    setBusy(m.id); setError(''); setNotice('');
    try { const state = await rpc.call('connect', { id: m.id }) as ConnectionState; setConnections(current => ({ ...current, [m.id]: state })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  const machines = snapshot?.machines.filter(m => `${m.name} ${m.workspace}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <section className="orgo-panel" aria-label="Orgo Machines"><style>{styles}</style><div className="orgo-content">
    <header className="orgo-header"><div><p className="orgo-eyebrow">CLOUD COMPUTERS</p><h1>Orgo Machines</h1><p>Connect Orgo computers to Zana and manage them here.</p></div><button onClick={() => void refresh()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
    {error && <div role="alert" className="orgo-alert">{error}</div>}{notice && <p role="status" className="orgo-notice">{notice}</p>}
    {!snapshot ? <p>{error ? 'Use Refresh to try again.' : 'Loading Orgo computers…'}</p> : !snapshot.configured ? <div className="orgo-empty"><h2>Connect your Orgo account</h2><p>Sign in using Orgo’s device approval flow, or configure your local API key as described in the plugin README.</p><p>Your API key stays on this computer.</p><a href="https://www.orgo.ai/settings/developers" target="_blank" rel="noreferrer">Orgo API settings ↗</a></div> : <>
      <div className="orgo-toolbar"><input aria-label="Filter computers" placeholder="Find a computer…" value={filter} onChange={e => setFilter(e.target.value)} /><span>{snapshot.machines.length} {snapshot.machines.length === 1 ? 'computer' : 'computers'}</span></div>
      {!machines.length ? <div className="orgo-empty"><h2>{filter ? 'No matching computers' : 'No computers yet'}</h2><p>{filter ? 'Try another name or workspace.' : 'Create a computer in Orgo, then refresh.'}</p></div> : <div className="orgo-list">{machines.map(m => <article className="orgo-card" key={m.id}>
        <div className="orgo-card-heading"><div><h2>{m.name}</h2><p>{m.workspace}</p></div><span className={`orgo-status ${m.status === 'running' ? 'is-running' : ''}`}>{operations[m.id] ? 'Changing…' : m.status}</span></div>
        <p className="orgo-specs">{m.os}{m.cpu !== null ? ` · ${m.cpu} vCPU` : ''}{m.ram !== null ? ` · ${m.ram} GB RAM` : ''}</p>
        {m.os === 'linux' && m.canManage && <div className="orgo-pairing"><span role="status">{connections[m.id]?.message ?? 'Connect this computer to run agents in Zana.'}</span><button disabled={busy !== null || isConnecting || m.status !== 'running' || Boolean(operations[m.id])} onClick={() => void connect(m)}>{connections[m.id]?.status === 'connecting' ? 'Connecting…' : connections[m.id]?.status === 'connected' ? 'Reconnect to Zana' : 'Connect to Zana'}</button></div>}
        <div className="orgo-actions"><a href={`https://www.orgo.ai/computers/${m.id}`} target="_blank" rel="noreferrer">Open computer ↗</a>{m.os === 'linux' && m.canManage && <button disabled={busy !== null} onClick={() => void showSsh(m)}>SSH details</button>}{options(m).map(action => <button key={action} disabled={busy !== null || Boolean(operations[m.id]) || connections[m.id]?.status === 'connecting'} onClick={() => ['stop', 'restart', 'suspend'].includes(action) ? setPending({ id: m.id, action }) : void run(m, action)}>{busy === m.id ? 'Working…' : names[action]}</button>)}{!m.canManage && <span>View only</span>}</div>
        {pending?.id === m.id && <div className="orgo-confirm" role="group" aria-label={`${names[pending.action]} ${m.name}?`}><h3>{names[pending.action]} {m.name}?</h3><p>{pending.action === 'suspend' ? 'The computer pauses and SSH disconnects until it resumes.' : 'Running apps close and unsaved work may be lost. Saved files remain.'}</p><div className="orgo-actions"><button onClick={() => setPending(null)}>Cancel</button><button disabled={busy !== null} onClick={() => void run(m, pending.action)}>{names[pending.action]} computer</button></div></div>}
        {ssh[m.id] && <div className="orgo-ssh"><code>{ssh[m.id]}</code><p>Connect to Zana above sets up the SSH identity and pairs this computer automatically.</p></div>}
      </article>)}</div>}
      <footer>Updates every 15 seconds · Last checked {new Date(snapshot.checkedAt).toLocaleTimeString()}<span>Linux computers connect directly to Zana</span></footer>
    </>}
  </div></section>;
}
const styles = `
.orgo-panel{height:100%;overflow:auto;box-sizing:border-box;background:var(--bg-base);color:var(--text-primary);font:inherit}.orgo-content{max-width:1080px;margin:0 auto;padding:36px 32px}.orgo-header{display:flex;gap:24px;align-items:center;justify-content:space-between;margin-bottom:28px}.orgo-panel .orgo-eyebrow{font-size:10px;letter-spacing:.12em;color:var(--text-muted);margin:0 0 8px}.orgo-panel h1{font-size:25px;font-weight:600;letter-spacing:-.6px;margin:0 0 8px}.orgo-panel h2{font-size:15px;font-weight:600;margin:0 0 5px}.orgo-panel h3{font-size:13px;margin:0 0 6px}.orgo-panel p{color:var(--text-secondary);font-size:13px;line-height:1.6;margin:0}.orgo-panel button,.orgo-panel a{font:inherit;font-size:12px;line-height:1.4}.orgo-panel button{background:var(--bg-raised,var(--bg-base));color:var(--text-primary);border:1px solid var(--border-color,var(--border));border-radius:6px;padding:7px 11px;cursor:pointer}.orgo-panel button:hover{background:var(--bg-hover)}.orgo-panel button:disabled{opacity:.45;cursor:default}.orgo-panel :focus-visible{outline:2px solid var(--accent);outline-offset:3px}.orgo-panel a{color:var(--text-primary);text-underline-offset:3px}.orgo-toolbar{display:flex;gap:20px;align-items:center;justify-content:space-between;margin-bottom:16px;color:var(--text-muted);font-size:12px}.orgo-toolbar input{font:inherit;border:1px solid var(--border-color,var(--border));color:var(--text-primary);background:var(--bg-base);border-radius:6px;padding:9px 12px;min-width:220px}.orgo-list{display:grid;gap:14px}.orgo-card{padding:21px 22px;border:1px solid var(--border-color,var(--border));border-radius:10px;background:var(--bg-surface,var(--bg-base))}.orgo-card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.orgo-status{font-size:11px;padding:4px 9px;border:1px solid var(--border-color,var(--border));border-radius:20px;color:var(--text-secondary)}.orgo-status.is-running{color:var(--success,#299968)}.orgo-panel .orgo-specs{margin:15px 0;color:var(--text-muted);font-size:12px}.orgo-pairing{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0 18px;font-size:12px;color:var(--text-secondary)}.orgo-actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.orgo-actions>a{margin-right:auto}.orgo-actions>span{color:var(--text-muted);font-size:12px}.orgo-panel .orgo-alert,.orgo-panel .orgo-notice{padding:12px 15px;border-radius:7px;margin-bottom:18px;border:1px solid var(--border-color,var(--border));font-size:13px}.orgo-alert{color:var(--error,#c44)}.orgo-empty{padding:32px;border:1px dashed var(--border-color,var(--border));border-radius:9px}.orgo-empty p{margin:8px 0 14px}.orgo-ssh,.orgo-confirm{margin-top:17px;padding:14px;border-radius:6px;background:var(--bg-base);border:1px solid var(--border-color,var(--border));overflow-wrap:anywhere}.orgo-ssh code{font-size:12px}.orgo-panel .orgo-ssh p{font-size:11px;margin-top:8px}.orgo-confirm .orgo-actions{justify-content:flex-end;margin-top:14px}.orgo-panel footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--text-muted);margin-top:19px}@media(max-width:600px){.orgo-content{padding:22px 16px}.orgo-header{align-items:flex-start}.orgo-toolbar input{min-width:0;width:60%}.orgo-actions>a{width:100%;margin:0 0 5px}}
`;
export default definePluginApp(app => app.slots.navPanel({ id: 'main', title: 'Orgo Machines', icon: 'Monitor', component: MachinesPanel }));
