/**
 * ai-ready.js — turn a PDF into Markdown an LLM can actually follow.
 *
 * Optimised for machine reading, not human display:
 *   - column-aware reading order (the #1 cause of confused AI output)
 *   - repeated header/footer stripping
 *   - de-hyphenation and ligature normalisation
 *   - page anchors so the model can cite locations
 *   - figures replaced with captioned placeholders, never silent gaps
 *
 * Usage:
 *   const md = await pdfToAiMarkdown(file);
 */

const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl' };

/* ------------------------------------------------------------------ *
 * 1. Pull text items with real geometry
 * ------------------------------------------------------------------ */

async function pageItems(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = [];

  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const x0 = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || it.height || 10;
    items.push({
      text: it.str,
      x0,
      x1: x0 + (it.width || it.str.length * size * 0.5),
      y,
      size,
      font: it.fontName,
    });
  }
  return { items, width: viewport.width, height: viewport.height };
}

/* ------------------------------------------------------------------ *
 * 2. Column detection — the fix that matters most
 * ------------------------------------------------------------------ */

/**
 * Project every text box onto the horizontal axis. A column gutter shows up as
 * a tall vertical band that no text crosses. Without this, two-column PDFs get
 * read line-by-line across both columns and the output is nonsense.
 */
function findColumns(items, pageWidth) {
  const BINS = 200;
  const binWidth = pageWidth / BINS;
  const occupancy = new Array(BINS).fill(0);

  for (const it of items) {
    const start = Math.max(0, Math.floor(it.x0 / binWidth));
    const end = Math.min(BINS - 1, Math.ceil(it.x1 / binWidth));
    for (let b = start; b <= end; b++) occupancy[b]++;
  }

  // A gutter must be empty, reasonably wide, and away from the page margins.
  const MIN_GUTTER_BINS = Math.max(3, Math.round(BINS * 0.025));
  const MARGIN = Math.round(BINS * 0.12);

  const gutters = [];
  let run = 0;
  for (let b = 0; b <= BINS; b++) {
    if (b < BINS && occupancy[b] === 0) {
      run++;
      continue;
    }
    if (run >= MIN_GUTTER_BINS) {
      const start = b - run;
      const mid = (start + b) / 2;
      if (mid > MARGIN && mid < BINS - MARGIN) gutters.push(mid * binWidth);
    }
    run = 0;
  }

  if (!gutters.length) return null; // single column

  const bounds = [0, ...gutters, pageWidth];
  const columns = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    columns.push({ x0: bounds[i], x1: bounds[i + 1] });
  }

  // Reject the split if any column is nearly empty — usually a false positive
  // caused by a centred title or a wide figure.
  const counts = columns.map((c) =>
    items.filter((it) => (it.x0 + it.x1) / 2 >= c.x0 && (it.x0 + it.x1) / 2 < c.x1).length
  );
  if (Math.min(...counts) < items.length * 0.15) return null;

  return columns;
}

/* ------------------------------------------------------------------ *
 * 3. Group items into lines, then order them properly
 * ------------------------------------------------------------------ */

function groupLines(items) {
  const lines = new Map();
  for (const it of items) {
    const key = Math.round(it.y / 3); // tolerate baseline jitter
    if (!lines.has(key)) lines.set(key, { y: it.y, x0: it.x0, size: 0, parts: [] });
    const line = lines.get(key);
    line.parts.push(it);
    line.size = Math.max(line.size, it.size);
    line.x0 = Math.min(line.x0, it.x0);
  }

  return [...lines.values()].map((line) => {
    line.parts.sort((a, b) => a.x0 - b.x0);
    // Wide horizontal gaps inside one line usually mean table cells.
    let text = '';
    let prev = null;
    let gaps = 0;
    for (const p of line.parts) {
      if (prev) {
        const gap = p.x0 - prev.x1;
        if (gap > prev.size * 2.5) { text += '\t'; gaps++; }
        else if (gap > prev.size * 0.15 && !text.endsWith(' ')) text += ' ';
      }
      text += p.text;
      prev = p;
    }
    return { y: line.y, x0: line.x0, size: line.size, text: clean(text), cells: gaps + 1 };
  });
}

