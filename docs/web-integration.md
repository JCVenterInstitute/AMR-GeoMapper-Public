# Web Integration

This guide explains how to embed AMR GeoMapper in your own web project as a standalone web component — without using the included Express development server.

---

## Overview

AGM is a self-contained web component. To embed it, you include one script tag and one custom HTML element. The component uses Shadow DOM for style encapsulation, so it will not conflict with your page styles.

---

## Minimal HTML Example

```html
<!DOCTYPE html>
<html>
  <head>
    <script type="module" src="/path/to/agm.min.js"></script>
  </head>
  <body>
    <div style="height: 100vh; width: 100%">
      <amr-geo-mapper
        config-url="https://your-server.com/config.json"
        taxonomy-info="https://your-server.com/taxon_v7.json"
      ></amr-geo-mapper>
    </div>
  </body>
</html>
```

The component fills its parent container, so set an explicit height on the parent element.

---

## Component Attributes

The `<amr-geo-mapper>` element accepts the following HTML attributes:

| Attribute | Required | Description |
|---|---|---|
| `config-url` | **Yes** | URL to the `config.json` file (see [Configuration Reference](configuration.md)) |
| `taxonomy-info` | **Yes** | URL to the taxonomy JSON file used for the species selection modal |
| `no-open-on-load` | No | Boolean attribute. When present, the taxonomy selection modal does not open automatically on page load. Useful when you want to load data programmatically. |

Example with all attributes:

```html
<amr-geo-mapper
  config-url="https://your-server.com/config.json"
  taxonomy-info="https://your-server.com/taxon_v7.json"
  no-open-on-load
></amr-geo-mapper>
```

---

## External Dependencies

AMR GeoMapper bundles all required CSS (including Bootstrap utilities) within the component's Shadow DOM. No external CSS `<link>` tags are needed on the host page.

The following libraries are loaded automatically by the component at runtime — you do **not** need to include them yourself:

- **Leaflet** — map rendering
- **Chart.js** — chart visualizations

---

## Hosting Requirements

Your server must serve the following files:

| File | Description |
|---|---|
| `agm.min.js` | The bundled component script (produced by `npm run build`) |
| `config.json` | Component configuration (see [Configuration Reference](configuration.md)) |
| Taxonomy JSON | Taxonomy hierarchy file (e.g., `taxon_v7.json`) |
| SVG icons | Icon files referenced in filter `svgIcon` fields in `config.json` |

Your server must also provide a **data API endpoint** that the component calls to fetch genomic data. The URL for this endpoint is set in `config.json` under `dataAPI.url`. See the [Data API Reference](data-api.md) for the request/response contract.

---

## Data API

The component expects a `POST` endpoint that accepts a JSON body with taxonomy selections and returns matching genome records. See the [Data API Reference](data-api.md) for the full contract.

At a minimum, the endpoint must:
1. Accept `POST` requests with `Content-Type: application/json`
2. Parse a JSON body containing a `queryString` array of `{family, genus, species}` objects
3. Return a JSON array of genome record objects

---

## User CSV Data

The `<csv-upload-button>` component is included in the `agm.min.js` bundle. It provides a file picker that lets users load their own CSV data for comparison with the server dataset. All processing happens locally in the browser — no data is sent to the server. No additional setup is required — the component is automatically available when you include the bundle.

See the [User Data Guide](user-data-guide.md) for the expected CSV format.

---

## Configuration

All component behavior is controlled through `config.json`. Key areas include:

- **Map options** — initial location, tile provider, marker pie charts, country shading
- **Filters** — which data columns appear as filters, chart types, colors
- **Linked fields** — which columns share observation-level relationships

See the [Configuration Reference](configuration.md) for the full schema.
