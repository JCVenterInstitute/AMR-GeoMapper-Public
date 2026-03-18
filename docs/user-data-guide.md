# User Data CSV — File Format Guide

> **Version:** v2.0 | **Format:** CSV (comma-separated) | **Encoding:** UTF-8

This guide explains how to prepare a CSV file for use with AMR GeoMapper. The primary public deployment is at [camra.acegid.org/amr-geomapper](https://camra.acegid.org/amr-geomapper), but these instructions apply to any AMR-GM instance.

---

## 1. Quick Summary

- **File type:** CSV (comma-separated), **UTF-8** encoding, **one header row**.
- **Quoting:** Any field that contains commas **must be wrapped in double quotes**.
- **Row scope:** One row per observation (a single gene/drug_class/etc. entry for a sample).
- **Sample grouping:** Rows with the same `id` value are grouped into a single sample. Each sample can have multiple observation rows.
- **Required headers** (minimum viable file):
  `id`, `genus`, `species`, `country`

---

## 2. File Requirements

- **Delimiter:** `,` (comma)
- **Quote char:** `"` (double quote)
- **Escape quotes inside a field:** `""` (two double quotes)
- **Decimal separator:** `.` (dot)
- **No formulas or merged cells** (export to plain CSV)
- **Header row is required** and **must match column names exactly** (case-sensitive, no trailing spaces)
- **Empty values:** leave blank; optionally use the literal `Unknown` to mark an unknown category (it will appear as its own group)

---

## 3. Column Dictionary

- Columns marked **(Required)** must be included in the header.
  - Required columns may have blank values in some rows, but this removes data from certain charts.
- **Observation columns** (gene, drug_class, evidence, etc.) contain one value per row. Multiple observations for the same sample are represented as separate rows sharing the same `id`.

| Column                 | Type              | Required | Description                                                  | Example                          |
| ---------------------- | ----------------- | -------: | ------------------------------------------------------------ | -------------------------------- |
| `id`                   | string            |  **Yes** | Sample/genome identifier used to group rows into one sample  | `sample1`                        |
| `genus`                | string            |  **Yes** | NCBI/accepted genus                                          | `Klebsiella`                     |
| `species`              | string            |  **Yes** | Species name. This will be the display name for the species. | `K. pneumoniae` or `pneumoniae`  |
| `country`              | string            |  **Yes** | Country or equivalent                                        | `Nigeria`                        |
| `family`               | string            |       No | Taxonomic family                                             | `Enterobacteriaceae`             |
| `collection_date`      | date (YYYY-MM-DD) |       No | Full collection date (year is extracted automatically)       | `2017-06-12`                     |
| `gene`                 | string            |       No | AMR gene / marker                                            | `(Bla)ampH`                      |
| `drug_class`           | string            |       No | Antibiotic class label                                       | `penicillin beta-lactam`         |
| `resistance_mechanism` | string            |       No | Mechanism label                                              | `antibiotic inactivation`        |
| `evidence`             | string            |       No | Evidence source                                              | `CARD`                           |
| `gene_short_name`      | string            |       No | Short display name for the gene                              | `ampH`                           |
| `gene_family_name`     | string            |       No | Gene family name                                             | `SHV`                            |

> **Note:** Extra columns are allowed but ignored.

---

## 4. How Rows Are Grouped

Each CSV row represents a **single observation** (one gene, one drug class, etc.) for a sample. Rows that share the same `id` are grouped together during import. Sample-level fields (`genus`, `species`, `country`, `collection_date`, `family`) are taken from the first row for each `id`. Observation-level fields (`gene`, `drug_class`, `evidence`, `resistance_mechanism`, `gene_short_name`, `gene_family_name`) are collected across all rows for that `id` into an observations list.

For example, these two CSV rows:

```csv
id,genus,species,country,collection_date,gene,drug_class,evidence
sample1,Escherichia,E. coli,Nigeria,2020-01-15,geneA,penicillin,CARD
sample1,Escherichia,E. coli,Nigeria,2020-01-15,geneB,cephalosporin,argannot
```

produce a single sample record with two observations:
- Observation 1: gene=geneA, drug_class=penicillin, evidence=CARD
- Observation 2: gene=geneB, drug_class=cephalosporin, evidence=argannot

---

## 5. Minimal Working Example

```csv
id,genus,species,country,collection_date,gene,drug_class,evidence,resistance_mechanism
sample1,Klebsiella,K. pneumoniae,Nigeria,2017-06-12,SHV-27,penicillin beta-lactam,CARD,antibiotic inactivation
sample1,Klebsiella,K. pneumoniae,Nigeria,2017-06-12,fosA,phosphonic acid antibiotic,CARD,antibiotic inactivation
sample1,Klebsiella,K. pneumoniae,Nigeria,2017-06-12,tet(A),nitrofuran antibiotic,argannot,antibiotic efflux
sample2,Escherichia,E. coli,Kenya,2019-03-10,blaTEM-1,penicillin beta-lactam,CARD,antibiotic inactivation
```

---

## 6. Validation Checklist

- [ ] File is **CSV, UTF-8**, with **one header row**.
- [ ] Required headers: `id`, `genus`, `species`, `country`.
- [ ] Each row represents a single observation (one gene/drug_class/etc.).
- [ ] All rows for the same sample share the same `id` value.
- [ ] `collection_date` uses **YYYY-MM-DD** format, if provided.
- [ ] No extra title rows, footers, or blank header lines.

---

## 7. Common Pitfalls and Fixes

- **"Unexpected non-whitespace character after JSON..."**
  _Cause:_ Loading a non-CSV format or CSV with extra preface lines.
  _Fix:_ Ensure the first line is **exactly** the header row.

- **Missing columns**
  _Cause:_ Renamed or misspelled headers.
  _Fix:_ Use the exact column names from the dictionary (case-sensitive).

- **Pin not shown on map**
  _Cause:_ Incorrect location name.
  _Fix:_ Ensure the name used in the `country` column matches a recognized country name (e.g., use "United States" instead of "USA", "Vietnam" instead of "Viet Nam").

- **Only one observation per sample**
  _Cause:_ Each sample has only one row.
  _Fix:_ Add additional rows with the same `id` for each observation.

---

## 8. "Unknown" vs Blank

- Use **blank** to indicate missing data (the field will be ignored in grouping).
- `na`, `n/a`, `null`, and `none` can also be used to indicate missing data.
- Use the literal `Unknown` to **intentionally group** unknown values (e.g., show an **Unknown** bucket in charts and menus).

---

## 9. Recommended Prep Workflow

1. Prepare data in a spreadsheet with columns from the **Column Dictionary**.
2. Enter one row per observation — if a sample has three genes, create three rows with the same `id`.
3. Export as **CSV (UTF-8)**.
4. Open the CSV in a text editor to confirm:
   - The **first line is the header**.
   - All rows for the same sample share the same `id`.

---

## 10. Data Privacy

Your data is never sent to a server. It is analyzed locally in your browser for the duration of the session.

---

## 11. Changelog

- **v2.0** – Switched to per-observation row format (one row per gene/drug_class entry). Added required `id` column for sample grouping. Column names are now config-driven.
- **v1.0** – Initial documentation

---

## 12. Support

If your file fails validation, check the **Validation Checklist** and **Common Pitfalls** first. When contacting support, include:

- The CSV **first 3 lines** (header + 2 rows)
- The **exact error message**
- Your **browser and OS**
