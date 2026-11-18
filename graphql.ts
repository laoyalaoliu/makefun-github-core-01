// The GraphQL v4 surface: a small parser and executor covering exactly the schema the suite
// documents — viewer, repository reads, issue/pull connections with cursor pagination, the five
// mutations gh and github-mcp-server send, Relay node(id:) and the __type introspection probes.
// Global ids are opaque base64 ("Kind:key") and stable across reads, never the plain database id.

import {
  VIEWER_LOGIN,
  diffCommits,
  forge,
  mergePullRequest,
  pullMergeable,
  type Issue,
  type PullRequest,
  type Repo,
} from './forge.ts';
import { mergeBase } from './gitstore.ts';

// ------------------------------------------------------------------ global ids

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split === -1) return null;
    return { kind: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

function repoByDatabaseId(databaseId: number): Repo | null {
  return forge.listRepos().find((repo) => repo.databaseId === databaseId) ?? null;
}

// ------------------------------------------------------------------ schema description

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description', 'createdAt',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'createdAt', 'updatedAt', 'author', 'repository',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['name', 'color'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The object type a field's value belongs to, when it is not a scalar leaf. */
const FIELD_TYPES: Readonly<Record<string, string>> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Query.__type': '__Type',
  'Mutation.createIssue': 'CreateIssuePayload',
  'Mutation.closeIssue': 'CloseIssuePayload',
  'Mutation.createPullRequest': 'CreatePullRequestPayload',
  'Mutation.mergePullRequest': 'MergePullRequestPayload',
  'Mutation.addComment': 'AddCommentPayload',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'Issue.author': 'User',
  'Issue.repository': 'Repository',
  'Issue.labels': 'Label',
  'Issue.comments': 'IssueComment',
  'IssueConnection.nodes': 'Issue',
  'IssueConnection.pageInfo': 'PageInfo',
  'PullRequest.author': 'User',
  'PullRequest.repository': 'Repository',
  'PullRequest.files': 'PullRequestChangedFileConnection',
  'PullRequestConnection.nodes': 'PullRequest',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
  'PullRequestChangedFileConnection.pageInfo': 'PageInfo',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'CommentEdge',
  'CommentEdge.node': 'IssueComment',
  '__Type.fields': '__Field',
  '__Type.enumValues': '__EnumValue',
};

(TYPE_FIELDS as Record<string, readonly string[]>)['PullRequestChangedFileConnection'] = ['nodes', 'pageInfo', 'totalCount'];

// ------------------------------------------------------------------ wrapped values

interface Wrapped {
  __type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: PullRequest;
  name?: string;
  kind?: string;
  nodes?: Wrapped[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  totalCount?: number;
  path?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
  commentId?: number;
  commentBody?: string;
  fieldNames?: readonly string[];
  enumNames?: readonly string[];
}

const wrapRepo = (repo: Repo): Wrapped => ({ __type: 'Repository', repo });
const wrapIssue = (issue: Issue): Wrapped => ({ __type: 'Issue', issue });
const wrapPull = (pull: PullRequest): Wrapped => ({ __type: 'PullRequest', pull });

// ------------------------------------------------------------------ the parser

type ValueNode =
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode = FieldNode | { kind: 'inlineFragment'; typeCondition: string; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  selectionSet: SelectionNode[];
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/\s|,/.test(ch)) {
      i += 1;
    } else if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          text += source[j + 1];
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
    } else if ('{}():$![]=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
    } else if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
    } else {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_\-.]/.test(source[j])) j += 1;
      if (j === i) throw new GqlSyntaxError(`unexpected character ${ch}`);
      tokens.push(source.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new GqlSyntaxError('empty document');
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token === '{') {
      return { type: 'query', selectionSet: this.parseSelectionSet() };
    }
    const kind = this.next();
    if (kind !== 'query' && kind !== 'mutation') throw new GqlSyntaxError(`expected an operation, got ${kind}`);
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') this.next(); // operation name
    if (this.peek() === '(') this.skipVariableDefinitions();
    return { type: kind, selectionSet: this.parseSelectionSet() };
  }

  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const on = this.next();
        if (on !== 'on') throw new GqlSyntaxError('only inline fragments are supported');
        const typeCondition = this.next();
        selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: token };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: token };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ execution

