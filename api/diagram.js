'use strict';

/**
 * Diagram Studio API — single Vercel serverless function.
 *
 * POST /api/diagram with a JSON body:
 *   { "action": "generate", "description": "..." }         -> { spec, svg }
 *   { "action": "refine", "spec": {...}, "instruction": "..." } -> { spec, svg }
 *   { "action": "render", "spec": {...} }                   -> { spec, svg }
 *
 * "render" is deterministic and free (no LLM call) — it powers shareable
 * links, where the spec travels compressed in the URL fragment.
 *
 * Auth: if the DIAGRAM_STUDIO_TOKEN env var is set, requests must carry it
 * in the "x-access-token" header. Leave it unset for a personal/private
 * deployment. ANTHROPIC_API_KEY must be set as a Vercel env var for
 * generate/refine.
 */

const { renderDiagram } = require('../diagrams/render-svg');
const { generateSpec, refineSpec } = require('../diagrams/generate-diagram');

const MAX_BODY_CHARS = 200000;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Method not allowed — POST a JSON body.' });
    return;
  }

  const requiredToken = process.env.DIAGRAM_STUDIO_TOKEN;
  if (requiredToken && req.headers['x-access-token'] !== requiredToken) {
    send(res, 401, { error: 'Missing or invalid access token.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      send(res, 400, { error: 'Request body is not valid JSON.' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    send(res, 400, { error: 'Request body must be a JSON object.' });
    return;
  }
  if (JSON.stringify(body).length > MAX_BODY_CHARS) {
    send(res, 413, { error: 'Request body too large.' });
    return;
  }

  try {
    switch (body.action) {
      case 'generate': {
        if (!body.description || typeof body.description !== 'string') {
          send(res, 400, { error: '"description" (string) is required for generate.' });
          return;
        }
        const spec = await generateSpec(body.description);
        const svg = renderDiagram(spec);
        send(res, 200, { spec, svg });
        return;
      }
      case 'refine': {
        if (!body.spec || typeof body.spec !== 'object') {
          send(res, 400, { error: '"spec" (object) is required for refine.' });
          return;
        }
        if (!body.instruction || typeof body.instruction !== 'string') {
          send(res, 400, { error: '"instruction" (string) is required for refine.' });
          return;
        }
        const spec = await refineSpec(body.spec, body.instruction);
        const svg = renderDiagram(spec);
        send(res, 200, { spec, svg });
        return;
      }
      case 'render': {
        if (!body.spec || typeof body.spec !== 'object') {
          send(res, 400, { error: '"spec" (object) is required for render.' });
          return;
        }
        const svg = renderDiagram(body.spec);
        send(res, 200, { spec: body.spec, svg });
        return;
      }
      default:
        send(res, 400, { error: 'Unknown "action" — use generate, refine, or render.' });
        return;
    }
  } catch (err) {
    const message = err && err.message ? err.message : 'Internal error';
    // Key-configuration problems are the operator's fault, not the caller's.
    const status = /API key|authentication/i.test(message) ? 500 : 422;
    send(res, status, { error: message });
  }
};
