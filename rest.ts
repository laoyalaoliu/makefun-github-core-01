// The REST v3 surface: /api/v3 root and meta, the token's user, repositories, contents, git refs,
// branches, commits, labels, issues, comments and pull requests. Every answer is JSON; errors are
// JSON with a string message; the caller (app.ts) adds the X-GitHub-Request-Id header.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commitFileChange,
  diffCommits,
  forge,
  listCommits,
  mergePullRequest,
  type Issue,
  type IssueOrPull,
  type PullRequest,
  type Repo,
} from './forge.ts';
import { ZERO_OID, buildCommit, buildTreeFromFiles, flattenTree, mergeBase, parseCommit, parseTree } from './gitstore.ts';

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const NOT_FOUND: RestResult = { status: 404, json: { message: 'Not Found' } };

function fail(status: number, message: string): RestResult {
  return { status, json: { message } };
}

interface JsonBody {
  ok: boolean;
  value: Record<string, unknown>;
}

function parseBody(raw: Buffer): JsonBody {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false, value: {} };
  } catch {
    return { ok: false, value: {} };
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ------------------------------------------------------------------ object shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  const openCount = [...repo.items.values()].filter((item) => item.state === 'open').length;
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://forge.invalid/${repo.fullName}`,
    clone_url: `https://forge.invalid/${repo.fullName}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openCount,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? ZERO_OID;
  const baseSha = repo.branchTip(pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

function itemJson(repo: Repo, item: IssueOrPull): Record<string, unknown> {
  if (item.kind === 'issue') return issueJson(repo, item);
  return { ...pullJson(repo, item), pull_request: { url: `https://forge.invalid/${repo.fullName}/pull/${item.number}` } };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.store.get(sha);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: '', email: '', date: repo.createdAt };
    return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      author: person(info?.author ?? ''),
      committer: person(info?.committer ?? ''),
      tree: { sha: info?.tree ?? ZERO_OID },
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page, path: string, host: string): RestResult {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const headers: Record<string, string> = {};
  if (start + page.perPage < items.length) {
    const next = `http://${host}${path}?per_page=${page.perPage}&page=${page.page + 1}`;
    const lastPage = Math.ceil(items.length / page.perPage);
    const last = `http://${host}${path}?per_page=${page.perPage}&page=${lastPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { status: 200, json: slice, headers };
}

// ------------------------------------------------------------------ router

export function restRoute(
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  rawBody: Buffer,
  host: string,
  rawPath: string,
): RestResult {
  // segments[0] === 'api', segments[1] === 'v3' (checked by the caller).
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      json: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (rest[0] === 'user') return userRoute(method, rest.slice(1), query, rawBody, host, rawPath);
  if (rest[0] === 'repos' && rest.length >= 3) {
    const repo = forge.getRepo(rest[1], rest[2]);
    if (repo === null) return NOT_FOUND;
    if (rest.length === 3) {
      if (method === 'GET') return { status: 200, json: repoJson(repo) };
      if (method === 'PATCH') {
        const body = parseBody(rawBody);
        if (!body.ok) return fail(400, 'Malformed JSON in request body');
        const description = str(body.value.description);
        if (description !== null) repo.description = description;
        if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
        const defaultBranch = str(body.value.default_branch);
        if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
        const newName = str(body.value.name);
        if (newName !== null && newName !== '' && newName !== repo.name) {
          if (forge.getRepo(repo.owner, newName) !== null) {
            return fail(422, 'Repository creation failed: name already exists on this account');
          }
          forge.deleteRepo(repo.owner, repo.name);
          repo.name = newName;
          forge.repos.set(repo.fullName, repo);
        }
        return { status: 200, json: repoJson(repo) };
      }
      if (method === 'DELETE') {
        forge.deleteRepo(rest[1], rest[2]);
        return { status: 204 };
      }
      return NOT_FOUND;
    }
    return repoRoute(repo, method, rest.slice(3), query, rawBody, host, rawPath);
  }
  return NOT_FOUND;
}

function userRoute(
  method: string,
  parts: readonly string[],
  query: URLSearchParams,
  rawBody: Buffer,
  host: string,
  rawPath: string,
): RestResult {
  if (parts.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      json: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' },
    };
  }
  if (parts[0] === 'repos' && parts.length === 1) {
    if (method === 'GET') {
      const page = pageOf(query);
      const all = forge.listRepos().map(repoJson);
      return paginate(all, page, rawPath, host);
    }
    if (method === 'POST') {
      const body = parseBody(rawBody);
      if (!body.ok) return fail(400, 'Malformed JSON in request body');
      const name = str(body.value.name);
      if (name === null || name === '') return fail(422, 'Repository creation failed: name is required');
      const created = forge.createRepo(name, body.value.private === true, str(body.value.description) ?? '');
      if (created === null) {
        return fail(422, 'Repository creation failed: name already exists on this account');
      }
      if (body.value.auto_init === true) {
        const readme = Buffer.from(`# ${name}\n`, 'utf8');
        const blob = created.store.put('blob', readme);
        const tree = buildTreeFromFiles(created.store, new Map([['README.md', blob]]));
        const ident = forge.ident();
        const commit = created.store.put(
          'commit',
          buildCommit({ tree, parents: [], author: ident, committer: ident, message: 'Initial commit\n' }),
        );
        created.refs.set(created.headRef(), commit);
      }
      return { status: 201, json: repoJson(created) };
    }
  }
  return NOT_FOUND;
}

