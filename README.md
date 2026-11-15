# Martian Map

EVA route planning and safe-return envelope replay on NASA Mars terrain data.
Routes, timelines and envelopes are computed offline in Python (`planner.py`); the website only displays
and replays three pre-computed scenarios from `public/data/`.

This folder is the integrated A/B/C/D working copy. See [本地运行、部署与录屏指南](本地运行_部署与录屏指南.md) for operating steps, [INTEGRATION_STATUS.md](INTEGRATION_STATUS.md) for actual results, and [SUBMISSION_DRAFT.md](SUBMISSION_DRAFT.md) for project-page text.

## Real data and reproducible build

The current map is a 2 × 2 km area of Gale crater near Mount Sharp, sampled at 2 m per cell (1000 × 1000). A supplied HiRISE DTM `DTEEC_001488_1750_001752_1750_U02`, matching ortho `PSP_001752_1750_RED_A_01_ORTHO`, a THEMIS daytime infrared mosaic, derived terrain layers, and four candidate locations. D selected three of those locations for the demonstrated route. Source products and interpretation limits are listed in [INTEGRATION_STATUS.md](INTEGRATION_STATUS.md) and `public/data/datasets.json`.

From `D:\Desktop\nansa` run `python abc/integrate_parts.py` to recopy A's layers and B's Python code, reconstruct D's three waypoint selection, and write `env.json`, `datasets.json`, and `hazard.png`. Then from this directory run:

```bash
python planning/run_scenarios.py --data work --waypoints public/data/waypoints.json --env public/data/env.json --output public/data/scenarios
npm ci
npm run envelope
npm run build
npm run dev
```

Requires Python 3 with NumPy, SciPy and Pillow, plus Node/npm. B's tests: `cd ../b && python -m pytest -q test/test_planner.py`. `work/` contains the raw planning grids and is not deployed; `dist/` is the static site. Do not run `npm run fake-data` on this integrated copy: it replaces the real data.

Planning values in `env.json` are **demo assumptions**: k=0.6, roughness penalty α=0.5, maximum traversable slope 15°, EVA budget 240 min with 30 min return reserve, slowdown factor 0.8 at T+95, and dust-event budget 180 min. A's hazard layer blocks >30° slopes and classified dark sand separately. The base route is precomputed offline; changing these values requires rerunning B and the envelope generator. The webpage does not perform a live replan. Weather values, actual EVA life-support constraints, and a validated go/no-go rule have not been supplied; `go: false` means **environmental clearance has not been established**, not a forecast of unsafe conditions.

## Frontend (C)

Vite + React + TypeScript, Leaflet `CRS.Simple` (grid pixel coordinates) + `L.imageOverlay`, ECharts for the profile.
No planning code runs in the browser.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (relative paths: works on Vercel and GitHub Pages)
```

Keyboard: `Space` play/pause · `←` `→` step 1 min (`Shift` = 10 min) · `Home` / `End` · `H` HUD ·
`1` `2` `3` switch scenario · `D` demo · `Esc` exit demo.
Hovering the elevation profile marks that spot on the map (distance · elevation · slope).
A scenario can be linked directly: `#slow20`.

### 30-second demo (for the video)

Click **Demo** (or press `D`). It plays the storyboard from the handbook in exactly 30 s, the same way every time:
layers stack up (0–5 s) → route and safe-return envelope (5–12 s) → `slow20` event and re-plan (12–22 s) →
HUD (22–25.5 s) → end card with the NASA data list (until 30 s). Captions follow the UI language (EN / 中文).
Record the browser window at 1920×1080, keep the mouse off the map (the exit button appears on hover), press `Esc` to leave.

### Data check

