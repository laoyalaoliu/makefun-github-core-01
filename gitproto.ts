// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack fetch, and v0
// receive-pack with report-status. pkt-line framing throughout; packfiles travel in sideband
// band-1 packets on fetch and push answers.

import {
  ZERO_OID,
  closure,
  commitGenerations,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  readPackInto,
  treeClosure,
  writePack,
} from './gitstore.ts';
import type { Repo } from './forge.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

// ------------------------------------------------------------------ pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse as many whole pkt-lines as the buffer holds; returns packets and the unconsumed rest. */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length < 4 || offset + length > buffer.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** Sideband-wrap a payload: band-1 pkt-lines of at most 64k each. */
export function sideband(payload: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  if (payload.length === 0) return Buffer.alloc(0);
  while (offset < payload.length) {
    const slice = payload.subarray(offset, offset + 65515);
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ ref advertisement

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every advertised ref: HEAD first (when it resolves or is unborn), then refs in name order. */
function refLines(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean }): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = repo.headRef();
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) {
    const line: RefLine = { oid: headOid, name: 'HEAD' };
    if (opts.symrefs) line.symrefTarget = headTarget;
    if (opts.peel) {
      const peeled = peelToCommit(repo.store, headOid);
      if (peeled !== headOid) line.peeled = peeled;
    }
    lines.push(line);
  } else if (opts.unborn) {
    lines.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: headTarget });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    if (opts.peel) {
      const peeled = peelToCommit(repo.store, oid);
      if (peeled !== oid) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

export function advertiseV2(service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (service === 'git-upload-pack') {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
  } else {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function advertiseV0(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const lines = refLines(repo, { peel: true, symrefs: false, unborn: false });
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const line of lines) {
      if (first) {
        parts.push(pktLine(`${line.oid} ${line.name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${line.oid} ${line.name}\n`));
      }
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

export function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  for (const line of refLines(repo, { peel, symrefs, unborn })) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    if (line.unborn === true) {
      parts.push(pktLine(`unborn HEAD symref-target:${line.symrefTarget}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    if (line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch planning

export interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  common: string | null;
}

/**
 * Decide what a fetch sends: closure(wants) bounded by `depth` generations when given, minus what
 * the haves prove the client holds (a shallow have proves only itself and its tree closure).
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const store = repo.store;
  const shallowSet = new Set(clientShallow);
  const included = new Set<string>();
  if (depth === null) {
    for (const oid of closure(store, wants)) included.add(oid);
  } else {
    const generations = commitGenerations(store, wants);
    const commits = [...generations.entries()].filter(([, gen]) => gen < depth).map(([oid]) => oid);
    for (const oid of commits) {
      included.add(oid);
      for (const inner of treeClosure(store, oid)) included.add(inner);
    }
    for (const want of wants) {
      const object = store.get(want);
      if (object !== undefined && object.type === 'tag') {
        for (const inner of closure(store, [want])) included.add(inner);
      }
    }
  }
  const excluded = new Set<string>();
  for (const have of haves) {
    if (!store.has(have)) continue;
    if (shallowSet.has(have)) {
      for (const inner of treeClosure(store, have)) excluded.add(inner);
    } else {
      for (const inner of closure(store, [have])) excluded.add(inner);
    }
  }
  const objects = [...included].filter((oid) => !excluded.has(oid));
  // The new shallow boundary: included commits whose parent exists but was not included, plus
  // wants' boundary when depth cut the history. Client-held shallow commits that are now fully
  // included become unshallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || clientShallow.length > 0) {
    for (const oid of included) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent) && store.has(parent))) shallow.push(oid);
    }
    for (const oid of clientShallow) {
      if (included.has(oid) && !shallow.includes(oid)) {
        const object = store.get(oid);
        if (object !== undefined && object.type === 'commit') {
          const parents = parseCommit(object.data).parents;
          if (parents.every((parent) => included.has(parent) || !store.has(parent))) unshallow.push(oid);
        }
      }
    }
  }
  const common = haves.find((have) => store.has(have)) ?? null;
  return { objects, shallow, unshallow, common };
}

function shallowInfoSection(plan: FetchPlan): Buffer | null {
  if (plan.shallow.length === 0 && plan.unshallow.length === 0) return null;
  const parts: Buffer[] = [pktLine('shallow-info\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function packfileSection(store: Repo['store'], objects: readonly string[]): Buffer {
  const pack = writePack(store, objects);
  const parts: Buffer[] = [pktLine('packfile\n')];
  let offset = 0;
  while (offset < pack.length) {
    const slice = pack.subarray(offset, offset + 65515);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ upload-pack POST

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
  waitForDone: boolean;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false, waitForDone: false };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') request.done = true;
    else if (line === 'wait-for-done') request.waitForDone = true;
  }
  return request;
}

/** Protocol v2 upload-pack: the request is command lines, a delim, argument lines, a flush. */
export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePackets(body);
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    return handleLsRefs(repo, lines.slice(1));
  }
  if (command === 'command=fetch') {
    const request = parseFetchArgs(lines.slice(1));
    return fetchResponse(repo, request, true);
  }
  return pktLine('ERR unknown command\n');
}

function fetchResponse(repo: Repo, request: FetchRequest, v2: boolean): Buffer {
  const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  const needsPack = plan.objects.length > 0;
  if (v2) {
    parts.push(pktLine('acknowledgments\n'));
    if (!needsPack && request.depth === null) {
      parts.push(pktLine(plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n'));
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    if (plan.common !== null) parts.push(pktLine(`ACK ${plan.common} common\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
    const shallowInfo = shallowInfoSection(plan);
    if (shallowInfo !== null) parts.push(shallowInfo);
    parts.push(packfileSection(repo.store, plan.objects));
    return Buffer.concat(parts);
  }
  // v0: negotiation lines, then sideband packets directly (no section headers).
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = writePack(repo.store, plan.objects);
  let offset = 0;
  while (offset < pack.length) {
    const slice = pack.subarray(offset, offset + 65515);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Protocol v0 upload-pack: want lines, a flush, have lines, "done". */
export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePackets(body);
  void rest;
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false, waitForDone: false };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') request.done = true;
  }
  return fetchResponse(repo, request, false);
}

// ------------------------------------------------------------------ receive-pack

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = parsePackets(body);
  const updates: RefUpdate[] = [];
  let capabilities = '';
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
      first = false;
    }
    const parts = text.split(' ');
    if (parts.length >= 3) updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const caps = new Set(capabilities.split(' ').filter((cap) => cap !== ''));
  let unpackOk = true;
  let unpackDetail = '';
  if (rest.length > 0) {
    try {
      readPackInto(repo.store, rest);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const update of updates) {
    if (!unpackOk) {
      results.push({ ref: update.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyUpdate(repo, update));
  }
  if (!caps.has('report-status')) return Buffer.alloc(0);
  const report: Buffer[] = [];
  report.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail || 'error'}\n`));
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  if (caps.has('side-band-64k')) {
    return Buffer.concat([sideband(reportBytes), PKT_FLUSH]);
  }
  return reportBytes;
}

function applyUpdate(repo: Repo, update: RefUpdate): { ref: string; ok: boolean; reason?: string } {
  const current = repo.refs.get(update.ref) ?? ZERO_OID;
  if (update.oldOid !== ZERO_OID && current !== update.oldOid) {
    return { ref: update.ref, ok: false, reason: 'stale info' };
  }
  if (update.newOid === ZERO_OID) {
    repo.refs.delete(update.ref);
    return { ref: update.ref, ok: true };
  }
  if (!repo.store.has(update.newOid)) {
    return { ref: update.ref, ok: false, reason: 'unknown object' };
  }
  if (current !== ZERO_OID && !isAncestor(repo.store, current, update.newOid)) {
    return { ref: update.ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(update.ref, update.newOid);
  return { ref: update.ref, ok: true };
}

export { parseTag };
