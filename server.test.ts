// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@zana-ai/zcc-plugin-sdk/testing';
import { readFile } from 'node:fs/promises';
import plugin, { allowedActions, OrgoClient, parseMachines, readCredential } from './server.ts';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
const op = '11111111-1111-4111-8111-111111111111';
const raw = (status = 'running', canWrite = true) => ({ workspaces: [{ name: 'Personal', permissions: { canWrite }, desktops: [{ id, name: 'Coding', status, os: 'linux', cpu: 2, ram: 8, permissions: { canWrite }, vnc_password: 'never-expose' }] }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const key = async () => 'sk_live_test';
const client = (transport = vi.fn(async () => response(raw()))) => new OrgoClient(key, transport as typeof fetch);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('safe account data', () => {
  it('only returns public display fields, sorts and ignores deleted/malformed entries', () => {
    const input = raw(); input.workspaces[0]!.desktops.push({ ...input.workspaces[0]!.desktops[0]!, id: op, name: 'Alpha' });
    input.workspaces[0]!.desktops.push({ ...input.workspaces[0]!.desktops[0]!, id: 'bad' }, { ...input.workspaces[0]!.desktops[0]!, status: 'deleted' });
    const result = parseMachines(input); expect(result.map(x => x.name)).toEqual(['Alpha', 'Coding']);
    expect(JSON.stringify(result)).not.toContain('never-expose');
  });
  it('rejects unexpected schemas and oversized accounts', () => {
    for (const input of [null, [], {}, { workspaces: [{}] }]) expect(() => parseMachines(input)).toThrow();
    const input = raw(); input.workspaces[0]!.desktops = Array(1001).fill(input.workspaces[0]!.desktops[0]);
    expect(() => parseMachines(input)).toThrow('limit');
  });
  it('uses safe defaults and treats missing permissions as view only', () => {
    const input = { workspaces: [{ desktops: [{ id }] }] }; const m = parseMachines(input)[0]!;
    expect(m).toMatchObject({ name: 'Computer', workspace: 'Workspace', cpu: null, ram: null, canManage: false });
    const m2 = parseMachines({ workspaces: [{ desktops: [{ id, ram: Infinity, cpu: '2' }] }] })[0]!;
    expect(m2.cpu).toBeNull(); expect(m2.ram).toBeNull();
  });
  it('handles permissions, platform and lifecycle states', () => {
    const m = parseMachines(raw())[0]!;
    expect(allowedActions(m)).toEqual(['restart', 'suspend', 'stop']);
    expect(allowedActions({ ...m, os: 'windows' })).toEqual(['restart', 'stop']);
    expect(allowedActions({ ...m, os: 'macos' })).toEqual(['restart']);
    expect(allowedActions({ ...m, canManage: false })).toEqual([]);
    expect(allowedActions({ ...m, status: 'suspended' })).toEqual(['resume']);
    for (const status of ['frozen', 'stopped', 'error']) expect(allowedActions({ ...m, status })).toEqual(['start']);
    expect(allowedActions({ ...m, status: 'creating' })).toEqual([]);
  });
});

describe('credentials', () => {
  it('reads a private file without returning credentials in account data', async () => {
    vi.mocked(readFile).mockResolvedValue(' sk_live_local\n'); expect(await readCredential()).toBe('sk_live_local');
  });
  it('falls back to the environment only if no file exists', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }));
    vi.stubEnv('ORGO_API_KEY', 'sk_live_env'); expect(await readCredential()).toBe('sk_live_env');
    vi.stubEnv('ORGO_API_KEY', undefined); expect(await readCredential()).toBe('');
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('private'), { code: 'EACCES' })); await expect(readCredential()).rejects.toThrow('Cannot read');
  });
});