On load the page normalizes every file and lists problems under **Data check** in the header (also logged to the console
as `[Martian Map 数据检查]`). The badge disappears when the data is clean. Tolerated without breaking the page:
numbers written as strings, unsorted `path`, missing `order` / `dropped` (inferred from the path), missing `legs` /
`profile` / `envelope_frames` (that part is just empty), missing `params` keys (handbook defaults), and both dwell
conventions in `path` — repeating the point while dwelling, or a time jump on the next cell.
If one scenario still fails to render, only that panel is replaced by an error card with buttons to switch scenario.

### Data pipeline

1. **A** puts `elevation.bin` / `rough.bin` / `hazard.bin` (+ a copy of `grid.json`) in `work/`, and the display files in `public/data/`.
2. **B** runs `python run_scenarios.py --data work --output public/data/scenarios` (B's default `--data public/data` also works,
   but then the `.bin` files get deployed with the site).
3. **C** runs `npm run envelope` — rebuilds the safe-return envelope every 10 min (+ at the event) from the same `.bin`
   files with B's exact graph rules, writing `public/data/scenarios/envelope/*.png` and `envelope.json`. Without this step
   the page still works but shows B's single envelope image per scenario (re-coloured green), so it doesn't shrink during replay.
4. `npm run build` and deploy `dist/`.

### Data the page reads (`public/data/`)

Every file is optional except `grid.json`, `waypoints.json` and at least one scenario; missing layers show as
"missing" in the layer list.

| File | Owner | Notes |
| --- | --- | --- |
| `grid.json` | A | `width`, `height`, `res_m`, `geotransform` |
| `ortho.png` `hillshade.png` `slope.png` `thermal.png` | A | stretched to the grid extent, any resolution |
| `hazard.png` | A | **addition**: hazard.bin rendered as RGBA (hazard = opaque red, else transparent) |
| `geology.geojson` | A | grid pixel coordinates; optional `properties.name / unit / color / note` |
| `waypoints.json` | D | **B's format** so B's script can read it: `{ "habitat": {x, y, …}, "waypoints": [{id, x, y, dwell_min, priority, name, why, source, photo}] }` (a dict keyed by id also works). The handbook's `hab` + `targets` is accepted too. |
| `env.json` `photos/` | D | `env.json` may also carry B's planning parameters (`k`, `alpha`, `max_slope_deg`, `eva_budget_min`, `reserve_min`, `slow_k_factor`, `dust_budget_min`) |
| `datasets.json` | D | **addition**: `[{ "name", "url", "role", "layers"? }]` — the NASA data list shown on the page; optional `layers` (e.g. `["ortho", "hazard"]`) puts the source under those layers in the layer panel |
| `scenarios/*.json` + `*_env_*.png` | B | B's output, read as-is (see below) |
| `scenarios/envelope.json` + `scenarios/envelope/` | C | from `npm run envelope` |

How the page reads B's scenario files (`src/lib/validate.ts`, `src/lib/adapt.ts`):

- `slow20` / `dust` only contain the part after the event (path starts at the event point at `event.t_min`). The page
  joins them to `nominal.json` up to the event — path, legs, profile and visit order — so `nominal.json` must be present.
- `params` in event scenarios are the post-event values; the page treats nominal's params as "before" and shows the
  difference (e.g. `k 0.6 → 0.48`).
- `"START"` in `order` / `legs` = the habitat (nominal) or the event point (event scenarios); `"hab"` = the habitat.
- `unsafe` cells are drawn as red route segments and raise a HUD alert. A scenario with `error` is skipped and listed under Data check.
- A target the crew was standing at when the event hit, and that B then dropped, is shown as visited with "stop cut short".
- Scenario titles come from the UI language (B's titles are Chinese).

### Placeholder data

`npm run fake-data` writes a synthetic data set in **exactly B's output format** (same graph rules, TSP ordering and
event logic as B's code, event at 95 min), A-format `.bin` files in `work/`, and then runs `npm run envelope`.
Real files from A/B/D simply overwrite these; do not re-run the script after that.

### Before submitting

- Set `REPO_URL` in `src/config.ts` (the page must link to the code repository).
- Make sure `grid.json` no longer has `"synthetic": true`.
