# Architecture Overview

This document describes the code organization and data flow of AMR GeoMapper for developers working on the codebase.

---

## Component Overview

AGM is a custom HTML web component (`<amr-geo-mapper>`) that extends `HTMLElement`. It uses Shadow DOM for style encapsulation, ES modules for code organization, and Rollup for bundling.

The component renders an interactive Leaflet map with markers representing geographic locations containing AMR genomic data. Users can filter data by various dimensions, view stacked bar / line / area / pie charts, and load their own CSV data for comparison.

---

## File Structure

```
public/
├── entry.js                              # Rollup entry point
├── index.html                            # Development page
├── config.json                           # Component configuration
├── components/
│   ├── AMRGeoMapper.js                   # Main web component (AMRGeoMapper)
│   └── userFileHandler.js                # CSV file loader component (CsvUploadButton)
├── core/
│   ├── dataLoader.js                     # Data fetching, filtering, metadata
│   ├── locationData.js                   # Geographic aggregation, SharedRegistries
│   ├── geneObservationProcessor.js       # Explodes linked-field rows into observations
│   ├── baseChart.js                      # Base class for Chart.js charts
│   ├── stackedBarChart.js                # Stacked bar chart implementation
│   ├── stackedAreaChart.js               # Stacked area chart implementation
│   ├── lineChart.js                      # Line chart (time series)
│   ├── pieChart.js                       # Pie chart (markers and detail views)
│   ├── taxonomyTree.js                   # Taxonomy selection tree widget
│   ├── chartPanelManager.js              # Chart panel UI and lifecycle
│   ├── filterMenuManager.js              # Filter menu rendering and interaction
│   ├── mapMarkerManager.js               # Map marker creation and management
│   ├── countryShadingManager.js          # Choropleth country shading
│   ├── tooltipManager.js                 # Tooltip hover behavior
│   ├── taxonomyModalManager.js           # Taxonomy selection modal
│   └── csv-worker.js                     # Web Worker for CSV → JSONL conversion
├── utils/
│   ├── HTMLHelper.js                     # HTML template generation
│   ├── colorGen.js                       # Color palette generation
│   ├── geoLookup.js                      # Country/state → lat/lng lookup
│   ├── populationData.js                 # Country population data (for per-capita)
│   ├── csvUtils.js                       # CSV parsing utilities
│   ├── sraLookup.js                      # SRA identifier lookup
│   └── domUtils.js                       # DOM utility functions
├── styles/
│   └── main.css                          # Component styles (inlined at build)
└── dist/
    ├── agm.js                            # Unminified bundle
    └── agm.min.js                        # Minified production bundle
```

---

## Core Modules

### AMRGeoMapper (`components/AMRGeoMapper.js`)

The main web component. Orchestrates initialization, data loading, map rendering, and UI interaction. Delegates to manager classes:

- **ChartPanelManager** — chart creation, panel expand/collapse
- **FilterMenuManager** — filter dropdowns, checkboxes, search
- **MapMarkerManager** — Leaflet marker creation and clearing
- **CountryShadingManager** — choropleth layer rendering
- **TooltipManager** — hover tooltip behavior
- **TaxonomyModalManager** — species selection modal

### DataLoader (`core/dataLoader.js`)

Fetches data from the API endpoint, applies active filters row-by-row, and generates metadata (value counts, unique values per filter). Also handles user-provided CSV data via IndexedDB.

For linked fields (those marked `arrayType: true` in config), filtering and metadata collection iterate over each row's `observations` array rather than looking for top-level array values.

Key methods:
- `dataGenerator()` — async generator that yields filtered data rows
- `filterRow(row)` — applies active filters using OR-within / AND-between logic; for linked fields, checks values inside `row.observations`
- `updateMetadata(row)` — collects unique values and counts; extracts linked field values from `row.observations`
- `addFilter(type, value)` / `removeFilter(type, value)` — manages the active filter set

### LocationData (`core/locationData.js`)

Aggregates data by geographic location (country, state/province, or global). Each `LocationData` instance maintains:

- **filterTotals** — per-dimension value counts used by pie charts and filter menus, populated from `row.observations` for linked fields
- **timeSeriesIndex** — pre-computed data for line charts over collection years
- **relationalIndex** — cross-dimensional relationships for hierarchical bar charts (using `RelationalCrosstab`), built from individual observations

All instances share a **SharedRegistries** singleton that provides string-to-integer mappings, avoiding duplicate string storage across locations.

### GeneObservationProcessor (`core/geneObservationProcessor.js`)

Transforms rows containing an `observations` array into flat observation objects for downstream processing. Each observation in the array is a self-contained object with linked field values (e.g., gene, evidence, drug_class). The processor merges each observation with the row's non-observation fields (e.g., country, species) to produce complete records. Observations missing a valid primary key value (typically `gene`) are skipped.

### Chart Classes

- **BaseChart** (`core/baseChart.js`) — shared Chart.js configuration and lifecycle
- **StackedBarChart** (`core/stackedBarChart.js`) — grouped/stacked bars with species/genus breakdown
- **StackedAreaChart** (`core/stackedAreaChart.js`) — area chart variant
- **LineChart** (`core/lineChart.js`) — time series over collection years
- **PieChart** (`core/pieChart.js`) — proportional display on markers and in detail views

---

## Data Flow Summary

### Loading

```
User selects species in taxonomy modal
  → POST request to data API with selections
  → Response: JSON array of genome records (each with an observations array)
  → DataLoader.dataGenerator() yields filtered rows
  → Each row is aggregated into LocationData objects (country, state, global)
  → GeneObservationProcessor merges each observation with the row's base fields
  → LocationData updates relational indexes and filter totals from observations
```

### Rendering

```
LocationData objects → Map markers placed at coordinates
  → Pie charts drawn on markers (if enabled)
  → Filter menu populated with value counts
  → User clicks marker → charts generated from LocationData indexes
```

### Filtering

```
User toggles filter checkbox
  → DataLoader.activeFilters updated
  → Full data re-processed through dataGenerator()
  → LocationData objects rebuilt
  → Map markers and charts re-rendered
```

---

## Build System

**Bundler:** Rollup

**Entry point:** `public/entry.js`

**Plugins:**
- `rollup-plugin-web-worker-loader` — inlines the CSV worker as base64
- `rollup-plugin-string` — inlines CSS files as strings
- `@rollup/plugin-terser` — minifies the production bundle

**Output:**
- `public/dist/agm.js` — unminified ES module
- `public/dist/agm.min.js` — minified ES module

**Build command:** `./utilities/build` (runs `rollup -c`)

---

## Key Patterns

### SharedRegistries

A singleton that maps strings to integer IDs, shared across all `LocationData` instances. This avoids storing duplicate strings (e.g., "Escherichia coli") hundreds of times. Reset at the start of each data load.

### Shadow DOM

The component uses Shadow DOM (`this.attachShadow({ mode: "open" })`) so its styles and DOM do not leak into or conflict with the host page. Bootstrap CSS is required on the host page because the component's internal markup uses Bootstrap utility classes.

### Manager Delegation

The main component class delegates UI concerns to focused manager classes (chart panel, filter menu, markers, shading, tooltips, taxonomy modal). Each manager receives a reference to the parent component and operates on the Shadow DOM.
