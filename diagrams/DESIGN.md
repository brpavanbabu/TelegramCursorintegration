# Architecture Diagram Generator — Design

Generate polished architecture / flow diagrams (like the "Bitcoin Settlement &
Reservation Flow" reference) automatically from a plain-text description, a
markdown doc, or a code file.

## Pipeline

```
input (text / md / code)
        │
        ▼
┌─────────────────────────┐     ┌──────────────────────────┐
│ 1. Spec Agent            │     │ 2. Renderer               │
│ claude-sonnet-5          │ ──▶ │ deterministic JS, no LLM  │
│ structured output:       │     │ DiagramSpec → SVG (+HTML) │
│ DiagramSpec JSON         │     │ fixed design system       │
└─────────────────────────┘     └──────────────────────────┘
```

Two stages on purpose:

- **The model produces structure, not pixels.** Claude Sonnet 5 is asked only
  for a `DiagramSpec` JSON (validated against `spec-schema.json` via the API's
  structured-outputs feature), never raw SVG. This makes output reliable,
  diffable, and cheap to re-render.
- **The renderer owns the visual language.** `render-svg.js` converts a spec
  into SVG using the tokens in `design-system.json`. Every diagram gets the
  same typography, palette, node shapes, legend, and footer panels — the
  consistency you see in the reference image comes from code, not prompting.

## DiagramSpec (authoring model)

See `spec-schema.json` for the full JSON Schema. Summary:

| Field     | Purpose |
|-----------|---------|
| `title` / `subtitle` | Big centered heading + one-line description |
| `actors`  | Header row of icons (bank, server, user, globe, database, gear, shield, doc) with label + sublabel |
| `nodes`   | The boxes. Each has `type` (`process`, `decision`, `datastore`, `note`), `category` (`system`, `external`, `success`, `error`, `reversal`, `info`), a `title`, bullet `lines`, and a grid position (`col` 0–5, `row` 0–N) |
| `edges`   | Arrows between node ids, optional `label` (e.g. "Yes"/"No"), `style` (`solid`/`dashed`), `color` |
| `panels`  | Footer boxes such as "Key Concepts" / "Statuses Used": term + description lists |
| `legend`  | Rendered automatically from the categories actually used |

Layout is a **grid with content-sized rows**: the model places nodes on a
coarse grid; the renderer measures text, sizes each box, and routes orthogonal
arrows. This sidesteps unreliable free-form auto-layout while keeping the
model's job easy ("put the error branch in the right-hand columns").

## Node categories → colors (matching the reference)

| Category   | Meaning                    | Fill / Stroke        |
|------------|----------------------------|----------------------|
| `system`   | Our system actions         | blue `#EAF2FB` / `#2B6CB8` |
| `external` | External validation        | orange `#FDF0E2` / `#D9822B` |
| `success`  | Happy path                 | green `#E8F5E9` / `#2F855A` |
| `error`    | Exception / error path     | red `#FDECEA` / `#C53030` |
| `reversal` | Reversal / failure handling| purple `#F3EEFA` / `#6B46C1` |
| `info`     | Notes / callouts           | yellow `#FFF9E6` / `#D6A400` |
| datastore  | Ledger / account store     | cylinder, `#FFFDF2` / `#C9A227` |

## Files

| File | Role |
|------|------|
| `spec-schema.json`   | JSON Schema for DiagramSpec (also sent to the API as the structured-output format) |
| `design-system.json` | Colors, typography, spacing, icon set |
| `render-svg.js`      | Deterministic renderer: `renderDiagram(spec) -> svg string`; CLI: `node render-svg.js spec.json out.svg` |
| `generate-diagram.js`| Full pipeline CLI: input → Sonnet 5 → spec → SVG. `node generate-diagram.js --input flow.md --out diagram.svg` |
| `examples/btc-settlement.json` | Reference spec reproducing the sample image |

## Model usage

- Model: `claude-sonnet-5` (adaptive thinking is on by default; structured
  outputs via `output_config.format` with the schema from `spec-schema.json`).
- Streaming is used (`client.messages.stream`) with generous `max_tokens` so
  large diagrams never truncate.
- Requires `ANTHROPIC_API_KEY` in the environment (or `config.json`'s
  `anthropicApiKey`). Rendering an existing spec needs no API key at all.

## Telegram integration

The bot gains a `/diagram <description>` command: it runs the pipeline and
replies with the generated SVG as a document. Long descriptions can be sent as
a follow-up message. This is optional — the bot works unchanged without an
Anthropic key.
