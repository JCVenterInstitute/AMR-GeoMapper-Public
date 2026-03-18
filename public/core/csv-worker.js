import { getSpeciesBatch } from "../utils/sraLookup.js";
import {
  AMR_WATCH_HEADERS,
  parseCsvLine,
  sniffDelimiter,
  parseHeaderSample,
  isAmrWatchHeaders,
} from "../utils/csvUtils.js";
import {
  DEFAULT_LIST_SEPARATOR,
  extractCollectionYear,
  inferValue,
  validateHeaders,
  typeOfValue,
  validateRowAgainstSchema,
  isNullishCell,
  parseListField,
  transformRow,
  buildFatalResult,
  extractLines,
  buildAmrWatchRowMapper,
  csvTextToJsonl,
  csvFlatTextToJsonl,
  groupFlatRowsToJsonl,
  extractFlatObservation,
} from "./csv-transforms.js";

async function scanCsvColumnValuesFromStream(
  fileStream,
  { delimiter, columnIndex, progressCb = () => {}, fileSize = null }
) {
  const reader = fileStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let headerSkipped = false;
  let bytesProcessed = 0;
  const values = new Set();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      bytesProcessed += value.byteLength || 0;
      buffer += decoder.decode(value, { stream: true });
    }

    let lineStart = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === "\n" || (buffer[i] === "\r" && buffer[i + 1] === "\n")) {
        const lineEnd = buffer[i] === "\r" ? i + 2 : i + 1;
        const line = buffer.slice(lineStart, i).replace(/\r$/, "");
        lineStart = lineEnd;

        if (!headerSkipped) {
          headerSkipped = true;
        } else if (line.trim()) {
          const cells = parseCsvLine(line, delimiter);
          const val = cells[columnIndex];
          if (!isNullishCell(val)) values.add(String(val).trim());
        }
      }
    }
    buffer = buffer.slice(lineStart);

    if (fileSize && fileSize > 0) {
      progressCb(Math.min(0.2, bytesProcessed / fileSize));
    }
  }

  if (buffer.trim()) {
    if (headerSkipped) {
      const cells = parseCsvLine(buffer.replace(/\r$/, ""), delimiter);
      const val = cells[columnIndex];
      if (!isNullishCell(val)) values.add(String(val).trim());
    }
  }

  return values;
}

