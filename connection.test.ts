// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const sandbox = vi.hoisted(() => ({ root: `/tmp/zcc-orgo-tests-${Math.random().toString(36).slice(2)}` }));
vi.mock('node:os', async () => ({ ...await vi.importActual('node:os'), homedir: () => sandbox.root }));
import { Connections, ZanaClient, addKeyCommand, ensureIdentity, generateIdentity, localServerUrl, parseSshEntries, registerSsh, withSshLock } from './connection.ts';
import type { Store } from './connection.ts';
import type { OrgoClient, Machine } from './server.ts';
const id = '11111111-1111-4111-8111-111111111111';
const hostId = '22222222-2222-4222-8222-222222222222';
const machine: Machine = { id, name: 'Coding', workspace: 'Personal', status: 'running', os: 'linux', cpu: 2, ram: 8, canManage: true };
const ssh = join(sandbox.root, '.ssh');
const json = (v: unknown) => new Response(JSON.stringify(v));
const endpoint = { enabled: true, ipv4_host: '203.0.113.10', ipv4_port: 22357 };
const publicKey = generateIdentity().publicKey;
const hosts = [{ id: hostId, sshHost: 'orgo-zana', status: 'connected' }];
function setup() {
  const values = new Map<string, unknown>();
  const store: Store = { get: async <T>(key: string) => values.get(key) as T | undefined, set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }) };
  const orgo = { list: vi.fn(async () => ({ machines: [machine] })), request: vi.fn(async (path: string, _method?: string, _body?: unknown): Promise<any> => path.endsWith('/bash') ? { exit_code: 0 } : endpoint) };
  const zana = { hosts: vi.fn(async () => hosts), connect: vi.fn(async (_alias: string, _signal: AbortSignal, progress: (message: string) => void) => { progress('Zana install: passed'); return hostId; }) };
  const identity = vi.fn(async () => publicKey); const register = vi.fn(async () => 'orgo-zana');
  const connection = new Connections(orgo as unknown as OrgoClient, store, zana as unknown as ZanaClient, identity, register);
  return { connection, orgo, store, values, zana, identity, register };
}
beforeEach(async () => { await rm(sandbox.root, { force: true, recursive: true }); await mkdir(ssh, { recursive: true }); });
afterAll(async () => { await rm(sandbox.root, { force: true, recursive: true }); });

