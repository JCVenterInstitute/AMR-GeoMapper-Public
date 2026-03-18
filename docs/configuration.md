# Configuration Reference

AMR GeoMapper is configured through a JSON config file and a taxonomy JSON file. Both are passed to the `<amr-geo-mapper>` component via HTML attributes.

---

## Component Attributes

The `<amr-geo-mapper>` element accepts the following HTML attributes:

| Attribute         | Type         | Required | Description                                                                             |
| ----------------- | ------------ | -------- | --------------------------------------------------------------------------------------- |
| `config-url`      | string (URL) | **Yes**  | URL to the JSON configuration file described in this document.                          |
| `taxonomy-info`   | string (URL) | **Yes**  | URL to the taxonomy tree JSON file used by the species selection modal.                 |
| `no-open-on-load` | flag         | No       | When present, prevents the taxonomy selection modal from opening automatically on load. |

Example:

```html
<amr-geo-mapper
  config-url="http://localhost:3000/config/demo/config-ecoli-obs.json"
  taxonomy-info="http://localhost:3000/config/demo/taxon-ecoli-obs.json"
></amr-geo-mapper>
```

---

## Quick Start

A minimal configuration requires only a data API URL and at least one filter:

```json
{
  "dataAPI": {
    "url": "http://localhost:3000/data"
  },
  "mapOptions": {
    "initialLocation": { "lat": 0, "lng": 0, "zoom": 2 }
  },
  "filters": [
    {
      "column": "species",
      "alias": "Species",
      "arrayType": false,
      "hasDropdown": true,
      "hasBarChart": true,
      "chartType": ["stackedBar"],
      "onPieChart": true,
      "chartColors": {
        "general": ["#90BE6D"],
        "pie": ["#228B22", "#339933", "#66B366", "#99CC99", "#CCE6CC"]
      }
    }
  ]
}
```

---

## Full Annotated Example

Below is a representative `config.json` based on the CAMRA deployment. Refer to the section reference tables for details on each field.

```json
{
  "linkedFields": {
    "fields": ["gene", "evidence", "drug_class", "resistance_mechanism"],
    "primaryKey": "gene"
  },
  "dataAPI": {
    "url": "http://localhost:3000/data",
    "dataFile": "data/demo/bvbrcEcoli_obs.jsonl"
  },
  "mapOptions": {
    "tileProvider": {
      "url": "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      "attribution": "&copy; OpenStreetMap contributors &copy; CARTO",
      "maxZoom": 19
    },
    "initialLocation": {
      "lat": 9,
      "lng": 10,
      "zoom": 4
    },
    "showMarkerPieCharts": true,
    "markerPieChartSize": {
      "min": 60,
      "max": 120
    },
    "countryShading": {
      "enabled": false,
      "valueMode": "perCapita",
      "colorGradient": [
        "#ffffcc",
        "#c7e9b4",
        "#7fcdbb",
        "#41b6c4",
        "#2c7fb8",
        "#253494"
      ],
      "noDataColor": "#f0f0f0",
      "fillOpacity": 0.6,
      "borderColor": "#cbcbcb",
      "borderWeight": 1,
      "showTooltip": false
    }
  },
  "filters": [
    {
      "column": "drug_class",
      "alias": "Drug Class",
      "specialType": null,
      "searchable": true,
      "arrayType": true,
      "hasDropdown": true,
      "hasBarChart": true,
      "chartType": ["stackedBar", "lineGraph", "stackedArea"],
      "hierarchicalOptions": {
        "secondaryDimensions": [
          "species",
          "resistance_mechanism",
          "evidence",
          "gene_short_name"
        ]
      },
      "onPieChart": true,
      "chartColors": {
        "general": ["#577590"],
        "pie": ["#F9A61A", "#B2134C", "#00B30D", "#0032B3", "#1F5E24"]
      },
      "svgIcon": "http://localhost:3000/images/syringe_pill.svg"
    }
  ]
}
```

---

## Section Reference

### `dataAPI`

