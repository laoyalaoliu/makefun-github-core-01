// The forge's domain state, shared by the REST, GraphQL and MCP surfaces so an object created on
// one surface is the same object on every other: repositories with their own git object store and
// refs, one shared issue/pull counter per repository (GitHub semantics), labels and comments.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
} from './gitstore.ts';

/** The trial token's owner: the sealed scenario's viewer, the only account this forge serves. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface Issue {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  kind: 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export type IssueOrPull = Issue | PullRequest;

export class Repo {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly items = new Map<number, IssueOrPull>();
  nextNumber = 1;
  defaultBranch = 'main';
  readonly owner: string;
  name: string;
  readonly databaseId: number;
  isPrivate: boolean;
  description: string;
  readonly createdAt: string;

  constructor(owner: string, name: string, databaseId: number, isPrivate: boolean, description: string, createdAt: string) {
    this.owner = owner;
    this.name = name;
    this.databaseId = databaseId;
    this.isPrivate = isPrivate;
    this.description = description;
    this.createdAt = createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The commit oid a branch name resolves to, or null when the branch does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a branch name, ref or oid to a commit oid. */
  resolveCommit(refOrOid: string): string | null {
    if (this.store.has(refOrOid)) return peelToCommit(this.store, refOrOid);
    const branch = this.branchTip(refOrOid);
    if (branch !== null) return branch;
    const ref = this.refs.get(refOrOid) ?? this.refs.get(`refs/heads/${refOrOid}`);
    return ref !== undefined ? peelToCommit(this.store, ref) : null;
  }

  /** The flat path -> blob oid map of a commit's tree (empty map for an unborn/unknown commit). */
  filesOf(commitOid: string | null): Map<string, string> {
    const files = new Map<string, string>();
    if (commitOid === null) return files;
    const commit = this.store.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return files;
    const flat = flattenTree(this.store, parseCommit(commit.data).tree);
    for (const [path, entry] of flat) files.set(path, entry.oid);
    return files;
  }
}

// ------------------------------------------------------------------ forge state

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoIdCounter = 10_000;
  private itemIdCounter = 100_000;
  private commentIdCounter = 1;
  private clockTick = 0;

  /** A deterministic, strictly increasing timestamp (ISO 8601, UTC). */
  now(): string {
    this.clockTick += 1;
    return new Date(1_760_000_000_000 + this.clockTick * 1000).toISOString();
  }

  /** A git author/committer line for REST-side commits, on the same logical clock. */
  ident(): string {
    this.clockTick += 1;
    const seconds = 1_760_000_000 + this.clockTick;
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${seconds} +0000`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(VIEWER_LOGIN, name, this.repoIdCounter, isPrivate, description, this.now());
    this.repoIdCounter += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  }

  nextItemId(): number {
    const id = this.itemIdCounter;
    this.itemIdCounter += 1;
    return id;
  }

  nextCommentId(): number {
    const id = this.commentIdCounter;
    this.commentIdCounter += 1;
    return id;
  }
}

/** The one forge instance every surface shares. */
export const forge = new Forge();

// ------------------------------------------------------------------ commits over the API

export interface CommitOutcome {
  commitSha: string;
  blobSha: string | null;
}

/**
 * Commit a single-file change on a branch, GitHub contents-API style: the branch is created when
 * missing (from the default branch's tip, or as a root commit on an empty repository).
 */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  newBlobOid: string | null,
  message: string,
): CommitOutcome {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null) {
    const fallback = repo.refs.get(repo.headRef()) ?? null;
    tip = fallback;
  }
  const files = repo.filesOf(tip);
  let blobSha: string | null = null;
  if (newBlobOid === null) {
    files.delete(path);
  } else {
    files.set(path, newBlobOid);
    blobSha = newBlobOid;
  }
  const tree = buildTreeFromFiles(repo.store, files);
  const ident = forge.ident();
  const commitData = buildCommit({
    tree,
    parents: tip === null ? [] : [tip],
    author: ident,
    committer: ident,
    message,
  });
  const commitSha = repo.store.put('commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** The commits reachable from a tip, newest first (BFS over parents, each commit once). */
export function listCommits(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

// ------------------------------------------------------------------ pull request diff and merge

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (oldText === null && newText === null) return { additions: 0, deletions: 0 };
  if (oldText === null) return { additions: newText === '' ? 0 : newText!.split('\n').length, deletions: 0 };
  if (newText === null) return { additions: 0, deletions: oldText === '' ? 0 : oldText.split('\n').length };
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

function blobText(repo: Repo, oid: string | undefined): string | null {
  if (oid === undefined) return null;
  const blob = repo.store.get(oid);
  return blob === undefined ? null : blob.data.toString('utf8');
}

/** The file-level diff between two commits' trees (merge-base tree vs head tree at call sites). */
export function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const from = repo.filesOf(fromCommit);
  const to = repo.filesOf(toCommit);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const changes: FileChange[] = [];
  for (const path of paths) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    const counts = lineCounts(blobText(repo, before), blobText(repo, after));
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'not-mergeable' | 'missing'; message: string };

/**
 * Merge a pull request into its (current) base branch. Squash produces one commit whose parent is
 * the base tip and whose tree is the three-way merged tree; merge produces a two-parent commit.
 * The three-way rule: a path changed on both sides to different content conflicts.
 */
export function mergePullRequest(repo: Repo, pull: PullRequest, method: 'squash' | 'merge'): MergeOutcome {
  if (pull.state === 'closed') {
    return { ok: false, reason: 'not-mergeable', message: 'Pull Request is not mergeable' };
  }
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) {
    return { ok: false, reason: 'missing', message: 'The head or base branch no longer exists' };
  }
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) {
    return { ok: false, reason: 'conflict', message: 'No merge base between the head and base branches' };
  }
  if (base === headTip) {
    return { ok: false, reason: 'not-mergeable', message: 'The head branch has no commits the base does not already contain' };
  }
  const baseFiles = repo.filesOf(base);
  const baseTipFiles = repo.filesOf(baseTip);
  const headFiles = repo.filesOf(headTip);
  const merged = new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const atBaseTip = baseTipFiles.get(path);
    const atHead = headFiles.get(path);
    const baseChanged = atBaseTip !== atBase;
    const headChanged = atHead !== atBase;
    if (baseChanged && headChanged && atBaseTip !== atHead) {
      return { ok: false, reason: 'conflict', message: `The file ${path} changed on both branches` };
    }
    const winner = headChanged ? atHead : atBaseTip;
    if (winner !== undefined) merged.set(path, winner);
  }
  const tree = buildTreeFromFiles(repo.store, merged);
  const ident = forge.ident();
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.headRef}\n`
      : `${pull.title} (#${pull.number})${pull.body ? `\n\n${pull.body}` : ''}\n`;
  const commitData = buildCommit({ tree, parents, author: ident, committer: ident, message });
  const sha = repo.store.put('commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.now();
  pull.mergeCommitSha = sha;
  pull.updatedAt = forge.now();
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's mergeable). */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state === 'closed') return 'UNKNOWN';
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  if (base === headTip) return 'MERGEABLE';
  const baseFiles = repo.filesOf(base);
  const baseTipFiles = repo.filesOf(baseTip);
  const headFiles = repo.filesOf(headTip);
  const paths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    if (baseTipFiles.get(path) !== atBase && headFiles.get(path) !== atBase && baseTipFiles.get(path) !== headFiles.get(path)) {
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

export { ZERO_OID, isAncestor };
