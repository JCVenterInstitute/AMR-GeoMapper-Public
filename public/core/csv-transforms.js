/**
 * Pure data-transformation functions extracted from csv-worker.js
 * so they can be imported by both the worker and by unit tests.
 */
import {
  AMR_WATCH_HEADERS,
  parseCsvLine,
  sniffDelimiter,
} from "../utils/csvUtils.js";

export const DEFAULT_LIST_SEPARATOR = ",";

// ---------- Date helpers ----------
export function extractCollectionYear(rawDate) {
  if (rawDate == null) return null;
  const s = String(rawDate).trim();
  if (!s) return null;

  // Most formats are year-first (YYYY, YYYY-MM-DD, YYYY/MM/DD, ISO strings).
  let match = s.match(/^(\d{4})(?:[^\d]|$)/);
  if (match) return match[1];

  // Fallback: capture a 4-digit year at the end (e.g., DD/MM/YYYY).
  match = s.match(/(\d{4})$/);
  if (match) return match[1];

  // Last resort: Date parser.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return String(parsed.getFullYear());
  }

  return null;
}

// ---------- Type inference ----------
export function inferValue(value) {
  if (value == null) return null;
  const s = String(value).trim();

  // null-ish
  if (s === "" || /^(na|n\/a|null|none)$/i.test(s)) return null;

  // bool
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";

  // int
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }

  // float
  const f = Number(s);
  if (!Number.isNaN(f)) return f;

  return value;
}

// ---------- Validation helpers ----------
export function validateHeaders(headers, requireHeaders = []) {
  const missing = [];
  for (const h of requireHeaders) if (!headers.includes(h)) missing.push(h);
  return { ok: missing.length === 0, missing };
}

export function typeOfValue(v) {
  if (v == null) return "null";
  if (Array.isArray(v)) return "list";
  return typeof v; // "string" | "number" | "boolean" | "object"
}

export function validateRowAgainstSchema(row, idx, schema, uniqueSets) {
  const errors = [];
  const warnings = [];

  // required non-empty (for required headers, make sure values aren't blank)
  for (const h of schema.requireHeaders || []) {
    const v = row[h];
    const empty =
      v == null ||
      (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
    if (empty)
      warnings.push({
        row: idx,
        column: h,
        code: "required_field",
        msg: "Missing required value in row " + idx,
      });
  }

  // type checks
  if (schema.types) {
    for (const [col, expect] of Object.entries(schema.types)) {
      const v = row[col];
      if (v == null) continue; // allow null
      const got = typeOfValue(v);
      const ok =
        (expect === "list" && got === "list") ||
        (expect === "number" && got === "number") ||
        (expect === "boolean" && got === "boolean") ||
        (expect === "string" &&
          (got === "string" || got === "number" || got === "boolean"));
      if (!ok)
        errors.push({
          row: idx,
          column: col,
          code: "type",
          msg: `Expected ${expect}, got ${got}`,
        });
    }
  }

  // enum checks
  if (schema.enums) {
    for (const [col, allowed] of Object.entries(schema.enums)) {
      const v = row[col];
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const x of v) {
          if (!allowed.includes(String(x))) {
            errors.push({
              row: idx,
              column: col,
              code: "enum",
              msg: `Invalid value "${x}"`,
            });
          }
        }
      } else if (!allowed.includes(String(v))) {
        errors.push({
          row: idx,
          column: col,
          code: "enum",
          msg: `Invalid value "${v}"`,
        });
      }
    }
  }

  // uniqueness (composite keys supported)
  if (schema.unique && schema.unique.length) {
    const key = schema.unique.map((k) => String(row[k] ?? "")).join("|");
    if (uniqueSets.has(key)) {
      errors.push({
        row: idx,
        column: schema.unique.join(","),
        code: "duplicate",
        msg: "Duplicate key",
      });
    } else {
      uniqueSets.add(key);
    }
  }

  return { errors, warnings };
}

// ---------- CSV helpers ----------
export function isNullishCell(value) {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || /^(na|n\/a|null|none)$/i.test(s);
}

