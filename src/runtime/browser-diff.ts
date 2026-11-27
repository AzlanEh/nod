const maxLines = 1600;
const maxLineChars = 400;
const diffBudgetRatio = 0.65;

export interface PageSnapshotState {
  url: string;
  lines: string[];
}

function splitLines(text: string): string[] {
  const raw = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < raw.length && out.length < maxLines; i++) {
    const line = raw[i]!;
    out.push(line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line);
  }
  return out;
}

function sameDocument(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return false;
  }
}

function computeLineDiff(prev: string[], next: string[]): string | null {
  let prefix = 0;
  const minLen = Math.min(prev.length, next.length);
  while (prefix < minLen && prev[prefix] === next[prefix]) prefix++;

  if (prefix === prev.length && prefix === next.length) return '';

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMid = prev.slice(prefix, prev.length - suffix);
  const newMid = next.slice(prefix, next.length - suffix);

  const oldSet = new Set(oldMid);
  const newSet = new Set(newMid);

  const removed: string[] = [];
  const added: string[] = [];
  for (const line of oldMid) {
    if (!newSet.has(line)) removed.push(line);
  }
  for (const line of newMid) {
    if (!oldSet.has(line)) added.push(line);
  }

  if (removed.length === 0 && added.length === 0) return '';

  const diffSize = removed.length + added.length;
  if (next.length > 0 && diffSize > next.length * diffBudgetRatio) return null;

  const parts: string[] = [];
  if (removed.length > 0) {
    parts.push(`Removed (${removed.length} lines):`);
    for (const line of removed) parts.push(`- ${line}`);
  }
  if (added.length > 0) {
    parts.push(`Added (${added.length} lines):`);
    for (const line of added) parts.push(`+ ${line}`);
  }
  return parts.join('\n');
}

export function createPageDiffer() {
  let last: PageSnapshotState | undefined;

  return {
    reset() {
      last = undefined;
    },
    format(url: string, text: string, options?: { full?: boolean; headerPrefix?: string }): string {
      const lines = splitLines(text);
      const prev = last;
      last = { url, lines };

      if (!options?.full && prev && sameDocument(prev.url, url)) {
        const diff = computeLineDiff(prev.lines, lines);
        if (diff === '') return `URL: ${url}\n(page unchanged)`;
        if (diff !== null) {
          return `URL: ${url}\n(changes since previous view; call snapshot for full page)\n${diff}`;
        }
      }
      return `URL: ${url}\n${text}`;
    },
  };
}