interface ExecContext {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
      return Number(node.value);
    case 'boolean':
      return node.value === 'true';
    case 'null':
      return null;
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = evalValue(arg.value, ctx);
  return args;
}

const cursorOf = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64');

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
  let items = [...repo.items.values()].filter((item): item is Issue => item.kind === 'issue');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    items = items.filter((item) => wanted.has(item.state));
  }
  const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
  const ascending = orderBy?.direction === 'ASC';
  items.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
  return paginateConnection(items.map(wrapIssue), args);
}

function paginateConnection(nodes: Wrapped[], args: Record<string, unknown>): Wrapped {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = typeof args.after === 'string' ? args.after : null;
  let start = 0;
  if (after !== null) {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = nodes.findIndex((node) => node.issue?.number === afterNumber || node.pull?.number === afterNumber);
      if (index !== -1) start = index + 1;
    }
  }
  const slice = nodes.slice(start, start + first);
  const last = slice[slice.length - 1];
  const lastNumber = last?.issue?.number ?? last?.pull?.number ?? null;
  return {
    __type: 'Connection',
    nodes: slice,
    pageInfo: {
      hasNextPage: start + slice.length < nodes.length,
      endCursor: lastNumber === null ? null : cursorOf(lastNumber),
    },
    totalCount: nodes.length,
  };
}