// ---------- List columns ----------
export function parseListField(raw, sep, inferElems) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s) return [];

  // Try JSON array first
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const val = JSON.parse(s);
      if (Array.isArray(val)) {
        return inferElems
          ? val.map((v) => (typeof v === "string" ? inferValue(v) : v))
          : val;
      }
    } catch (_) {
      /* ignore */
    }
  }

  let effectiveSep = sep && String(sep).length > 0 ? sep : ",";

  if (!s.includes(effectiveSep)) {
    // Nothing to split on -> treat the whole thing as one value
    return inferElems ? [inferValue(s)] : [s];
  }

  const parts = s
    .split(effectiveSep)
    .map((p) => p.trim())
    .filter(Boolean);
  return inferElems ? parts.map(inferValue) : parts;
}

// ---------- Row transform ----------
export function transformRow(
  rowObj,
  { inferTypes, listCols, listSep, inferListElems, keepHeaders },
) {
  const out = {};
  const useAll = !keepHeaders || keepHeaders.length === 0;

  // Parse linked (list) columns into individual arrays first
  const parsedLists = {};
  let maxLen = 0;
  for (const col of listCols) {
    const raw = rowObj[col];
    if (raw === undefined) continue;
    const arr = parseListField(raw, listSep, inferListElems);
    parsedLists[col] = arr;
    if (arr.length > maxLen) maxLen = arr.length;
  }

  // Add non-list columns to the output
  for (const [k, v] of Object.entries(rowObj)) {
    if (!useAll && !keepHeaders.includes(k)) continue;
    if (listCols.has(k)) continue; // handled via observations
    out[k] = inferTypes ? inferValue(v) : v;
  }

  // Build observations array from parsed list columns
  if (maxLen > 0) {
    const listColNames = Object.keys(parsedLists);
    const observations = [];
    for (let i = 0; i < maxLen; i++) {
      const obs = {};
      for (const col of listColNames) {
        obs[col] = parsedLists[col][i] ?? null;
      }
      observations.push(obs);
    }
    out.observations = observations;
  }

  return out;
}

// ---------- Flat-observation row transform ----------
/**
 * Extract a single observation object from a flat CSV row.
 * Returns { scalar, observation } where scalar contains non-linked fields
 * and observation contains linked fields for one observation.
 */
export function extractFlatObservation(rowObj, linkedFieldsSet, inferTypes) {
  const scalar = {};
  const observation = {};

  for (const [k, v] of Object.entries(rowObj)) {
    const val = inferTypes ? inferValue(v) : v;
    if (linkedFieldsSet.has(k)) {
      observation[k] = val;
    } else {
      scalar[k] = val;
    }
  }

  return { scalar, observation };
}

/**
 * Group flat per-observation CSV rows into JSONL sample records.
 * Each output record has scalar fields + observations[].
 *
 * @param {Object[]} rows - Parsed CSV rows (each an object keyed by header)
 * @param {Object} options
 * @param {string} options.idColumn - Column used as sample grouping key (default "id")
 * @param {string[]} options.linkedFields - Column names that belong in observations[]
 * @param {boolean} options.inferTypes - Whether to infer value types
 * @param {Object|null} options.schema - Validation schema
 * @param {number} options.maxErrors - Max validation errors before stopping
 * @param {Function} options.progressCb - Progress callback
 * @returns {{ jsonlRows: string[], validation: Object|null }}
 */
export function groupFlatRowsToJsonl(
  rows,
  {
    idColumn = "id",
    linkedFields = [],
    inferTypes = false,
    schema = null,
    maxErrors = 200,
    progressCb = () => {},
  },
) {
  const linkedFieldsSet = new Set(linkedFields);
  const groups = new Map(); // idValue → { scalar, observations[] }
  const groupOrder = []; // preserve insertion order of IDs

  const total = Math.max(1, rows.length);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const { scalar, observation } = extractFlatObservation(
      row,
      linkedFieldsSet,
      inferTypes,
    );
    const id = scalar[idColumn] ?? "";
    const key = String(id);

    if (!groups.has(key)) {
      groups.set(key, { scalar, observations: [] });
      groupOrder.push(key);
    }

    // Only add observation if it has at least one non-null linked field
    const hasContent = Object.values(observation).some((v) => v != null);
    if (hasContent) {
      groups.get(key).observations.push(observation);
    }

    if (i % 500 === 0) progressCb(i / total);
  }

  // Build output JSONL rows + validate
  const uniqueSets = new Set();
  const allErrors = [];
  const allWarnings = [];
  const jsonlRows = [];

  for (let i = 0; i < groupOrder.length; i++) {
    const key = groupOrder[i];
    const { scalar, observations } = groups.get(key);
    const record = { ...scalar };
    if (observations.length > 0) {
      record.observations = observations;
    }

    // Derive collection_year from collection_date if not already present
    if (record.collection_date && !record.collection_year) {
      const year = extractCollectionYear(record.collection_date);
      if (year) record.collection_year = year;
    }

    if (schema) {
      const { errors, warnings } = validateRowAgainstSchema(
        record,
        i + 2,
        schema,
        uniqueSets,
      );
      if (errors.length) allErrors.push(...errors);
      if (warnings.length) allWarnings.push(...warnings);
      if (allErrors.length >= maxErrors) break;
    }

    jsonlRows.push(JSON.stringify(record));
  }

  progressCb(1);

  const validation = schema
    ? {
        ok: allErrors.length === 0,
        fatal: false,
        header: { missing: [] },
        counts: { errors: allErrors.length, warnings: allWarnings.length },
        errors: allErrors,
        warnings: allWarnings,
      }
    : null;

  return { jsonlRows, validation };
}

