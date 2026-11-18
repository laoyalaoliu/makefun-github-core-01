// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at /mcp, modern (2026-07-28) era —
// server/discover answers identity, capabilities and supported versions in one round trip, and
// every later request is a plain POST answered with one JSON object. The six github-mcp-server
// tools operate on the same forge state as REST and GraphQL, so ids agree across surfaces.

import {
  VIEWER_LOGIN,
  forge,
  mergePullRequest,
  type Issue,
  type PullRequest,
  type Repo,
} from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

// ------------------------------------------------------------------ tool execution

interface ToolOutcome {
  result?: Record<string, unknown>;
  rpcError?: { code: number; message: string };
}

function toolResult(payload: Record<string, unknown>): ToolOutcome {
  return {
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    },
  };
}

function toolFailure(message: string): ToolOutcome {
  return {
    result: {
      content: [{ type: 'text', text: message }],
      isError: true,
    },
  };
}

function invalidParams(message: string): ToolOutcome {
  return { rpcError: { code: -32602, message } };
}

function repoArg(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return forge.getRepo(owner, repo);
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return invalidParams(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return invalidParams(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const created = forge.createRepo(String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      if (created === null) return toolFailure(`A repository named ${String(args.name)} already exists`);
      return toolResult(repoJson(created));
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      const now = forge.now();
      const issue: Issue = {
        kind: 'issue',
        number: repo.nextNumber,
        id: forge.nextItemId(),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.items.set(issue.number, issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.items.values()]
        .filter((item): item is Issue => item.kind === 'issue' && (state === 'all' || item.state === state))
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return toolResult({ issues, total_count: issues.length });
    }
    case 'get_issue': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      const item = repo.items.get(Number(args.issue_number));
      if (item === undefined || item.kind !== 'issue') return toolFailure('Issue not found');
      return toolResult(issueJson(repo, item));
    }
    case 'list_pull_requests': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.items.values()]
        .filter((item): item is PullRequest => item.kind === 'pull' && (state === 'all' || item.state === state))
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullJson(repo, pull));
      return toolResult({ pull_requests: pulls, total_count: pulls.length });
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (repo.branchTip(base) === null) return toolFailure(`The base branch "${base}" does not exist`);
      if (repo.branchTip(head) === null) return toolFailure(`The head branch "${head}" does not exist`);
      const now = forge.now();
      const pull: PullRequest = {
        kind: 'pull',
        number: repo.nextNumber,
        id: forge.nextItemId(),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.items.set(pull.number, pull);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return toolFailure('Repository not found');
      const item = repo.items.get(Number(args.pull_number));
      if (item === undefined || item.kind !== 'pull') return toolFailure('Pull request not found');
      const outcome = mergePullRequest(repo, item, 'squash');
      if (!outcome.ok) return toolFailure(outcome.message);
      return toolResult({ ...pullJson(repo, item), sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return invalidParams(`Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------------ JSON-RPC handling

export interface McpResult {
  status: number;
  json?: unknown;
}

/** Handle one POST /mcp body. Auth is enforced by the caller (app.ts). */
export function handleMcp(rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleOne(entry)).filter((entry) => entry !== null);
    return { status: 200, json: responses };
  }
  const response = handleOne(parsed);
  if (response === null) return { status: 202 };
  return { status: 200, json: response };
}

function handleOne(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = entry as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (id === undefined) return null; // a notification: no answer
  const args = (params !== null && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS[0],
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      };
    case 'initialize': {
      const requested = typeof args.protocolVersion === 'string' ? args.protocolVersion : SUPPORTED_VERSIONS[1];
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1];
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: negotiated, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const toolName = typeof args.name === 'string' ? args.name : '';
      const toolArgs = (args.arguments !== null && typeof args.arguments === 'object' ? args.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(toolName, toolArgs);
      if (outcome.rpcError !== undefined) {
        return { jsonrpc: '2.0', id, error: outcome.rpcError };
      }
      return { jsonrpc: '2.0', id, result: outcome.result };
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}
