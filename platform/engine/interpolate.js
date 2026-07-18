/**
 * Variable interpolation for plugin manifests and stack files.
 *
 * Supported placeholders inside any string value:
 *   ${port}                     -> value from the service's resolved config
 *   ${anyConfigKey}             -> any key from the service's resolved config
 *   ${service.<name>.<key>}     -> resolved config value of another service
 *   ${env.<NAME>}               -> environment variable of the host
 */
'use strict';

const PLACEHOLDER = /\$\{([a-zA-Z0-9_.-]+)\}/g;

function lookup(path, context) {
  const parts = path.split('.');
  if (parts[0] === 'env') {
    return process.env[parts.slice(1).join('.')] ?? '';
  }
  if (parts[0] === 'service') {
    const [, svcName, ...rest] = parts;
    const svc = context.services && context.services[svcName];
    if (!svc) {
      throw new Error(`Unknown service reference "\${${path}}" — no service named "${svcName}" in this stack`);
    }
    let value = svc.config;
    for (const key of rest) value = value == null ? undefined : value[key];
    if (value === undefined) {
      throw new Error(`Unknown key "\${${path}}" — service "${svcName}" has no config value "${rest.join('.')}"`);
    }
    return value;
  }
  let value = context.config;
  for (const key of parts) value = value == null ? undefined : value[key];
  if (value === undefined) {
    throw new Error(`Unknown placeholder "\${${path}}" in service "${context.name || '?'}"`);
  }
  return value;
}

function interpolateString(str, context) {
  // A string that is exactly one placeholder keeps its original type (numbers stay numbers)
  const exact = str.match(/^\$\{([a-zA-Z0-9_.-]+)\}$/);
  if (exact) {
    const v = lookup(exact[1], context);
    return typeof v === 'string' ? interpolateString(v, context) : v;
  }
  return str.replace(PLACEHOLDER, (_, path) => String(lookup(path, context)));
}

function interpolate(value, context) {
  if (typeof value === 'string') return interpolateString(value, context);
  if (Array.isArray(value)) return value.map((v) => interpolate(v, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, context);
    return out;
  }
  return value;
}

module.exports = { interpolate };
