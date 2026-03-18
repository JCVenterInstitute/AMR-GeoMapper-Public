import { GeneObservationProcessor } from "./geneObservationProcessor.js";

class DataLoader {
  #filterConfigMap;

  /**
   * @date 15/07/2025
   * @param {[string]} dataUrls
   */
  constructor(filterTypes = [], config = {}) {
    this.filterTypes = filterTypes;
    this.activeFilters = {};
    this.filters = {};
    this.meta = {
      general: {
        totalObservationCount: 0,
        filteredObservationCount: 0,
      },
      groups: {},
    };
    this.dataObj = null;
    this.jsonObjs = [];
    this.taxonomy = {};
    // Track unfiltered year totals for relative mode calculations
    // Structure: datasetName -> yearString -> count
    this.unfilteredYearTotals = new Map();
    this.idbName = "CsvUploadCache";
    this.idbVersion = 4; // same or higher than your component uses (updated for chunked storage)
    this.storeResults = "results";
    this.storeChunks = "chunks";
    this.storeMetadata = "metadata";

    // Gene observation processor for linked field relationships
    this.obsProcessor = new GeneObservationProcessor(config);
    this.blob = null;

    // Cached filter lookups (initialized lazily)
    this.#filterConfigMap = null;
  }

  /**
   * Gets or creates the cached filter config map for O(1) lookups.
   * @returns {Map<string, Object>}
   */
  #getFilterConfigMap() {
    if (!this.#filterConfigMap) {
      this.#filterConfigMap = new Map(
        this.filterTypes.map((f) => [f.column, f]),
      );
    }
    return this.#filterConfigMap;
  }

  /**
   * Converts a blob stream to an async iterable of string chunks.
   * @param {Blob} blob
   * @yields {string}
   */
  async *#streamToChunks(blob) {
    const reader = blob.stream().getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  }

  /**
   * Parses JSONL from an async iterable of string chunks.
   * @param {AsyncIterable<string>} chunks
   * @param {Function} handleRow - Callback to process each parsed row
   * @yields {Object} Parsed and processed rows
   */
  async *#parseJsonlChunks(chunks, handleRow) {
    let buf = "";

    for await (const chunk of chunks) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const s = line.trim();
        if (!s) continue;
        try {
          const parsed = handleRow(JSON.parse(s));
          if (parsed) yield parsed;
        } catch (err) {
          console.warn("Bad JSONL line (skipped):", s, err);
        }
      }
    }

    const tail = buf.trim();
    if (tail) {
      try {
        const parsed = handleRow(JSON.parse(tail));
        if (parsed) yield parsed;
      } catch (err) {
        console.warn("Bad JSONL tail (skipped):", tail, err);
      }
    }
  }

  /**
   * @description This generator chunks the json data from the api and user upload and sends it to be reduced into map data objects.
   * @date 15/07/2025
   * @return {*}
   * @memberof dataLoader
   */
  async *dataGenerator() {
    // Check if user data exists before returning early
    const loadUserData = localStorage.getItem("AMRTrackerUserDataLoaded");
    const key = localStorage.getItem("latestJsonlKey") || null;
    const hasUserData = key && loadUserData === "true";

    // Allow processing if user data exists, even if dataObj is null/empty
    if (this.dataObj === null && !hasUserData) {
      console.error("No data loaded from API");
      return;
    }

    // Initialize dataObj to empty array if null and user data exists
    if (this.dataObj === null && hasUserData) {
      this.dataObj = [];
    }

    const reset = () => {
      this.meta.general.totalObservationCount = 0;
      this.meta.general.filteredObservationCount = 0;
      this.meta.groups = {};
      this.jsonObjs = [];
      this.taxonomy = {};
      this.blob = null;
      this.unfilteredYearTotals = new Map();
    };
    reset();

    // This is where non-user data is processed.
    if (this.dataObj && Array.isArray(this.dataObj)) {
      for (let row of this.dataObj) {
        const processedRow = this.handleRow(row);
        if (!!processedRow) {
          yield processedRow;
        } else {
          continue;
        }
      }
    }

    // This is where user data is loaded.
    // At this point the user data has already been loaded from csv to jsonl.
    // It is then stored in the browsers indexedDB and processed here.
    // Parse key(s) — supports JSON array (multi-file) and legacy single-string format
    if (hasUserData) {
      let keys;
      try {
        const parsed = JSON.parse(key);
        keys = Array.isArray(parsed) ? parsed : [key];
      } catch {
        keys = [key];
      }

      for (const k of keys) {
        const record = await this.idbGetResult(k);
        if (!record) {
          console.warn(`Skipping missing user data entry. Key: ${k}`);
          continue;
        }

        if (record.chunked) {
          const chunks = await this.idbGetChunks(k);
          yield* this.#parseJsonlChunks(chunks, (row) => this.handleRow(row));
        } else if (record.blob) {
          yield* this.#parseJsonlChunks(
            this.#streamToChunks(record.blob),
            (row) => this.handleRow(row),
          );
        } else {
          console.warn(`No blob or chunks found. Key: ${k}`);
        }
      }
    }
  }

  handleRow(row) {
    try {
      // Track unfiltered year totals for ALL rows (before filter check)
      const dataset = row.dataset ?? "User Data";
      let yearValue = row.collection_year;
      if (yearValue) {
        const yearStr = Array.isArray(yearValue)
          ? String(yearValue[0]).trim()
          : String(yearValue).trim();
        // Only track valid numeric years
        if (yearStr && /^\d{4}$/.test(yearStr)) {
          if (!this.unfilteredYearTotals.has(dataset)) {
            this.unfilteredYearTotals.set(dataset, new Map());
          }
          const dsMap = this.unfilteredYearTotals.get(dataset);
          dsMap.set(yearStr, (dsMap.get(yearStr) ?? 0) + 1);
        }
      }

      if (!this.filterRow(row)) {
        return false;
      }

      if (row["family"]) {
        this.taxonomy[row["family"]] ||= {};
        if (row["genus"]) {
          this.taxonomy[row["family"]][row["genus"]] ||= new Set();
          if (row["species"]) {
            let thisGenus = this.taxonomy[row["family"]][row["genus"]];
            if (!thisGenus.has(row["species"])) {
              thisGenus.add(row["species"]);
            }
          }
        }
      }

      this.updateMetadata(row);
      this.jsonObjs.push(row);
      return row;
    } catch (err) {
      console.error("Failed to parse JSONL line:", row, err);
    }
  }

  filterRow(row) {
    // OR within groups, AND between groups
    const data = row;
    const rowDate = data["collection_date"]
      ? new Date(String(data["collection_date"]))
      : data["collection_year"]
        ? new Date(String(data["collection_year"]))
        : null;

    if (Object.keys(this.activeFilters).length > 0) {
      for (let group of Object.keys(this.activeFilters)) {
        const filters = this.activeFilters[group];

        if (group === "date-start") {
          const startDateRange = filters; // a Date
          if (rowDate === null || Number.isNaN(rowDate.getTime())) {
            return false;
          }
          if (rowDate < startDateRange) {
            return false;
          }
        } else if (group === "date-end") {
          const endDateRange = filters; // a Date
          if (rowDate === null || Number.isNaN(rowDate.getTime())) {
            return false;
          }
          if (rowDate > endDateRange) {
            return false;
          }
        } else {
          // case insensitive normalization
          const norm = (x) =>
            typeof x === "string" ? x.trim().toLowerCase() : String(x);

          const filterConfig = this.#getFilterConfigMap().get(group);

          // For linked/arrayType fields, collect values from observations
          if (filterConfig?.arrayType && Array.isArray(data.observations)) {
            const valueSet = new Set();
            for (const obs of data.observations) {
              const v = obs[group];
              if (v != null && v !== "") valueSet.add(norm(v));
            }
            if (valueSet.size === 0) return false;

            let hasMatch = false;
            for (const filter of filters) {
              if (valueSet.has(norm(filter))) {
                hasMatch = true;
                break;
              }
            }
            if (!hasMatch) return false;
          } else {
            const val = data[group];
            if (val == null) return false;

            const valueSet = new Set([norm(val)]);

            let hasMatch = false;
            for (const filter of filters) {
              if (valueSet.has(norm(filter))) {
                hasMatch = true;
                break;
              }
            }
            if (!hasMatch) return false;
          }
        }
      }
    }

    return true;
  }

  updateMetadata(jsonObj) {
    const data = jsonObj;
    const configMap = this.#getFilterConfigMap();

    // Process non-observation (scalar) fields
    for (const group of Object.keys(data)) {
      if (group === "observations") continue;
      if (!configMap.has(group)) continue;

      const filterConfig = configMap.get(group);
      if (filterConfig?.arrayType) continue; // handled below from observations

      const val = data[group];
      if (val === undefined || val === null || val === "") continue;

      if (!this.meta.groups[group]) {
        this.meta.groups[group] = {
          count: 0,
          unique: new Set(),
          valueCounts: {},
        };
      }
      const groupMeta = this.meta.groups[group];
      const key = String(val);
      groupMeta.valueCounts[key] = (groupMeta.valueCounts[key] ?? 0) + 1;
      groupMeta.unique.add(key);
    }

    // Process arrayType (linked) fields from observations
    if (Array.isArray(data.observations)) {
      for (const [group, filterConfig] of configMap) {
        if (!filterConfig.arrayType) continue;

        if (!this.meta.groups[group]) {
          this.meta.groups[group] = {
            count: 0,
            unique: new Set(),
            valueCounts: {},
          };
        }
        const groupMeta = this.meta.groups[group];

        // Dedupe within this row to avoid double-counting
        const seen = new Set();
        for (const obs of data.observations) {
          const v = obs[group];
          if (v === undefined || v === null || v === "") continue;
          if (!seen.has(v)) {
            seen.add(v);
            const key = String(v);
            groupMeta.valueCounts[key] = (groupMeta.valueCounts[key] ?? 0) + 1;
            groupMeta.unique.add(key);
          }
        }
      }
    }
  }

  /**
   * @description Add additional active filter
   * @date 29/07/2025
   * @param {String} type Filter category
   * @param {String} value
   * @memberof DataLoader
   */
  addFilter(type, value, specialType = null) {
    try {
      if (!specialType) {
        this.activeFilters[type] ??= new Set();
        this.activeFilters[type].add(value);
      } else {
        switch (specialType) {
          case "date":
            this.activeFilters[type] = value;
            break;
        }
      }
    } catch (err) {
      console.error(`Error adding filter "${type}, ${value}": ${err}`);
    }
  }

  removeFilter(type, value = null) {
    try {
      if (value === null) {
        delete this.activeFilters[type];
      } else {
        this.activeFilters[type]?.delete?.(value);
        if (this.activeFilters[type] instanceof Set && this.activeFilters[type].size === 0) {
          delete this.activeFilters[type];
        }
      }
    } catch (err) {
      console.error(`Error removing filter "${type}, ${value}": ${err}`);
    }
  }

  /**
   * Get the gene observation processor instance.
   * @returns {GeneObservationProcessor}
   */
  getObservationProcessor() {
    return this.obsProcessor;
  }

  /**
   * Get the count of filtered observations.
   * @returns {number}
   */
  getFilteredObservationCount() {
    return this.meta.general.filteredObservationCount;
  }

  /**
   * Increment the filtered observation count.
   * Called during data loading when processing observations.
   * @param {number} count - Number of observations to add
   */
  incrementObservationCount(count = 1) {
    this.meta.general.filteredObservationCount += count;
  }

  createAllDataBlob() {
    const rows = Array.isArray(this.jsonObjs) ? this.jsonObjs : [];
    if (!rows.length) {
      this.blob = new Blob([""], { type: "text/csv;charset=utf-8;" });
      return;
    }

    const csvEscape = (val) => {
      if (val === null || val === undefined) return "";
      if (Array.isArray(val)) {
        val = val.join(":");
      } else if (typeof val === "object") {
        val = JSON.stringify(val);
      }

      let s = String(val);
      if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    // Collect meta headers (everything except observations) and observation-level headers
    const metaHeaders = [];
    const obsKeySet = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key === "observations") {
          if (Array.isArray(row.observations)) {
            for (const obs of row.observations) {
              for (const k of Object.keys(obs)) obsKeySet.add(k);
            }
          }
        } else if (!metaHeaders.includes(key)) {
          metaHeaders.push(key);
        }
      }
    }
    const obsHeaders = [...obsKeySet];
    const allHeaders = [...metaHeaders, ...obsHeaders];

    const parts = [];
    parts.push(allHeaders.map((h) => csvEscape(h)).join(",") + "\r\n");

    // Flatten: one row per observation, duplicating meta columns.
    // Samples with no observations still get one row with empty obs fields.
    const chunkSize = 10000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const chunkLines = [];
      for (const row of chunk) {
        const metaVals = metaHeaders.map((h) => csvEscape(row[h]));
        const observations = Array.isArray(row.observations)
          ? row.observations
          : [];

        if (observations.length === 0) {
          const obsVals = obsHeaders.map(() => "");
          chunkLines.push([...metaVals, ...obsVals].join(",") + "\r\n");
        } else {
          for (const obs of observations) {
            const obsVals = obsHeaders.map((h) => csvEscape(obs[h]));
            chunkLines.push([...metaVals, ...obsVals].join(",") + "\r\n");
          }
        }
      }
      parts.push(...chunkLines);
    }

    this.blob = new Blob(parts, { type: "text/csv;charset=utf-8;" });
  }

  getAllDataBlob() {
    if (!this.blob) {
      this.createAllDataBlob();
    }
    return this.blob;
  }
  updateDataFiles(newUrlList) {
    this.dataUrls = newUrlList;
  }

  async updateDataObject(url, selectedSpecies, config = {}) {
    const json = await this.dataFetch(url, selectedSpecies, config);
    this.dataObj = json;
  }

  /**
   * @description This is were our data is loaded into the component. This function expects a json object from the api.
   * From here the data is processed by the *dataGenerator function.
   * @date 04/11/2025
   * @param {*} url
   * @param {*} selectedSpecies
   * @return {*}
   * @memberof DataLoader
   */
  async dataFetch(url, selectedSpecies, config = {}) {
    const body = { species: selectedSpecies };

    if (config.dataAPI?.dataFile) {
      body.dataFile = config.dataAPI.dataFile;
    }

    if (config.filters || config.linkedFields) {
      const obsFields = [];
      for (const f of config.filters ?? []) {
        if (f.arrayType) obsFields.push(f.column);
      }
      for (const f of config.linkedFields?.fields ?? []) {
        if (!obsFields.includes(f)) obsFields.push(f);
      }
      if (obsFields.length > 0) {
        body.observationFields = obsFields;
      }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return await res.json();
  }

  openResultsDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.idbName, this.idbVersion);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion || 0;

        if (!db.objectStoreNames.contains(this.storeResults)) {
          db.createObjectStore(this.storeResults);
        }

        // Create chunks store for incremental storage (version 4+)
        if (oldVersion < 4 && !db.objectStoreNames.contains(this.storeChunks)) {
          const chunksStore = db.createObjectStore(this.storeChunks, {
            keyPath: ["key", "chunkIndex"],
          });
          chunksStore.createIndex("by-key", "key", { unique: false });
        }

        // Create metadata store for chunked data (version 4+)
        if (
          oldVersion < 4 &&
          !db.objectStoreNames.contains(this.storeMetadata)
        ) {
          db.createObjectStore(this.storeMetadata);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Get all chunks for a given key (for chunked storage)
  async idbGetChunks(key) {
    const db = await this.openResultsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeChunks, "readonly");
      const store = tx.objectStore(this.storeChunks);
      const index = store.index("by-key");
      const req = index.getAll(key);

      req.onsuccess = () => {
        const chunks = req.result || [];
        // Sort by chunkIndex
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        resolve(chunks.map((c) => c.data));
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Create a blob from chunks (for backward compatibility)
  // Note: This method may fail for very large files due to string length limits
  // Use incremental chunk processing in dataGenerator instead
  async idbGetChunkedBlob(key) {
    const chunks = await this.idbGetChunks(key);
    // For very large files, joining all chunks may exceed string length limit
    // Instead, create a blob from chunks array directly (more memory efficient)
    return new Blob(chunks, { type: "application/jsonl" });
  }

  async idbGetResult(key) {
    const db = await this.openResultsDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeResults, "readonly");
      const req = tx.objectStore(this.storeResults).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get unfiltered year totals for all datasets.
   * Used for relative mode calculations to show percentages based on
   * pre-filter row counts rather than post-filter counts.
   * @returns {Map<string, Map<string, number>>} datasetName -> yearString -> count
   */
  getUnfilteredYearTotals() {
    return this.unfilteredYearTotals;
  }

  getAllFilters() {
    const result = {};
    for (const [group, meta] of Object.entries(this.meta.groups ?? {})) {
      result[group] = {
        ...meta,
        unique: Array.from(meta.unique ?? []),
      };
    }
    return result;
  }
  getActiveFilters() {
    return this.activeFilters;
  }
  getFilterValueCounts() {
    const counts = {};
    for (const [group, meta] of Object.entries(this.meta.groups ?? {})) {
      if (meta?.valueCounts) {
        counts[group] = { ...meta.valueCounts };
      }
    }
    return counts;
  }
}
export { DataLoader };
