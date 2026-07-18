#!/usr/bin/env node
/**
 * Deterministic DiagramSpec -> SVG renderer.
 *
 * Pure Node.js (fs + path only). No layout engine, no canvas: text width is
 * estimated (chars * fontSize * factor) since there is no font-metrics API
 * available in a plain Node process. This is "good enough" because every
 * dimension in the diagram (box size, wrapping, row height) is derived from
 * that same estimate, so nothing needs to line up against a real renderer -
 * it only needs to be internally consistent.
 *
 * Usage:
 *   const { renderDiagram, loadDesignSystem } = require('./render-svg');
 *   const svg = renderDiagram(spec);
 *
 * CLI:
 *   node render-svg.js <spec.json> <out.svg>
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Design system loading
// ---------------------------------------------------------------------------

function loadDesignSystem() {
  const p = path.join(__dirname, 'design-system.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return ch;
    }
  });
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// Character-width estimate: no canvas/font-metrics available.
function charFactor(bold) {
  return bold ? 0.62 : 0.58;
}

function measureText(text, fontSize, bold) {
  return String(text).length * fontSize * charFactor(bold);
}

// Greedy word-wrap for plain (single-weight) text.
function wrapPlain(text, maxWidth, fontSize, bold) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (cur === '' || measureText(test, fontSize, bold) <= maxWidth) {
      cur = test;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Greedy word-wrap over a list of {text, bold} words (used for panel items
// where the leading "term" is bold and the rest of the description is not).
function wrapWords(words, maxWidth, fontSize) {
  const lines = [];
  let cur = [];
  let curWidth = 0;
  const spaceW = fontSize * charFactor(false) * 0.9;
  for (const word of words) {
    const w = measureText(word.text, fontSize, word.bold);
    const extra = curWidth === 0 ? w : curWidth + spaceW + w;
    if (curWidth === 0 || extra <= maxWidth) {
      cur.push(word);
      curWidth = extra;
    } else {
      lines.push(cur);
      cur = [word];
      curWidth = w;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function lineHeightOf(fontSize) {
  return fontSize * 1.25;
}

// ---------------------------------------------------------------------------
// SVG string builders
// ---------------------------------------------------------------------------

function attrsToStr(attrs) {
  const parts = [];
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    parts.push(`${k}="${v}"`);
  }
  return parts.join(' ');
}

function tag(name, attrs, inner) {
  const a = attrsToStr(attrs);
  if (inner === undefined) return `<${name}${a ? ' ' + a : ''}/>`;
  return `<${name}${a ? ' ' + a : ''}>${inner}</${name}>`;
}

function textEl(x, y, text, opts) {
  opts = opts || {};
  const attrs = {
    x: round(x),
    y: round(y),
    'font-family': opts.fontFamily,
    'font-size': opts.size,
    'font-weight': opts.bold ? 'bold' : 'normal',
    'font-style': opts.italic ? 'italic' : undefined,
    fill: opts.color || '#111111',
    'text-anchor': opts.anchor || 'start',
  };
  return tag('text', attrs, escapeXml(text));
}

// A <text> made of bold/normal tspans, used for panel items (bold term +
// normal description) sharing one baseline.
function mixedTextEl(x, y, segments, opts) {
  opts = opts || {};
  const attrs = {
    x: round(x),
    y: round(y),
    'font-family': opts.fontFamily,
    'font-size': opts.size,
    fill: opts.color || '#111111',
    'text-anchor': opts.anchor || 'start',
  };
  let inner = '';
  segments.forEach((seg, i) => {
    const sp = i > 0 ? ' ' : '';
    inner += `<tspan font-weight="${seg.bold ? 'bold' : 'normal'}">${escapeXml(sp + seg.text)}</tspan>`;
  });
  return tag('text', attrs, inner);
}

// ---------------------------------------------------------------------------
// Node measurement + shape sizing
// ---------------------------------------------------------------------------

function measureNode(node, design) {
  const typ = design.typography;
  const nd = design.node;
  const boxWidth = design.canvas.columnWidth;
  const innerWidth = boxWidth - nd.paddingX * 2;
  const bulletPrefix = nd.bullet + ' ';
  const bulletIndent = measureText(bulletPrefix, typ.nodeLine.size, false);

  const titleLines = wrapPlain(node.title, innerWidth, typ.nodeTitle.size, true);
  const titleLineH = lineHeightOf(typ.nodeTitle.size);
  const titleBlockH = titleLines.length * titleLineH;

  const rawLines = node.lines || [];
  const isBulleted = node.type === 'process' || node.type === 'note';
  const contentRows = [];
  for (const raw of rawLines) {
    const avail = isBulleted ? innerWidth - bulletIndent : innerWidth;
    const wrapped = wrapPlain(raw, avail, typ.nodeLine.size, false);
    wrapped.forEach((txt, i) => contentRows.push({ text: txt, first: i === 0 }));
  }
  const lineH = lineHeightOf(typ.nodeLine.size);
  const contentBlockH = contentRows.length
    ? contentRows.length * lineH + (rawLines.length - 1) * nd.lineGap
    : 0;

  if (node.type === 'decision') {
    return sizeDecision(node, design);
  }

  if (node.type === 'datastore') {
    const cap = Math.max(10, boxWidth * 0.07);
    const height =
      nd.paddingY * 2 + cap * 2 + titleBlockH + (contentRows.length ? nd.titleLineGap + contentBlockH : 0);
    return {
      width: boxWidth,
      height: Math.max(height, cap * 4 + 20),
      titleLines,
      contentRows,
      cap,
      bulletIndent,
    };
  }

  // process / note
  const height = nd.paddingY * 2 + titleBlockH + (contentRows.length ? nd.titleLineGap + contentBlockH : 0);
  return { width: boxWidth, height, titleLines, contentRows, bulletIndent };
}

function sizeDecision(node, design) {
  const typ = design.typography;
  const nd = design.node;
  // Diamonds taper toward their corners, so the usable text band is roughly
  // half the bounding box; size generously and cap at the column width so
  // grid math (fixed column x-positions) still holds.
  const maxTextWidth = design.canvas.columnWidth - nd.paddingX * 4;
  const lines = wrapPlain(node.title, maxTextWidth, typ.nodeTitle.size, true);
  const lineH = lineHeightOf(typ.nodeTitle.size);
  const textW = Math.max(...lines.map((l) => measureText(l, typ.nodeTitle.size, true)));
  const textH = lines.length * lineH;
  const width = Math.min(design.canvas.columnWidth, Math.max(150, textW * 2 + nd.paddingX * 4));
  const height = Math.max(96, textH * 2.2 + nd.paddingY * 4);
  return { width, height, titleLines: lines, contentRows: [] };
}

function categoryFor(node, design) {
  if (node.type === 'datastore') return design.categories.datastore;
  if (node.type === 'note') return design.categories[node.category || 'info'];
  if (node.type === 'decision') return design.categories[node.category || 'external'];
  return design.categories[node.category || 'system'];
}

// ---------------------------------------------------------------------------
// Grid layout
// ---------------------------------------------------------------------------

function layoutNodes(spec, design, gridTop) {
  const canvas = design.canvas;
  const measured = new Map();
  let usedColumns = 1;
  let maxRow = 0;
  for (const node of spec.nodes) {
    const m = measureNode(node, design);
    measured.set(node.id, m);
    usedColumns = Math.max(usedColumns, node.col + 1);
    maxRow = Math.max(maxRow, node.row);
  }
  usedColumns = Math.min(usedColumns, canvas.maxColumns);

  const rowHeights = [];
  for (let r = 0; r <= maxRow; r++) {
    let h = 0;
    for (const node of spec.nodes) {
      if (node.row === r) h = Math.max(h, measured.get(node.id).height);
    }
    rowHeights.push(h);
  }

  const rowTops = [];
  let y = gridTop;
  for (let r = 0; r <= maxRow; r++) {
    rowTops.push(y);
    y += rowHeights[r] + (rowHeights[r] > 0 ? canvas.rowGap : 0);
  }
  const gridBottom = maxRow >= 0 ? y - (rowHeights[maxRow] > 0 ? canvas.rowGap : 0) : gridTop;

  const layout = new Map();
  for (const node of spec.nodes) {
    const m = measured.get(node.id);
    const colX = canvas.padding + node.col * (canvas.columnWidth + canvas.columnGap);
    const cellX = colX + (canvas.columnWidth - m.width) / 2;
    const rowH = rowHeights[node.row];
    const cellY = rowTops[node.row] + (rowH - m.height) / 2;
    layout.set(node.id, {
      node,
      x: cellX,
      y: cellY,
      width: m.width,
      height: m.height,
      col: node.col,
      row: node.row,
      measured: m,
    });
  }

  const gridWidth = canvas.padding * 2 + usedColumns * canvas.columnWidth + (usedColumns - 1) * canvas.columnGap;

  return { layout, usedColumns, maxRow, rowHeights, rowTops, gridBottom, gridWidth };
}

// ---------------------------------------------------------------------------
// Shape drawing
// ---------------------------------------------------------------------------

function drawTextBlock(l, design) {
  const typ = design.typography;
  const nd = design.node;
  const m = l.measured;
  const cx = l.x + l.width / 2;
  const isCylinder = l.node.type === 'datastore';
  const isDiamond = l.node.type === 'decision';
  const topPad = isCylinder ? nd.paddingY + m.cap * 2 : nd.paddingY;
  let y = l.y + topPad;

  const titleLineH = lineHeightOf(typ.nodeTitle.size);
  const parts = [];
  const titleColor = typ.nodeTitle.color;
  const titleBaselineOffset = typ.nodeTitle.size * 0.88;

  if (isDiamond) {
    // Centered vertically as a block within the diamond.
    const blockH = m.titleLines.length * titleLineH;
    y = l.y + (l.height - blockH) / 2;
  }

  for (const line of m.titleLines) {
    parts.push(
      textEl(cx, y + titleBaselineOffset, line, {
        fontFamily: typ.fontFamily,
        size: typ.nodeTitle.size,
        bold: true,
        color: titleColor,
        anchor: 'middle',
      })
    );
    y += titleLineH;
  }

  if (m.contentRows.length && !isDiamond) {
    y += nd.titleLineGap - titleLineH + titleLineH; // land exactly on titleLineGap after last title line
    y = l.y + topPad + m.titleLines.length * titleLineH + nd.titleLineGap;
    const lineH = lineHeightOf(typ.nodeLine.size);
    const bulletPrefix = nd.bullet + ' ';
    const bulletIndent = m.bulletIndent;
    const leftX = l.x + nd.paddingX;
    const isBulleted = l.node.type === 'process' || l.node.type === 'note';
    let prevWasFirstOfNew = true;
    m.contentRows.forEach((row, idx) => {
      const baseline = y + typ.nodeLine.size * 0.85;
      if (isCylinder) {
        parts.push(
          textEl(cx, baseline, row.text, {
            fontFamily: typ.fontFamily,
            size: typ.nodeLine.size,
            color: typ.nodeLine.color,
            anchor: 'middle',
          })
        );
      } else if (isBulleted) {
        if (row.first) {
          parts.push(
            textEl(leftX, baseline, bulletPrefix + row.text, {
              fontFamily: typ.fontFamily,
              size: typ.nodeLine.size,
              color: typ.nodeLine.color,
              anchor: 'start',
            })
          );
        } else {
          parts.push(
            textEl(leftX + bulletIndent, baseline, row.text, {
              fontFamily: typ.fontFamily,
              size: typ.nodeLine.size,
              color: typ.nodeLine.color,
              anchor: 'start',
            })
          );
        }
      } else {
        parts.push(
          textEl(leftX, baseline, row.text, {
            fontFamily: typ.fontFamily,
            size: typ.nodeLine.size,
            color: typ.nodeLine.color,
            anchor: 'start',
          })
        );
      }
      y += lineH;
      // Extra gap between distinct bullets (not between wrapped continuations
      // of the same bullet) - approximate by adding lineGap whenever the next
      // row starts a new bullet.
      const next = m.contentRows[idx + 1];
      if (next && next.first) y += nd.lineGap;
    });
  }

  return parts.join('');
}

function drawNodeShape(l, design) {
  const cat = categoryFor(l.node, design);
  const nd = design.node;
  const parts = [];

  if (l.node.type === 'decision') {
    const cx = l.x + l.width / 2;
    const cy = l.y + l.height / 2;
    const points = [
      `${round(cx)},${round(l.y)}`,
      `${round(l.x + l.width)},${round(cy)}`,
      `${round(cx)},${round(l.y + l.height)}`,
      `${round(l.x)},${round(cy)}`,
    ].join(' ');
    parts.push(tag('polygon', { points, fill: cat.fill, stroke: cat.stroke, 'stroke-width': nd.strokeWidth }));
  } else if (l.node.type === 'datastore') {
    const cap = l.measured.cap;
    const rx = l.width / 2;
    const cx = l.x + rx;
    const topY = l.y + cap;
    const botY = l.y + l.height - cap;
    const bodyPath = [
      `M ${round(l.x)} ${round(topY)}`,
      `L ${round(l.x)} ${round(botY)}`,
      `A ${round(rx)} ${round(cap)} 0 0 0 ${round(l.x + l.width)} ${round(botY)}`,
      `L ${round(l.x + l.width)} ${round(topY)}`,
    ].join(' ');
    parts.push(tag('path', { d: bodyPath, fill: cat.fill, stroke: cat.stroke, 'stroke-width': nd.strokeWidth }));
    parts.push(
      tag('ellipse', {
        cx: round(cx),
        cy: round(topY),
        rx: round(rx),
        ry: round(cap),
        fill: cat.fill,
        stroke: cat.stroke,
        'stroke-width': nd.strokeWidth,
      })
    );
  } else {
    parts.push(
      tag('rect', {
        x: round(l.x),
        y: round(l.y),
        width: round(l.width),
        height: round(l.height),
        rx: nd.cornerRadius,
        ry: nd.cornerRadius,
        fill: cat.fill,
        stroke: cat.stroke,
        'stroke-width': nd.strokeWidth,
      })
    );
  }

  parts.push(drawTextBlock(l, design));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Anchors + edge routing
// ---------------------------------------------------------------------------

function topCenter(l) { return { x: l.x + l.width / 2, y: l.y }; }
function bottomCenter(l) { return { x: l.x + l.width / 2, y: l.y + l.height }; }
function leftMiddle(l) { return { x: l.x, y: l.y + l.height / 2 }; }
function rightMiddle(l) { return { x: l.x + l.width, y: l.y + l.height / 2 }; }

function routeEdge(a, b, design) {
  const gap = design.canvas.columnGap;

  if (b.row > a.row) {
    const p1 = bottomCenter(a);
    const p2 = topCenter(b);
    if (a.col === b.col) return [p1, p2];
    const midY = round(p1.y + (p2.y - p1.y) / 2);
    return [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2];
  }

  if (b.row === a.row) {
    if (b.col === a.col) {
      // Same cell row/col shouldn't happen for distinct nodes; fall back to
      // a vertical stub.
      return [bottomCenter(a), topCenter(b)];
    }
    const forward = b.col > a.col;
    const p1 = forward ? rightMiddle(a) : leftMiddle(a);
    const p2 = forward ? leftMiddle(b) : rightMiddle(b);
    if (Math.abs(p1.y - p2.y) < 0.5) return [p1, p2];
    const midX = round((p1.x + p2.x) / 2);
    return [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
  }

  // Upward: b.row < a.row. Leave the side facing the target and route
  // through the column gap so the line doesn't cut through intervening rows.
  if (b.col < a.col) {
    const p1 = leftMiddle(a);
    const p2 = rightMiddle(b);
    const channelX = round((b.x + b.width + a.x) / 2);
    return [p1, { x: channelX, y: p1.y }, { x: channelX, y: p2.y }, p2];
  }
  if (b.col > a.col) {
    const p1 = rightMiddle(a);
    const p2 = leftMiddle(b);
    const channelX = round((a.x + a.width + b.x) / 2);
    return [p1, { x: channelX, y: p1.y }, { x: channelX, y: p2.y }, p2];
  }
  // Same column, straight up through a side channel just left of the column.
  const p1 = leftMiddle(a);
  const p2 = leftMiddle(b);
  const channelX = round(a.x - gap / 2);
  return [p1, { x: channelX, y: p1.y }, { x: channelX, y: p2.y }, p2];
}

function polylinePoints(points) {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

function segLength(p, q) {
  return Math.hypot(q.x - p.x, q.y - p.y);
}

function longestSegment(points) {
  let best = { i: 0, len: -1 };
  for (let i = 0; i < points.length - 1; i++) {
    const len = segLength(points[i], points[i + 1]);
    if (len > best.len) best = { i, len };
  }
  return { a: points[best.i], b: points[best.i + 1] };
}

function drawEdge(edge, layout, design, markerIds) {
  const a = layout.get(edge.from);
  const b = layout.get(edge.to);
  if (!a || !b) return ''; // caller validates ids; be defensive at render time

  const colorKey = edge.color || 'default';
  const stroke = design.edge.colors[colorKey] || design.edge.colors.default;
  const points = routeEdge(a, b, design);
  const markerId = markerIds[colorKey] || markerIds.default;

  const attrs = {
    points: polylinePoints(points),
    fill: 'none',
    stroke,
    'stroke-width': design.edge.strokeWidth,
    'marker-end': `url(#${markerId})`,
  };
  if (edge.style === 'dashed') attrs['stroke-dasharray'] = design.edge.dashArray;

  let out = tag('polyline', attrs);

  if (edge.label) {
    const seg = { a: points[0], b: points[1] };
    const mx = (seg.a.x + seg.b.x) / 2;
    const my = (seg.a.y + seg.b.y) / 2;
    const labelColor = design.edge.labelColors[edge.labelColor || 'default'] || design.edge.labelColors.default;
    const size = design.typography.edgeLabel.size;
    const w = measureText(edge.label, size, true) + 10;
    const h = size + 8;
    out += tag('rect', {
      x: round(mx - w / 2),
      y: round(my - h / 2),
      width: round(w),
      height: round(h),
      fill: '#FFFFFF',
      opacity: 0.92,
    });
    out += textEl(mx, my + size * 0.32, edge.label, {
      fontFamily: design.typography.fontFamily,
      size,
      bold: true,
      color: labelColor,
      anchor: 'middle',
    });
  }

  if (edge.note) {
    const seg = longestSegment(points);
    const mx = (seg.a.x + seg.b.x) / 2;
    const my = (seg.a.y + seg.b.y) / 2;
    const size = design.typography.nodeLine.size - 1;
    const maxW = Math.max(120, Math.abs(seg.b.x - seg.a.x) - 20);
    const noteLines = wrapPlain(edge.note, maxW, size, false);
    const boxW = Math.max(...noteLines.map((l) => measureText(l, size, false))) + 12;
    const boxH = noteLines.length * lineHeightOf(size) + 8;
    out += tag('rect', {
      x: round(mx - boxW / 2),
      y: round(my - boxH / 2),
      width: round(boxW),
      height: round(boxH),
      fill: '#FFFFFF',
      opacity: 0.9,
    });
    noteLines.forEach((line, i) => {
      const ly = my - boxH / 2 + 4 + (i + 1) * lineHeightOf(size) - lineHeightOf(size) * 0.25;
      out += textEl(mx, ly, line, {
        fontFamily: design.typography.fontFamily,
        size,
        italic: true,
        color: design.edge.colors.muted,
        anchor: 'middle',
      });
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Actor icons (hand-drawn glyphs, ~iconSize box centered at 0,0 then translated)
// ---------------------------------------------------------------------------

function iconGlyph(icon, size, color) {
  const s = size;
  const parts = [];
  const sw = Math.max(1.4, s * 0.05);
  switch (icon) {
    case 'bank': {
      // Pediment triangle + columns + base
      parts.push(tag('polygon', { points: `0,${-s * 0.5} ${s * 0.48},${-s * 0.18} ${-s * 0.48},${-s * 0.18}`, fill: color }));
      for (let i = -1; i <= 1; i++) {
        parts.push(
          tag('rect', {
            x: round(i * s * 0.28 - s * 0.05),
            y: round(-s * 0.14),
            width: round(s * 0.1),
            height: round(s * 0.5),
            fill: color,
          })
        );
      }
      parts.push(tag('rect', { x: round(-s * 0.5), y: round(s * 0.36), width: round(s), height: round(s * 0.1), fill: color }));
      break;
    }
    case 'server': {
      for (let i = 0; i < 3; i++) {
        const y = -s * 0.42 + i * s * 0.32;
        parts.push(
          tag('rect', {
            x: round(-s * 0.45),
            y: round(y),
            width: round(s * 0.9),
            height: round(s * 0.24),
            rx: 3,
            fill: 'none',
            stroke: color,
            'stroke-width': sw,
          })
        );
        parts.push(tag('circle', { cx: round(s * 0.28), cy: round(y + s * 0.12), r: round(s * 0.03), fill: color }));
      }
      break;
    }
    case 'user': {
      parts.push(tag('circle', { cx: 0, cy: round(-s * 0.18), r: round(s * 0.22), fill: color }));
      parts.push(
        tag('path', {
          d: `M ${round(-s * 0.38)} ${round(s * 0.42)} A ${round(s * 0.38)} ${round(s * 0.34)} 0 0 1 ${round(s * 0.38)} ${round(s * 0.42)} Z`,
          fill: color,
        })
      );
      break;
    }
    case 'globe': {
      parts.push(tag('circle', { cx: 0, cy: 0, r: round(s * 0.46), fill: 'none', stroke: color, 'stroke-width': sw }));
      parts.push(tag('ellipse', { cx: 0, cy: 0, rx: round(s * 0.2), ry: round(s * 0.46), fill: 'none', stroke: color, 'stroke-width': sw }));
      parts.push(tag('line', { x1: round(-s * 0.46), y1: 0, x2: round(s * 0.46), y2: 0, stroke: color, 'stroke-width': sw }));
      parts.push(tag('ellipse', { cx: 0, cy: 0, rx: round(s * 0.46), ry: round(s * 0.18), fill: 'none', stroke: color, 'stroke-width': sw }));
      break;
    }
    case 'database': {
      const rx = s * 0.42;
      const cap = s * 0.14;
      parts.push(
        tag('path', {
          d: `M ${round(-rx)} ${round(-s * 0.3 + cap)} L ${round(-rx)} ${round(s * 0.3 - cap)} A ${round(rx)} ${round(cap)} 0 0 0 ${round(rx)} ${round(s * 0.3 - cap)} L ${round(rx)} ${round(-s * 0.3 + cap)}`,
          fill: 'none',
          stroke: color,
          'stroke-width': sw,
        })
      );
      parts.push(tag('ellipse', { cx: 0, cy: round(-s * 0.3 + cap), rx: round(rx), ry: round(cap), fill: 'none', stroke: color, 'stroke-width': sw }));
      break;
    }
    case 'gear': {
      parts.push(tag('circle', { cx: 0, cy: 0, r: round(s * 0.2), fill: 'none', stroke: color, 'stroke-width': sw }));
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i;
        const cx = Math.cos(ang) * s * 0.35;
        const cy = Math.sin(ang) * s * 0.35;
        parts.push(
          tag('rect', {
            x: round(cx - s * 0.07),
            y: round(cy - s * 0.07),
            width: round(s * 0.14),
            height: round(s * 0.14),
            fill: color,
            transform: `rotate(${round((ang * 180) / Math.PI)} ${round(cx)} ${round(cy)})`,
          })
        );
      }
      break;
    }
    case 'shield': {
      parts.push(
        tag('path', {
          d: `M 0 ${round(-s * 0.46)} L ${round(s * 0.4)} ${round(-s * 0.3)} L ${round(s * 0.4)} ${round(s * 0.08)} Q ${round(s * 0.4)} ${round(s * 0.4)} 0 ${round(s * 0.5)} Q ${round(-s * 0.4)} ${round(s * 0.4)} ${round(-s * 0.4)} ${round(s * 0.08)} L ${round(-s * 0.4)} ${round(-s * 0.3)} Z`,
          fill: 'none',
          stroke: color,
          'stroke-width': sw,
        })
      );
      break;
    }
    case 'doc':
    default: {
      const w = s * 0.7;
      const h = s * 0.9;
      const fold = s * 0.18;
      parts.push(
        tag('path', {
          d: `M ${round(-w / 2)} ${round(-h / 2)} L ${round(w / 2 - fold)} ${round(-h / 2)} L ${round(w / 2)} ${round(-h / 2 + fold)} L ${round(w / 2)} ${round(h / 2)} L ${round(-w / 2)} ${round(h / 2)} Z`,
          fill: 'none',
          stroke: color,
          'stroke-width': sw,
        })
      );
      parts.push(tag('path', { d: `M ${round(w / 2 - fold)} ${round(-h / 2)} L ${round(w / 2 - fold)} ${round(-h / 2 + fold)} L ${round(w / 2)} ${round(-h / 2 + fold)}`, fill: 'none', stroke: color, 'stroke-width': sw }));
      for (let i = 0; i < 3; i++) {
        parts.push(tag('line', { x1: round(-w / 2 + 6), y1: round(-h / 6 + i * 8), x2: round(w / 2 - 6), y2: round(-h / 6 + i * 8), stroke: color, 'stroke-width': sw * 0.8 }));
      }
      break;
    }
  }
  return parts.join('');
}

function drawActorRow(spec, design, y, canvasWidth) {
  const actors = spec.actors || [];
  if (actors.length === 0) return { svg: '', height: 0 };
  const ar = design.actorRow;
  const typ = design.typography;
  const cellW = canvasWidth / actors.length;
  const iconCy = y + ar.iconSize / 2;
  const labelY = y + ar.iconSize + 16;
  const sublabelY = labelY + typ.actorLabel.size + 6;

  let svg = '';
  actors.forEach((actor, i) => {
    const cx = cellW * (i + 0.5);
    const color = ar.iconColors[actor.color || 'gray'];
    svg += tag('g', { transform: `translate(${round(cx)} ${round(iconCy)})` }, iconGlyph(actor.icon, ar.iconSize, color));
    svg += textEl(cx, labelY, actor.label, {
      fontFamily: typ.fontFamily,
      size: typ.actorLabel.size,
      bold: true,
      color: typ.actorLabel.color,
      anchor: 'middle',
    });
    if (actor.sublabel) {
      svg += textEl(cx, sublabelY, actor.sublabel, {
        fontFamily: typ.fontFamily,
        size: typ.actorSublabel.size,
        color: typ.actorSublabel.color,
        anchor: 'middle',
      });
    }
  });

  const contentHeight = ar.iconSize + 16 + typ.actorLabel.size + 6 + typ.actorSublabel.size;
  const sepY = y + contentHeight + ar.gapBelow;
  svg += tag('line', {
    x1: round(design.canvas.padding),
    y1: round(sepY),
    x2: round(canvasWidth - design.canvas.padding),
    y2: round(sepY),
    stroke: ar.separator.stroke,
    'stroke-width': 1,
    'stroke-dasharray': ar.separator.dashArray,
  });

  const totalHeight = contentHeight + ar.gapBelow;
  return { svg, height: totalHeight };
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ['system', 'external', 'success', 'error', 'reversal', 'info', 'neutral'];

function usedCategories(spec) {
  const set = new Set();
  for (const n of spec.nodes) {
    if (n.type === 'datastore') continue;
    const cat = n.type === 'note' ? n.category || 'info' : n.type === 'decision' ? n.category || 'external' : n.category || 'system';
    set.add(cat);
  }
  return CATEGORY_ORDER.filter((c) => set.has(c));
}

function measureLegend(spec, design) {
  const cats = usedCategories(spec);
  const hasDatastore = spec.nodes.some((n) => n.type === 'datastore');
  const rows = cats.length + (hasDatastore ? 1 : 0);
  const typ = design.typography;
  const lg = design.legend;
  const rowH = Math.max(lg.swatchHeight, typ.panelItem.size + 4) + 8;
  const titleH = typ.panelTitle.size + 10;

  let maxLabelW = measureText(lg.title, typ.panelTitle.size, true);
  for (const c of cats) {
    maxLabelW = Math.max(maxLabelW, measureText(design.categories[c].label, typ.panelItem.size, false));
  }
  if (hasDatastore) {
    maxLabelW = Math.max(maxLabelW, measureText(design.categories.datastore.label, typ.panelItem.size, false));
  }

  const width = 16 + lg.swatchWidth + 10 + maxLabelW + 16;
  const height = 12 + titleH + rows * rowH + 10;
  return { width, height, cats, hasDatastore, rowH, titleH };
}

function drawLegend(spec, design, x, y) {
  const m = measureLegend(spec, design);
  const lg = design.legend;
  const typ = design.typography;
  let svg = tag('rect', {
    x: round(x),
    y: round(y),
    width: round(m.width),
    height: round(m.height),
    rx: lg.border.radius,
    ry: lg.border.radius,
    fill: '#FFFFFF',
    stroke: lg.border.stroke,
    'stroke-width': 1.4,
    'stroke-dasharray': lg.border.dashArray,
  });
  svg += textEl(x + 14, y + m.titleH, lg.title, {
    fontFamily: typ.fontFamily,
    size: typ.panelTitle.size,
    bold: true,
    color: '#111111',
  });

  let rowY = y + m.titleH + 14;
  const drawSwatchRow = (fill, stroke, label, isCylinder) => {
    const sw = lg.swatchWidth;
    const sh = lg.swatchHeight;
    const sx = x + 16;
    const sy = rowY - sh * 0.7;
    if (isCylinder) {
      const cap = sh * 0.28;
      svg += tag('path', {
        d: `M ${round(sx)} ${round(sy + cap)} L ${round(sx)} ${round(sy + sh - cap)} A ${round(sw / 2)} ${round(cap)} 0 0 0 ${round(sx + sw)} ${round(sy + sh - cap)} L ${round(sx + sw)} ${round(sy + cap)}`,
        fill,
        stroke,
        'stroke-width': 1.2,
      });
      svg += tag('ellipse', { cx: round(sx + sw / 2), cy: round(sy + cap), rx: round(sw / 2), ry: round(cap), fill, stroke, 'stroke-width': 1.2 });
    } else {
      svg += tag('rect', { x: round(sx), y: round(sy), width: round(sw), height: round(sh), rx: 3, fill, stroke, 'stroke-width': 1.2 });
    }
    svg += textEl(sx + sw + 10, rowY, label, {
      fontFamily: typ.fontFamily,
      size: typ.panelItem.size,
      color: typ.panelItem.color,
      anchor: 'start',
    });
    rowY += m.rowH;
  };

  for (const c of m.cats) {
    const cat = design.categories[c];
    drawSwatchRow(cat.fill, cat.stroke, cat.label, false);
  }
  if (m.hasDatastore) {
    const cat = design.categories.datastore;
    drawSwatchRow(cat.fill, cat.stroke, cat.label, true);
  }

  return { svg, width: m.width, height: m.height };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function measurePanel(panel, width, design) {
  const typ = design.typography;
  const pn = design.panel;
  const innerWidth = width - pn.paddingX * 2;
  const titleH = typ.panelTitle.size + 8;
  const lineH = lineHeightOf(typ.panelItem.size);

  let itemsH = 0;
  const wrappedItems = [];
  for (const item of panel.items) {
    const words = [
      ...String(item.term).split(/\s+/).map((t) => ({ text: t, bold: true })),
      ...String(item.description).split(/\s+/).map((t) => ({ text: t, bold: false })),
    ];
    const lines = wrapWords(words, innerWidth, typ.panelItem.size);
    wrappedItems.push(lines);
    itemsH += lines.length * lineH + 4;
  }

  const height = pn.paddingY * 2 + titleH + 6 + itemsH;
  return { height, wrappedItems, titleH, lineH };
}

function drawPanel(panel, x, y, width, design) {
  const cat = design.categories[panel.category || 'info'];
  const typ = design.typography;
  const pn = design.panel;
  const m = measurePanel(panel, width, design);

  let svg = tag('rect', {
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(m.height),
    rx: pn.cornerRadius,
    ry: pn.cornerRadius,
    fill: cat.fill,
    stroke: cat.stroke,
    'stroke-width': pn.strokeWidth,
  });

  let ty = y + pn.paddingY + typ.panelTitle.size * 0.85;
  svg += textEl(x + pn.paddingX, ty, panel.title, {
    fontFamily: typ.fontFamily,
    size: typ.panelTitle.size,
    bold: true,
    color: cat.stroke,
  });
  ty += m.titleH;

  const leftX = x + pn.paddingX;
  panel.items.forEach((item, idx) => {
    const lines = m.wrappedItems[idx];
    lines.forEach((line) => {
      ty += m.lineH;
      svg += mixedTextEl(
        leftX,
        ty - m.lineH * 0.22,
        line.map((w) => ({ text: w.text, bold: w.bold })),
        {
          fontFamily: typ.fontFamily,
          size: typ.panelItem.size,
          color: typ.panelItem.color,
        }
      );
    });
    ty += 4;
  });

  return { svg, height: m.height };
}

// ---------------------------------------------------------------------------
// Markers (arrowheads)
// ---------------------------------------------------------------------------

function buildMarkers(design) {
  const colors = design.edge.colors;
  const size = design.edge.arrowSize;
  const ids = {};
  let defs = '';
  for (const key in colors) {
    const id = `arrow-${key}`;
    ids[key] = id;
    defs += tag(
      'marker',
      {
        id,
        markerWidth: size * 1.4,
        markerHeight: size * 1.4,
        refX: size * 1.1,
        refY: size / 2,
        orient: 'auto-start-reverse',
        markerUnits: 'userSpaceOnUse',
      },
      tag('path', { d: `M0,0 L${size},${size / 2} L0,${size} Z`, fill: colors[key] })
    );
  }
  return { defs, ids };
}

// ---------------------------------------------------------------------------
// Top-level assembly
// ---------------------------------------------------------------------------

function computeHeader(spec, design) {
  const typ = design.typography;
  const padding = design.canvas.padding;
  let y = padding;
  const titleH = lineHeightOf(typ.title.size);
  y += titleH;
  let subtitleH = 0;
  if (spec.subtitle) {
    subtitleH = lineHeightOf(typ.subtitle.size) + 6;
    y += subtitleH;
  }
  return { headerHeight: y - padding, titleBaseline: padding + typ.title.size * 0.85, subtitleBaseline: padding + titleH + typ.subtitle.size * 0.85 };
}

function renderDiagram(spec, options) {
  options = options || {};
  const design = options.design || loadDesignSystem();
  const canvas = design.canvas;
  const typ = design.typography;

  if (!spec || !Array.isArray(spec.nodes)) throw new Error('DiagramSpec requires a nodes array');

  const nodeIds = new Set(spec.nodes.map((n) => n.id));
  for (const e of spec.edges || []) {
    if (!nodeIds.has(e.from)) throw new Error(`Edge references unknown node id (from): ${e.from}`);
    if (!nodeIds.has(e.to)) throw new Error(`Edge references unknown node id (to): ${e.to}`);
  }

  // --- Header -------------------------------------------------------------
  const header = computeHeader(spec, design);
  let cursorY = canvas.padding + header.headerHeight;

  // --- Provisional grid layout to learn content width ----------------------
  const prelim = layoutNodes(spec, design, 0);
  const gridWidth = prelim.gridWidth;

  // Actor row / separator height (depends on final canvas width, but actor
  // row height itself doesn't depend on width - only x positions do).
  const hasActors = (spec.actors || []).length > 0;
  let actorRowHeight = 0;
  if (hasActors) {
    const ar = design.actorRow;
    actorRowHeight = ar.iconSize + 16 + typ.actorLabel.size + 6 + typ.actorSublabel.size + ar.gapBelow;
  }

  const gridTop = cursorY + (hasActors ? actorRowHeight + canvas.rowGap * 0.6 : canvas.rowGap * 0.6);

  const layoutResult = layoutNodes(spec, design, gridTop);
  const canvasWidth = Math.max(gridWidth, measureText(spec.title, typ.title.size, true) + canvas.padding * 2 + 40);

  // --- Legend ---------------------------------------------------------------
  const showLegend = spec.legend !== false;
  let legendSvg = '';
  let contentBottom = layoutResult.gridBottom;

  if (showLegend) {
    const legendM = measureLegend(spec, design);
    const maxRow = layoutResult.maxRow;
    const lastRowTop = layoutResult.rowTops[maxRow];
    const lastRowHeight = layoutResult.rowHeights[maxRow];

    // Look for free columns at the right of the last row to tuck the legend
    // into, otherwise fall back to placing it below the grid.
    let rightmostOccupied = -1;
    for (const node of spec.nodes) {
      if (node.row === maxRow) rightmostOccupied = Math.max(rightmostOccupied, node.col);
    }
    const freeStartCol = rightmostOccupied + 1;
    const freeWidth =
      (layoutResult.usedColumns - freeStartCol) * canvas.columnWidth +
      Math.max(0, layoutResult.usedColumns - freeStartCol - 1) * canvas.columnGap;

    if (freeStartCol < layoutResult.usedColumns && freeWidth >= legendM.width + 10 && lastRowHeight >= legendM.height) {
      const lx = canvas.padding + freeStartCol * (canvas.columnWidth + canvas.columnGap);
      const ly = lastRowTop + lastRowHeight - legendM.height;
      const drawn = drawLegend(spec, design, lx, ly);
      legendSvg = drawn.svg;
      // Grid bottom already accounts for this row; no extra height needed.
    } else {
      const lx = canvas.padding + gridWidth - canvas.padding * 2 - legendM.width;
      const ly = layoutResult.gridBottom + canvas.rowGap * 0.5;
      const drawn = drawLegend(spec, design, lx, ly);
      legendSvg = drawn.svg;
      contentBottom = ly + legendM.height;
    }
  }

  // --- Panels ---------------------------------------------------------------
  const panels = spec.panels || [];
  let panelsSvg = '';
  let panelsBottom = contentBottom;
  if (panels.length) {
    const panelsTop = contentBottom + canvas.rowGap;
    const perRow = 2;
    const panelGap = canvas.columnGap;
    const contentWidth = gridWidth - canvas.padding * 2;
    const panelWidth = perRow === 1 ? contentWidth : (contentWidth - panelGap * (perRow - 1)) / perRow;

    let rowTop = panelsTop;
    let rowMaxH = 0;
    panels.forEach((panel, i) => {
      const col = i % perRow;
      if (col === 0 && i !== 0) {
        rowTop += rowMaxH + panelGap;
        rowMaxH = 0;
      }
      const px = canvas.padding + col * (panelWidth + panelGap);
      const drawn = drawPanel(panel, px, rowTop, panelWidth, design);
      panelsSvg += drawn.svg;
      rowMaxH = Math.max(rowMaxH, drawn.height);
    });
    panelsBottom = rowTop + rowMaxH;
  }

  const canvasHeight = panelsBottom + canvas.padding;

  // --- Assemble SVG ----------------------------------------------------------
  const markers = buildMarkers(design);

  let body = '';
  body += tag('rect', { x: 0, y: 0, width: round(canvasWidth), height: round(canvasHeight), fill: canvas.background });

  body += textEl(canvasWidth / 2, header.titleBaseline, spec.title, {
    fontFamily: typ.fontFamily,
    size: typ.title.size,
    bold: true,
    color: typ.title.color,
    anchor: 'middle',
  });
  if (spec.subtitle) {
    body += textEl(canvasWidth / 2, header.subtitleBaseline, spec.subtitle, {
      fontFamily: typ.fontFamily,
      size: typ.subtitle.size,
      color: typ.subtitle.color,
      anchor: 'middle',
    });
  }

  if (hasActors) {
    const actorRow = drawActorRow(spec, design, cursorY, canvasWidth);
    body += actorRow.svg;
  }

  // Edges under nodes so box fills cleanly cover the anchor stubs.
  for (const edge of spec.edges || []) {
    body += drawEdge(edge, layoutResult.layout, design, markers.ids);
  }

  for (const node of spec.nodes) {
    body += drawNodeShape(layoutResult.layout.get(node.id), design);
  }

  body += legendSvg;
  body += panelsSvg;

  const defs = tag('defs', {}, markers.defs);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(canvasWidth)}" height="${round(canvasHeight)}" ` +
    `viewBox="0 0 ${round(canvasWidth)} ${round(canvasHeight)}" font-family="${typ.fontFamily}">` +
    defs +
    body +
    `</svg>`;

  return svg;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const [, , specPath, outPath] = process.argv;
  if (!specPath || !outPath) {
    console.error('Usage: node render-svg.js <spec.json> <out.svg>');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const svg = renderDiagram(spec);
  fs.writeFileSync(outPath, svg, 'utf8');
  const wMatch = svg.match(/width="([\d.]+)"/);
  const hMatch = svg.match(/height="([\d.]+)"/);
  console.log(`Wrote ${outPath} (${wMatch ? wMatch[1] : '?'}x${hMatch ? hMatch[1] : '?'})`);
}

if (require.main === module) {
  main();
}

module.exports = { renderDiagram, loadDesignSystem, escapeXml, wrapPlain, measureText };