describe('SSH identity and configuration', () => {
  it('generates an identity accepted by OpenSSH and reuses its private file', async () => {
    const pub = await ensureIdentity(); const privatePath = join(ssh, 'id_ed25519_orgo_zana');
    expect(execFileSync('/usr/bin/ssh-keygen', ['-y', '-f', privatePath], { encoding: 'utf8' }).trim().split(' ').slice(0, 2)).toEqual(pub.split(' ').slice(0, 2));
    const before = await readFile(privatePath, 'utf8'); expect(await ensureIdentity()).toBe(pub); expect(await readFile(privatePath, 'utf8')).toBe(before);
    expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
    await writeFile(privatePath + '.pub', 'bad'); await expect(ensureIdentity()).rejects.toThrow('valid public key');
  });
  it('preserves user config, adopts the enrolled alias and refreshes its endpoint atomically', async () => {
    const original = 'Host orgo-zana\n HostName 203.0.113.10\n Port 22357\nHost *\n ServerAliveInterval 15\n';
    await writeFile(join(ssh, 'config'), original);
    const alias = await registerSsh(id, '203.0.113.10', 22357, hosts); expect(alias).toBe('orgo-zana');
    await registerSsh(id, '203.0.113.11', 22358, hosts, { alias, hostId });
    const managed = await readFile(join(ssh, 'zana-orgo-hosts.conf'), 'utf8'); expect(managed.match(/# BEGIN/g)).toHaveLength(1); expect(managed).toContain('Port 22358');
    const config = await readFile(join(ssh, 'config'), 'utf8'); expect(config).toContain(original); expect(config.match(/Include/g)).toHaveLength(1);
    expect((await stat(join(ssh, 'config'))).mode & 0o777).toBe(0o600);
    const probe = join(sandbox.root, 'probe-config'); await writeFile(probe, config.replace('~/.ssh/zana-orgo-hosts.conf', join(ssh, 'zana-orgo-hosts.conf')));
    const effective = execFileSync('/usr/bin/ssh', ['-G', '-F', probe, alias], { encoding: 'utf8' }); expect(effective).toContain('hostname 203.0.113.11\n'); expect(effective).toContain('port 22358\n');
  });
  it('adds deterministic aliases without a prior config and rejects injected fields', async () => {
    expect(await registerSsh(id, 'host.example', 22, [])).toBe(`orgo-${id}`);
    expect(parseSshEntries('Host *\n User root\nHost alias\n HostName box\n Port 2022\n')).toEqual([{ alias: 'alias', host: 'box', port: 2022 }]);
    for (const [ident, host, port] of [['bad', 'host', 22], [id, '-oProxyCommand=bad', 22], [id, 'host', 0]] as const) await expect(registerSsh(ident, host, port, [])).rejects.toThrow('Invalid');
    await expect(registerSsh(id, 'host', 22, [], { alias: 'a\nHost bad', hostId })).rejects.toThrow('alias');
  });
  it('serializes updates, refuses competing locks and unsafe files', async () => {
    const order: number[] = []; await Promise.all([withSshLock(async () => { order.push(1); await Promise.resolve(); order.push(2); }), withSshLock(async () => { order.push(3); })]); expect(order).toEqual([1, 2, 3]);
    await writeFile(join(ssh, '.zana-orgo.lock'), ''); await expect(ensureIdentity()).rejects.toThrow('already running'); await rm(join(ssh, '.zana-orgo.lock'));
    await symlink('/etc/passwd', join(ssh, 'config')); await expect(registerSsh(id, 'host', 22, [])).rejects.toThrow('Unsafe');
    await rm(join(ssh, 'config')); await writeFile(join(ssh, 'config'), 'x'.repeat(1_000_001)); await expect(registerSsh(id, 'host', 22, [])).rejects.toThrow('Unsafe');
    await rm(ssh, { recursive: true }); await symlink('/tmp', ssh); await expect(ensureIdentity()).rejects.toThrow('Unsafe SSH directory');
  });
  it('adds public keys idempotently without replacing existing keys', async () => {
    const original = 'restrict ssh-rsa existing-user-key user\n'; await writeFile(join(ssh, 'authorized_keys'), original);
    const command = addKeyCommand(publicKey).replaceAll('/root/.ssh', ssh);
    expect(execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' })).toContain('zana-key-ready');
    execFileSync('/bin/bash', ['-c', command]);
    const keys = await readFile(join(ssh, 'authorized_keys'), 'utf8'); expect(keys).toContain(original); expect(keys.split(publicKey)).toHaveLength(2);
    expect(addKeyCommand(publicKey)).toContain('authorized_keys'); expect(addKeyCommand(publicKey)).toContain('fcntl');
    expect(() => addKeyCommand('ssh-ed25519 bad\ncommand')).toThrow('Invalid');
  });
});

describe('main-authorized Zana transport', () => {
  it('only permits a local origin with no embedded credentials', () => {
    expect(localServerUrl('http://localhost:8781')).toBe('http://localhost:8781'); expect(localServerUrl('http://[::1]:8780')).toContain('[::1]');
    for (const url of ['https://evil.test', 'http://remote.test', 'http://user@localhost', 'http://localhost/a', 'http://localhost/?token=x', 'http://localhost/#x']) expect(() => localServerUrl(url)).toThrow();
  });
  it('validates host responses, bounds bodies and refuses HTTP errors', async () => {
    const transport = vi.fn(async (_url: any, _init?: any) => json([...hosts, { id: 'bad' }])); const zana = new ZanaClient(transport); expect(await zana.hosts()).toEqual(hosts);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    for (const value of [json({}), new Response('not-json')]) { transport.mockResolvedValue(value); await expect(zana.hosts()).rejects.toThrow(); }
    transport.mockResolvedValue(new Response('{}', { status: 403 })); await expect(zana.request('/api/v1/hosts')).rejects.toThrow('HTTP 403');
    transport.mockResolvedValue(new Response('x'.repeat(2_000_001))); await expect(zana.request('/api/v1/hosts')).rejects.toThrow('size limit');
    transport.mockResolvedValue(new Response(null)); await expect(zana.request('/api/v1/hosts')).rejects.toThrow('Empty');
  });
  it('consumes large streamed enrollment output, exposes only safe stages and a host ID', async () => {
    const rows = [JSON.stringify({ type: 'log', text: 'private-token=' + 'x'.repeat(20000) }), JSON.stringify({ type: 'stage', stage: 'install', status: 'passed', pairingCommand: 'private' }), JSON.stringify({ type: 'stage', stage: 'secret', status: 'passed' }), JSON.stringify({ type: 'done', hostId })];
    const bytes = new TextEncoder().encode(rows.join('\n'));
    const stream = new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 777) controller.enqueue(bytes.slice(offset, offset + 777)); controller.close(); } });
    const transport = vi.fn(async (_url: any, _init?: any) => new Response(stream)); const progress = vi.fn();
    expect(await new ZanaClient(transport).connect('orgo-zana', new AbortController().signal, progress)).toBe(hostId); expect(progress).toHaveBeenCalledExactlyOnceWith('Zana install: passed');
    expect(transport.mock.calls[0]?.[1].body).toBe('{"ssh":{"host":"orgo-zana"}}');
  });
  it.each(['', 'bad secret', '{}', 'null', '{"type":"log","text":"private"}', '{"type":"done","hostId":"bad"}', '{"type":"error","message":"secret","pairingCommand":"secret"}'])('fails closed on incomplete or failed enrollment %s', async body => {
    await expect(new ZanaClient(async () => new Response(body)).connect('orgo-zana', new AbortController().signal, () => {})).rejects.not.toThrow('secret');
  });
});

