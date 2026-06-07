import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { BotRegistry } from '../src/api/bot-registry.js';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';
import { AgentTeamSupervisor } from '../src/agent-teams/team-supervisor.js';

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'metabot-agent-team-supervisor-'));
  return new AgentTeamStore(logger, join(dir, 'teams.db'));
}

function makeRegistry(executeApiTask: any, stopChatTask = vi.fn(), sendAgentActivityCard = vi.fn()) {
  const setSessionEngine = vi.fn();
  const setSessionId = vi.fn();
  const bridge = {
    getSessionManager: () => ({ setSessionEngine, setSessionId }),
    executeApiTask,
    stopChatTask,
    sendAgentActivityCard,
  };
  const registry = new BotRegistry();
  registry.register({
    name: 'metabot',
    platform: 'feishu',
    bridge,
    sender: {},
    config: {
      name: 'metabot',
      engine: 'codex',
      claude: { defaultWorkingDirectory: process.cwd() },
    },
  } as any);
  return { registry, bridge, setSessionEngine, setSessionId, stopChatTask, sendAgentActivityCard };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe('AgentTeamSupervisor', () => {
  it('recovers stale running runs left by a previous bridge process', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    const task = store.createTask('demo', { subject: 'Interrupted task', owner: 'worker', blockedBy: [99] });
    store.updateTask('demo', task.id, { status: 'in_progress' });
    const run = store.createRun('demo', { agentName: 'worker', taskId: task.id });
    store.setAgentStatus('demo', 'worker', 'working');

    const { registry } = makeRegistry(vi.fn());
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });
    supervisor.start();

    await waitFor(() => {
      expect(store.getRun('demo', run.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Bridge restarted'),
      });
    });
    expect(store.getTask('demo', task.id)).toMatchObject({
      status: 'pending',
      result: expect.stringContaining(run.id),
    });
    expect(store.getAgent('demo', 'worker')).toMatchObject({ status: 'idle' });
    expect(store.listMessages('demo', 'lead', false)[0]).toMatchObject({
      fromName: 'worker',
      summary: expect.stringContaining('Recovered stale run'),
    });
    supervisor.destroy();
    store.close();
  });

  it('runs a member in an independent team chat session and reports to lead', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'kimi', role: 'Worker' });
    store.createTask('demo', { subject: 'Inspect supervisor', owner: 'worker' });
    store.sendMessage('demo', { fromName: 'lead', toName: 'worker', body: 'Please inspect task 1' });

    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => ({
      success: true,
      responseText: `done from ${chatId}`,
      sessionId: `session-${chatId}`,
    }));
    const { registry, setSessionEngine } = makeRegistry(executeApiTask);

    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });
    await supervisor.tick();

    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'team:demo:worker',
        userId: 'agent-team-supervisor',
        sendCards: false,
      }));
    });
    expect(setSessionEngine).toHaveBeenCalledWith('team:demo:worker', 'kimi');
    expect(store.listTasks('demo')[0]).toMatchObject({ status: 'completed', result: 'done from team:demo:worker' });
    expect(store.getAgent('demo', 'worker')).toMatchObject({ sessionId: 'session-team:demo:worker' });
    expect(store.listMessages('demo', 'worker', true)).toHaveLength(0);

    await waitFor(() => {
      expect(store.listMessages('demo', 'lead', true)).toHaveLength(1);
    });

    await supervisor.tick();
    expect(executeApiTask).not.toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'team:demo:lead',
    }));

    const runs = store.listRuns('demo');
    expect(runs.some((run) => run.agentName === 'worker' && run.status === 'completed')).toBe(true);
    expect(runs.some((run) => run.agentName === 'lead')).toBe(false);
    supervisor.destroy();
    store.close();
  });

  it('sends an agent activity card to display chats when a member finishes', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Notify task', owner: 'worker' });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: 'member report',
      sessionId: 'sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(sendAgentActivityCard).toHaveBeenCalledWith(
        'oc_main',
        expect.stringContaining('demo / worker'),
      );
    });
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('member report');
    expect(sendAgentActivityCard.mock.calls[0][1]).not.toContain('Completed run');
    supervisor.destroy();
    store.close();
  });

  it('sends lead inbox messages as activity when the team has no lead agent member', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.sendMessage('demo', {
      fromName: 'worker',
      toName: 'lead',
      summary: 'member finished',
      body: 'Worker final report',
    });

    const executeApiTask = vi.fn(async () => ({
      success: true,
      responseText: '长沙当前多云，约 28°C。',
      sessionId: 'sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    expect(executeApiTask).not.toHaveBeenCalled();
    expect(sendAgentActivityCard).toHaveBeenCalledWith(
      'oc_main',
      expect.stringContaining('demo / lead'),
    );
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('Worker final report');
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    expect(store.listRuns('demo').some((run) => run.agentName === 'lead')).toBe(false);
    supervisor.destroy();
    store.close();
  });

  it('runs lead as a normal nested member when the team defines one', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'lead', engine: 'codex' });
    store.sendMessage('demo', {
      fromName: 'worker',
      toName: 'lead',
      summary: 'member finished',
      body: 'Worker final report',
    });

    const executeApiTask = vi.fn(async ({ chatId }: { chatId: string }) => ({
      success: true,
      responseText: `lead reply from ${chatId}`,
      sessionId: 'lead-sid',
    }));
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
        chatId: 'team:demo:lead',
      }));
    });
    expect(sendAgentActivityCard).toHaveBeenCalledWith(
      'oc_main',
      expect.stringContaining('demo / lead'),
    );
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('lead reply from team:demo:lead');
    expect(store.listRuns('demo').some((run) => run.agentName === 'lead' && run.status === 'completed')).toBe(true);
    supervisor.destroy();
    store.close();
  });

  it('uses the member lead message as the agent activity body when one was sent during the run', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo', { displayChatIds: ['oc_main'] });
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Weather', owner: 'worker' });

    const executeApiTask = vi.fn(async () => {
      store.sendMessage('demo', {
        fromName: 'worker',
        toName: 'lead',
        summary: 'weather report',
        body: '北京当前多云，约 26°C。',
      });
      return {
        success: true,
        responseText: 'No files edited. Completed task and sent message #1.',
        sessionId: 'sid',
      };
    });
    const sendAgentActivityCard = vi.fn();
    const { registry } = makeRegistry(executeApiTask, vi.fn(), sendAgentActivityCard);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(sendAgentActivityCard).toHaveBeenCalledWith(
        'oc_main',
        expect.stringContaining('demo / lead'),
      );
    });
    expect(sendAgentActivityCard.mock.calls[0][1]).toContain('北京当前多云，约 26°C。');
    expect(sendAgentActivityCard.mock.calls[0][1]).not.toContain('No files edited');
    expect(store.listMessages('demo', 'lead').filter((message) => message.fromName === 'worker')).toHaveLength(1);
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    supervisor.destroy();
    store.close();
  });

  it('persists heartbeat output while a member run is still running', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Long task', owner: 'worker' });

    let resolveRun!: () => void;
    const executeApiTask = vi.fn(async ({ onUpdate }: any) => {
      onUpdate?.({ status: 'running', userPrompt: 'p', responseText: 'hello', toolCalls: [] }, 'msg', false);
      onUpdate?.({ status: 'running', userPrompt: 'p', responseText: 'hello world', toolCalls: [] }, 'msg', false);
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      return { success: true, responseText: 'final output', sessionId: 'sid' };
    });
    const { registry } = makeRegistry(executeApiTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running', output: 'hello world' });
    });

    resolveRun();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'completed', output: 'final output' });
    });
    supervisor.destroy();
    store.close();
  });

  it('requeues assigned tasks when a member run fails or crashes', async () => {
    const failedStore = makeStore();
    failedStore.createTeam('demo', 'Demo');
    failedStore.createAgent('demo', { name: 'worker', engine: 'codex' });
    failedStore.createTask('demo', { subject: 'Fail task', owner: 'worker' });
    const failed = makeRegistry(vi.fn(async () => ({ success: false, responseText: 'bad output', error: 'boom' })));
    const failedSupervisor = new AgentTeamSupervisor({ registry: failed.registry, store: failedStore, logger, intervalMs: 60_000 });
    await failedSupervisor.tick();
    await waitFor(() => {
      expect(failedStore.listRuns('demo')[0]).toMatchObject({ status: 'failed', error: 'boom' });
      expect(failedStore.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('boom') });
    });
    failedSupervisor.destroy();
    failedStore.close();

    const crashedStore = makeStore();
    crashedStore.createTeam('demo', 'Demo');
    crashedStore.createAgent('demo', { name: 'worker', engine: 'codex' });
    crashedStore.createTask('demo', { subject: 'Crash task', owner: 'worker' });
    const crashed = makeRegistry(vi.fn(async () => { throw new Error('crash'); }));
    const crashedSupervisor = new AgentTeamSupervisor({ registry: crashed.registry, store: crashedStore, logger, intervalMs: 60_000 });
    await crashedSupervisor.tick();
    await waitFor(() => {
      expect(crashedStore.listRuns('demo')[0]).toMatchObject({ status: 'failed', error: 'crash' });
      expect(crashedStore.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('crash') });
    });
    crashedSupervisor.destroy();
    crashedStore.close();
  });

  it('stops in-flight runs and suppresses late executor results', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Stop task', owner: 'worker' });

    let resolveRun!: () => void;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((resolve) => { resolveRun = resolve; });
      return { success: true, responseText: 'late success', sessionId: 'sid' };
    });
    const stopChatTask = vi.fn();
    const { registry } = makeRegistry(executeApiTask, stopChatTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running' });
    });
    const run = store.listRuns('demo')[0];
    supervisor.stopRun('demo', run.id);
    expect(stopChatTask).toHaveBeenCalledWith('team:demo:worker');
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('Stopped run') });

    resolveRun();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getRun('demo', run.id)?.output).not.toBe('late success');
    supervisor.destroy();
    store.close();
  });

  it('suppresses crash notice when an intentionally stopped run rejects', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Stop reject task', owner: 'worker' });

    let rejectRun!: (err: Error) => void;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((_resolve, reject) => { rejectRun = reject; });
      return { success: true, responseText: 'unreachable', sessionId: 'sid' };
    });
    const stopChatTask = vi.fn();
    const { registry } = makeRegistry(executeApiTask, stopChatTask);
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running' });
    });
    const run = store.listRuns('demo')[0];
    supervisor.stopRun('demo', run.id);
    rejectRun(new Error('Task was stopped'));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    expect(store.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('Stopped run') });
    supervisor.destroy();
    store.close();
  });

  it('does not report a crash to lead when a stopped run aborts with an error', async () => {
    const store = makeStore();
    store.createTeam('demo', 'Demo');
    store.createAgent('demo', { name: 'worker', engine: 'codex' });
    store.createTask('demo', { subject: 'Abort task', owner: 'worker' });

    let rejectRun!: (err: Error) => void;
    const executeApiTask = vi.fn(async () => {
      await new Promise<void>((_resolve, reject) => { rejectRun = reject; });
      return { success: true, responseText: 'unreachable', sessionId: 'sid' };
    });
    const { registry } = makeRegistry(executeApiTask, vi.fn());
    const supervisor = new AgentTeamSupervisor({ registry, store, logger, intervalMs: 60_000 });

    await supervisor.tick();
    await waitFor(() => {
      expect(store.listRuns('demo')[0]).toMatchObject({ status: 'running' });
    });
    const run = store.listRuns('demo')[0];
    supervisor.stopRun('demo', run.id);
    rejectRun(new Error('aborted by stop'));

    await waitFor(() => {
      expect(store.getAgent('demo', 'worker')).toMatchObject({ status: 'idle' });
    });
    expect(store.getRun('demo', run.id)).toMatchObject({ status: 'stopped' });
    expect(store.getTask('demo', 1)).toMatchObject({ status: 'pending', result: expect.stringContaining('Stopped run') });
    expect(store.listMessages('demo', 'lead', true)).toHaveLength(0);
    supervisor.destroy();
    store.close();
  });
});
