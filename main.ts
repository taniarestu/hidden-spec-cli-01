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
  /** Moves an edit made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/** A file as its lines, its line break and whether it ends with one (SPEC section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** All positions at or after `from` where O occurs in lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence of O at or after `from` (tier 0 only when strict). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines N writes when O matched at `at`: context lines come from the file, tier 2 re-indents the rest. */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = leadWs(fileLines[at] ?? '');
  return n.map((nl) => {
    if (nl.ctx !== null) return fileLines[at + nl.ctx]!;
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return nl.text;
  });
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

/** One unified hunk (SPEC section 6). */
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEolCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

/** One unified section: one edit. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path of a `--- ` / `+++ ` header line, or null when it names no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
}

/** A hunk body starting at `start`: its content lines and the index after them. */
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const content: BodyLine[] = [];
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      content.push({ kind: 'ctx', text: '', noEol: false });
      i++;
      continue;
    }
    const c = line[0]!;
    if (c === ' ') {
      content.push({ kind: 'ctx', text: line.slice(1), noEol: false });
      i++;
      continue;
    }
    if (c === '-') {
      content.push({ kind: 'old', text: line.slice(1), noEol: false });
      i++;
      continue;
    }
    if (c === '+') {
      content.push({ kind: 'new', text: line.slice(1), noEol: false });
      i++;
      continue;
    }
    if (c === '\\') {
      if (content.length > 0) content[content.length - 1]!.noEol = true;
      i++;
      continue;
    }
    break;
  }
  while (content.length > 0) {
    const last = content[content.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') content.pop();
    else break;
  }
  const o: string[] = [];
  const nl: NewLine[] = [];
  for (const cl of content) {
    if (cl.kind === 'ctx') {
      nl.push({ text: cl.text, ctx: o.length });
      o.push(cl.text);
    } else if (cl.kind === 'old') o.push(cl.text);
    else nl.push({ text: cl.text, ctx: null });
  }
  let noEolCtxPlus = false;
  let noEolPlus = false;
  for (let k = content.length - 1; k >= 0; k--) {
    const cl = content[k]!;
    if (cl.kind === 'ctx' || cl.kind === 'new') {
      noEolCtxPlus = cl.noEol;
      break;
    }
  }
  for (let k = content.length - 1; k >= 0; k--) {
    const cl = content[k]!;
    if (cl.kind === 'new') {
      noEolPlus = cl.noEol;
      break;
    }
  }
  return { hunk: { a: 0, o, n: nl, noEolCtxPlus, noEolPlus }, next: i };
}

/** Apply a section's hunks in order to a file state (SPEC section 6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(f.lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(f.lines, best, h.o, h.n, found.tier);
      const touchesEnd = best + h.o.length === f.lines.length;
      f.lines.splice(best, h.o.length, ...rep);
      if (touchesEnd) f.final = !h.noEolCtxPlus;
      d += h.n.length - h.o.length;
    } else {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const rep = h.n.map((x) => x.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...rep);
      if (atEnd) f.final = !h.noEolPlus;
      d += h.n.length;
    }
  }
}

/** One unified section as an edit. */
function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP === null || s.isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const nl of h.n) if (nl.ctx === null) plus.push(nl.text);
      let text = '';
      if (plus.length > 0) {
        let noEol = false;
        for (let k = s.hunks.length - 1; k >= 0; k--) {
          const h = s.hunks[k]!;
          if (h.n.some((nl) => nl.ctx === null)) {
            noEol = h.noEolPlus;
            break;
          }
        }
        text = plus.join('\n') + (noEol ? '' : '\n');
      }
      tree.now.set(p, text);
      return;
    }
    if (newP === null || s.isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = parseFile(tree.get(oldP)!);
      applyHunks(f, s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(f));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const f = parseFile(tree.get(oldP)!);
    applyHunks(f, s.hunks, strict, oldP);
    tree.now.set(oldP, serializeFile(f));
  };
}

/** Read a patch as unified diffs: one edit per section (SPEC section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  const startSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, hasPair: false, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.oldPath = m[1]!;
      s.newPath = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        const s = startSection();
        s.oldPath = headerPath(line);
        s.newPath = headerPath(lines[i + 1]!);
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      body.hunk.a = parseInt(m[1]!, 10);
      cur.hunks.push(body.hunk);
      i = body.next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ') && !cur.hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !cur.hasPair) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (SPEC section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = buildReplacement(f.lines, at, oldLines, n, found.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(f));
  };
}

/** Read a patch as SEARCH/REPLACE blocks: one edit per block (SPEC section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const t = lines[j]!;
      if (t.trim() === '') continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk (SPEC section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

/** One V4A Add File section as an edit. */
function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as an edit. */
function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as an edit. */
function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(cur);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const found = findTier(f.lines, [c.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (c.o.length > 0) {
        const found = findTier(f.lines, c.o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let at: number | null = null;
        if (c.eof) {
          for (const p of found.pos) {
            if (p + c.o.length === f.lines.length) {
              at = p;
              break;
            }
          }
          if (at === null) throw new Fail('no-match', path);
        } else {
          at = found.pos[0]!;
        }
        const rep = buildReplacement(f.lines, at, c.o, c.n, found.tier);
        f.lines.splice(at, c.o.length, ...rep);
        cursor = at + rep.length;
      } else {
        const at = c.eof ? f.lines.length : cursor;
        const rep = c.n.map((nl) => nl.text);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      }
    }
    const text = serializeFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** Read a patch as a V4A patch: one edit per section (SPEC section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  while (i < end) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const raw: Array<{ t: string; no: number }> = [];
    let j = i + 1;
    while (j < end) {
      const l = lines[j]!;
      if (sectionStart(l) !== null) break;
      raw.push({ t: l, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.t.trim() === '') raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.t === '') fileLines.push('');
        else if (r.t.startsWith('+')) fileLines.push(r.t.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(vAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push(vDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.t.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const startChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, eof: false, o: [], n: [] };
        chunks.push(c);
        return c;
      };
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const t = r.t;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = startChunk(anchor === '' ? null : anchor);
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = startChunk(null);
          }
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = startChunk(null);
          }
          if (t === '') {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          } else if (t.startsWith(' ')) {
            cur.o.push(t.slice(1));
            cur.n.push({ text: t.slice(1), ctx: cur.o.length - 1 });
          } else if (t.startsWith('-')) cur.o.push(t.slice(1));
          else cur.n.push({ text: t.slice(1), ctx: null });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      moved.set(o, n);
    }
  }
  const movedNew = new Set(moved.values());
  const rowList: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moved.has(p) || movedNew.has(p)) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of moved) rowList.push({ key: n, line: `R ${o} -> ${n}` });
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