function repoRoute(
  repo: Repo,
  method: string,
  parts: readonly string[],
  query: URLSearchParams,
  rawBody: Buffer,
  host: string,
  rawPath: string,
): RestResult {
  const head = parts[0];
  if (head === 'contents') return contentsRoute(repo, method, parts.slice(1).join('/'), query, rawBody);
  if (head === 'git' && parts[1] === 'refs') return gitRefsRoute(repo, method, parts.slice(2).join('/'), rawBody);
  if (head === 'branches') return branchesRoute(repo, method, parts.slice(1).join('/'), query, host, rawPath);
  if (head === 'commits') return commitsRoute(repo, method, parts.slice(1).join('/'), query, host, rawPath);
  if (head === 'labels') return labelsRoute(repo, method, parts.slice(1), rawBody);
  if (head === 'issues') return issuesRoute(repo, method, parts.slice(1), query, rawBody, host, rawPath);
  if (head === 'pulls') return pullsRoute(repo, method, parts.slice(1), query, rawBody, host, rawPath);
  return NOT_FOUND;
}

// ------------------------------------------------------------------ contents

function contentsRoute(repo: Repo, method: string, path: string, query: URLSearchParams, rawBody: Buffer): RestResult {
  if (method === 'GET') {
    const refParam = query.get('ref') ?? query.get('branch') ?? repo.defaultBranch;
    const tip = repo.resolveCommit(refParam);
    if (tip === null) return NOT_FOUND;
    const commit = repo.store.get(tip);
    if (commit === undefined || commit.type !== 'commit') return NOT_FOUND;
    const rootTree = parseCommit(commit.data).tree;
    if (path === '') {
      return { status: 200, json: dirListing(repo, rootTree, '') };
    }
    // Walk to the target.
    let treeOid = rootTree;
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.store.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return NOT_FOUND;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return NOT_FOUND;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          return { status: 200, json: dirListing(repo, entry.oid, path) };
        }
        const blob = repo.store.get(entry.oid);
        if (blob === undefined) return NOT_FOUND;
        return {
          status: 200,
          json: {
            type: 'file',
            name: segments[i],
            path,
            sha: entry.oid,
            size: blob.data.length,
            encoding: 'base64',
            content: blob.data.toString('base64'),
          },
        };
      }
      if (entry.mode !== '40000') return NOT_FOUND;
      treeOid = entry.oid;
    }
    return NOT_FOUND;
  }
  if (method === 'PUT' || method === 'DELETE') {
    const body = parseBody(rawBody);
    if (!body.ok) return fail(400, 'Malformed JSON in request body');
    const message = str(body.value.message);
    if (message === null || message === '') return fail(422, 'A commit message is required');
    const branch = str(body.value.branch) ?? repo.defaultBranch;
    const tip = repo.branchTip(branch) ?? repo.branchTip(repo.defaultBranch);
    const files = repo.filesOf(tip);
    const existing = files.get(path);
    const givenSha = str(body.value.sha);
    if (method === 'PUT') {
      const content = str(body.value.content);
      if (content === null) return fail(422, 'Content is required');
      if (existing !== undefined && givenSha !== existing) {
        return fail(409, 'The sha supplied does not match the current blob sha');
      }
      if (existing === undefined && givenSha !== null && givenSha !== '') {
        return fail(409, 'The sha supplied does not match the current blob sha');
      }
      const blobOid = repo.store.put('blob', Buffer.from(content, 'base64'));
      const outcome = commitFileChange(repo, branch, path, blobOid, message);
      const blob = repo.store.get(blobOid)!;
      return {
        status: existing === undefined ? 201 : 200,
        json: {
          content: {
            type: 'file',
            name: path.split('/').pop(),
            path,
            sha: blobOid,
            size: blob.data.length,
            encoding: 'base64',
            content: blob.data.toString('base64'),
          },
          commit: { sha: outcome.commitSha },
        },
      };
    }
    // DELETE
    if (existing === undefined) return NOT_FOUND;
    if (givenSha !== existing) return fail(409, 'The sha supplied does not match the current blob sha');
    const outcome = commitFileChange(repo, branch, path, null, message);
    return { status: 200, json: { content: null, commit: { sha: outcome.commitSha } } };
  }
  return NOT_FOUND;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
  }));
}