/**
 * Build a fatal result object for early termination errors.
 */
export function buildFatalResult(
  delimiter,
  headers,
  code,
  msg,
  missingHeaders = [],
) {
  const errorCount = missingHeaders.length || 1;
  const errors = missingHeaders.length
    ? missingHeaders.map((h) => ({
        row: 1,
        column: h,
        code,
        msg: "Header missing",
      }))
    : [{ row: 1, column: "", code, msg }];

  return {
    jsonl: "",
    headers: headers || [],
    rows: 0,
    delimiter: delimiter || ",",
    validation: {
      ok: false,
      fatal: true,
      header: { missing: missingHeaders },
      counts: { errors: errorCount, warnings: 0 },
      errors,
      warnings: [],
    },
  };
}

/**
 * Extract complete lines from a buffer, returning lines and the remaining partial line.
 */
export function extractLines(buffer) {
  const lines = [];
  let lineStart = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === "\r" && buffer[i + 1] === "\n") {
      lines.push(buffer.slice(lineStart, i));
      i++; // skip the \n so it isn't processed again
      lineStart = i + 1;
    } else if (buffer[i] === "\n") {
      lines.push(buffer.slice(lineStart, i));
      lineStart = i + 1;
    }
  }

  return { lines, remaining: buffer.slice(lineStart) };
}

export function buildAmrWatchRowMapper(
  speciesMap,
  availableDrugCols = null,
  speciesOverride = null,
) {
  const drugCols = AMR_WATCH_HEADERS.drugCols;
  const activeDrugCols = Array.isArray(availableDrugCols)
    ? availableDrugCols
    : Object.keys(AMR_WATCH_HEADERS.drugCols);
  const normalizedOverride =
    typeof speciesOverride === "string" && speciesOverride.trim().length > 0
      ? speciesOverride.trim()
      : null;
  return (row) => {
    const accession = row[AMR_WATCH_HEADERS.accession]?.trim();
    const species =
      normalizedOverride || speciesMap?.[accession] || "Unknown species";
    const genus =
      species && species !== "Unknown species"
        ? species.split(" ")[0]
        : "Unknown genus";
    const country = row[AMR_WATCH_HEADERS.country] ?? "";
    const collectionDate = row[AMR_WATCH_HEADERS.date] ?? "";
    const collectionYear = extractCollectionYear(collectionDate);

    // Build observations: each gene paired with its drug class
    const observations = [];
    for (const col of activeDrugCols) {
      const label = drugCols[col];
      const cell = row[col];
      if (!isNullishCell(cell)) {
        const genes = String(cell)
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean);
        for (const gene of genes) {
          observations.push({
            antibiotic_resistant: label,
            gene: gene,
          });
        }
      }
    }

    return {
      id: accession || "",
      country,
      species,
      genus,
      collection_date: collectionDate,
      collection_year: collectionYear,
      observations,
    };
  };
}