// ---------- CSV -> JSONL (Streaming) ----------
async function csvStreamToJsonl(
  fileStream,
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
    chunkCallback = null, // Callback to store chunks: (chunkIndex, jsonlChunk) => Promise
    chunkSizeBytes = 10 * 1024 * 1024, // 10MB chunks
    fileSize = null, // Total file size for progress calculation
  }
) {
  const decoder = new TextDecoder();
  const reader = fileStream.getReader();

  let buffer = "";
  let headers = null;
  let delimiter_final = null;
  let rowIndex = 0;
  let totalRows = 0;
  let currentChunk = "";
  let currentChunkSize = 0;
  let chunkIndex = 0;
  let preview = [];
  let previewLines = 5;
  let bytesProcessed = 0; // Track bytes processed for progress

  const uniqueSets = new Set();
  const allErrors = [];
  const allWarnings = [];

  // First, read sample for delimiter detection
  let sampleBuffer = "";
  let sampleRead = false;

  while (!sampleRead) {
    const { value, done } = await reader.read();

    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      sampleBuffer += chunk;
    }

    // If we have enough bytes or file is done, detect delimiter
    if (
      sampleBuffer.length >= sniffBytes ||
      (done && sampleBuffer.length > 0)
    ) {
      // Sniff delimiter from sample
      delimiter_final =
        delimiter ||
        sniffDelimiter(
          sampleBuffer.slice(0, Math.min(sniffBytes, sampleBuffer.length)),
          ","
        );
      buffer = sampleBuffer; // Continue with full buffer
      sampleRead = true;
      if (done && sampleBuffer.length === 0) {
        return buildFatalResult(",", [], "empty_file", "File is empty");
      }
      break;
    }

    if (done && sampleBuffer.length === 0) {
      return buildFatalResult(",", [], "empty_file", "File is empty");
    }
  }

  // Process header
  let headerLine = "";
  let headerEnd = -1;

  // Find first newline for header
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === "\n" || (buffer[i] === "\r" && buffer[i + 1] === "\n")) {
      headerEnd = buffer[i] === "\r" ? i + 2 : i + 1;
      headerLine = buffer.slice(0, i).replace(/\r$/, "");
      break;
    }
  }

  if (headerEnd === -1) {
    // Header might span chunks, need to read more
    while (headerEnd === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      for (let i = 0; i < buffer.length; i++) {
        if (
          buffer[i] === "\n" ||
          (buffer[i] === "\r" && buffer[i + 1] === "\n")
        ) {
          headerEnd = buffer[i] === "\r" ? i + 2 : i + 1;
          headerLine = buffer.slice(0, i).replace(/\r$/, "");
          break;
        }
      }
    }
  }

  if (headerEnd === -1) {
    return buildFatalResult(delimiter_final, [], "no_header", "No header line found");
  }

  headers = parseCsvLine(headerLine, delimiter_final);
  buffer = buffer.slice(headerEnd);

  // Header validation
  if (schema && schema.requireHeaders?.length) {
    const hres = validateHeaders(headers, schema.requireHeaders);
    if (!hres.ok) {
      return buildFatalResult(delimiter_final, headers, "missing_header", "Header missing", hres.missing);
    }
  }

  // Process rows line by line
  const processLine = (line) => {
    if (!line.trim()) return null;

    const cells = parseCsvLine(line, delimiter_final);
    const rowObj = {};
    for (let c = 0; c < headers.length; c++) {
      rowObj[headers[c]] = cells[c] ?? "";
    }

    const mappedRow = rowMapper ? rowMapper(rowObj) : rowObj;
    if (!mappedRow) return null;

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
        rowIndex + 2,
        schema,
        uniqueSets
      );
      if (errors.length) allErrors.push(...errors);
      if (warnings.length) allWarnings.push(...warnings);
      if (allErrors.length >= maxErrors) return null;
    }

    const jsonLine = JSON.stringify(tr, null, pretty ? 2 : 0);
    rowIndex++;
    totalRows++;

    if (preview.length < previewLines) {
      preview.push(jsonLine);
    }

    return jsonLine;
  };

  // Process buffer and handle chunking
  const flushChunk = async () => {
    if (currentChunk && chunkCallback) {
      await chunkCallback(chunkIndex, currentChunk);
      chunkIndex++;
      currentChunk = "";
      currentChunkSize = 0;
    }
  };

  const addLineToChunk = async (line) => {
    const jsonLine = processLine(line);
    if (jsonLine) {
      const lineWithNewline = jsonLine + "\n";
      currentChunk += lineWithNewline;
      currentChunkSize += new TextEncoder().encode(lineWithNewline).length;
      if (currentChunkSize >= chunkSizeBytes) {
        await flushChunk();
      }
    }
  };

  // Process initial buffer
  const initialExtract = extractLines(buffer);
  for (const line of initialExtract.lines) {
    await addLineToChunk(line);
  }
  buffer = initialExtract.remaining;

  // Continue reading from stream
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const chunkBytes = new TextEncoder().encode(chunk).length;
    bytesProcessed += chunkBytes;
    buffer += chunk;

    // Process complete lines
    const extracted = extractLines(buffer);
    for (const line of extracted.lines) {
      await addLineToChunk(line);

      // Progress update every 1000 rows
      if (totalRows % 1000 === 0) {
        const progress = fileSize && fileSize > 0
          ? Math.min(0.95, bytesProcessed / fileSize)
          : Math.min(0.95, totalRows / Math.max(100000, totalRows * 1.1));
        progressCb(progress);
      }
    }
    buffer = extracted.remaining;
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const jsonLine = processLine(buffer.trim());
    if (jsonLine) {
      currentChunk += jsonLine + "\n";
    }
  }

  // Flush final chunk
  if (currentChunk && chunkCallback) {
    await flushChunk();
  }

  // Final progress update
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
    headers,
    rows: totalRows,
    delimiter: delimiter_final,
    validation,
    preview,
    chunkCount: chunkIndex,
  };
}

