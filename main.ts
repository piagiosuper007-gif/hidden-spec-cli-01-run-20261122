// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 5: matching lines at three tiers, and the file's own lines. */

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function trimEndWs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function trimWs(s: string): string {
  return trimEndWs(s.slice(leadWs(s).length));
}

function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

/** A file's lines under its own line break, and whether it ends with one. */
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The first tier at which O occurs in lines at or after `from`, and every position there. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; positions: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (!tierEq(tier, lines[i + k]!, O[k]!)) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return { tier: -1, positions: [] };
}

interface Block {
  o: string[];
  n: string[];
  nCtx: (number | null)[];
}

/**
 * N as written: a context line is the file's own matched line, never the patch's; at tier 2 every other
 * line of N that starts with O's first line's leading whitespace has that prefix swapped for the file's.
 */
function mapN(b: Block, fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = b.o.length > 0 ? leadWs(b.o[0]!) : '';
  const f = b.o.length > 0 ? leadWs(fileLines[pos]!) : '';
  for (let j = 0; j < b.n.length; j += 1) {
    const ctx = b.nCtx[j]!;
    if (ctx !== null) {
      out.push(fileLines[pos + ctx]!);
      continue;
    }
    const line = b.n[j]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** Section 6: unified diffs. */

interface Hunk extends Block {
  a: number;
  noEol: boolean;
  plus: string[];
  plusNoEol: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  headerPaths: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` line: after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function uniPath(raw: string): string | null {
  const t = raw.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseHunkHeader(l: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  return m === null ? null : Number(m[1]);
}

const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

function diffGitPaths(l: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

/** A section's header: the lines before its first hunk. Returns the index after the header. */
function uniHeader(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (isDiffGitLine(l)) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldPath = uniPath(l);
        sec.newPath = uniPath(lines[i + 1]!);
        sec.headerPaths = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      if (!sec.headerPaths) sec.oldPath = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!sec.headerPaths) sec.newPath = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.create = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** A section's hunks. Returns the index of the next section's start, or the end of the patch. */
function uniHunks(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (isDiffGitLine(bl)) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: string[] = [];
      const nn: string[] = [];
      const nCtx: (number | null)[] = [];
      const plus: string[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k += 1) {
        const bl = body[k]!;
        if (bl === '') {
          o.push('');
          nn.push('');
          nCtx.push(o.length - 1);
          lastCtxPlus = k;
        } else if (bl[0] === ' ') {
          o.push(bl.slice(1));
          nn.push(bl.slice(1));
          nCtx.push(o.length - 1);
          lastCtxPlus = k;
        } else if (bl[0] === '-') {
          o.push(bl.slice(1));
        } else if (bl[0] === '+') {
          nn.push(bl.slice(1));
          nCtx.push(null);
          plus.push(bl.slice(1));
          lastCtxPlus = k;
          lastPlus = k;
        }
      }
      const followsBackslash = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]![0] === '\\';
      sec.hunks.push({ a, o, n: nn, nCtx, noEol: followsBackslash(lastCtxPlus), plus, plusNoEol: followsBackslash(lastPlus) });
      i = j;
      continue;
    }
    if (isDiffGitLine(l)) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    i += 1;
  }
  return i;
}

/** A section's hunks applied in order to a file's text. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FileLines {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines = [...f.lines.slice(0, pos), ...h.n, ...f.lines.slice(pos)];
      if (atEnd) f.final = !h.noEol;
    } else {
      const { tier, positions } = findTier(h.o, f.lines, 0, strict);
      if (positions.length === 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === f.lines.length;
      const mapped = mapN(h, f.lines, best, tier);
      f.lines = [...f.lines.slice(0, best), ...mapped, ...f.lines.slice(best + h.o.length)];
      if (atEnd) f.final = !h.noEol;
    }
    d += h.n.length - h.o.length;
  }
  return f;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const [x, y] = diffGitPaths(l, i + 1);
      const sec: UniSection = { oldPath: x, newPath: y, create: false, del: false, headerPaths: false, hunks: [] };
      sections.push(sec);
      i = uniHeader(lines, i + 1, sec);
      i = uniHunks(lines, i, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { oldPath: null, newPath: null, create: false, del: false, headerPaths: false, hunks: [] };
      sections.push(sec);
      i = uniHeader(lines, i, sec);
      i = uniHunks(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      // A creation is an old path of /dev/null (oldP null) or `new file mode`; a deletion is a new
      // path of /dev/null (newP null) or `deleted file mode`.
      if (sec.create || oldP === null) {
        const np = newP ?? oldP ?? '';
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let plusNoEol = false;
        for (const h of sec.hunks) {
          plus.push(...h.plus);
          if (h.plus.length > 0) plusNoEol = h.plusNoEol;
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (plusNoEol ? '' : '\n'));
        return;
      }
      if (sec.del || newP === null) {
        const op = oldP ?? newP ?? '';
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = oldP ?? newP ?? '';
      const np = newP ?? oldP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyUnifiedHunks(before, sec.hunks, strict, op);
      const text = joinFile(out.lines, out.br, out.final);
      if (op !== np) {
        tree.now.set(op, null);
        tree.now.set(np, text);
        moves.push([op, np]);
      } else {
        tree.now.set(op, text);
      }
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */

interface SearchBlock {
  path: string;
  old: string[];
  new: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let i = 0;
  let lastEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > lastEnd; j -= 1) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      let sep = -1;
      for (let k = i + 1; k < lines.length; k += 1) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') { sep = k; break; }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
      let end = -1;
      for (let k = sep + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { end = k; break; }
      }
      if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, old: lines.slice(i + 1, sep), new: lines.slice(sep + 1, end) });
      prevPath = path;
      lastEnd = end;
      i = end + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.new.length === 0 ? '' : b.new.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const f = splitFile(before);
      const { tier, positions } = findTier(b.old, f.lines, 0, strict);
      if (positions.length === 0) throw new Fail('no-match', b.path);
      if (positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = positions[0]!;
      const mapped = mapN({ o: b.old, n: b.new, nCtx: b.new.map(() => null) }, f.lines, pos, tier);
      const out = [...f.lines.slice(0, pos), ...mapped, ...f.lines.slice(pos + b.old.length)];
      tree.now.set(b.path, joinFile(out, f.br, f.final));
    };
  });
}

/** Section 8: V4A patches. */

interface VChunk extends Block {
  anchor: string | null;
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  lineNo: number;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionKind = (l: string): 'add' | 'del' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'del';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sectionPath = (l: string, kind: 'add' | 'del' | 'update'): string => {
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    return l.slice(prefix.length).trim();
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind, path: sectionPath(l, kind), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
    sections.push(sec);
    i += 1;
    const raw: { t: string; no: number }[] = [];
    while (i < last) {
      const rl = lines[i]!;
      if (sectionKind(rl) !== null) break;
      raw.push({ t: rl, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    if (kind === 'add') {
      for (const rl of raw) {
        if (rl.t.startsWith('+')) sec.addLines.push(rl.t.slice(1));
        else if (rl.t === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${rl.no}`);
      }
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let j = 0;
      if (j < raw.length && raw[j]!.t.startsWith('*** Move to: ')) {
        sec.moveTo = raw[j]!.t.slice('*** Move to: '.length).trim();
        j += 1;
      }
      let cur: VChunk | null = null;
      for (; j < raw.length; j += 1) {
        const rl = raw[j]!;
        if (rl.t.startsWith('@@')) {
          const anchor = rl.t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], nCtx: [] };
          sec.chunks.push(cur);
          continue;
        }
        if (rl.t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${rl.no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (rl.t === '' || rl.t[0] === ' ' || rl.t[0] === '-' || rl.t[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${rl.no}`);
            cur = { anchor: null, eof: false, o: [], n: [], nCtx: [] };
            sec.chunks.push(cur);
          }
          if (rl.t === '') {
            cur.o.push('');
            cur.n.push('');
            cur.nCtx.push(cur.o.length - 1);
          } else if (rl.t[0] === ' ') {
            cur.o.push(rl.t.slice(1));
            cur.n.push(rl.t.slice(1));
            cur.nCtx.push(cur.o.length - 1);
          } else if (rl.t[0] === '-') {
            cur.o.push(rl.t.slice(1));
          } else {
            cur.n.push(rl.t.slice(1));
            cur.nCtx.push(null);
          }
          continue;
        }
        throw new Exit2(`error: parse ${rl.no}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'del') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const f = splitFile(before);
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let found = -1;
          for (const tier of tiers) {
            for (let j = cursor; j < f.lines.length; j += 1) {
              if (tierEq(tier, f.lines[j]!, ch.anchor)) { found = j; break; }
            }
            if (found >= 0) break;
          }
          if (found < 0) throw new Fail('no-match', sec.path);
          cursor = found + 1;
        }
        if (ch.o.length === 0) {
          const pos = ch.eof ? f.lines.length : cursor;
          f.lines = [...f.lines.slice(0, pos), ...ch.n, ...f.lines.slice(pos)];
          cursor = pos + ch.n.length;
        } else {
          const { tier, positions } = findTier(ch.o, f.lines, cursor, strict);
          const cands = ch.eof ? positions.filter((q) => q + ch.o.length === f.lines.length) : positions;
          if (cands.length === 0) throw new Fail('no-match', sec.path);
          const pos = cands[0]!;
          const mapped = mapN(ch, f.lines, pos, tier);
          f.lines = [...f.lines.slice(0, pos), ...mapped, ...f.lines.slice(pos + ch.o.length)];
          cursor = pos + mapped.length;
        }
      }
      const text = joinFile(f.lines, f.br, f.final);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, text);
        moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict, moves)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move qualifies for an `R` line when the old path existed before the patch and is gone now, and the
  // new path did not exist before it and holds the file now; chains of moves collapse to a single line.
  const next = new Map<string, string>();
  for (const [o, n] of moves) next.set(o, n);
  const allNew = new Set<string>(moves.map(([, n]) => n));
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const emitted = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o] of moves) {
    if (allNew.has(o) || emitted.has(o)) continue;
    let dest = o;
    const seen = new Set<string>([o]);
    let cyclic = false;
    while (next.has(dest)) {
      const d = next.get(dest)!;
      if (seen.has(d)) { cyclic = true; break; }
      seen.add(d);
      dest = d;
    }
    if (cyclic) continue;
    if (tree.original(o) === null || tree.original(dest) !== null) continue;
    if (tree.get(o) !== null || tree.get(dest) === null) continue;
    emitted.add(o);
    rOld.add(o);
    rNew.add(dest);
    rows.push({ key: dest, line: `R ${o} -> ${dest}` });
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