function resolveField(typeName: string, parent: Wrapped | null, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return { __type: 'User' } as Wrapped;
      if (field === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : wrapRepo(repo);
      }
      if (field === 'node') return resolveNode(String(args.id ?? ''));
      if (field === '__type') return typeByName(String(args.name ?? ''));
      return null;
    }
    case 'Mutation':
      return resolveMutation(field, args, ctx);
    case 'User':
      if (field === 'login') return VIEWER_LOGIN;
      if (field === 'id') return globalId('User', '1000');
      if (field === 'name') return 'ada iversen';
      if (field === 'email') return 'adaiversen@example.invalid';
      return null;
    case 'Repository': {
      const repo = parent!.repo!;
      switch (field) {
        case 'id':
          return globalId('Repository', String(repo.databaseId));
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { __type: 'User' } as Wrapped;
        case 'defaultBranchRef':
          return repo.branchTip(repo.defaultBranch) === null ? null : ({ __type: 'Ref', name: repo.defaultBranch } as Wrapped);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.createdAt;
        case 'issue': {
          const item = repo.items.get(Number(args.number));
          return item !== undefined && item.kind === 'issue' ? wrapIssue(item) : null;
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequest': {
          const item = repo.items.get(Number(args.number));
          return item !== undefined && item.kind === 'pull' ? wrapPull(item) : null;
        }
        case 'pullRequests': {
          const pulls = [...repo.items.values()]
            .filter((item): item is PullRequest => item.kind === 'pull' && item.state === 'open')
            .sort((a, b) => b.number - a.number)
            .map(wrapPull);
          return paginateConnection(pulls, args);
        }
        default:
          return null;
      }
    }
    case 'Ref':
      return field === 'name' ? parent!.name : null;
    case 'Issue': {
      const issue = parent!.issue!;
      switch (field) {
        case 'id':
          return globalId('Issue', `${repoOfIssue(issue)}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return { __type: 'User' } as Wrapped;
        case 'labels':
          return issue.labels.map((label) => ({ __type: 'Label', name: label.name }) as Wrapped);
        case 'comments':
          return issue.comments.map((comment) => ({ __type: 'IssueComment', commentId: comment.id, commentBody: comment.body }) as Wrapped);
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const pull = parent!.pull!;
      const repo = repoOfPull(pull);
      switch (field) {
        case 'id':
          return globalId('PullRequest', `${repo?.databaseId ?? 0}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return repo === null ? 'UNKNOWN' : pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'author':
          return { __type: 'User' } as Wrapped;
        case 'files': {
          if (repo === null) return { __type: 'PullRequestChangedFileConnection', nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } as Wrapped;
          const headTip = repo.branchTip(pull.headRef);
          const baseTip = repo.branchTip(pull.baseRef);
          const base = headTip !== null && baseTip !== null ? (mergeBase(repo.store, baseTip, headTip) ?? baseTip) : null;
          const changes = diffCommits(repo, base, headTip);
          const first = typeof args.first === 'number' ? args.first : 30;
          return {
            __type: 'PullRequestChangedFileConnection',
            nodes: changes.slice(0, first).map(
              (change) => ({ __type: 'PullRequestChangedFile', path: change.filename, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() }) as Wrapped,
            ),
            pageInfo: { hasNextPage: false, endCursor: null },
          } as Wrapped;
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return parent!.nodes ?? [];
      if (field === 'pageInfo') return { __type: 'PageInfo', pageInfo: parent!.pageInfo } as Wrapped;
      if (field === 'totalCount') return parent!.totalCount ?? (parent!.nodes?.length ?? 0);
      return null;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return parent!.pageInfo?.hasNextPage ?? false;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return parent!.pageInfo?.endCursor ?? null;
      if (field === 'startCursor') return parent!.pageInfo?.endCursor ?? null;
      return null;
    }
    case 'PullRequestChangedFile':
      if (field === 'path') return parent!.path;
      if (field === 'additions') return parent!.additions;
      if (field === 'deletions') return parent!.deletions;
      if (field === 'changeType') return parent!.changeType;
      return null;
    case 'IssueComment':
      if (field === 'id') return globalId('IssueComment', String(parent!.commentId));
      if (field === 'body') return parent!.commentBody;
      if (field === 'author') return { __type: 'User' } as Wrapped;
      return null;
    case 'Label':
      return field === 'name' ? parent!.name : null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return field === 'issue' ? (parent as unknown as Record<string, unknown>).issue ?? null : null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return field === 'pullRequest' ? (parent as unknown as Record<string, unknown>).pullRequest ?? null : null;
    case 'AddCommentPayload':
      return field === 'commentEdge' ? (parent as unknown as Record<string, unknown>).commentEdge ?? null : null;
    case 'CommentEdge':
      if (field === 'node') return (parent as unknown as Record<string, unknown>).node ?? null;
      if (field === 'cursor') return cursorOf(0);
      return null;
    case '__Type': {
      if (field === 'name') return parent!.name;
      if (field === 'kind') return parent!.kind;
      if (field === 'fields') {
        return (parent!.fieldNames ?? []).map((name) => ({ __type: '__Field', name }) as Wrapped);
      }
      if (field === 'enumValues') {
        return (parent!.enumNames ?? []).map((name) => ({ __type: '__EnumValue', name }) as Wrapped);
      }
      return null;
    }
    case '__Field':
    case '__EnumValue':
      return field === 'name' ? parent!.name : null;
    default:
      return null;
  }
}

function repoOfIssue(issue: Issue): number {
  for (const repo of forge.listRepos()) {
    if (repo.items.get(issue.number) === issue) return repo.databaseId;
  }
  return 0;
}

function repoOfPull(pull: PullRequest): Repo | null {
  for (const repo of forge.listRepos()) {
    if (repo.items.get(pull.number) === pull) return repo;
  }
  return null;
}

function typeByName(name: string): Wrapped | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return { __type: '__Type', name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name] } as Wrapped;
  }
  if (ENUM_VALUES[name] !== undefined) {
    return { __type: '__Type', name, kind: 'ENUM', enumNames: ENUM_VALUES[name] } as Wrapped;
  }
  return null;
}

function resolveNode(id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoByDatabaseId(parseInt(decoded.key, 10));
    return repo === null ? null : wrapRepo(repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const [dbId, number] = decoded.key.split(':').map((part) => parseInt(part, 10));
    const repo = repoByDatabaseId(dbId);
    const item = repo?.items.get(number);
    if (item === undefined) return null;
    return item.kind === 'issue' ? wrapIssue(item) : wrapPull(item);
  }
  return null;
}

// ------------------------------------------------------------------ mutations

