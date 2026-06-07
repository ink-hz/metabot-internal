import { parseArgs, print } from '@xvirobotics/cli-core';

interface BridgeConfig {
  url: string;
  token: string;
}

function loadBridgeConfig(): BridgeConfig {
  const port = process.env.API_PORT || '9100';
  const url = (process.env.METABOT_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const token = process.env.API_SECRET || 'changeme';
  return { url, token };
}

async function bridgeRequest<T = unknown>(
  cfg: BridgeConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + path, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave raw */ }
  }
  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : String(parsed);
    throw new Error(`bridge ${method} ${path} -> ${res.status}: ${msg}`);
  }
  return parsed as T;
}

function usage(): string {
  return `metabot teams — MetaBot Agent Teams

Subcommands:
  list
  create <team> [--description <text>]
  delete <team>
  status <team>
  bind <team> <chatId> [--display]
  start <team>
  stop <team>

  agents list <team>
  agents spawn <team> <name> [--role <role>] [--engine claude|codex|kimi] [--prompt <text>]
  agents stop <team> <name>
  agents delete <team> <name>

  send <team> <to> <message> [--from <name>] [--summary <text>]
  inbox <team> <name> [--unread] [--read]

  tasks list <team>
  tasks create <team> <subject> [--description <text>] [--owner <name>]
  tasks get <team> <id>
  tasks update <team> <id> [--status pending|in_progress|completed|deleted] [--owner <name>] [--result <text>]

  runs list <team>
  runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
  runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
  runs output <team> <runId>
  runs stop <team> <runId>
`;
}

export async function run(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    print(usage());
    return;
  }

  const cfg = loadBridgeConfig();
  const rest = argv.slice(1);
  if (cmd === 'list') {
    print(await bridgeRequest(cfg, 'GET', '/api/agent-teams'));
    return;
  }
  if (cmd === 'create') {
    const { positional, flags } = parseArgs(rest);
    const name = positional[0];
    if (!name) throw new Error('metabot teams create: <team> required');
    print(await bridgeRequest(cfg, 'POST', '/api/agent-teams', {
      name,
      description: typeof flags.description === 'string' ? flags.description : undefined,
    }));
    return;
  }
  if (cmd === 'delete') {
    const team = rest[0];
    if (!team) throw new Error('metabot teams delete: <team> required');
    print(await bridgeRequest(cfg, 'DELETE', `/api/agent-teams/${encodeURIComponent(team)}`));
    return;
  }
  if (cmd === 'status') {
    const team = rest[0];
    if (!team) throw new Error('metabot teams status: <team> required');
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}`));
    return;
  }
  if (cmd === 'bind') {
    const { positional, flags } = parseArgs(rest);
    const [team, chatId] = positional;
    if (!team || !chatId) throw new Error('metabot teams bind: <team> <chatId> required');
    const current = await bridgeRequest<{ team?: { chatIds?: string[]; displayChatIds?: string[] } }>(
      cfg,
      'GET',
      `/api/agent-teams/${encodeURIComponent(team)}`,
    );
    const existingChatIds = current.team?.chatIds ?? [];
    const existingDisplayChatIds = current.team?.displayChatIds ?? [];
    const key = flags.display === true || flags.display === 'true' ? 'displayChatIds' : 'chatIds';
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}`, {
      chatIds: key === 'chatIds' ? unique([...existingChatIds, chatId]) : existingChatIds,
      displayChatIds: key === 'displayChatIds' ? unique([...existingDisplayChatIds, chatId]) : existingDisplayChatIds,
    }));
    return;
  }
  if (cmd === 'start' || cmd === 'stop') {
    const team = rest[0];
    if (!team) throw new Error(`metabot teams ${cmd}: <team> required`);
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/${cmd}`));
    return;
  }
  if (cmd === 'agents') {
    await runAgents(cfg, rest);
    return;
  }
  if (cmd === 'send') {
    await runSend(cfg, rest);
    return;
  }
  if (cmd === 'inbox') {
    await runInbox(cfg, rest);
    return;
  }
  if (cmd === 'tasks') {
    await runTasks(cfg, rest);
    return;
  }
  if (cmd === 'runs') {
    await runRuns(cfg, rest);
    return;
  }
  throw new Error(`metabot teams: unknown subcommand '${cmd}'`);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

async function runAgents(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'list') {
    const team = rest[0];
    if (!team) throw new Error('metabot teams agents list: <team> required');
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/agents`));
    return;
  }
  if (sub === 'spawn') {
    const { positional, flags } = parseArgs(rest);
    const [team, name] = positional;
    if (!team || !name) throw new Error('metabot teams agents spawn: <team> <name> required');
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/agents`, {
      name,
      role: typeof flags.role === 'string' ? flags.role : undefined,
      engine: typeof flags.engine === 'string' ? flags.engine : undefined,
      prompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
    }));
    return;
  }
  if (sub === 'stop') {
    const [team, name] = rest;
    if (!team || !name) throw new Error('metabot teams agents stop: <team> <name> required');
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/agents/${encodeURIComponent(name)}/stop`));
    return;
  }
  if (sub === 'delete' || sub === 'remove') {
    const [team, name] = rest;
    if (!team || !name) throw new Error(`metabot teams agents ${sub}: <team> <name> required`);
    print(await bridgeRequest(cfg, 'DELETE', `/api/agent-teams/${encodeURIComponent(team)}/agents/${encodeURIComponent(name)}`));
    return;
  }
  throw new Error('metabot teams agents: expected list|spawn|stop|delete');
}

