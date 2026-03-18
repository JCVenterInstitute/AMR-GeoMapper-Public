/**
 * Shared CSV parsing utilities used by both the main thread (userFileHandler)
 * and the web worker (csv-worker).
 */

export const AMR_WATCH_HEADERS = {
  accession: "Run Accession",
  country: "Country Name",
  date: "Collection Date",
  drugCols: {
    "3G CEPHALOSPORIN": "cephalosporin",
    QUINOLONE: "quinolone",
    CARBAPENEM: "carbapenem",
  },
};

/**
 * Parse a single CSV line, handling quoted fields and escaped quotes.
 */
export function parseCsvLine(line, delimiter = ",") {
  const out = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === delimiter && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  // Strip BOM on first cell if present; trim spaces
  out[0] = out[0]?.replace(/^\uFEFF/, "") ?? "";
  return out.map((s) => s.trim());
}

/**
 * Detect the delimiter used in a CSV sample by checking common delimiters.
 */
export function sniffDelimiter(sample, fallback = ",") {
  const candidates = [",", "\t", ";", "|"];
  const scores = new Map(candidates.map((d) => [d, 0]));
  const lines = sample.split(/\r?\n/).slice(0, 10);

  for (const d of candidates) {
    let ok = 0;
    for (const line of lines) {
      if (!line) continue;
      const parts = parseCsvLine(line, d);
      if (parts.length > 1) ok++;
    }
    scores.set(d, ok);
  }

  let best = { d: fallback, s: -1 };
  for (const [d, s] of scores) {
    if (s > best.s) best = { d, s };
  }
  return best.s > 0 ? best.d : fallback;
}

/**
 * Parse the header row from a CSV sample, detecting delimiter if not provided.
 */
export function parseHeaderSample(sample, delimiter = null) {
  if (!sample) {
    return { headers: [], delimiter: delimiter || "," };
  }
  const firstLine = sample.split(/\r?\n/)[0] ?? "";
  const delim = delimiter || sniffDelimiter(sample, ",");
  const headers = parseCsvLine(firstLine, delim);
  return { headers, delimiter: delim };
}

/**
 * Check if headers indicate an AMR.watch format file.
 */
export function isAmrWatchHeaders(headers) {
  const required = [
    AMR_WATCH_HEADERS.accession,
    AMR_WATCH_HEADERS.country,
    AMR_WATCH_HEADERS.date,
  ];
  return required.every((h) => headers.includes(h));
}
