#!/usr/bin/env node
'use strict';

/**
 * Architecture Diagram Generator — LLM pipeline
 *
 * Turns a plain-text / markdown / code description of a flow into a
 * DiagramSpec (validated JSON) via the Claude API, then (optionally) renders
 * it to SVG using the sibling `render-svg.js` module.
 *
 * Library usage:
 *   const { generateSpec, generateDiagram } = require('./generate-diagram');
 *   const spec = await generateSpec('...description...');
 *   const { spec, svg } = await generateDiagram('...description...');
 *
 * CLI usage:
 *   node generate-diagram.js --input flow.md --out diagram.svg [--spec-out spec.json] [--model claude-sonnet-5]
 *   node generate-diagram.js --prompt "describe the flow..." --out diagram.svg
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_OUT = 'diagram.svg';
const MAX_TOKENS = 64000;

const SYSTEM_PROMPT = `You are an expert systems architect who converts flow descriptions into DiagramSpec JSON for an automatic diagram renderer.

Design rules:
- Number process steps in flow order ("1. Receive Message", "2. Validate", ...) and use sub-numbers for exception branches ("4A. Mismatch / Not Found").
- Choose categories deliberately: system = actions our system performs (blue), external = validation/checks against external systems (orange), success = the happy-path completion steps (green), error = exception/rejection handling (red), reversal = later reversal/failure compensation (purple), info = explanatory note boxes (yellow).
- Use a decision node (diamond) for every branch point, with short question titles ("Do Details Match?"). Outgoing edges from decisions carry "Yes"/"No" labels with labelColor success/error.
- Use datastore nodes (cylinders) for ledgers, databases, and account stores; connect them with dashed muted edges from the steps that write to them.
- Lay out on the grid: main happy flow runs top-to-bottom around columns 1-3; error branches go to the right-hand columns (3-5); reversal/compensation flows go to the left-hand column 0; keep col in 0-5. Increment row for each sequential step; put parallel/branch nodes on the same row in different columns. Never place two nodes on the same (col,row).
- Add an actors header row identifying the participants (source system, our system, users, external references) with fitting icons.
- Add 1-3 info note boxes for concepts a reader might not know, near the step they explain.
- Finish with footer panels: a "Key Concepts" panel defining domain terms, and a "Statuses Used" panel if the flow has state/status transitions.
- Titles stay short; details go in bullet lines (3-5 words each). Keep the total under ~25 nodes; summarize instead of exhaustively enumerating.

Return ONLY the DiagramSpec JSON.`;

/**
 * Load the DiagramSpec JSON Schema from spec-schema.json, stripping the
 * top-level keys the structured-output API doesn't want.
 */
function loadSchema() {
  const schemaPath = path.join(__dirname, 'spec-schema.json');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw);
  delete schema.$schema;
  delete schema.title;
  return schema;
}

/**
 * Resolve the Anthropic API key: options.apiKey -> ANTHROPIC_API_KEY ->
 * config.json's "anthropicApiKey" field (repo root) -> throw.
 */
function resolveApiKey(options) {
  if (options && options.apiKey) {
    return options.apiKey;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }

  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      if (config && typeof config.anthropicApiKey === 'string' && config.anthropicApiKey.trim()) {
        return config.anthropicApiKey;
      }
    }
  } catch (err) {
    // Malformed/unreadable config.json — fall through to the error below
    // rather than crashing; the user still gets an actionable message.
  }

  throw new Error(
    'No Anthropic API key found. Set one with:\n' +
      '  export ANTHROPIC_API_KEY=your-key-here\n' +
      'or add an "anthropicApiKey" field to config.json in the repo root.'
  );
}

/**
 * Resolve the model id: options.model -> DIAGRAM_MODEL env -> default.
 */
function resolveModel(options) {
  if (options && options.model) {
    return options.model;
  }
  if (process.env.DIAGRAM_MODEL) {
    return process.env.DIAGRAM_MODEL;
  }
  return DEFAULT_MODEL;
}

/**
 * Minimal structural validation of a parsed DiagramSpec, beyond what the
 * schema/structured-output already guarantees.
 */
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('Diagram spec is not a valid JSON object.');
  }
  if (!spec.title || typeof spec.title !== 'string') {
    throw new Error('Diagram spec is missing a non-empty "title" string.');
  }
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    throw new Error('Diagram spec must have a non-empty "nodes" array.');
  }
  if (!Array.isArray(spec.edges)) {
    throw new Error('Diagram spec must have an "edges" array.');
  }

  const nodeIds = new Set(spec.nodes.map((n) => n && n.id));
  const badIds = new Set();
  for (const edge of spec.edges) {
    if (!edge || !nodeIds.has(edge.from)) {
      badIds.add(String(edge && edge.from));
    }
    if (!edge || !nodeIds.has(edge.to)) {
      badIds.add(String(edge && edge.to));
    }
  }
  if (badIds.size > 0) {
    throw new Error(
      `Diagram spec has edges referencing unknown node ids: ${Array.from(badIds).join(', ')}`
    );
  }

  return spec;
}

