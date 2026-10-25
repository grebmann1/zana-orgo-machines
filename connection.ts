import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrgoClient, Machine } from './server.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ConnectionState = { status: 'connecting' | 'connected' | 'disconnected' | 'error'; message: string; hostId?: string };
type Host = { id: string; sshHost?: string; status: string };
type Record = { hostId: string; alias: string };
export type Store = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
const sshDir = join(homedir(), '.ssh');
const identityPath = join(sshDir, 'id_ed25519_orgo_zana');
const managedPath = join(sshDir, 'zana-orgo-hosts.conf');
const include = 'Include ~/.ssh/zana-orgo-hosts.conf';
const string = (value: Buffer | string) => { const b = Buffer.from(value); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };

/** Encode an unencrypted OpenSSH Ed25519 identity, using Node's key generator. */
export function generateIdentity() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.from(jwk.x!, 'base64url'); const seed = Buffer.from(jwk.d!, 'base64url');
  const publicBlob = Buffer.concat([string('ssh-ed25519'), string(pub)]);
  const check = randomBytes(4);
  let block = Buffer.concat([check, check, string('ssh-ed25519'), string(pub), string(Buffer.concat([seed, pub])), string('zana-orgo')]);
  const padding = 8 - block.length % 8; block = Buffer.concat([block, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const blob = Buffer.concat([Buffer.from('openssh-key-v1\0'), string('none'), string('none'), string(''), Buffer.from([0, 0, 0, 1]), string(publicBlob), string(block)]);
  return { publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} zana-orgo`, privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${blob.toString('base64').match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n` };
}
async function textFile(path: string) {
  try { const st = await lstat(path); if (!st.isFile() || st.size > 1_000_000) throw new Error('Unsafe SSH configuration file.'); return await readFile(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}
async function atomic(path: string, value: string) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { const fd = await open(temp, 'wx', 0o600); try { await fd.writeFile(value); } finally { await fd.close(); } await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
let serial: Promise<unknown> = Promise.resolve();
export function withSshLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = serial.then(async () => {
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(sshDir)).isDirectory()) throw new Error('Unsafe SSH directory.');
    const lockPath = join(sshDir, '.zana-orgo.lock');
    let lock; try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new Error('SSH setup is already running. Retry shortly.'); }
    try { return await fn(); } finally { await lock.close(); await unlink(lockPath); }
  });
  serial = result.catch(() => {}); return result;
}
export async function ensureIdentity(): Promise<string> {
  return withSshLock(async () => {
    const existing = await textFile(identityPath);
    if (existing) {
      const pub = (await textFile(`${identityPath}.pub`)).trim();
      if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(pub)) throw new Error('The Orgo SSH identity has no valid public key.');
      await chmod(identityPath, 0o600); return pub;
    }
    const pair = generateIdentity(); await atomic(identityPath, pair.privateKey); await atomic(`${identityPath}.pub`, pair.publicKey + '\n'); return pair.publicKey;
  });
}
export function parseSshEntries(config: string) {
  const entries: Array<{ alias: string; host?: string; port: number }> = []; let current: typeof entries[number] | undefined;
  for (const line of config.split(/\r?\n/)) {
    const [key, ...parts] = line.trim().split(/\s+/); const value = parts.join(' ');
    if (key?.toLowerCase() === 'host') { current = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ? { alias: value, port: 22 } : undefined; if (current) entries.push(current); }
    else if (current && key?.toLowerCase() === 'hostname') current.host = value;
    else if (current && key?.toLowerCase() === 'port') current.port = Number(value);
  }
  return entries;
}
export async function registerSsh(id: string, host: string, port: number, hosts: Host[], previous?: Record): Promise<string> {
  if (!UUID.test(id) || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH endpoint.');
  return withSshLock(async () => {
    const configPath = join(sshDir, 'config'); const config = await textFile(configPath); const managed = await textFile(managedPath);
    const candidates = [...parseSshEntries(managed), ...parseSshEntries(config)];
    const adopted = candidates.find(e => e.host === host && e.port === port && hosts.some(h => h.sshHost === e.alias));
    const alias = previous?.alias ?? adopted?.alias ?? `orgo-${id}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(alias)) throw new Error('Invalid stored SSH alias.');
    const pattern = new RegExp(`^# BEGIN ${alias}\\n[\\s\\S]*?^# END ${alias}\\n?`, 'gm');
    const block = `# BEGIN ${alias}\nHost ${alias}\n    HostName ${host}\n    Port ${port}\n    User root\n    IdentityFile ~/.ssh/id_ed25519_orgo_zana\n    IdentitiesOnly yes\n    StrictHostKeyChecking accept-new\n    ServerAliveInterval 30\n    ServerAliveCountMax 3\n# END ${alias}\n`;
    await atomic(managedPath, managed.replace(pattern, '').trimEnd() + '\n' + block);
    if (!config.split(/\r?\n/).some(line => line.trim() === include)) await atomic(configPath, `${include}\nHost *\n${config}`);
    return alias;
  });
}
/** Fixed root command; only a validated public key is embedded. Existing keys are retained. */
export function addKeyCommand(publicKey: string) {
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [a-zA-Z0-9_-]+)?$/.test(publicKey)) throw new Error('Invalid SSH public key.');
  const script = `import pathlib,os,fcntl,tempfile\np=pathlib.Path('/root/.ssh');p.mkdir(mode=0o700,exist_ok=True)\nwith open(p/'.zana-orgo.lock','w') as lock:\n fcntl.flock(lock,fcntl.LOCK_EX)\n target=p/'authorized_keys'\n if target.is_symlink(): raise RuntimeError('symlink refused')\n current=target.read_text() if target.exists() else ''\n key=${JSON.stringify(publicKey)}\n if not any(line.split()[:2]==key.split()[:2] for line in current.splitlines()):\n  fd,tmp=tempfile.mkstemp(dir=p,prefix='.zana-orgo-')\n  try:\n   os.fchmod(fd,0o600)\n   with os.fdopen(fd,'w') as out: out.write(current.rstrip()+'\\n'+key+'\\n')\n   os.replace(tmp,target)\n  finally:\n   if os.path.exists(tmp): os.unlink(tmp)\nprint('zana-key-ready')`;
  return `python3 -c '${script.replace(/'/g, `'"'"'`)}'`;
}
export function localServerUrl(raw = process.env.ZCC_SERVER_URL ?? 'http://127.0.0.1:8780') {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Zana pairing requires the local product server.');
  return url.origin;
}
async function limitedBody(res: Response, onLine?: (line: string) => void) {
  let output = ''; let size = 0; const reader = res.body?.getReader();
  if (!reader) throw new Error('Empty response from Zana.');
  let pending = '';
  const append = (text: string) => { output += text; pending += text; let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.trim()) onLine?.(line); } };
  try { const decoder = new TextDecoder(); for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2_000_000) { await reader.cancel(); throw new Error('Zana response exceeded the size limit.'); } append(decoder.decode(chunk.value, { stream: true })); } append(decoder.decode()); if (pending.trim()) onLine?.(pending); return output; }
  finally { reader.releaseLock(); }
}
export class ZanaClient {
  constructor(private transport: typeof fetch = fetch, private base = localServerUrl()) {}
  async request(path: string, body?: object, signal?: AbortSignal, onLine?: (line: string) => void) {
    const response = await this.transport(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: signal ?? AbortSignal.timeout(10_000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Zana pairing request failed (HTTP ${response.status}).`);
    return limitedBody(response, onLine);
  }
  async hosts(): Promise<Host[]> {
    let data; try { data = JSON.parse(await this.request('/api/v1/hosts')); } catch { throw new Error('Could not read Zana machine status.'); }
    if (!Array.isArray(data)) throw new Error('Unexpected Zana machine response.');
    return data.filter(h => h && UUID.test(h.id) && typeof h.status === 'string');
  }
  async connect(alias: string, signal: AbortSignal, progress: (message: string) => void): Promise<string> {
    const text = await this.request('/api/v1/hosts/bootstrap', { ssh: { host: alias } }, signal, line => {
      try { const e = JSON.parse(line); if (e.type === 'stage' && ['ssh', 'tunnel', 'install', 'wait', 'register', 'connected'].includes(e.stage) && ['running', 'passed', 'failed'].includes(e.status)) progress(`Zana ${e.stage}: ${e.status}`); } catch { /* Final parser reports incomplete or malformed streams. */ }
    });
    let events; try { events = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { throw new Error('Invalid Zana pairing response. Refresh before retrying.'); }
    if (events.some(e => !e || typeof e !== 'object' || !['stage', 'log', 'done', 'error'].includes(e.type))) throw new Error('Invalid Zana pairing response. Refresh before retrying.');
    if (events.some(e => e.type === 'error')) throw new Error('Zana could not pair this computer. Check Settings → Machines and retry.');
    const done = events.find(e => e.type === 'done' && UUID.test(e.hostId));
    if (!done) throw new Error('Zana pairing was interrupted. Refresh before retrying.');
    return done.hostId as string;
  }
}
export class Connections {
  readonly states = new Map<string, ConnectionState>();
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private disposed = false;
  constructor(private orgo: OrgoClient, private store: Store, private zana = new ZanaClient(), private identity = ensureIdentity, private register = registerSsh) {}
  async status(machines: Machine[]) {
    const hosts = await this.zana.hosts(); const result: { [id: string]: ConnectionState } = {};
    for (const m of machines) {
      const current = this.states.get(m.id); const rec = await this.store.get<Record>(`machine:${m.id}`);
      const host = hosts.find(h => h.id === rec?.hostId);
      result[m.id] = current?.status === 'connecting' || current?.status === 'error' ? current : { status: host?.status === 'connected' ? 'connected' : 'disconnected', message: host?.status === 'connected' ? 'Connected to Zana' : 'Not connected to Zana', ...(host ? { hostId: host.id } : {}) };
    }
    return result;
  }
  async start(id: string) {
    if (!UUID.test(id) || this.disposed) throw new Error('Invalid computer connection.');
    if (this.active || this.disposed) throw new Error('A computer is already connecting or the plugin is reloading.');
    const m = (await this.orgo.list()).machines.find(m => m.id === id);
    if (!m || m.os !== 'linux' || m.status !== 'running' || !m.canManage) throw new Error('Connection requires a running Linux computer with write access.');
    if (this.active || this.disposed) throw new Error('A computer is already connecting or the plugin is reloading.');
    const state: ConnectionState = { status: 'connecting', message: 'Preparing SSH…' }; this.states.set(id, state);
    // The account list caps IDs at 1,000; prune removed computers as well.
    for (const key of this.states.keys()) if (key !== id && this.states.size > 1000) this.states.delete(key);
    this.abort = new AbortController(); const timer = setTimeout(() => this.abort?.abort(), 360_000);
    this.active = this.run(m, state, this.abort.signal).catch(() => { state.status = 'error'; state.message = this.abort?.signal.aborted ? 'Connection timed out or plugin reloaded. Refresh before retrying.' : state.message; }).finally(() => { clearTimeout(timer); this.active = null; this.abort = null; });
    return { ...state };
  }
  private async run(m: Machine, state: ConnectionState, signal: AbortSignal) {
    try {
      const publicKey = await this.identity();
      if (signal.aborted) throw new Error('Connection cancelled.');
      const settings = await this.orgo.request(`/computers/${m.id}/ssh`);
      if (signal.aborted) throw new Error('Connection cancelled.');
      if (settings.enabled !== true) {
        if (settings.authorized_key_set === true) throw new Error('SSH is disabled with existing keys. Enable SSH in Orgo first to preserve those keys.');
        const enabled = await this.orgo.request(`/computers/${m.id}/ssh`, 'POST', { public_key: publicKey });
        if (enabled.requires_restart === true || enabled.pending === true) throw new Error('SSH is enabled. Restart this computer using the power controls, then connect again.');
      }
      if (signal.aborted) throw new Error('Connection cancelled.');
      state.message = 'Preparing the SSH key…';
      const added = await this.orgo.request(`/computers/${m.id}/bash`, 'POST', { command: addKeyCommand(publicKey.split(' ').slice(0, 2).join(' ')), timeout: 10 });
      if (added.exit_code !== 0 || added.error) throw new Error('Could not install the SSH public key. Existing keys were preserved.');
      if (signal.aborted) throw new Error('Connection cancelled.');
      const endpoint = await this.orgo.request(`/computers/${m.id}/ssh`);
      if (endpoint.enabled !== true) throw new Error('SSH is not ready. Refresh and retry.');
      const previous = await this.store.get<Record>(`machine:${m.id}`);
      const alias = await this.register(m.id, String(endpoint.ipv4_host ?? ''), Number(endpoint.ipv4_port), await this.zana.hosts(), previous);
      if (signal.aborted) throw new Error('Connection cancelled.');
      state.message = 'Pairing with Zana…';
      const hostId = await this.zana.connect(alias, signal, message => { state.message = message; });
      await this.store.set(`machine:${m.id}`, { hostId, alias });
      state.status = 'connected'; state.message = 'Connected to Zana'; state.hostId = hostId;
    } catch (e) { state.message = e instanceof Error ? e.message : 'Connection failed.'; throw e; }
  }
  dispose() { this.disposed = true; this.abort?.abort(); }
  async settled() { await this.active; }
}
