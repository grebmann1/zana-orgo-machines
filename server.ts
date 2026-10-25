import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ZccPluginApi } from '@zana-ai/zcc-plugin-sdk/server';
import { Connections } from './connection.js';

const API = 'https://www.orgo.ai/api';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const credentialPath = join(homedir(), '.config', 'zcc-orgo', 'api-key');
export type Action = 'start' | 'stop' | 'restart' | 'suspend' | 'resume';
export type Machine = { id: string; name: string; workspace: string; status: string; os: string; cpu: number | null; ram: number | null; canManage: boolean };
export type Snapshot = { configured: boolean; machines: Machine[]; checkedAt: number };
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const label = (v: unknown, fallback: string) => typeof v === 'string' ? v.slice(0, 160) : fallback;
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;

export async function readCredential(): Promise<string> {
  try { return (await readFile(credentialPath, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the local Orgo credential file.');
    return process.env.ORGO_API_KEY?.trim() ?? '';
  }
}
export function parseMachines(value: unknown): Machine[] {
  const data = object(value);
  if (!Array.isArray(data.workspaces)) throw new Error('Orgo returned an unexpected workspace response.');
  const result: Machine[] = [];
  for (const item of data.workspaces) {
    const workspace = object(item);
    if (!Array.isArray(workspace.desktops)) throw new Error('Orgo returned an unexpected computer list.');
    for (const item of workspace.desktops) {
      const m = object(item);
      if (typeof m.id !== 'string' || !UUID.test(m.id) || m.status === 'deleted') continue;
      result.push({ id: m.id, name: label(m.name, 'Computer'), workspace: label(workspace.name, 'Workspace'), status: label(m.status, 'unknown'), os: label(m.os, 'linux'), cpu: number(m.cpu), ram: number(m.ram), canManage: object(m.permissions).canWrite === true && object(workspace.permissions).canWrite === true });
      if (result.length > 1000) throw new Error('Account exceeds the 1,000 computer display limit.');
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export function allowedActions(m: Machine): Action[] {
  if (!m.canManage) return [];
  if (m.status === 'running') return m.os === 'linux' ? ['restart', 'suspend', 'stop'] : m.os === 'windows' ? ['restart', 'stop'] : ['restart'];
  if (m.status === 'suspended') return ['resume'];
  if (['frozen', 'stopped', 'error'].includes(m.status)) return ['start'];
  return [];
}
export class OrgoClient {
  constructor(private key: () => Promise<string> = readCredential, private transport: typeof fetch = fetch) {}
  async request(path: string, method = 'GET', body?: object): Promise<Record<string, unknown>> {
    const key = await this.key();
    if (!key) throw new Error('Connect your Orgo account first.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await this.transport(`${API}${path}`, { method, redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const reader = res.body?.getReader();
      let text = ''; let bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2_000_000) { await reader.cancel(); throw new Error('Orgo response exceeded the size limit.'); }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
      }
      if (!res.ok) {
        const messages: Record<number, string> = { 401: 'Orgo rejected the API key. Reconnect your account.', 402: 'Orgo requires an active subscription or credit for this action.', 403: 'Your Orgo key does not permit this action.', 404: 'Orgo computer or operation not found.', 409: 'Orgo is already changing this computer. Refresh and wait for it to finish.', 429: 'Orgo rate limit reached. Wait a moment and refresh.' };
        throw new Error(messages[res.status] ?? `Orgo request failed (HTTP ${res.status}).`);
      }
      try { return object(JSON.parse(text || '{}')); } catch { throw new Error('Orgo returned an invalid JSON response.'); }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Orgo timed out. Refresh before retrying an action.');
      if (error instanceof TypeError) throw new Error('Cannot reach Orgo. Check your internet connection.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  async list(): Promise<Snapshot> {
    if (!await this.key()) return { configured: false, machines: [], checkedAt: Date.now() };
    return { configured: true, machines: parseMachines(await this.request('/workspaces')), checkedAt: Date.now() };
  }
  async ssh(id: string) {
    if (!UUID.test(id)) throw new Error('Invalid computer ID.');
    const s = await this.request(`/computers/${id}/ssh`);
    if (s.enabled !== true) return { enabled: false, command: null };
    if (typeof s.ipv4_host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(s.ipv4_host) || typeof s.ipv4_port !== 'number' || !Number.isInteger(s.ipv4_port) || s.ipv4_port < 1 || s.ipv4_port > 65535) throw new Error('Orgo has not assigned a usable SSH endpoint yet.');
    return { enabled: true, command: `ssh -p ${s.ipv4_port} root@${s.ipv4_host}` };
  }
  async action(id: string, action: Action) {
    if (!UUID.test(id) || !['start', 'stop', 'restart', 'suspend', 'resume'].includes(action)) throw new Error('Invalid computer action.');
    const m = (await this.list()).machines.find(m => m.id === id);
    if (!m || !allowedActions(m).includes(action)) throw new Error('Action unavailable for the computer’s current status or permissions.');
    const result = await this.request(`/computers/${id}/${action}`, 'POST', ['start', 'stop'].includes(action) ? { async: true } : undefined);
    return { accepted: true, operationId: typeof result.operation_id === 'string' && UUID.test(result.operation_id) ? result.operation_id : null };
  }
  async operation(id: string, operationId: string) {
    if (!UUID.test(id) || !UUID.test(operationId)) throw new Error('Invalid operation ID.');
    const result = await this.request(`/computers/${id}/operations/${operationId}`);
    return { status: label(result.status, 'unknown') };
  }
}
export default function plugin(zcc: ZccPluginApi) {
  const client = new OrgoClient(); const busy = new Set<string>();
  const connections = new Connections(client, zcc.storage.kv);
  let machines: Machine[] = [];
  zcc.onDispose(() => connections.dispose());
  zcc.rpc.method('list', async () => { const result = await client.list(); machines = result.machines; return result; });
  zcc.rpc.method('connections', () => connections.status(machines));
  zcc.rpc.method('connect', a => connections.start(String(object(a).id ?? '')));
  zcc.rpc.method('ssh', a => client.ssh(String(object(a).id ?? '')));
  zcc.rpc.method('operation', a => client.operation(String(object(a).id ?? ''), String(object(a).operationId ?? '')));
  zcc.rpc.method('action', async args => {
    const a = object(args); const id = String(a.id ?? '');
    if (busy.has(id) || busy.size >= 4) throw new Error('An action is already running. Wait for it to finish.');
    busy.add(id);
    try { return await client.action(id, String(a.action ?? '') as Action); } finally { busy.delete(id); }
  });
  zcc.cli.register({ name: 'orgo-machines', summary: 'List Orgo computers and their current SSH details', commands: [ { name: 'list', summary: 'List computers', usage: 'zcc orgo-machines list' }, { name: 'ssh', summary: 'Show SSH endpoint', usage: 'zcc orgo-machines ssh <computer-id>' } ], async run(argv) {
    try {
      if (argv[0] === 'list') return { exitCode: 0, stdout: JSON.stringify(await client.list(), null, 2) };
      if (argv[0] === 'ssh' && argv[1]) return { exitCode: 0, stdout: JSON.stringify(await client.ssh(argv[1]), null, 2) };
      return { exitCode: 2, stderr: 'Usage: orgo-machines list | ssh <computer-id>' };
    } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : 'Orgo request failed.' }; }
  } });
}