| Attribute  | Type   | Required | Default | Description                                                                                                                                                      |
| ---------- | ------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`      | string | **Yes**  | —       | URL of the data API endpoint. The component sends `POST` requests to this URL. See the [Data API Reference](data-api.md).                                        |
| `dataFile` | string | No       | —       | Path to the JSONL data file, relative to the `public/` directory (e.g., `"data/demo/bvbrcEcoli_obs.jsonl"`). Sent to the server so it knows which file to query. |

### `mapOptions`

| Attribute                  | Type    | Required | Default       | Description                                                               |
| -------------------------- | ------- | -------- | ------------- | ------------------------------------------------------------------------- |
| `initialLocation.lat`      | number  | No       | `0`           | Initial map center latitude.                                              |
| `initialLocation.lng`      | number  | No       | `0`           | Initial map center longitude.                                             |
| `initialLocation.zoom`     | number  | No       | `4`           | Initial map zoom level.                                                   |
| `tileProvider.url`         | string  | No       | CartoDB Light | Leaflet tile layer URL template.                                          |
| `tileProvider.attribution` | string  | No       | —             | Attribution HTML for the tile provider.                                   |
| `tileProvider.maxZoom`     | number  | No       | `19`          | Maximum zoom level for the tile layer.                                    |
| `showMarkerPieCharts`      | boolean | No       | `false`       | Show pie charts on map markers. When `false`, markers are simple circles. |
| `centerOnMarkerClick`      | boolean | No       | `false`       | Pan the map to center on a marker when it is clicked.                     |
| `markerPieChartSize.min`   | number  | No       | `40`          | Minimum pie chart marker diameter in pixels.                              |
| `markerPieChartSize.max`   | number  | No       | `120`         | Maximum pie chart marker diameter in pixels.                              |

#### `mapOptions.countryShading`

Controls choropleth shading of country boundaries on the map.

| Attribute       | Type     | Required | Default                  | Description                                                               |
| --------------- | -------- | -------- | ------------------------ | ------------------------------------------------------------------------- |
| `enabled`       | boolean  | No       | `false`                  | Enable country boundary shading.                                          |
| `valueMode`     | string   | No       | `"perCapita"`            | How to compute shading values. Options: `"perCapita"`, `"absolute"`.      |
| `colorGradient` | string[] | No       | `["#f7fbff", "#08306b"]` | Array of hex color strings defining the gradient from low to high values. |
| `noDataColor`   | string   | No       | `"#f0f0f0"`              | Fill color for countries with no data.                                    |
| `fillOpacity`   | number   | No       | `0.6`                    | Opacity of the country fill (0–1).                                        |
| `borderColor`   | string   | No       | `"#999999"`              | Border color for country boundaries.                                      |
| `borderWeight`  | number   | No       | `1`                      | Border width in pixels.                                                   |
| `showTooltip`   | boolean  | No       | `true`                   | Show a tooltip on hover with the country name and value.                  |

### `filters[]`

Each entry in the `filters` array defines a data dimension that appears in the filter menu and/or charts.

| Attribute                                 | Type     | Required | Default | Description                                                                                                                                   |
| ----------------------------------------- | -------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `column`                                  | string   | **Yes**  | —       | Name of the data field in the genome records. Must match a field returned by the data API.                                                    |
| `alias`                                   | string   | **Yes**  | —       | Display name shown in the UI.                                                                                                                 |
| `arrayType`                               | boolean  | **Yes**  | —       | `true` if the data field's values come from inside the `observations` array (linked/multi-value fields). `false` for scalar top-level fields. |
| `specialType`                             | string   | No       | `null`  | Special handling mode. Currently only `"date"` is supported (enables date-range filtering).                                                   |
| `searchable`                              | boolean  | No       | `false` | Show a search box in the filter dropdown.                                                                                                     |
| `hasDropdown`                             | boolean  | No       | `false` | Show a dropdown in the filter menu for this dimension.                                                                                        |
| `hasBarChart`                             | boolean  | No       | `false` | Enable bar chart visualization for this dimension.                                                                                            |
| `chartType`                               | string[] | No       | —       | Chart types available for this dimension. Options: `"stackedBar"`, `"lineGraph"`, `"stackedArea"`.                                            |
| `onPieChart`                              | boolean  | No       | `false` | Include this dimension in marker pie charts (requires `showMarkerPieCharts: true`).                                                           |
| `chartColors.general`                     | string[] | No       | —       | Color(s) used for general chart rendering.                                                                                                    |
| `chartColors.pie`                         | string[] | No       | —       | Color palette for pie chart slices.                                                                                                           |
| `svgIcon`                                 | string   | No       | `null`  | URL to an SVG icon displayed next to the filter in the menu.                                                                                  |
| `hierarchicalOptions.secondaryDimensions` | string[] | No       | —       | List of other filter `column` names that can be used as the secondary (stacking) dimension in bar charts for this filter.                     |

### `linkedFields`

Defines which data columns are stored inside the `observations` array on each genome record. These are the AMR-specific fields (e.g., gene, evidence, drug_class) that have a many-to-one relationship with each genome. Each object in the `observations` array contains one value per linked field, representing a single gene observation.

This configuration enables cross-dimensional charts that show co-occurrence data (e.g., which drug classes appear with which genes).

| Attribute    | Type     | Required | Default | Description                                                                                                      |
| ------------ | -------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `fields`     | string[] | No       | —       | Array of field names stored in each observation object. Must match the keys inside `observations[*]`.            |
| `primaryKey` | string   | No       | —       | The field used to determine observation validity. Observations missing this value are skipped during processing. |

---

## Filter Behavior Notes

- **Within a filter group** (e.g., selecting multiple drug classes): values are combined with **OR** logic — a record matches if it contains any selected value.
- **Between filter groups** (e.g., drug class + species): groups are combined with **AND** logic — a record must match at least one value in every active group.
- **Date filter**: when `specialType` is `"date"`, the filter shows a year-range widget instead of checkboxes.
