// mend: applies an AI-written edit, in one of four formats, to a tree of text files.
// Written fresh in this session from SPEC.md (kit starter's sections 1-4, 9, 10 are
// re-implemented here in my own code; unified, SEARCH/REPLACE, V4A and the three-tier
// matcher are written from the spec). Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`. When MAKEFUN_ENV_URL is set, the trial
// hand-over at the bottom runs runner.ts instead; keep both as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

const byteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file's text as lines: its own break, whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; fin: boolean } {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, for the R output lines. */
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

type Edit = (tree: Tree) => void;

/** A line normalised at a matching tier (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at a tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = O.length;
  if (n === 0) return out;
  const want = O.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + n <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < n; k += 1) {
      if (normLine(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where O occurs, with its positions. */
function firstTierWith(
  O: string[],
  lines: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** Map N onto the matched file lines: context lines are the file's own, tier-2 new lines re-indented. */
function mapNewLines(N: NLine[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const pfx = O.length > 0 ? leadWs(O[0]!) : '';
  const ffx = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  return N.map((nl) => {
    if (nl.ctx >= 0) return fileLines[pos + nl.ctx]!;
    if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(pfx)) return ffx + t.slice(pfx.length);
    }
    return nl.text;
  });
}

/** Detect the patch format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- unified (section 6)

interface HunkBodyItem {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

interface Hunk {
  /** Old start line A from the @@ header. */
  a: number;
  body: HunkBodyItem[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  /** Where each path came from: 'pair' (---/+++), 'rename', or 'git' (diff --git). */
  oldFrom: 'pair' | 'rename' | 'git';
  newFrom: 'pair' | 'rename' | 'git';
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
  /** 1-based line of the section's first line, for error reporting. */
  firstLine: number;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The path a --- / +++ line names: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!;
  const p = raw.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  void strict;
  const sections: Section[] = [];
  let cur: Section | null = null;
  /** True while the current section has seen no hunk yet (still in its header). */
  let inHeader = false;
  let i = 0;
  const n = lines.length;

  const startSection = (
    oldP: string | null,
    newP: string | null,
    from: 'pair' | 'git',
    lineNo: number,
  ): void => {
    cur = {
      oldPath: oldP,
      newPath: newP,
      oldFrom: from,
      newFrom: from,
      create: false,
      remove: false,
      hunks: [],
      firstLine: lineNo,
    };
    sections.push(cur);
    inHeader = true;
  };

  while (i < n) {
    const line = lines[i]!;
    // A diff --git line: a new section, or a parse error when malformed.
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!, 'git', i + 1);
      i += 1;
      continue;
    }
    // A --- / +++ pair starts a section (outside a header), or names the header's paths.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.oldFrom = 'pair';
        cur.newFrom = 'pair';
      } else {
        startSection(headerPath(line), headerPath(lines[i + 1]!), 'pair', i + 1);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      // The body: lines starting with ' ', '-', '+' or '\', or empty lines.
      while (i < n) {
        const b = lines[i]!;
        if (b === 'diff --git' || b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') hunk.body.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') hunk.body.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') hunk.body.push({ kind: 'mark', text: b.slice(1) });
        else break;
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // A --- line in a header that is not followed by +++: parse error at the line after it.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line);
        cur.newFrom = 'pair';
      } else if (line.startsWith('rename from ')) {
        // rename names a path only when no ---/+++ pair does; it beats diff --git paths.
        if (cur.oldFrom !== 'pair') {
          cur.oldPath = line.slice('rename from '.length).trim();
          cur.oldFrom = 'rename';
        }
      } else if (line.startsWith('rename to ')) {
        if (cur.newFrom !== 'pair') {
          cur.newPath = line.slice('rename to '.length).trim();
          cur.newFrom = 'rename';
        }
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.remove = true;
      }
      // index, old mode, new mode, similarity/dissimilarity index, Index: and any other
      // header line are ignored.
      i += 1;
      continue;
    }
    // Prose and code fences outside bodies are ignored.
    i += 1;
  }

  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Split a hunk body into its old lines O and its new lines N (with context flags). */
