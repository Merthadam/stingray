// POSIX path helpers for core (no node:path). Same results as node:path.posix; relative() needs absolute paths
// because core has no working directory (tests/views/posix-path.test.ts compares every helper with node:path.posix).
export const sep = '/';
const SLASH = 47, DOT = 46;

function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = '', lastSegmentLength = 0, lastSlash = -1, dots = 0, code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === SLASH) break;
    else code = SLASH;
    if (code === SLASH) {
      if (lastSlash === i - 1 || dots === 1) { /* skip */ } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== DOT || res.charCodeAt(res.length - 2) !== DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex === -1) { res = ''; lastSegmentLength = 0; } else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf('/'); }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) { res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue; }
        }
        if (allowAboveRoot) { res += res.length > 0 ? '/..' : '..'; lastSegmentLength = 2; }
      } else {
        res = res.length > 0 ? `${res}/${path.slice(lastSlash + 1, i)}` : path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === DOT && dots !== -1) ++dots;
    else dots = -1;
  }
  return res;
}

export const isAbsolute = (path: string) => path.length > 0 && path.charCodeAt(0) === SLASH;

export function normalize(path: string): string {
  if (path.length === 0) return '.';
  const absolute = isAbsolute(path), trailing = path.charCodeAt(path.length - 1) === SLASH;
  let out = normalizeString(path, !absolute);
  if (out.length === 0) { if (absolute) return '/'; return trailing ? './' : '.'; }
  if (trailing) out += '/';
  return absolute ? `/${out}` : out;
}

export function join(...parts: string[]): string {
  const joined = parts.filter(p => p.length > 0).join('/');
  return joined.length === 0 ? '.' : normalize(joined);
}

export function dirname(path: string): string {
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1, matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) { if (!matchedSlash) { end = i; break; } } else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

export function basename(path: string, suffix?: string): string {
  let start = 0, end = -1, matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1, firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === SLASH) { if (!matchedSlash) { start = i + 1; break; } } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; } else { extIdx = -1; end = firstNonSlashEnd; }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd; else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) { if (!matchedSlash) { start = i + 1; break; } } else if (end === -1) { matchedSlash = false; end = i + 1; }
  }
  return end === -1 ? '' : path.slice(start, end);
}

export function extname(path: string): string {
  let startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === SLASH) { if (!matchedSlash) { startPart = i + 1; break; } continue; }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === DOT) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; } else if (startDot !== -1) preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return '';
  return path.slice(startDot, end);
}

const resolveAbsolute = (path: string) => `/${normalizeString(path, false)}`;
export function relative(from: string, to: string): string {
  if (!isAbsolute(from) || !isAbsolute(to)) throw new Error('posix-path.relative needs absolute paths.');
  if (from === to) return '';
  from = resolveAbsolute(from); to = resolveAbsolute(to);
  if (from === to) return '';
  const fromStart = 1, fromEnd = from.length, fromLen = fromEnd - fromStart, toStart = 1, toLen = to.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1, i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === SLASH) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === SLASH) return to.slice(toStart + i + 1);
      if (i === 0) return to.slice(toStart + i);
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === SLASH) lastCommonSep = i; else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = '';
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) if (i === fromEnd || from.charCodeAt(i) === SLASH) out += out.length === 0 ? '..' : '/..';
  return `${out}${to.slice(toStart + lastCommonSep)}`;
}
