// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@zana-ai/zcc-plugin-sdk/testing/app';
const app = await loadPluginApp(() => import('./app.tsx'), 'orgo-machines-6758');
const id = '11111111-1111-4111-8111-111111111111';
const machine = { id, name: 'Coding', workspace: 'Personal', status: 'running', os: 'linux', cpu: 2, ram: 8, canManage: true };
const snapshot = (machines = [machine]) => ({ configured: true, machines, checkedAt: Date.now() });
function render(rpc: Record<string, (...args: any[]) => any>) { const slot = renderSlot(app.navPanels[0]!, { pluginId: 'orgo-machines-6758', subPath: '' }, { rpc: { connections: () => ({}), ...rpc } }); return { ...screen, inspection: slot.inspection, unmount: () => slot.lifecycle.unmount() }; }
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('machine panel', () => {
  it('shows live computers, specs, SSH and filtering', async () => {
    const slot = render({ list: () => snapshot(), ssh: () => ({ enabled: true, command: 'ssh -p 22357 root@203.0.113.10' }) });
    await slot.findByText('Coding'); expect(slot.getByText('linux · 2 vCPU · 8 GB RAM')).toBeTruthy();
    fireEvent.click(slot.getByRole('button', { name: 'SSH details' })); await slot.findByText('ssh -p 22357 root@203.0.113.10');
    fireEvent.change(slot.getByRole('textbox', { name: 'Filter computers' }), { target: { value: 'missing' } }); await slot.findByText('No matching computers');
    fireEvent.change(slot.getByRole('textbox', { name: 'Filter computers' }), { target: { value: 'Personal' } }); await slot.findByText('Coding');
  });
  it('shows empty and unconfigured accounts', async () => {
    let value = snapshot([]); const slot = render({ list: () => value }); await slot.findByText('No computers yet');
    value = { ...value, configured: false }; fireEvent.click(slot.getByRole('button', { name: 'Refresh' })); await slot.findByText('Connect your Orgo account');
  });
  it('shows read-only machines without lifecycle controls', async () => {
    const slot = render({ list: () => snapshot([{ ...machine, canManage: false, ram: null, cpu: null } as never]) });
    await slot.findByText('View only'); expect(slot.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('requires confirmation for restart and supports cancelling', async () => {
    const action = vi.fn(() => ({ operationId: null })); const slot = render({ list: () => snapshot(), action }); await slot.findByText('Coding');
    fireEvent.click(slot.getByRole('button', { name: 'Restart' })); await slot.findByRole('group', { name: 'Restart Coding?' }); expect(action).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole('button', { name: 'Cancel' })); expect(slot.queryByRole('group')).toBeNull();
    fireEvent.click(slot.getByRole('button', { name: 'Restart' })); fireEvent.click(slot.getByRole('button', { name: 'Restart computer' }));
    await slot.findByText('Restart requested for Coding.'); expect(action).toHaveBeenCalledWith({ id, action: 'restart' });
  });
  it('starts a frozen computer without a disruptive-action confirmation', async () => {
    const action = vi.fn(() => ({ operationId: null })); const slot = render({ list: () => snapshot([{ ...machine, status: 'frozen', os: 'windows' }]), action });
    await slot.findByText('Coding'); fireEvent.click(slot.getByRole('button', { name: 'Start' })); await slot.findByText('Start requested for Coding.'); expect(action).toHaveBeenCalled();
  });
  it('shows resume for suspended and only restart for macOS', async () => {
    const slot = render({ list: () => snapshot([{ ...machine, status: 'suspended' }, { ...machine, id: 'other', name: 'Mac', os: 'macos' }]) });
    await slot.findByText('Mac'); expect(slot.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(slot.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('surfaces API, SSH and power-action failures', async () => {
    let fail = true; const slot = render({ list: () => { if (fail) throw new Error('Offline'); return snapshot(); }, ssh: () => { throw new Error('No SSH'); }, action: () => { throw new Error('Denied'); } });
    await slot.findByRole('alert'); fail = false; fireEvent.click(slot.getByRole('button', { name: 'Refresh' })); await slot.findByText('Coding');
    fireEvent.click(slot.getByRole('button', { name: 'SSH details' })); await slot.findByText('No SSH');
    fireEvent.click(slot.getByRole('button', { name: 'Stop' })); fireEvent.click(slot.getByRole('button', { name: 'Stop computer' })); await slot.findByText('Denied');
  });
  it('explains when SSH is disabled and when suspend disconnects', async () => {
    const slot = render({ list: () => snapshot(), ssh: () => ({ enabled: false, command: null }) }); await slot.findByText('Coding');
    fireEvent.click(slot.getByRole('button', { name: 'SSH details' })); await slot.findByText('Enable SSH in this computer’s Orgo settings.');
    fireEvent.click(slot.getByRole('button', { name: 'Suspend' })); await slot.findByText('The computer pauses and SSH disconnects until it resumes.');
  });
  it.each(['succeeded', 'failed', 'needs_review'])('polls asynchronous operations until %s', async status => {
    const operation = vi.fn(() => ({ status })); const slot = render({ list: () => snapshot(), action: () => ({ operationId: 'operation' }), operation });
    await slot.findByText('Coding'); vi.useFakeTimers(); await act(async () => { fireEvent.click(slot.getByRole('button', { name: 'Stop' })); }); await act(async () => { fireEvent.click(slot.getByRole('button', { name: 'Stop computer' })); }); expect(slot.getByText('Changing…')).toBeTruthy();
     await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(operation).toHaveBeenCalledWith({ id, operationId: 'operation' });
    expect(slot.getAllByRole('status').map(e => e.textContent).join(' ')).toContain(status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted');
    slot.unmount();
  });
  it('surfaces operation polling errors and keeps refreshing while mounted', async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => snapshot()); const slot = render({ list, action: () => ({ operationId: 'operation' }), operation: () => { throw new Error('Poll failed'); } });
    await act(async () => {}); expect(slot.getByText('Coding')).toBeTruthy(); await act(async () => { fireEvent.click(slot.getByRole('button', { name: 'Stop' })); }); await act(async () => { fireEvent.click(slot.getByRole('button', { name: 'Stop computer' })); }); expect(slot.getByText('Changing…')).toBeTruthy();
     await act(async () => { await vi.advanceTimersByTimeAsync(3100); }); expect(slot.getByRole('alert').textContent).toContain('Poll failed');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(list.mock.calls.length).toBeGreaterThan(2);
    slot.unmount(); const calls = list.mock.calls.length; await vi.advanceTimersByTimeAsync(16000); expect(list.mock.calls.length).toBe(calls);
  });
});

describe('direct Zana pairing', () => {
  it('connects from the card, polls progress, and offers reconnection', async () => {
    vi.useFakeTimers(); let status = { status: 'disconnected', message: 'Not connected to Zana' }; const connect = vi.fn(() => { status = { status: 'connecting', message: 'Preparing SSH…' }; return status; });
    const slot = render({ list: () => snapshot(), connections: () => ({ [id]: status }), connect });
    await act(async () => {}); await act(async () => { fireEvent.click(slot.getByRole('button', { name: 'Connect to Zana' })); });
    expect(connect).toHaveBeenCalledWith({ id }); expect(slot.getByRole('button', { name: 'Connecting…' })).toHaveProperty('disabled', true);
    status = { status: 'connected', message: 'Connected to Zana' }; await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(slot.getByText('Connected to Zana')).toBeTruthy(); expect(slot.getByRole('button', { name: 'Reconnect to Zana' })).toBeTruthy(); slot.unmount();
  });
  it('shows connection errors and disables pairing for stopped computers', async () => {
    let stopped = false; const slot = render({ list: () => snapshot([{ ...machine, status: stopped ? 'frozen' : 'running' }]), connect: () => { throw new Error('Connection unavailable'); } });
    await slot.findByText('Coding'); fireEvent.click(slot.getByRole('button', { name: 'Connect to Zana' })); await slot.findByText('Connection unavailable');
    stopped = true; fireEvent.click(slot.getByRole('button', { name: 'Refresh' })); await slot.findByRole('button', { name: 'Start' }); expect(slot.getByRole('button', { name: 'Connect to Zana' })).toHaveProperty('disabled', true);
  });
  it('reports polling errors and cleans up on unmount', async () => {
    vi.useFakeTimers(); let fail = false;
    const connections = vi.fn(() => { if (fail) throw new Error('Status unavailable'); return { [id]: { status: 'connecting', message: 'Pairing with Zana…' } }; });
    const slot = render({ list: () => snapshot(), connections }); await act(async () => {}); fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); }); expect(slot.getByRole('alert').textContent).toContain('Status unavailable');
    slot.unmount(); const calls = connections.mock.calls.length; await vi.advanceTimersByTimeAsync(2100); expect(connections.mock.calls.length).toBe(calls);
  });
});