// ------------------------------------------------------------------ git refs and branches

function gitRefsRoute(repo: Repo, method: string, refPath: string, rawBody: Buffer): RestResult {
  if (method === 'POST' && refPath === '') {
    const body = parseBody(rawBody);
    if (!body.ok) return fail(400, 'Malformed JSON in request body');
    const ref = str(body.value.ref);
    const sha = str(body.value.sha);
    if (ref === null || sha === null) return fail(422, 'A ref and a sha are required');
    const object = repo.store.get(sha);
    if (object === undefined) return fail(422, 'The sha does not name an object in this repository');
    repo.refs.set(ref, sha);
    return { status: 201, json: { ref, object: { sha, type: object.type } } };
  }
  if (method === 'GET' && refPath === '') {
    return {
      status: 200,
      json: [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } })),
    };
  }
  const fullRef = `refs/${refPath}`;
  if (method === 'GET') {
    const sha = repo.refs.get(fullRef);
    if (sha === undefined) return NOT_FOUND;
    return { status: 200, json: { ref: fullRef, object: { sha, type: repo.store.get(sha)?.type ?? 'commit' } } };
  }
  if (method === 'DELETE') {
    if (!repo.refs.delete(fullRef)) return NOT_FOUND;
    return { status: 204 };
  }
  return NOT_FOUND;
}

function branchesRoute(repo: Repo, method: string, name: string, query: URLSearchParams, host: string, rawPath: string): RestResult {
  if (method !== 'GET') return NOT_FOUND;
  if (name === '') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
    branches.sort((a, b) => (a.name < b.name ? -1 : 1));
    return paginate(branches, pageOf(query), rawPath, host);
  }
  const sha = repo.branchTip(name);
  if (sha === null) return NOT_FOUND;
  return { status: 200, json: { name, commit: { sha } } };
}

function commitsRoute(repo: Repo, method: string, shaPart: string, query: URLSearchParams, host: string, rawPath: string): RestResult {
  if (method !== 'GET') return NOT_FOUND;
  if (shaPart !== '') {
    if (!repo.store.has(shaPart)) return NOT_FOUND;
    return { status: 200, json: commitJson(repo, shaPart) };
  }
  const start = query.get('sha') ?? repo.defaultBranch;
  const tip = repo.resolveCommit(start);
  if (tip === null) return { status: 200, json: [] };
  const all = listCommits(repo, tip).map((sha) => commitJson(repo, sha));
  return paginate(all, pageOf(query), rawPath, host);
}

