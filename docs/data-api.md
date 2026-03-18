# Data API Reference

This document describes the API contract that AMR GeoMapper expects from its backend. If you are deploying AGM with your own server, your backend must implement these endpoints.

---

## Endpoints

| Method | Path | Content-Type | Description |
|---|---|---|---|
| `POST` | `/data` | `application/json` | Query genome records by taxonomy selection |

---

## POST `/data`

Returns genome records matching the user's taxonomy selection.

### Request

**Content-Type:** `application/json`

**Body:** A JSON array of objects, where each object specifies a `{family, genus, species}` triple:

```json
[
  {
    "family": "Enterobacteriaceae",
    "genus": "Klebsiella",
    "species": "K. pneumoniae"
  },
  {
    "family": "Enterobacteriaceae",
    "genus": "Escherichia",
    "species": "E. coli"
  }
]
```

The server should return all records whose family, genus, and species match any of the provided triples (case-insensitive).

### Response

**Content-Type:** `application/json`

**Body:** A JSON array of genome record objects. AMR-linked fields (gene, evidence, drug class, etc.) are grouped into an `observations` array where each object represents one gene observation with all its associated metadata:

```json
[
  {
    "family": "Enterobacteriaceae",
    "genus": "Klebsiella",
    "species": "K. pneumoniae",
    "country": "Nigeria",
    "state_province": "",
    "collection_year": 2020,
    "collection_date": "2020-03-15",
    "genome_id": "573.CCI162",
    "observations": [
      {
        "gene": "SHV-27",
        "evidence": "CARD",
        "drug_class": "penicillin beta-lactam",
        "resistance_mechanism": "antibiotic inactivation",
        "gene_short_name": "SHV-27",
        "gene_family_name": "SHV"
      },
      {
        "gene": "fosA",
        "evidence": "argannot",
        "drug_class": "phosphonic acid antibiotic",
        "resistance_mechanism": "antibiotic inactivation",
        "gene_short_name": "fosA",
        "gene_family_name": null
      },
      {
        "gene": "tet(A)",
        "evidence": "ARDB",
        "drug_class": "tetracycline antibiotic",
        "resistance_mechanism": "antibiotic efflux",
        "gene_short_name": "tet(A)",
        "gene_family_name": null
      }
    ]
  }
]
```

### Record Schema

#### Top-level fields

| Field | Type | Description |
|---|---|---|
| `family` | string | Taxonomic family |
| `genus` | string | Taxonomic genus |
| `species` | string | Species display name |
| `country` | string | Country name |
| `state_province` | string | State or province (may be empty) |
| `collection_year` | number | 4-digit collection year |
| `collection_date` | string | Collection date in `YYYY-MM-DD` format (may be empty) |
| `genome_id` | string | Unique genome/sample identifier |
| `observations` | object[] | Array of gene observation objects (see below) |

#### Observation object fields

Each object in the `observations` array represents a single AMR gene observation with its associated metadata. All fields within an observation are scalar values (strings or `null`).

| Field | Type | Description |
|---|---|---|
| `gene` | string | AMR gene identifier |
| `evidence` | string | Evidence source label |
| `drug_class` | string | Antibiotic drug class |
| `resistance_mechanism` | string | Resistance mechanism label |
| `gene_short_name` | string | Short gene display name |
| `gene_family_name` | string | Gene family name |

> **Note:** The set of fields within each observation object must match the `linkedFields.fields` array in `config.json`. Fields with unknown or missing values should use `null`.

---

## Example

### Request

```bash
curl -X POST http://localhost:3000/data \
  -H "Content-Type: application/json" \
  -d '[{"family": "Enterobacteriaceae", "genus": "Klebsiella", "species": "K. pneumoniae"}]'
```

### Response

```json
[
  {
    "family": "Enterobacteriaceae",
    "genus": "Klebsiella",
    "species": "K. pneumoniae",
    "country": "Nigeria",
    "state_province": "",
    "collection_year": 2020,
    "collection_date": "",
    "genome_id": "573.CCI162",
    "observations": [
      {
        "gene": "SHV-27",
        "evidence": "CARD",
        "drug_class": "penicillin beta-lactam",
        "resistance_mechanism": "antibiotic inactivation",
        "gene_short_name": "SHV-27",
        "gene_family_name": "SHV"
      }
    ]
  }
]
```

---

## Implementation Notes

The reference implementation in `express/controller.js` reads from a JSONL file (e.g., `public/data/CAMRA/CAMRA_v7_obs.jsonl`) and streams it line-by-line, filtering rows against the taxonomy predicate. The route is defined in `express/route.js`.

If you are implementing a custom backend (e.g., backed by a database), the key requirement is matching the request/response contract above. The component does not depend on any server-specific behavior beyond standard JSON over HTTP.
