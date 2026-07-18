/**
 * Minimal YAML emitter — enough to write docker-compose files without
 * pulling in a dependency. Handles objects, arrays, strings, numbers, booleans.
 */
'use strict';

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s === '' || !PLAIN.test(s) || ['true', 'false', 'null', 'yes', 'no'].includes(s.toLowerCase())) {
    return JSON.stringify(s); // double-quoted, escapes handled
  }
  return s;
}

function emit(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const body = emit(item, indent + 1);
          return `${pad}-\n${body}`;
        }
        return `${pad}- ${scalar(item)}\n`;
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return `${pad}{}\n`;
    return entries
      .map(([k, v]) => {
        if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
          return `${pad}${scalar(k)}:\n${emit(v, indent + 1)}`;
        }
        if (v && typeof v === 'object') {
          return `${pad}${scalar(k)}: ${Array.isArray(v) ? '[]' : '{}'}\n`;
        }
        return `${pad}${scalar(k)}: ${scalar(v)}\n`;
      })
      .join('');
  }
  return `${pad}${scalar(value)}\n`;
}

function toYaml(obj) {
  return emit(obj, 0);
}

module.exports = { toYaml };