// ------------------------------------------------------------------ labels

function labelsRoute(repo: Repo, method: string, parts: readonly string[], rawBody: Buffer): RestResult {
  if (method === 'GET' && parts.length === 0) {
    return { status: 200, json: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
  }
  if (method === 'POST' && parts.length === 0) {
    const body = parseBody(rawBody);
    if (!body.ok) return fail(400, 'Malformed JSON in request body');
    const name = str(body.value.name);
    if (name === null || name === '') return fail(422, 'A label name is required');
    if (repo.labels.has(name)) return fail(422, 'Validation Failed: the label already exists');
    const label = { name, color: str(body.value.color) ?? 'ededed' };
    repo.labels.set(name, label);
    return { status: 201, json: { name: label.name, color: label.color } };
  }
  if (method === 'GET' && parts.length === 1) {
    const label = repo.labels.get(parts[0]);
    if (label === undefined) return NOT_FOUND;
    return { status: 200, json: { name: label.name, color: label.color } };
  }
  return NOT_FOUND;
}

// ------------------------------------------------------------------ issues and comments

function labelNamesOf(repo: Repo, value: unknown): { labels: { name: string; color: string }[] } | { error: RestResult } {
  if (value === undefined || value === null) return { labels: [] };
  if (!Array.isArray(value)) return { error: fail(422, 'Labels must be an array') };
  const labels: { name: string; color: string }[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : str((entry as Record<string, unknown>)?.name);
    if (name === null) return { error: fail(422, 'Labels must be names') };
    const label = repo.labels.get(name);
    if (label === undefined) return { error: fail(422, `Label "${name}" does not exist in this repository`) };
    labels.push(label);
  }
  return { labels };
}

function issuesRoute(
  repo: Repo,
  method: string,
  parts: readonly string[],
  query: URLSearchParams,
  rawBody: Buffer,
  host: string,
  rawPath: string,
): RestResult {
  if (parts.length === 0) {
    if (method === 'POST') {
      const body = parseBody(rawBody);
      if (!body.ok) return fail(400, 'Malformed JSON in request body');
      const title = str(body.value.title);
      if (title === null || title === '') return fail(422, 'A title is required');
      const resolved = labelNamesOf(repo, body.value.labels);
      if ('error' in resolved) return resolved.error;
      const now = forge.now();
      const issue: Issue = {
        kind: 'issue',
        number: repo.nextNumber,
        id: forge.nextItemId(),
        title,
        body: str(body.value.body) ?? '',
        state: 'open',
        labels: resolved.labels,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.items.set(issue.number, issue);
      return { status: 201, json: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let items = [...repo.items.values()];
      if (state === 'open' || state === 'closed') items = items.filter((item) => item.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(query);
      return paginate(items.map((item) => itemJson(repo, item)), page, rawPath, host);
    }
    return NOT_FOUND;
  }
  const number = parseInt(parts[0], 10);
  if (!Number.isInteger(number)) return NOT_FOUND;
  const item = repo.items.get(number);
  if (parts.length === 1) {
    if (item === undefined) return NOT_FOUND;
    if (method === 'GET') return { status: 200, json: itemJson(repo, item) };
    if (method === 'PATCH') {
      const body = parseBody(rawBody);
      if (!body.ok) return fail(400, 'Malformed JSON in request body');
      const state = str(body.value.state);
      if (state === 'open' || state === 'closed') item.state = state;
      if (item.kind === 'issue') {
        const title = str(body.value.title);
        if (title !== null) item.title = title;
        const text = str(body.value.body);
        if (text !== null) item.body = text;
        if (body.value.labels !== undefined) {
          const resolved = labelNamesOf(repo, body.value.labels);
          if ('error' in resolved) return resolved.error;
          item.labels = resolved.labels;
        }
        item.updatedAt = forge.now();
      } else {
        item.updatedAt = forge.now();
      }
      return { status: 200, json: itemJson(repo, item) };
    }
    return NOT_FOUND;
  }
  if (parts[1] === 'comments' && parts.length === 2) {
    if (item === undefined) return NOT_FOUND;
    const holder: { comments: Issue['comments'] } = item.kind === 'issue' ? item : { comments: pullComments(item) };
    if (method === 'GET') {
      return { status: 200, json: holder.comments.map(commentJson) };
    }
    if (method === 'POST') {
      const body = parseBody(rawBody);
      if (!body.ok) return fail(400, 'Malformed JSON in request body');
      const text = str(body.value.body);
      if (text === null) return fail(422, 'A comment body is required');
      const comment = { id: forge.nextCommentId(), body: text, author: VIEWER_LOGIN, createdAt: forge.now() };
      if (item.kind === 'issue') item.comments.push(comment);
      else pullComments(item).push(comment);
      return { status: 201, json: commentJson(comment) };
    }
  }
  return NOT_FOUND;
}

const pullCommentStore = new WeakMap<PullRequest, Issue['comments']>();

function pullComments(pull: PullRequest): Issue['comments'] {
  let comments = pullCommentStore.get(pull);
  if (comments === undefined) {
    comments = [];
    pullCommentStore.set(pull, comments);
  }
  return comments;
}

// ------------------------------------------------------------------ pull requests

function pullsRoute(
  repo: Repo,
  method: string,
  parts: readonly string[],
  query: URLSearchParams,
  rawBody: Buffer,
  host: string,
  rawPath: string,
): RestResult {
  if (parts.length === 0) {
    if (method === 'POST') {
      const body = parseBody(rawBody);
      if (!body.ok) return fail(400, 'Malformed JSON in request body');
      const title = str(body.value.title);
      const headRaw = str(body.value.head);
      const baseRaw = str(body.value.base);
      if (title === null || headRaw === null || baseRaw === null) {
        return fail(422, 'A title, head and base are required');
      }
      const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      if (repo.branchTip(base) === null) return fail(422, `The base branch "${base}" does not exist`);
      if (repo.branchTip(head) === null) return fail(422, `The head branch "${head}" does not exist`);
      for (const item of repo.items.values()) {
        if (item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base) {
          return fail(422, `A pull request already exists for ${head} into ${base}`);
        }
      }
      const now = forge.now();
      const pull: PullRequest = {
        kind: 'pull',
        number: repo.nextNumber,
        id: forge.nextItemId(),
        title,
        body: str(body.value.body) ?? '',
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
      return { status: 201, json: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let pulls = [...repo.items.values()].filter((item): item is PullRequest => item.kind === 'pull');
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return paginate(pulls.map((pull) => pullJson(repo, pull)), pageOf(query), rawPath, host);
    }
    return NOT_FOUND;
  }
  const number = parseInt(parts[0], 10);
  if (!Number.isInteger(number)) return NOT_FOUND;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'pull') return NOT_FOUND;
  if (parts.length === 1 && method === 'GET') {
    return { status: 200, json: pullJson(repo, item) };
  }
  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const headTip = repo.branchTip(item.headRef);
    const baseTip = repo.branchTip(item.baseRef);
    if (headTip === null || baseTip === null) return { status: 200, json: [] };
    const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
    return { status: 200, json: diffCommits(repo, base, headTip) };
  }
  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    const body = parseBody(rawBody);
    if (!body.ok) return fail(400, 'Malformed JSON in request body');
    const methodName = str(body.value.merge_method) ?? 'merge';
    const outcome = mergePullRequest(repo, item, methodName === 'merge' ? 'merge' : 'squash');
    if (!outcome.ok) {
      return fail(405, outcome.message);
    }
    return { status: 200, json: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return NOT_FOUND;
}
