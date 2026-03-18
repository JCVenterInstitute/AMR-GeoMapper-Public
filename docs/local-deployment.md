# Local Deployment

This guide walks through running AMR GeoMapper on your local machine using the included Express development server.

---

## Prerequisites

- **Node.js** v18 or later
- **npm** (included with Node.js)

---

## Installation

```bash
git clone <repository-url>
cd mGO
npm install
```

---

## Environment Setup

The project includes a `.env` file in the root directory with the server port:

```
PORT=3000
```

You can change the port by editing this file. It defaults to `3000` if not specified.

---

## Demo Data

The repository includes a demo dataset so you can start exploring right away. The demo files are:

| File | Path | Description |
| --- | --- | --- |
| Data file | `public/data/demo/bvbrcEcoli_obs.jsonl` | Sample JSONL dataset of *E. coli* genomes from BV-BRC |
| Configuration | `public/config/demo/config-ecoli-obs.json` | Config file that defines filters, chart options, and the data file path |
| Taxonomy tree | `public/config/demo/taxon-ecoli-obs.json` | Taxonomy hierarchy for the species selection modal |

The JSONL data file contains one JSON object per line, where each object represents a genome record. Each record contains scalar metadata (country, species, etc.) and an `observations` array of gene observation objects. See the [Data API Reference](data-api.md) for the record schema.

By default, `public/index.html` is already configured to use the demo config and taxonomy files, so no changes are needed to get started.

---

## Build

AMR GeoMapper uses Rollup to bundle all ES modules into a single file. Run the build script from the project root:

```bash
./utilities/build
```

This produces two files:

| Output | Description |
| --- | --- |
| `public/dist/agm.js` | Unminified ES module bundle |
| `public/dist/agm.min.js` | Minified ES module bundle (used in production) |

The entry point for the bundle is `public/entry.js`, which imports the `<amr-geo-mapper>` and `<csv-upload-button>` web components.

> **Note:** You must rebuild after any changes to files under `public/`.

---

## Running the Server

**Development mode** (auto-restarts on server file changes):

```bash
npm run dev
```

**Standard mode:**

```bash
node server.js
```

Both start an Express server that:

- Serves static files from `public/`
- Exposes a `POST /data` endpoint for querying the JSONL dataset

---

## Verifying It Works

Open [http://localhost:3000](http://localhost:3000) in your browser. You should see the AMR GeoMapper map interface with a taxonomy selection modal.

If the map loads but shows no data, verify:

1. The JSONL data file exists at `public/data/demo/bvbrcEcoli_obs.jsonl`.
2. The config file at `public/config/demo/config-ecoli-obs.json` has `dataAPI.url` set to `http://localhost:3000/data`.
3. The `config-url` and `taxonomy-info` attributes in `public/index.html` point to your config and taxonomy files.

---

## Configuration

The `<amr-geo-mapper>` web component is configured through two HTML attributes set in `public/index.html`:

- **`config-url`** — URL to the JSON configuration file (e.g., `http://localhost:3000/config/demo/config-ecoli-obs.json`)
- **`taxonomy-info`** — URL to the taxonomy tree JSON file (e.g., `http://localhost:3000/config/demo/taxon-ecoli-obs.json`)

To use a different dataset, create new config and taxonomy files under `public/config/` and update these attributes in `index.html`.

See the [Configuration Reference](configuration.md) for a full description of all config options.

---

## Next Steps

- [Configuration Reference](configuration.md) — customize map options, filters, and chart behavior
- [Web Integration](web-integration.md) — embed AMR GeoMapper in another web project
- [Data API Reference](data-api.md) — implement a custom backend