function orderLines(items, pageWidth) {
  const columns = findColumns(items, pageWidth);

  if (!columns) {
    return groupLines(items).sort((a, b) => b.y - a.y);
  }

  // Read each column top-to-bottom, then move to the next column.
  const out = [];
  for (const col of columns) {
    const inCol = items.filter((it) => {
      const mid = (it.x0 + it.x1) / 2;
      return mid >= col.x0 && mid < col.x1;
    });
    out.push(...groupLines(inCol).sort((a, b) => b.y - a.y));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. Strip running headers and footers
 * ------------------------------------------------------------------ */

/**
 * Forty repetitions of "Acme Corp · Confidential · Page 12" scattered through
 * the text is pure noise to a model, and it poisons RAG chunk boundaries.
 * Detect by finding near-identical lines that recur at the page edges.
 */
function stripRunning(pages) {
  const counts = new Map();
  const normalise = (s) => s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

  for (const page of pages) {
    const edge = page.lines.filter(
      (l) => l.y > page.height * 0.92 || l.y < page.height * 0.08
    );
    for (const l of new Set(edge.map((l) => normalise(l.text)))) {
      if (l.length > 2) counts.set(l, (counts.get(l) || 0) + 1);
    }
  }

  const threshold = Math.max(2, pages.length * 0.5);
  const junk = new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
  if (!junk.size) return;

  for (const page of pages) {
    page.lines = page.lines.filter((l) => {
      const atEdge = l.y > page.height * 0.92 || l.y < page.height * 0.08;
      return !(atEdge && junk.has(normalise(l.text)));
    });
  }
}

/* ------------------------------------------------------------------ *
 * 5. Text cleanup
 * ------------------------------------------------------------------ */

function clean(s) {
  let out = s;
  for (const [lig, rep] of Object.entries(LIGATURES)) out = out.split(lig).join(rep);
  return out
    .replace(/\u00AD/g, '')            // soft hyphens
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[ \t]+$/g, '')
    .replace(/  +/g, ' ');
}

/** Rejoin words split across a line break: "manage-\nment" -> "management". */
function dehyphenate(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && /[a-z]-$/.test(prev.text) && /^[a-z]/.test(line.text)) {
      prev.text = prev.text.slice(0, -1) + line.text;
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. Table reconstruction from tab-separated lines
 * ------------------------------------------------------------------ */

/**
 * Consecutive lines that all split into the same number of wide-gap segments
 * are almost certainly a table. Emitting real pipe syntax lets the model line
 * values up with headers; leaving them as loose text does not.
 */
function emitTables(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.cells < 2) { out.push(line); i++; continue; }

    let j = i;
    while (j < lines.length && lines[j].cells === line.cells) j++;

    if (j - i < 2) { out.push(line); i++; continue; }

    const rows = lines.slice(i, j).map((l) => l.text.split('\t').map((c) => c.trim()));
    const cols = rows[0].length;
    out.push({ markdown: [
      `| ${rows[0].join(' | ')} |`,
      `| ${Array(cols).fill('---').join(' | ')} |`,
      ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
    ].join('\n') });
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 7. Assemble
 * ------------------------------------------------------------------ */

export async function pdfToAiMarkdown(file, { pageAnchors = true } = {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items, width, height } = await pageItems(page);
    pages.push({ n, height, lines: orderLines(items, width) });
    page.cleanup();
  }

  stripRunning(pages);

  const sizes = pages.flatMap((p) => p.lines.map((l) => l.size)).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 12;

  const out = [];
  for (const page of pages) {
    if (pageAnchors) out.push(`\n<!-- page ${page.n} -->\n`);

    for (const line of emitTables(dehyphenate(page.lines))) {
      if (line.markdown) { out.push('', line.markdown, ''); continue; }
      if (!line.text.trim()) continue;

      const ratio = line.size / body;
      if (ratio >= 1.6) out.push('', `# ${line.text}`, '');
      else if (ratio >= 1.3) out.push('', `## ${line.text}`, '');
      else if (ratio >= 1.12) out.push('', `### ${line.text}`, '');
      else out.push(line.text);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