async function runSend(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team, to, ...messageParts] = positional;
  const message = messageParts.join(' ');
  if (!team || !to || !message) throw new Error('metabot teams send: <team> <to> <message> required');
  print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/messages`, {
    toName: to,
    body: message,
    fromName: typeof flags.from === 'string' ? flags.from : undefined,
    summary: typeof flags.summary === 'string' ? flags.summary : undefined,
  }));
}

async function runInbox(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team, name] = positional;
  if (!team || !name) throw new Error('metabot teams inbox: <team> <name> required');
  const unread = flags.unread === true || flags.unread === 'true';
  const inbox = await bridgeRequest<Record<string, unknown>>(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/messages?to=${encodeURIComponent(name)}${unread ? '&unread=1' : ''}`);
  if (flags.read === true || flags.read === 'true') {
    const read = await bridgeRequest<{ read?: number }>(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/messages/read?to=${encodeURIComponent(name)}`, {});
    inbox.read = read.read ?? 0;
  }
  print(inbox);
}

async function runTasks(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'list') {
    const team = rest[0];
    if (!team) throw new Error('metabot teams tasks list: <team> required');
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/tasks`));
    return;
  }
  if (sub === 'create') {
    const { positional, flags } = parseArgs(rest);
    const [team, ...subjectParts] = positional;
    const subject = subjectParts.join(' ');
    if (!team || !subject) throw new Error('metabot teams tasks create: <team> <subject> required');
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/tasks`, {
      subject,
      description: typeof flags.description === 'string' ? flags.description : undefined,
      owner: typeof flags.owner === 'string' ? flags.owner : undefined,
    }));
    return;
  }
  if (sub === 'get') {
    const [team, id] = rest;
    if (!team || !id) throw new Error('metabot teams tasks get: <team> <id> required');
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`));
    return;
  }
  if (sub === 'update') {
    const { positional, flags } = parseArgs(rest);
    const [team, id] = positional;
    if (!team || !id) throw new Error('metabot teams tasks update: <team> <id> required');
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`, {
      status: typeof flags.status === 'string' ? flags.status : undefined,
      owner: typeof flags.owner === 'string' ? flags.owner : undefined,
      result: typeof flags.result === 'string' ? flags.result : undefined,
    }));
    return;
  }
  throw new Error('metabot teams tasks: expected list|create|get|update');
}

async function runRuns(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { positional, flags } = parseArgs(rest);
  const [team, id] = positional;
  if (!team) throw new Error('metabot teams runs: <team> required');
  if (sub === 'list') {
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/runs`));
    return;
  }
  if (sub === 'create') {
    const taskId = typeof flags['task-id'] === 'string' ? Number(flags['task-id']) : undefined;
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/runs`, {
      agentName: typeof flags.agent === 'string' ? flags.agent : undefined,
      taskId: Number.isFinite(taskId) ? taskId : undefined,
      status: typeof flags.status === 'string' ? flags.status : undefined,
      output: typeof flags.output === 'string' ? flags.output : undefined,
      error: typeof flags.error === 'string' ? flags.error : undefined,
    }));
    return;
  }
  if (!id) throw new Error(`metabot teams runs ${sub}: <team> <runId> required`);
  if (sub === 'update') {
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/runs/${encodeURIComponent(id)}`, {
      status: typeof flags.status === 'string' ? flags.status : undefined,
      output: typeof flags.output === 'string' ? flags.output : undefined,
      error: typeof flags.error === 'string' ? flags.error : undefined,
    }));
    return;
  }
  if (sub === 'output') {
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/runs/${encodeURIComponent(id)}/output`));
    return;
  }
  if (sub === 'stop') {
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/runs/${encodeURIComponent(id)}/stop`));
    return;
  }
  throw new Error('metabot teams runs: expected list|create|update|output|stop');
}