function resolveMutation(field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.kind === 'Repository' ? repoByDatabaseId(parseInt(decoded.key, 10)) : null;
    if (repo === null) {
      ctx.errors.push({ message: 'The repository does not exist' });
      return null;
    }
    const now = forge.now();
    const issue: Issue = {
      kind: 'issue',
      number: repo.nextNumber,
      id: forge.nextItemId(),
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return { __type: 'CreateIssuePayload', issue: wrapIssue(issue) } as unknown as Wrapped;
  }
  if (field === 'closeIssue') {
    const target = resolveNode(String(input.issueId ?? ''));
    if (target === null || target.__type !== 'Issue') {
      ctx.errors.push({ message: 'The issue does not exist' });
      return null;
    }
    target.issue!.state = 'closed';
    target.issue!.updatedAt = forge.now();
    return { __type: 'CloseIssuePayload', issue: target } as unknown as Wrapped;
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.kind === 'Repository' ? repoByDatabaseId(parseInt(decoded.key, 10)) : null;
    if (repo === null) {
      ctx.errors.push({ message: 'The repository does not exist' });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (repo.branchTip(head) === null || repo.branchTip(base) === null) {
      ctx.errors.push({ message: 'The head or base branch does not exist' });
      return null;
    }
    const now = forge.now();
    const pull: PullRequest = {
      kind: 'pull',
      number: repo.nextNumber,
      id: forge.nextItemId(),
      title: String(input.title ?? ''),
      body: '',
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
    return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(pull) } as unknown as Wrapped;
  }
  if (field === 'mergePullRequest') {
    const target = resolveNode(String(input.pullRequestId ?? ''));
    if (target === null || target.__type !== 'PullRequest') {
      ctx.errors.push({ message: 'The pull request does not exist' });
      return null;
    }
    const repo = repoOfPull(target.pull!);
    if (repo === null) {
      ctx.errors.push({ message: 'The pull request does not exist' });
      return null;
    }
    const outcome = mergePullRequest(repo, target.pull!, 'squash');
    if (!outcome.ok) {
      ctx.errors.push({ message: outcome.message });
      return null;
    }
    return { __type: 'MergePullRequestPayload', pullRequest: target } as unknown as Wrapped;
  }
  if (field === 'addComment') {
    const target = resolveNode(String(input.subjectId ?? ''));
    if (target === null || (target.__type !== 'Issue' && target.__type !== 'PullRequest')) {
      ctx.errors.push({ message: 'The subject does not exist' });
      return null;
    }
    const body = String(input.body ?? '');
    const comment = { id: forge.nextCommentId(), body, author: VIEWER_LOGIN, createdAt: forge.now() };
    if (target.__type === 'Issue') target.issue!.comments.push(comment);
    const node = { __type: 'IssueComment', commentId: comment.id, commentBody: body } as Wrapped;
    return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } } as unknown as Wrapped;
  }
  return null;
}

// ------------------------------------------------------------------ selection execution

function executeSelectionSet(
  typeName: string,
  parent: Wrapped | null,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node' || (parent !== null && selection.typeCondition === parent.__type)) {
        Object.assign(out, executeSelectionSet(typeName, parent, selection.selectionSet, ctx));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const knownFields = TYPE_FIELDS[typeName];
    if (typeName === 'Node') {
      // node(id:) answers with the target object; its fields are the target type's.
      const targetType = parent?.__type ?? 'Repository';
      const value = resolveField(targetType, parent, selection.name, argsOf(selection, ctx), ctx);
      out[responseKey] = completeValue(FIELD_TYPES[`${targetType}.${selection.name}`] ?? targetType, value, selection, ctx);
      continue;
    }
    if (knownFields !== undefined && !knownFields.includes(selection.name) && !selection.name.startsWith('__')) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[responseKey] = null;
      continue;
    }
    const value = resolveField(typeName, parent, selection.name, argsOf(selection, ctx), ctx);
    out[responseKey] = completeValue(FIELD_TYPES[`${typeName}.${selection.name}`], value, selection, ctx);
  }
  return out;
}

function completeValue(childType: string | undefined, value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(childType, entry, field, ctx));
  }
  const wrapped = value as Wrapped;
  const type = childType === 'Node' ? wrapped.__type : (childType ?? wrapped.__type);
  return executeSelectionSet(type, wrapped, field.selectionSet, ctx);
}

// ------------------------------------------------------------------ entry point

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (a single operation object, or a batch array). */
export function executeGraphQL(rawBody: Buffer): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { errors: [{ message: 'The request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne(entry)) };
  }
  return { status: 200, body: executeOne(parsed) };
}

function executeOne(entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object') {
    return { errors: [{ message: 'The request is not a GraphQL operation object' }] };
  }
  const { query, variables } = entry as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string') {
    return { errors: [{ message: 'The request carries no query string' }] };
  }
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation = operations[0];
  const ctx: ExecContext = {
    variables: (variables !== null && typeof variables === 'object' ? variables : {}) as Record<string, unknown>,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, operation.selectionSet, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
