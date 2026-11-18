// The git object store: SHA-1 addressed commit/tree/blob/tag objects held in memory, plus pack
// read/write. Plain zlib objects only on write (the suite resolves deltas but never requires the
// server to send them); the pack reader resolves ofs/ref deltas so real git clients can push too.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** The git object id: SHA-1 over "<type> <size>\0" + data. */
export function oidOf(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build nested trees for a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, string>): string {
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = dir.dirs.get(segments[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segments[i], next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1], oid);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of dir.files) entries.push({ mode: '100644', name, oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/** Flatten a tree (recursively) into a path -> {oid, mode} map. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const split = data.indexOf('\n\n');
  const head = (split === -1 ? data : data.subarray(0, split)).toString('utf8');
  const message = split === -1 ? '' : data.subarray(split + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n\n`, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  let object = '';
  let type = '';
  let tag = '';
  for (const line of data.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Follow tag objects until a non-tag object; returns the final oid (or the input when unknown). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from the given tips (commits, their trees and blobs, tags). */
export function closure(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Just the tree closure of one commit (the commit itself plus every tree and blob under it). */
export function treeClosure(store: ObjectStore, commitOid: string): Set<string> {
  const seen = new Set<string>();
  const commit = store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return seen;
  seen.add(commitOid);
  const stack = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
  }
  return seen;
}

/** Commit generation distances from the tips (shortest parent path; tip = 0). */
export function commitGenerations(store: ObjectStore, tips: readonly string[]): Map<string, number> {
  const generations = new Map<string, number>();
  let frontier = tips.filter((oid) => store.get(oid)?.type === 'commit');
  let generation = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (generations.has(oid)) continue;
      generations.set(oid, generation);
      const commit = parseCommit(store.get(oid)!.data);
      for (const parent of commit.parents) if (!generations.has(parent)) next.push(parent);
    }
    frontier = next;
    generation += 1;
  }
  return generations;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents (or equal to it). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const start = peelToCommit(store, descendant);
  const target = peelToCommit(store, ancestor);
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (first shared commit in BFS order from `a`), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const stackB = [peelToCommit(store, b)];
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stackB.push(parent);
    }
  }
  const seen = new Set<string>();
  const queue = [peelToCommit(store, a)];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------- packs

/** Serialize objects into a version-2 pack with a SHA-1 trailer. */
export function writePack(store: ObjectStore, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = store.get(oid);
    if (object === undefined) continue;
    const code = TYPE_CODES[object.type];
    let size = object.data.length;
    const first = (code << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        bytes.push(size > 0 ? byte | 0x80 : byte);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset] * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize += delta[offset] * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Read a pack into the store. Objects already known are skipped; delta bases may live in the pack
 * itself or in the store. Returns the oids the pack carried.
 */
export function readPackInto(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack');
  }
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const type = CODE_TYPES[code];
    if (type === undefined) throw new Error(`unknown pack object type ${code}`);
    const entry: PackEntry = { offset: start, type, data: Buffer.alloc(0) };
    if (type === 'ofs-delta') {
      let b = pack[offset];
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = start - baseOffset;
    } else if (type === 'ref-delta') {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // Inflate this entry's stream: zlib streams are self-terminating, and inflateSync with
    // { info: true } reports exactly how many compressed bytes the stream consumed.
    const rest = pack.subarray(offset, pack.length - 20);
    const inflated = inflateSync(rest, { info: true });
    if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const resolved = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const resolve = (entry: PackEntry): { oid: string; type: GitObjectType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let result: { oid: string; type: GitObjectType; data: Buffer };
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry);
      } else {
        base = store.get(entry.baseOid!);
        if (base === undefined) throw new Error('ref-delta base not available');
      }
      const data = applyDelta(base.data, entry.data);
      result = { oid: oidOf(base.type, data), type: base.type, data };
    } else {
      result = { oid: oidOf(entry.type, entry.data), type: entry.type, data: entry.data };
    }
    resolved.set(entry.offset, result);
    return result;
  };
  const oids: string[] = [];
  for (const entry of entries) {
    const object = resolve(entry);
    store.putKnown(object.oid, object.type, object.data);
    oids.push(object.oid);
  }
  return oids;
}