// IndexedDB setup for chunk storage (in worker)
async function setupWorkerIndexedDB(dbName, dbVersion) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // Create chunks store if it doesn't exist
      if (!db.objectStoreNames.contains("chunks")) {
        const chunksStore = db.createObjectStore("chunks", {
          keyPath: ["key", "chunkIndex"],
        });
        chunksStore.createIndex("by-key", "key", { unique: false });
      }
      // Create metadata store if it doesn't exist
      if (!db.objectStoreNames.contains("metadata")) {
        db.createObjectStore("metadata");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function storeChunk(db, key, chunkIndex, chunkData) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");
    const req = store.put({ key, chunkIndex, data: chunkData });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function storeMetadata(db, key, metadata) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("metadata", "readwrite");
    const store = tx.objectStore("metadata");
    const req = store.put(metadata, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener("message", async (e) => {
  try {
    const { type } = e.data || {};

    if (type === "loadSelected") {
      const {
        file,
        headers: keepHeaders,
        options = {},
        dbName,
        dbVersion,
        resultKey,
        speciesOverride,
      } = e.data;
      if (!file) {
        self.postMessage({ type: "error", error: "No file provided." });
        return;
      }

      const {
        delimiter = null,
        sniffBytes = 8192,
        inferTypes = false,
        listCols = [], // array of names from UI (legacy list-column mode)
        listSep = DEFAULT_LIST_SEPARATOR,
        inferListElems = true,
        pretty = false,
        useStreaming = true, // Enable streaming by default for large files
        chunkSizeBytes = 10 * 1024 * 1024, // 10MB chunks
        flatObservations = false, // flat per-observation CSV mode
        idColumn = "id", // column for grouping rows in flat mode
        linkedFields = [], // observation columns in flat mode
      } = options;

      const headerSample = await file.slice(0, sniffBytes).text();
      const headerInfo = parseHeaderSample(headerSample, delimiter);
      const isAmrWatch = isAmrWatchHeaders(headerInfo.headers);
      let scanProgressMax = 0.2;
      let lookupProgressBase = 0.2;
      let lookupProgressSpan = 0.2;
      let conversionProgressBase = 0.4;
      let conversionProgressSpan = 0.6;
      let rowMapper = null;
      let effectiveSchema = options.schema ?? null;
      let effectiveDelimiter = delimiter || headerInfo.delimiter;

      if (isAmrWatch) {
        const requiredHeaders = [
          AMR_WATCH_HEADERS.accession,
          AMR_WATCH_HEADERS.country,
          AMR_WATCH_HEADERS.date,
        ];
        const hres = validateHeaders(headerInfo.headers, requiredHeaders);
        if (!hres.ok) {
          self.postMessage({
            type: "result",
            meta: null,
            result: null,
            validation: {
              ok: false,
              fatal: true,
              header: { missing: hres.missing },
              counts: { errors: hres.missing.length, warnings: 0 },
              errors: hres.missing.map((h) => ({
                row: 1,
                column: h,
                code: "missing_header",
                msg: "Header missing",
              })),
              warnings: [],
            },
          });
          return;
        }

        const override =
          typeof speciesOverride === "string" ? speciesOverride.trim() : "";
        const hasOverride = override.length > 0;
        if (hasOverride) {
          scanProgressMax = 0;
          lookupProgressBase = 0;
          lookupProgressSpan = 0;
          conversionProgressBase = 0;
          conversionProgressSpan = 1;
        }

        let speciesMap = {};
        if (!hasOverride) {
          const accessionIndex = headerInfo.headers.indexOf(
            AMR_WATCH_HEADERS.accession
          );
          const accessionSet = await scanCsvColumnValuesFromStream(
            file.stream(),
            {
              delimiter: effectiveDelimiter,
              columnIndex: accessionIndex,
              progressCb: (p) =>
                self.postMessage({
                  type: "progress",
                  progress: Math.min(scanProgressMax, p),
                }),
              fileSize: file.size,
            }
          );
          try {
            speciesMap = await getSpeciesBatch(Array.from(accessionSet), {
              onProgress: ({ completed, total }) => {
                const ratio = total > 0 ? completed / total : 1;
                const progress =
                  lookupProgressBase + ratio * lookupProgressSpan;
                self.postMessage({ type: "progress", progress });
              },
            });
          } catch (err) {
            console.warn("Species lookup failed, continuing:", err);
            speciesMap = {};
          }
        }
        const availableDrugCols = Object.keys(AMR_WATCH_HEADERS.drugCols).filter(
          (col) => headerInfo.headers.includes(col)
        );
        rowMapper = buildAmrWatchRowMapper(
          speciesMap,
          availableDrugCols,
          override
        );
        effectiveSchema = null;
      }

      // Use streaming for files larger than 50MB, or if explicitly requested.
      // Flat-observation mode requires grouping by ID, so it cannot stream row-by-row.
      const useStream =
        !flatObservations &&
        useStreaming && (file.size > 50 * 1024 * 1024 || useStreaming === true);

      if (useStream && file.stream) {
        // Streaming mode: process file in chunks and store incrementally
        try {
          const stream = file.stream();

          // Setup IndexedDB in worker
          const db = await setupWorkerIndexedDB(
            dbName || "CsvUploadCache",
            dbVersion || 4
          );

          let chunkIndex = 0;
          const chunkCallback = async (idx, chunkData) => {
            await storeChunk(db, resultKey, idx, chunkData);
            self.postMessage({
              type: "chunk-stored",
              chunkIndex: idx,
              chunkSize: new TextEncoder().encode(chunkData).length,
            });
          };

          const res = await csvStreamToJsonl(stream, {
            delimiter: effectiveDelimiter,
            sniffBytes,
            inferTypes,
            listCols: new Set(listCols),
            listSep,
            inferListElems,
            keepHeaders,
            pretty,
            progressCb: (p) =>
              self.postMessage({
                type: "progress",
                progress: isAmrWatch
                  ? conversionProgressBase + p * conversionProgressSpan
                  : p,
              }),
            schema: effectiveSchema,
            rowMapper,
            maxErrors: options.maxErrors ?? 200,
            chunkCallback,
            chunkSizeBytes,
            fileSize: file.size, // Pass file size for accurate progress
          });

          if (res.validation && res.validation.fatal) {
            self.postMessage({
              type: "result",
              meta: null,
              result: null,
              validation: res.validation,
            });
            return;
          }

          // Store metadata
          const meta = {
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            rows: res.rows,
            delimiter: res.delimiter,
            selectedHeaders: keepHeaders,
            chunked: true,
            chunkCount: res.chunkCount || 0,
          };

          await storeMetadata(db, resultKey, meta);
          db.close();

          self.postMessage({
            type: "result",
            meta,
            result: { chunked: true, preview: res.preview || [] },
            validation: res.validation,
          });
          return;
        } catch (streamErr) {
          // Fallback to non-streaming if streaming fails
          console.warn(
            "Streaming failed, falling back to non-streaming:",
            streamErr
          );
        }
      }

      // Fallback: non-streaming mode (for smaller files or compatibility)
      const text = await file.text();

      const progressFn = (p) =>
        self.postMessage({
          type: "progress",
          progress: isAmrWatch
            ? conversionProgressBase + p * conversionProgressSpan
            : p,
        });

      const res = (flatObservations && !isAmrWatch)
        ? csvFlatTextToJsonl(text, {
            delimiter: effectiveDelimiter,
            sniffBytes,
            inferTypes,
            idColumn,
            linkedFields,
            keepHeaders,
            pretty,
            progressCb: progressFn,
            schema: effectiveSchema,
            maxErrors: options.maxErrors ?? 200,
          })
        : csvTextToJsonl(text, {
            delimiter: effectiveDelimiter,
            sniffBytes,
            inferTypes,
            listCols: new Set(listCols),
            listSep,
            inferListElems,
            keepHeaders,
            pretty,
            progressCb: progressFn,
            schema: effectiveSchema,
            rowMapper,
            maxErrors: options.maxErrors ?? 200,
          });

      if (res.validation && res.validation.fatal) {
        // Send a lightweight result with validation only; no blob/meta/preview
        self.postMessage({
          type: "result",
          meta: null,
          result: null,
          validation: res.validation,
        });
        return;
      }

      // Return a Blob so the main thread can save/download or store it.
      const blob = new Blob([res.jsonl], { type: "application/x-ndjson" });
      const meta = {
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        rows: res.rows,
        delimiter: res.delimiter,
        selectedHeaders: keepHeaders,
        chunked: false,
      };

      // Include a tiny preview (first 5 lines) for quick UI feedback
      const preview = res.jsonl.split("\n").slice(0, 5).filter(Boolean);

      self.postMessage({
        type: "result",
        meta,
        result: { blob, preview },
        validation: res.validation,
      });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      error: (err && err.message) || String(err),
    });
  }
});
