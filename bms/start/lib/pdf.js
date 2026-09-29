import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/* Renders a discovery submission as a PDF anyone can read, skim on a phone,
 * or drop into a client folder.
 *
 * This runs alongside the answers.json attachment rather than replacing it:
 * the JSON is for machines (CRM import, automation), this is for people. The
 * two audiences want genuinely different things and one file can't serve both.
 *
 * Deliberately uses the built-in Helvetica rather than embedding Montserrat —
 * pdf-lib can only embed TTF/OTF and the sites ship woff2, so embedding would
 * mean carrying a second copy of the font purely for this. Brand comes through
 * in colour and layout instead, which is the part that actually reads. */

const PAGE = { w: 612, h: 792 };                 // US Letter, in points
// The footer sits at y=30 and is 8pt tall, so content can safely run to 46
// without colliding. Reserving 56 wasted ten points on every page and was
// enough to push a short trailing section onto a page of its own.
const M = { top: 64, bottom: 46, left: 56, right: 56 };
const CONTENT_W = PAGE.w - M.left - M.right;

const hexRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/* Greedy wrap. Also breaks a single word that is itself wider than the column
 * (a pasted URL, usually) so it can never run off the page edge. */
function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxW) { line = candidate; continue; }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxW) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxW) { out.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    if (line) out.push(line);
  }
  return out;
}

export async function buildSubmissionPdf({ id, receivedAt, data = {}, rows = [], files = [], brand = {} }) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = hexRgb(brand.ink || '#161B26');
  // Neutral fallbacks on purpose: a brand colour defaulted here would be
  // silently inherited by the next brand that copies this file.
  const accent = hexRgb(brand.accent || '#4C5566');
  const steel = hexRgb('#4C5566');
  const line = hexRgb('#E1E5EB');

  let logo = null;
  if (brand.logoPng) {
    // A malformed logo must not cost us the whole document.
    try { logo = await doc.embedPng(brand.logoPng); } catch { logo = null; }
  }

  const pages = [];
  let page, y;

  function newPage() {
    page = doc.addPage([PAGE.w, PAGE.h]);
    pages.push(page);
    // Brand band across the top of every page.
    page.drawRectangle({ x: 0, y: PAGE.h - 8, width: PAGE.w, height: 8, color: accent });
    y = PAGE.h - M.top;
  }

  function room(need) { return y - need >= M.bottom; }
  function ensure(need) { if (!room(need)) newPage(); }

  function text(str, { font = reg, size = 10.5, color = ink, x = M.left, gap = 4, maxW = CONTENT_W } = {}) {
    for (const ln of wrap(str, font, size, maxW)) {
      ensure(size + gap);
      if (ln) page.drawText(ln, { x, y: y - size, size, font, color });
      y -= size + gap;
    }
  }

  newPage();

  /* ---- masthead ---- */
  if (logo) {
    const h = 26;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: M.left, y: y - h + 6, width: Math.min(w, 200), height: h });
    y -= h + 18;
  } else {
    text(brand.name || '', { font: bold, size: 12, color: accent });
    y -= 8;
  }

  text('Discovery summary', { font: bold, size: 24 });
  y -= 2;
  const business = data.businessName || [data.firstName, data.lastName].filter(Boolean).join(' ') || 'Submission';
  text(business, { size: 14, color: steel });
  y -= 10;

  const received = receivedAt ? new Date(receivedAt) : new Date();
  const stamp = received.toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short'
  });
  text(`Received ${stamp} ET   ·   Reference ${id || '—'}`, { size: 9, color: steel });

  y -= 10;
  ensure(12);
  page.drawLine({ start: { x: M.left, y }, end: { x: PAGE.w - M.right, y }, thickness: 1, color: line });
  y -= 20;

  /* ---- contact ---- */
  const contact = [
    ['Name', [data.firstName, data.lastName].filter(Boolean).join(' ')],
    ['Role', data.role], ['Business', data.businessName], ['Email', data.email],
    ['Phone', data.phone], ['Website', data.website], ['Location', data.location],
    ['Prefers', data.contactPref], ['Wants to start', data.timeline]
  ].filter((r) => r[1]);

  if (contact.length) {
    text('Contact', { font: bold, size: 11, color: accent });
    y -= 6;
    const labelW = 108;
    for (const [k, v] of contact) {
      const lines = wrap(v, reg, 10.5, CONTENT_W - labelW);
      ensure(lines.length * 14 + 4);
      page.drawText(k, { x: M.left, y: y - 10.5, size: 9.5, font: bold, color: steel });
      lines.forEach((ln, i) => {
        page.drawText(ln, { x: M.left + labelW, y: y - 10.5 - i * 14, size: 10.5, font: reg, color: ink });
      });
      y -= lines.length * 14 + 4;
    }
    y -= 12;
  }

  /* ---- answers, grouped by the section they came from ---- */
  const grouped = [];
  for (const r of rows) {
    let g = grouped.find((x) => x[0] === r.section);
    if (!g) grouped.push((g = [r.section, []]));
    g[1].push(r);
  }

  for (const [section, items] of grouped) {
    // Keep a heading with at least its first answer rather than stranding it
    // at the foot of a page.
    ensure(64);
    text(section, { font: bold, size: 11, color: accent });
    y -= 4;
    for (const item of items) {
      ensure(30);
      page.drawLine({ start: { x: M.left, y: y + 6 }, end: { x: PAGE.w - M.right, y: y + 6 }, thickness: 0.5, color: line });
      y -= 4;
      text(item.label, { font: bold, size: 9.5, color: steel, gap: 3 });
      text(item.value, { size: 10.5, gap: 4 });
      y -= 8;
    }
    y -= 8;
  }

  /* ---- uploads ---- */
  if (files.length) {
    // Reserve roughly what this block needs (heading + rows + footnote),
    // capped so a long list still breaks rather than demanding a whole page.
    ensure(Math.min(34 + files.length * 15 + 13, 200));
    text('Files uploaded', { font: bold, size: 11, color: accent });
    y -= 4;
    for (const f of files) {
      ensure(20);
      const size = f.size ? ` (${(f.size / 1024).toFixed(0)} KB)` : '';
      text(`• ${f.name || f.path || 'file'}${size}`, { size: 10.5 });
    }
    y -= 6;
    text('Download links are in the notification email and expire for security.', { size: 9, color: steel });
  }

  /* ---- footer on every page, added last so the count is known ---- */
  pages.forEach((p, i) => {
    const label = `${brand.name || ''}  ·  ${id || ''}  ·  Page ${i + 1} of ${pages.length}`;
    p.drawText(label, {
      x: M.left, y: 30, size: 8, font: reg, color: steel,
      maxWidth: CONTENT_W
    });
  });

  return doc.save();
}