describe('connection orchestration', () => {
  it('prepares SSH, uses the existing enrollment and persists only its mapping', async () => {
    const s = setup(); expect(await s.connection.start(id)).toMatchObject({ status: 'connecting' }); await s.connection.settled();
    expect(s.register).toHaveBeenCalledWith(id, endpoint.ipv4_host, endpoint.ipv4_port, hosts, undefined);
    expect(s.store.set).toHaveBeenCalledWith(`machine:${id}`, { hostId, alias: 'orgo-zana' });
    expect((await s.connection.status([machine]))[id]).toEqual({ hostId, status: 'connected', message: 'Connected to Zana' });
    s.zana.hosts.mockResolvedValue([]); expect((await s.connection.status([machine]))[id]?.status).toBe('disconnected');
    expect(s.orgo.request.mock.calls.some(call => call[0].endsWith('/bash'))).toBe(true); expect(JSON.stringify(s.values)).not.toContain('privateKey');
  });
  it('refuses invalid IDs, stopped platforms and missing permissions before changing anything', async () => {
    const s = setup(); await expect(s.connection.start('bad')).rejects.toThrow('Invalid');
    for (const m of [{ ...machine, status: 'frozen' }, { ...machine, os: 'windows' }, { ...machine, canManage: false }]) { s.orgo.list.mockResolvedValue({ machines: [m] }); await expect(s.connection.start(id)).rejects.toThrow('running Linux'); }
    s.orgo.list.mockResolvedValue({ machines: [] }); await expect(s.connection.start(id)).rejects.toThrow('running Linux'); expect(s.identity).not.toHaveBeenCalled();
  });
  it('enables SSH only when there are no existing keys, and reports required restarts', async () => {
    const s = setup(); s.orgo.request.mockResolvedValueOnce({ enabled: false, authorized_key_set: true }); await s.connection.start(id); await s.connection.settled();
    expect(s.connection.states.get(id)?.message).toContain('preserve those keys'); expect(s.orgo.request).toHaveBeenCalledTimes(1);
    s.orgo.request.mockResolvedValueOnce({ enabled: false }).mockResolvedValueOnce({ pending: true }); await s.connection.start(id); await s.connection.settled(); expect(s.connection.states.get(id)?.message).toContain('Restart');
    s.orgo.request.mockResolvedValueOnce({ enabled: false }).mockResolvedValueOnce({ enabled: true }); await s.connection.start(id); await s.connection.settled(); expect(s.connection.states.get(id)?.status).toBe('connected');
    expect(s.orgo.request).toHaveBeenCalledWith(`/computers/${id}/ssh`, 'POST', { public_key: publicKey });
  });
  it('handles remote command failures, disabled SSH and pairing errors without losing the mapping', async () => {
    const s = setup(); s.values.set(`machine:${id}`, { hostId, alias: 'orgo-zana' });
    s.orgo.request.mockResolvedValueOnce(endpoint).mockResolvedValueOnce({ exit_code: 1, output: 'private' }); await s.connection.start(id); await s.connection.settled(); expect(s.connection.states.get(id)?.message).toContain('Existing keys');
    expect((await s.connection.status([machine]))[id]?.status).toBe('error');
    s.orgo.request.mockResolvedValueOnce(endpoint).mockResolvedValueOnce({ exit_code: 0 }).mockResolvedValueOnce({ enabled: false }); await s.connection.start(id); await s.connection.settled(); expect(s.connection.states.get(id)?.message).toContain('not ready');
    s.zana.connect.mockRejectedValue(new Error('Pairing failed')); await s.connection.start(id); await s.connection.settled(); expect(s.connection.states.get(id)?.message).toBe('Pairing failed'); expect(s.values.get(`machine:${id}`)).toEqual({ hostId, alias: 'orgo-zana' });
  });
  it('keeps only one enrollment active and aborts it on dispose', async () => {
    const s = setup(); s.zana.connect.mockImplementation((_alias, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    await s.connection.start(id); await vi.waitFor(() => expect(s.zana.connect).toHaveBeenCalled());
    await expect(s.connection.start(id)).rejects.toThrow('already connecting'); expect((await s.connection.status([machine]))[id]?.status).toBe('connecting');
    s.connection.dispose(); await s.connection.settled(); expect(s.connection.states.get(id)?.message).toContain('reloaded'); await expect(s.connection.start(id)).rejects.toThrow('Invalid');
  });
  it('cancels before mutations if disposed while the identity loads', async () => {
    const s = setup(); let ready!: (v: string) => void; s.identity.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    await s.connection.start(id); s.connection.dispose(); ready(publicKey); await s.connection.settled(); expect(s.orgo.request).not.toHaveBeenCalled();
  });
  it('bounds diagnostic state and returns disconnected for unpaired computers', async () => {
    const s = setup(); for (let i = 0; i < 1005; i++) s.connection.states.set(String(i), { status: 'error', message: 'old' });
    expect((await s.connection.status([machine]))[id]?.status).toBe('disconnected'); await s.connection.start(id); await s.connection.settled(); expect(s.connection.states.size).toBeLessThanOrEqual(1000);
  });
});