function hunkLines(h: Hunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const it of h.body) {
    if (it.kind === 'ctx') {
      const idx = O.length;
      O.push(it.text);
      N.push({ text: it.text, ctx: idx });
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else if (it.kind === 'new') {
      N.push({ text: it.text, ctx: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line (no final line break). */
function hunkNoFinalBreak(h: Hunk): boolean | null {
  let last = -1;
  h.body.forEach((it, idx) => {
    if (it.kind === 'ctx' || it.kind === 'new') last = idx;
  });
  if (last < 0) return null;
  const next = h.body[last + 1];
  return next !== undefined && next.kind === 'mark';
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(
  start: { lines: string[]; br: string; fin: boolean },
  hunks: Hunk[],
  strict: boolean,
  path: string,
): { lines: string[]; fin: boolean } {
  let lines = start.lines;
  let fin = start.fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkLines(h);
    if (O.length > 0) {
      const m = firstTierWith(O, lines, 0, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of m.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const mapped = mapNewLines(N, O, lines, best, m.tier);
      const touchesEnd = best + O.length === lines.length;
      lines = [...lines.slice(0, best), ...mapped, ...lines.slice(best + O.length)];
      if (touchesEnd) {
        const mark = hunkNoFinalBreak(h);
        fin = mark === null ? lines.length > 0 : !mark;
      }
      d += N.length - O.length;
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const mapped = N.map((nl) => nl.text);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...mapped, ...lines.slice(at)];
      if (atEnd && mapped.length > 0) {
        const mark = hunkNoFinalBreak(h);
        if (mark !== null) fin = !mark;
        else fin = true;
      }
      d += N.length;
    }
  }
  return { lines, fin };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    for (const p of [oldP, newP]) {
      if (p !== null && !safePath(p)) throw new Fail('unsafe', p);
    }
    if (sec.create || oldP === null) {
      // Creation: the file is the + lines of all its hunks, in order.
      const plus: string[] = [];
      let finalBr = true;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const it of h.body) {
          if (it.kind === 'new') {
            plus.push(it.text);
            hasPlus = true;
          }
        }
        if (hasPlus) {
          const mark = hunkNoFinalBreak(h);
          if (mark !== null) finalBr = !mark;
        }
      }
      if (newP === null) throw new Fail('missing', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (sec.remove || newP === null) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      // Move: hunks apply to the old file's lines, the result is written at the new path.
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = splitFile(cur);
      const res = applyHunks(f, sec.hunks, strict, oldP);
      tree.now.set(newP, joinFile(res.lines, f.br, res.fin));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const f = splitFile(cur);
    const res = applyHunks(f, sec.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(res.lines, f.br, res.fin));
  };
}

// ------------------------------------------------------- SEARCH/REPLACE (section 7)

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  /** 1-based line of the SEARCH line, for error reporting. */
  searchLine: number;
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  const n = lines.length;
  let prevEnd = -1; // index of the previous block's >>>>>>> line
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path: the nearest line before the SEARCH line, after the previous block,
    // that is not blank and does not start with three backticks once trimmed.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    // Find ======= then >>>>>>> REPLACE after the SEARCH line.
    let eq = -1;
    let end = -1;
    for (let j = searchIdx + 1; j < n; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eq + 1; j < n; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, end),
      searchLine: searchIdx + 1,
    });
    prevEnd = end;
    i = end + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const m = firstTierWith(b.oldLines, f.lines, 0, strict);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = m.occ[0]!;
    const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
    const mapped = mapNewLines(N, b.oldLines, f.lines, pos, m.tier);
    const out = [...f.lines.slice(0, pos), ...mapped, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile(out, f.br, f.fin));
  };
}

// ---------------------------------------------------------------- V4A (section 8)