describe('API client', () => {
  it('handles unconfigured accounts without a network call', async () => {
    const network = vi.fn(); const c = new OrgoClient(async () => '', network);
    expect(await c.list()).toMatchObject({ configured: false, machines: [] }); expect(network).not.toHaveBeenCalled();
    await expect(c.request('/workspaces')).rejects.toThrow('Connect');
  });
  it('uses only the official origin, bearer header and rejects redirects', async () => {
    const network = vi.fn(async () => response(raw())); const c = client(network);
    expect((await c.list()).machines).toHaveLength(1);
    expect(network).toHaveBeenCalledWith('https://www.orgo.ai/api/workspaces', expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer sk_live_test' } }));
  });
  it.each([401, 402, 403, 404, 409, 429, 500])('redacts error response contents for HTTP %s', async status => {
    await expect(client(vi.fn(async () => response({ error: 'secret-response' }, status))).list()).rejects.not.toThrow('secret-response');
  });
  it('rejects malformed JSON, network failures and oversized responses', async () => {
    await expect(client(vi.fn(async () => new Response('not-json'))).list()).rejects.toThrow('invalid JSON');
    await expect(client(vi.fn(async () => { throw new TypeError('private-network-details'); })).list()).rejects.toThrow('Cannot reach');
    await expect(client(vi.fn(async () => new Response('x'.repeat(2_000_001)))).list()).rejects.toThrow('size limit');
    expect(await client(vi.fn(async () => new Response(null))).request('/workspaces')).toEqual({});
  });
  it('aborts slow responses', async () => {
    vi.useFakeTimers();
    const c = client(vi.fn((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as never);
    const request = expect(c.list()).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(30_001); await request; vi.useRealTimers();
  });
  it('returns fresh SSH endpoints, checks enabled and validates all fields', async () => {
    const network = vi.fn(async () => response({ enabled: true, ipv4_host: '203.0.113.10', ipv4_port: 22357 })); const c = client(network);
    expect(await c.ssh(id)).toEqual({ enabled: true, command: 'ssh -p 22357 root@203.0.113.10' });
    network.mockResolvedValue(response({ enabled: false, ssh_command: 'old' })); expect(await c.ssh(id)).toEqual({ enabled: false, command: null });
    for (const values of [{ enabled: true }, { enabled: true, ipv4_host: '-o bad', ipv4_port: 22 }, { enabled: true, ipv4_host: 'host', ipv4_port: 70000 }]) {
      network.mockResolvedValue(response(values)); await expect(c.ssh(id)).rejects.toThrow('usable SSH');
    }
    await expect(c.ssh('../../escape')).rejects.toThrow('Invalid');
  });
  it('revalidates status and permissions before posting, and handles operation IDs', async () => {
    const network = vi.fn().mockResolvedValueOnce(response(raw())).mockResolvedValueOnce(response({ operation_id: op }));
    const c = client(network); expect(await c.action(id, 'stop')).toEqual({ accepted: true, operationId: op });
    expect(network.mock.calls[1]).toEqual([`https://www.orgo.ai/api/computers/${id}/stop`, expect.objectContaining({ method: 'POST', body: '{"async":true}' })]);
    network.mockResolvedValueOnce(response(raw())).mockResolvedValueOnce(response({})); expect(await c.action(id, 'restart')).toMatchObject({ operationId: null });
    network.mockResolvedValue(response(raw('creating'))); await expect(c.action(id, 'stop')).rejects.toThrow('unavailable');
    network.mockResolvedValue(response(raw('running', false))); await expect(c.action(id, 'stop')).rejects.toThrow('unavailable');
    await expect(c.action('bad', 'stop')).rejects.toThrow('Invalid'); await expect(c.action(id, 'delete' as never)).rejects.toThrow('Invalid');
  });
  it('sanitizes operation results', async () => {
    const c = client(vi.fn(async () => response({ status: 'succeeded', result: 'private' })));
    expect(await c.operation(id, op)).toEqual({ status: 'succeeded' });
    await expect(c.operation(id, 'bad')).rejects.toThrow('Invalid');
  });
});

describe('SDK wiring', () => {
  it('registers RPC and a read-only CLI, and releases per-machine locks after errors', async () => {
    vi.mocked(readFile).mockResolvedValue('sk_live_test');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(String(url).includes('/api/v1/hosts') ? [] : raw())));
    const { zcc, harness } = createFakePluginHost({ pluginId: 'orgo-machines-6758' }); plugin(zcc);
    expect(await harness.callRpc('list')).toMatchObject({ configured: true });
    expect(await harness.callRpc('connections')).toMatchObject({ [id]: { status: 'disconnected' } });
    await expect(harness.callRpc('connect', null)).rejects.toThrow('Invalid');
    expect((await harness.runCli(['list'])).stdout).toContain('Coding');
    expect((await harness.runCli(['bad'])).exitCode).toBe(2);
    expect((await harness.runCli(['ssh', 'bad'])).exitCode).toBe(1);
    await expect(harness.callRpc('action', { id, action: 'delete' })).rejects.toThrow('Invalid');
    await expect(harness.callRpc('action', { id, action: 'delete' })).rejects.toThrow('Invalid');
    await expect(harness.callRpc('ssh', null)).rejects.toThrow('Invalid');
    await expect(harness.callRpc('operation', {})).rejects.toThrow('Invalid');
  });
});