// ---------- CSV -> JSONL (Flat per-observation format) ----------
export function csvFlatTextToJsonl(
  text,
  {
    delimiter = null,
    sniffBytes = 8192,
    inferTypes = false,
    idColumn = "id",
    linkedFields = [],
    keepHeaders = [],
    pretty = false,
    progressCb = () => {},
    schema = null,
    maxErrors = 200,
  },
) {
  const sample = text.slice(0, sniffBytes);
  const delim = delimiter || sniffDelimiter(sample, ",");

  const lines = text.split(/\r?\n/);
  if (!lines.length) return { jsonl: "", headers: [], rows: 0 };

  const headerLine = lines.shift() || "";
  const headers = parseCsvLine(headerLine, delim);

  // Header validation
  if (schema && schema.requireHeaders?.length) {
    const hres = validateHeaders(headers, schema.requireHeaders);
    if (!hres.ok) {
      return buildFatalResult(
        delim,
        headers,
        "missing_header",
        "Header missing",
        hres.missing,
      );
    }
  }

  // Parse all data rows into objects
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = parseCsvLine(line, delim);
    const rowObj = {};
    for (let c = 0; c < headers.length; c++) {
      rowObj[headers[c]] = cells[c] ?? "";
    }
    rows.push(rowObj);
  }

  // Group by sample ID and build JSONL
  const { jsonlRows, validation } = groupFlatRowsToJsonl(rows, {
    idColumn,
    linkedFields,
    inferTypes,
    schema,
    maxErrors,
    progressCb,
  });

  const jsonl =
    jsonlRows
      .map((r) => (pretty ? JSON.stringify(JSON.parse(r), null, 2) : r))
      .join("\n") + (jsonlRows.length ? "\n" : "");

  return {
    jsonl,
    headers,
    rows: jsonlRows.length,
    delimiter: delim,
    validation,
  };
}

// ---------- CSV -> JSONL (Legacy - list-column format) ----------
export function csvTextToJsonl(
  text,
  {
    delimiter = null,
    sniffBytes = 8192,
    inferTypes = false,
    listCols = new Set(),
    listSep = DEFAULT_LIST_SEPARATOR,
    inferListElems = false,
    keepHeaders = [],
    pretty = false,
    progressCb = () => {},
    schema = null,
    rowMapper = null,
    maxErrors = 200,
  },
) {
  // Delimiter sniff: sample first sniffBytes
  const sample = text.slice(0, sniffBytes);
  const delim = delimiter || sniffDelimiter(sample, ",");

  const lines = text.split(/\r?\n/);
  if (!lines.length) return { jsonl: "", headers: [], rows: 0 };

  // Header
  const headerLine = lines.shift() || "";
  const headers = parseCsvLine(headerLine, delim);

  // Header validation
  if (schema && schema.requireHeaders?.length) {
    const hres = validateHeaders(headers, schema.requireHeaders);
    if (!hres.ok) {
      return buildFatalResult(
        delim,
        headers,
        "missing_header",
        "Header missing",
        hres.missing,
      );
    }
  }

  // Build rows
  const rowsOut = [];
  const total = Math.max(1, lines.length);

  const uniqueSets = new Set();
  const allErrors = [];
  const allWarnings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const cells = parseCsvLine(line, delim);
    const rowObj = {};
    for (let c = 0; c < headers.length; c++) {
      rowObj[headers[c]] = cells[c] ?? "";
    }

    const mappedRow = rowMapper ? rowMapper(rowObj) : rowObj;
    if (!mappedRow) continue;

    const tr = transformRow(mappedRow, {
      inferTypes,
      listCols,
      listSep,
      inferListElems,
      keepHeaders,
    });

    // Row validation (2-based row index including header)
    if (schema) {
      const { errors, warnings } = validateRowAgainstSchema(
        tr,
        i + 2,
        schema,
        uniqueSets,
      );
      if (errors.length) allErrors.push(...errors);
      if (warnings.length) allWarnings.push(...warnings);
      if (allErrors.length >= maxErrors) break;
    }

    rowsOut.push(JSON.stringify(tr, null, pretty ? 2 : 0));
    if (i % 500 === 0) progressCb(i / total); // periodic progress
  }
  progressCb(1);

  const validation = schema
    ? {
        ok: allErrors.length === 0,
        fatal: false,
        header: { missing: [] },
        counts: { errors: allErrors.length, warnings: allWarnings.length },
        errors: allErrors,
        warnings: allWarnings,
      }
    : null;

  return {
    jsonl: rowsOut.join("\n") + (rowsOut.length ? "\n" : ""),
    headers,
    rows: rowsOut.length,
    delimiter: delim,
    validation,
  };
}