interface VChunk {
  anchor: string | null;
  /** Body lines: [kind, text]; kind ' ' context, '-' old, '+' new. */
  body: Array<{ kind: ' ' | '-' | '+'; text: string }>;
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File lines, in order. */
  addLines: string[];
  chunks: VChunk[];
  /** 1-based line of the section's first line, for error reporting. */
  firstLine: number;
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function isVSectionStart(line: string): boolean {
  return line.startsWith(V_ADD) || line.startsWith(V_DEL) || line.startsWith(V_UPD);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  const end = last; // the *** End Patch line itself is never a section line
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const sec: VSection = {
        kind: 'add',
        path: line.slice(V_ADD.length).trim(),
        moveTo: null,
        addLines: [],
        chunks: [],
        firstLine: i + 1,
      };
      i += 1;
      // Collect + lines and empty lines; blank lines at the end of the section drop out.
      const collected: Array<{ text: string; fromBlank: boolean }> = [];
      while (i < end) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          collected.push({ text: l.slice(1), fromBlank: false });
          i += 1;
        } else if (blank(l)) {
          collected.push({ text: '', fromBlank: true });
          i += 1;
        } else break;
      }
      while (collected.length > 0 && collected[collected.length - 1]!.fromBlank) collected.pop();
      sec.addLines = collected.map((c) => c.text);
      if (i < end && !isVSectionStart(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      sections.push(sec);
      continue;
    }
    if (line.startsWith(V_DEL)) {
      sections.push({
        kind: 'delete',
        path: line.slice(V_DEL.length).trim(),
        moveTo: null,
        addLines: [],
        chunks: [],
        firstLine: i + 1,
      });
      i += 1;
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const sec: VSection = {
        kind: 'update',
        path: line.slice(V_UPD.length).trim(),
        moveTo: null,
        addLines: [],
        chunks: [],
        firstLine: i + 1,
      };
      i += 1;
      if (i < end && lines[i]!.startsWith(V_MOVE)) {
        sec.moveTo = lines[i]!.slice(V_MOVE.length).trim();
        i += 1;
      }
      // Chunks: start at an @@ line, or for the first chunk at a body line.
      let curChunk: VChunk | null = null;
      const closeChunk = (atSectionEnd: boolean): void => {
        if (curChunk === null) return;
        if (atSectionEnd) {
          // Blank lines at the end of a section are not part of it.
          while (curChunk.body.length > 0) {
            const lastB = curChunk.body[curChunk.body.length - 1]!;
            if (lastB.kind === ' ' && lastB.text.trim() === '') curChunk.body.pop();
            else break;
          }
        }
        sec.chunks.push(curChunk);
        curChunk = null;
      };
      while (i < end) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          closeChunk(false);
          curChunk = { anchor: l.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          closeChunk(false);
          i += 1;
          continue;
        }
        if (isVSectionStart(l)) break;
        if (blank(l)) {
          if (curChunk === null && sec.chunks.length === 0) {
            // A blank line before the first chunk is its first body line (empty context).
            curChunk = { anchor: null, body: [], eof: false };
          } else if (curChunk === null) {
            // Blank lines between chunks are ignored.
            i += 1;
            continue;
          }
          curChunk!.body.push({ kind: ' ', text: '' });
          i += 1;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, body: [], eof: false };
          }
          curChunk.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(true);
      if (sec.chunks.length === 0 && sec.moveTo === null) {
        throw new Exit2(`error: parse ${sec.firstLine}`);
      }
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findAnchor(ch.anchor, lines, cursor, strict);
        if (found < 0) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ') {
          const idx = O.length;
          O.push(b.text);
          N.push({ text: b.text, ctx: idx });
        } else if (b.kind === '-') {
          O.push(b.text);
        } else {
          N.push({ text: b.text, ctx: -1 });
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const mapped = N.map((nl) => nl.text);
        lines = [...lines.slice(0, at), ...mapped, ...lines.slice(at)];
        cursor = at + mapped.length;
        continue;
      }
      const hit = findChunkOccurrence(O, lines, cursor, strict, ch.eof);
      if (hit === null) throw new Fail('no-match', sec.path);
      const mapped = mapNewLines(N, O, lines, hit.pos, hit.tier);
      lines = [...lines.slice(0, hit.pos), ...mapped, ...lines.slice(hit.pos + O.length)];
      cursor = hit.pos + mapped.length;
    }
    const out = joinFile(lines, f.br, f.fin);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/** The first line at or after the cursor equal to the anchor, at the first tier where one is. */
function findAnchor(anchor: string, lines: string[], cursor: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    for (let i = cursor; i < lines.length; i += 1) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after the cursor, at the first tier with one. */
function findChunkOccurrence(
  O: string[],
  lines: string[],
  cursor: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    for (const pos of occurrences(O, lines, t, cursor)) {
      if (eof && pos + O.length !== lines.length) continue;
      return { tier: t, pos };
    }
  }
  return null;
}

// ---------------------------------------------------------------- JSON (section 9)

/** One JSON edit object (section 9), or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  /** The file's current text, after the safety and existence checks. */
  const need = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const f = splitFile(before);
      if (atLine < 0 || atLine > f.lines.length) throw new Fail('no-match', p);
      const out = [...f.lines];
      out.splice(atLine, 0, ...add);
      tree.now.set(p, joinFile(out, f.br, f.fin));
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

// ---------------------------------------------------------------- running (sections 1, 2, 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  // Output rows: one per changed path, byte order; a move prints one R line, sorted by <new>.
  const rows: Array<{ key: string; text: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    changed.push(p);
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    for (const [oldP, newP] of tree.moves) {
      if (!movedOld.has(oldP)) continue;
      rmSync(oldP, { force: true });
      mkdirSync(dirname(newP), { recursive: true });
      writeFileSync(newP, tree.now.get(newP)!);
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