/**
 * Call Claude to turn a plain-text/markdown/code description into a
 * validated DiagramSpec object.
 *
 * @param {string} description
 * @param {{ apiKey?: string, model?: string }} [options]
 * @returns {Promise<object>} the parsed and validated DiagramSpec
 */
async function generateSpec(description, options = {}) {
  if (!description || !description.trim()) {
    throw new Error('generateSpec: "description" must be a non-empty string.');
  }

  const apiKey = resolveApiKey(options);
  const model = resolveModel(options);
  const schema = loadSchema();

  const client = new Anthropic({ apiKey });

  process.stderr.write(`Requesting diagram spec from ${model}...\n`);

  let message;
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: description }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error(
        'Anthropic API authentication failed — check that your API key is valid.'
      );
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Anthropic API rate limit hit — please retry later.');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new Error(
        `Could not reach the Anthropic API (network error): ${err.message}`
      );
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API error (status ${err.status}): ${err.message}`);
    }
    throw err;
  }

  if (message.stop_reason === 'max_tokens') {
    throw new Error('diagram spec truncated: response hit max_tokens before completing.');
  }
  if (message.stop_reason === 'refusal') {
    const details = message.stop_details
      ? JSON.stringify(message.stop_details)
      : '(no details provided)';
    throw new Error(`Claude refused to generate a diagram spec: ${details}`);
  }

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock) {
    throw new Error('Claude response contained no text block with the diagram spec.');
  }

  let spec;
  try {
    spec = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Failed to parse diagram spec JSON from Claude's response: ${err.message}`);
  }

  return validateSpec(spec);
}

/**
 * Full pipeline: description -> DiagramSpec (via Claude) -> SVG (via the
 * deterministic renderer). `render-svg.js` is required lazily so this module
 * can be loaded/used for spec generation alone even if the renderer isn't
 * ready yet.
 *
 * @param {string} description
 * @param {{ apiKey?: string, model?: string }} [options]
 * @returns {Promise<{ spec: object, svg: string }>}
 */
async function generateDiagram(description, options = {}) {
  const spec = await generateSpec(description, options);

  process.stderr.write('Rendering SVG...\n');
  const { renderDiagram } = require('./render-svg');
  const svg = renderDiagram(spec);

  return { spec, svg };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  process.stderr.write(
    [
      'Usage:',
      '  node generate-diagram.js --input <file> --out <file.svg> [--spec-out <file.json>] [--model <model-id>]',
      '  node generate-diagram.js --prompt "<description>" --out <file.svg> [--spec-out <file.json>] [--model <model-id>]',
      '',
      'Options:',
      '  --input      Path to a text/markdown/code file whose contents describe the flow',
      '  --prompt     Inline text description of the flow (alternative to --input)',
      '  --out        Output SVG path (default: diagram.svg)',
      '  --spec-out   Also write the intermediate DiagramSpec JSON to this path',
      '  --model      Claude model id to use (default: claude-sonnet-5, or DIAGRAM_MODEL env var)',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        args.input = argv[++i];
        break;
      case '--prompt':
        args.prompt = argv[++i];
        break;
      case '--out':
        args.out = argv[++i];
        break;
      case '--spec-out':
        args.specOut = argv[++i];
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.input && !args.prompt) {
    process.stderr.write('Error: exactly one of --input or --prompt is required.\n\n');
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (args.input && args.prompt) {
    process.stderr.write('Error: pass only one of --input or --prompt, not both.\n\n');
    printUsage();
    process.exitCode = 1;
    return;
  }

  let description;
  if (args.input) {
    try {
      description = fs.readFileSync(path.resolve(args.input), 'utf8');
    } catch (err) {
      process.stderr.write(`Error: could not read --input file "${args.input}": ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    description = args.prompt;
  }

  const options = {};
  if (args.model) {
    options.model = args.model;
  }

  try {
    const { spec, svg } = await generateDiagram(description, options);

    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, svg, 'utf8');
    process.stderr.write(`Wrote SVG to ${outPath}\n`);

    if (args.specOut) {
      const specOutPath = path.resolve(args.specOut);
      fs.writeFileSync(specOutPath, JSON.stringify(spec, null, 2), 'utf8');
      process.stderr.write(`Wrote spec JSON to ${specOutPath}\n`);
    }

    console.log(outPath);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { generateSpec, generateDiagram };
