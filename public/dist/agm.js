/**
 * GeneObservationProcessor
 *
 * Transforms rows containing an `observations` array into individual
 * gene observation objects. Each observation in the array is a
 * self-contained object with linked field values. Non-linked fields
 * from the parent row are merged into each observation.
 *
 * Example:
 * Input row: {
 *   species: "E. coli",
 *   observations: [
 *     { gene: "geneA", evidence: "BLAST", drug_class: "beta-lactam" },
 *     { gene: "geneB", evidence: "HMM", drug_class: "aminoglycoside" }
 *   ]
 * }
 *
 * Output observations: [
 *   { gene: "geneA", evidence: "BLAST", drug_class: "beta-lactam", species: "E. coli" },
 *   { gene: "geneB", evidence: "HMM", drug_class: "aminoglycoside", species: "E. coli" }
 * ]
 */

class GeneObservationProcessor {
  /**
   * @param {Object} config - Configuration containing linkedFields
   * @param {Object} config.linkedFields - Linked fields configuration
   * @param {string[]} config.linkedFields.fields - Array of field names that are linked
   * @param {string} config.linkedFields.primaryKey - The primary key field (e.g., "gene")
   */
  constructor(config = {}) {
    const linkedConfig = config.linkedFields || {};
    this.linkedFields = linkedConfig.fields || [
      "gene",
      "evidence",
      "drug_class",
      "resistance_mechanism",
      "gene_short_name",
      "gene_family_name"
    ];
    this.primaryKey = linkedConfig.primaryKey || "gene";
  }

  /**
   * Transform a row with an observations array into flat observation objects.
   * Each observation is merged with the row's non-linked (non-observation) fields.
   *
   * @param {Object} row - The input row containing an `observations` array
   * @returns {Object[]} Array of observation objects
   */
  explodeRow(row) {
    if (!row) return [];

    const obs = row.observations;

    // If no observations array, check if linked fields exist at the top level
    // (flat row format — e.g., from IDB data created without linkedFields grouping).
    // Treat the row itself as a single observation.
    if (!Array.isArray(obs) || obs.length === 0) {
      const primaryValue = row[this.primaryKey];
      if (primaryValue === null || primaryValue === undefined || primaryValue === "") return [];
      // Only return the row as an observation if it has at least one linked field value
      const hasLinkedValue = this.linkedFields.some(f => {
        const v = row[f];
        return v !== null && v !== undefined && v !== "";
      });
      return hasLinkedValue ? [row] : [];
    }

    // Collect non-observation fields to merge into each observation
    const baseFields = {};
    for (const [key, value] of Object.entries(row)) {
      if (key !== "observations") {
        baseFields[key] = value;
      }
    }

    const results = [];
    for (const entry of obs) {
      if (this.primaryKey in entry) {
        const primaryValue = entry[this.primaryKey];
        if (primaryValue === null || primaryValue === undefined || primaryValue === "") continue;
      }
      results.push({ ...baseFields, ...entry });
    }

    return results;
  }

  /**
   * Get the count of observations a row would produce without fully exploding it.
   *
   * @param {Object} row - The input row
   * @returns {number} Number of observations this row would produce
   */
  countObservations(row) {
    if (!row || !Array.isArray(row.observations)) return 0;

    let count = 0;
    for (const entry of row.observations) {
      if (this.primaryKey in entry) {
        const v = entry[this.primaryKey];
        if (v === null || v === undefined || v === "") continue;
      }
      count++;
    }
    return count;
  }

  /**
   * Check if a row has observation data that can be exploded.
   *
   * @param {Object} row - The input row
   * @returns {boolean} True if row has observation data
   */
  hasLinkedData(row) {
    if (!row) return false;
    return Array.isArray(row.observations) && row.observations.length > 0;
  }

  /**
   * Get the list of linked fields.
   * @returns {string[]} Array of linked field names
   */
  getLinkedFields() {
    return [...this.linkedFields];
  }

  /**
   * Get the primary key field name.
   * @returns {string} Primary key field name
   */
  getPrimaryKey() {
    return this.primaryKey;
  }
}

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

const geoLookup = {
  "united states": {
    states: {
      alaska: {
        state_code: "AK",
        state_latitude: "63.588753",
        state_longitude: "-154.493062",
      },
      alabama: {
        state_code: "AL",
        state_latitude: "32.318231",
        state_longitude: "-86.902298",
      },
      arkansas: {
        state_code: "AR",
        state_latitude: "35.20105",
        state_longitude: "-91.831833",
      },
      arizona: {
        state_code: "AZ",
        state_latitude: "34.048928",
        state_longitude: "-111.093731",
      },
      california: {
        state_code: "CA",
        state_latitude: "36.778261",
        state_longitude: "-119.417932",
      },
      colorado: {
        state_code: "CO",
        state_latitude: "39.550051",
        state_longitude: "-105.782067",
      },
      connecticut: {
        state_code: "CT",
        state_latitude: "41.603221",
        state_longitude: "-73.087749",
      },
      "district of columbia": {
        state_code: "DC",
        state_latitude: "38.905985",
        state_longitude: "-77.033418",
      },
      delaware: {
        state_code: "DE",
        state_latitude: "38.910832",
        state_longitude: "-75.52767",
      },
      florida: {
        state_code: "FL",
        state_latitude: "27.664827",
        state_longitude: "-81.515754",
      },
      georgia: {
        state_code: "GA",
        state_latitude: "32.157435",
        state_longitude: "-82.907123",
      },
      hawaii: {
        state_code: "HI",
        state_latitude: "19.898682",
        state_longitude: "-155.665857",
      },
      iowa: {
        state_code: "IA",
        state_latitude: "41.878003",
        state_longitude: "-93.097702",
      },
      idaho: {
        state_code: "ID",
        state_latitude: "44.068202",
        state_longitude: "-114.742041",
      },
      illinois: {
        state_code: "IL",
        state_latitude: "40.633125",
        state_longitude: "-89.398528",
      },
      indiana: {
        state_code: "IN",
        state_latitude: "40.551217",
        state_longitude: "-85.602364",
      },
      kansas: {
        state_code: "KS",
        state_latitude: "39.011902",
        state_longitude: "-98.484246",
      },
      kentucky: {
        state_code: "KY",
        state_latitude: "37.839333",
        state_longitude: "-84.270018",
      },
      louisiana: {
        state_code: "LA",
        state_latitude: "31.244823",
        state_longitude: "-92.145024",
      },
      massachusetts: {
        state_code: "MA",
        state_latitude: "42.407211",
        state_longitude: "-71.382437",
      },
      maryland: {
        state_code: "MD",
        state_latitude: "39.045755",
        state_longitude: "-76.641271",
      },
      maine: {
        state_code: "ME",
        state_latitude: "45.253783",
        state_longitude: "-69.445469",
      },
      michigan: {
        state_code: "MI",
        state_latitude: "44.314844",
        state_longitude: "-85.602364",
      },
      minnesota: {
        state_code: "MN",
        state_latitude: "46.729553",
        state_longitude: "-94.6859",
      },
      missouri: {
        state_code: "MO",
        state_latitude: "37.964253",
        state_longitude: "-91.831833",
      },
      mississippi: {
        state_code: "MS",
        state_latitude: "32.354668",
        state_longitude: "-89.398528",
      },
      montana: {
        state_code: "MT",
        state_latitude: "46.879682",
        state_longitude: "-110.362566",
      },
      "north carolina": {
        state_code: "NC",
        state_latitude: "35.759573",
        state_longitude: "-79.0193",
      },
      "north dakota": {
        state_code: "ND",
        state_latitude: "47.551493",
        state_longitude: "-101.002012",
      },
      nebraska: {
        state_code: "NE",
        state_latitude: "41.492537",
        state_longitude: "-99.901813",
      },
      "new hampshire": {
        state_code: "NH",
        state_latitude: "43.193852",
        state_longitude: "-71.572395",
      },
      "new jersey": {
        state_code: "NJ",
        state_latitude: "40.058324",
        state_longitude: "-74.405661",
      },
      "new mexico": {
        state_code: "NM",
        state_latitude: "34.97273",
        state_longitude: "-105.032363",
      },
      nevada: {
        state_code: "NV",
        state_latitude: "38.80261",
        state_longitude: "-116.419389",
      },
      "new york": {
        state_code: "NY",
        state_latitude: "43.299428",
        state_longitude: "-74.217933",
      },
      ohio: {
        state_code: "OH",
        state_latitude: "40.417287",
        state_longitude: "-82.907123",
      },
      oklahoma: {
        state_code: "OK",
        state_latitude: "35.007752",
        state_longitude: "-97.092877",
      },
      oregon: {
        state_code: "OR",
        state_latitude: "43.804133",
        state_longitude: "-120.554201",
      },
      pennsylvania: {
        state_code: "PA",
        state_latitude: "41.203322",
        state_longitude: "-77.194525",
      },
      "puerto rico": {
        state_code: "PR",
        state_latitude: "18.220833",
        state_longitude: "-66.590149",
      },
      "rhode island": {
        state_code: "RI",
        state_latitude: "41.580095",
        state_longitude: "-71.477429",
      },
      "south carolina": {
        state_code: "SC",
        state_latitude: "33.836081",
        state_longitude: "-81.163725",
      },
      "south dakota": {
        state_code: "SD",
        state_latitude: "43.969515",
        state_longitude: "-99.901813",
      },
      tennessee: {
        state_code: "TN",
        state_latitude: "35.517491",
        state_longitude: "-86.580447",
      },
      texas: {
        state_code: "TX",
        state_latitude: "31.968599",
        state_longitude: "-99.901813",
      },
      utah: {
        state_code: "UT",
        state_latitude: "39.32098",
        state_longitude: "-111.093731",
      },
      virginia: {
        state_code: "VA",
        state_latitude: "37.431573",
        state_longitude: "-78.656894",
      },
      vermont: {
        state_code: "VT",
        state_latitude: "44.558803",
        state_longitude: "-72.577841",
      },
      washington: {
        state_code: "WA",
        state_latitude: "47.751074",
        state_longitude: "-120.740139",
      },
      wisconsin: {
        state_code: "WI",
        state_latitude: "43.78444",
        state_longitude: "-88.787868",
      },
      "west virginia": {
        state_code: "WV",
        state_latitude: "38.597626",
        state_longitude: "-80.454903",
      },
      wyoming: {
        state_code: "WY",
        state_latitude: "43.075968",
        state_longitude: "-107.290284",
      },
    },
    country_code: "US",
    country_latitude: "37.09024",
    country_longitude: "-95.712891",
  },
  andorra: {
    country_code: "AD",
    country_latitude: "42.546245",
    country_longitude: "1.601554",
  },
  "united arab emirates": {
    country_code: "AE",
    country_latitude: "23.424076",
    country_longitude: "53.847818",
  },
  afghanistan: {
    country_code: "AF",
    country_latitude: "33.93911",
    country_longitude: "67.709953",
  },
  "antigua and barbuda": {
    country_code: "AG",
    country_latitude: "17.060816",
    country_longitude: "-61.796428",
  },
  anguilla: {
    country_code: "AI",
    country_latitude: "18.220554",
    country_longitude: "-63.068615",
  },
  albania: {
    country_code: "AL",
    country_latitude: "41.153332",
    country_longitude: "20.168331",
  },
  armenia: {
    country_code: "AM",
    country_latitude: "40.069099",
    country_longitude: "45.038189",
  },
  "netherlands antilles": {
    country_code: "AN",
    country_latitude: "12.226079",
    country_longitude: "-69.060087",
  },
  angola: {
    country_code: "AO",
    country_latitude: "-11.202692",
    country_longitude: "17.873887",
  },
  antarctica: {
    country_code: "AQ",
    country_latitude: "-75.250973",
    country_longitude: "-0.071389",
  },
  argentina: {
    country_code: "AR",
    country_latitude: "-38.416097",
    country_longitude: "-63.616672",
  },
  "american samoa": {
    country_code: "AS",
    country_latitude: "-14.270972",
    country_longitude: "-170.132217",
  },
  austria: {
    country_code: "AT",
    country_latitude: "47.516231",
    country_longitude: "14.550072",
  },
  australia: {
    country_code: "AU",
    country_latitude: "-25.274398",
    country_longitude: "133.775136",
  },
  aruba: {
    country_code: "AW",
    country_latitude: "12.52111",
    country_longitude: "-69.968338",
  },
  azerbaijan: {
    country_code: "AZ",
    country_latitude: "40.143105",
    country_longitude: "47.576927",
  },
  "bosnia and herzegovina": {
    country_code: "BA",
    country_latitude: "43.915886",
    country_longitude: "17.679076",
  },
  barbados: {
    country_code: "BB",
    country_latitude: "13.193887",
    country_longitude: "-59.543198",
  },
  bangladesh: {
    country_code: "BD",
    country_latitude: "23.684994",
    country_longitude: "90.356331",
  },
  belgium: {
    country_code: "BE",
    country_latitude: "50.503887",
    country_longitude: "4.469936",
  },
  "burkina faso": {
    country_code: "BF",
    country_latitude: "12.238333",
    country_longitude: "-1.561593",
  },
  bulgaria: {
    country_code: "BG",
    country_latitude: "42.733883",
    country_longitude: "25.48583",
  },
  bahrain: {
    country_code: "BH",
    country_latitude: "25.930414",
    country_longitude: "50.637772",
  },
  burundi: {
    country_code: "BI",
    country_latitude: "-3.373056",
    country_longitude: "29.918886",
  },
  benin: {
    country_code: "BJ",
    country_latitude: "9.30769",
    country_longitude: "2.315834",
  },
  bermuda: {
    country_code: "BM",
    country_latitude: "32.321384",
    country_longitude: "-64.75737",
  },
  brunei: {
    country_code: "BN",
    country_latitude: "4.535277",
    country_longitude: "114.727669",
  },
  bolivia: {
    country_code: "BO",
    country_latitude: "-16.290154",
    country_longitude: "-63.588653",
  },
  brazil: {
    country_code: "BR",
    country_latitude: "-14.235004",
    country_longitude: "-51.92528",
  },
  bahamas: {
    country_code: "BS",
    country_latitude: "25.03428",
    country_longitude: "-77.39628",
  },
  bhutan: {
    country_code: "BT",
    country_latitude: "27.514162",
    country_longitude: "90.433601",
  },
  "bouvet island": {
    country_code: "BV",
    country_latitude: "-54.423199",
    country_longitude: "3.413194",
  },
  botswana: {
    country_code: "BW",
    country_latitude: "-22.328474",
    country_longitude: "24.684866",
  },
  belarus: {
    country_code: "BY",
    country_latitude: "53.709807",
    country_longitude: "27.953389",
  },
  belize: {
    country_code: "BZ",
    country_latitude: "17.189877",
    country_longitude: "-88.49765",
  },
  canada: {
    country_code: "CA",
    country_latitude: "56.130366",
    country_longitude: "-106.346771",
  },
  "cocos [keeling] islands": {
    country_code: "CC",
    country_latitude: "-12.164165",
    country_longitude: "96.870956",
  },
  "congo [drc]": {
    country_code: "CD",
    country_latitude: "-4.038333",
    country_longitude: "21.758664",
  },
  "democratic republic of the congo": {
    country_code: "CD",
    country_latitude: "-4.038333",
    country_longitude: "21.758664",
  },
  "zaire": {
    country_code: "CD",
    country_latitude: "-4.038333",
    country_longitude: "21.758664",
  },
  "central african republic": {
    country_code: "CF",
    country_latitude: "6.611111",
    country_longitude: "20.939444",
  },
  "congo [republic]": {
    country_code: "CG",
    country_latitude: "-0.228021",
    country_longitude: "15.827659",
  },
  "republic of the congo": {
    country_code: "CG",
    country_latitude: "-0.228021",
    country_longitude: "15.827659",
  },
  switzerland: {
    country_code: "CH",
    country_latitude: "46.818188",
    country_longitude: "8.227512",
  },
  "c\u00e3\u00b4te d'ivoire": {
    country_code: "CI",
    country_latitude: "7.539989",
    country_longitude: "-5.54708",
  },
  "cote d'ivoire": {
    country_code: "CI",
    country_latitude: "7.539989",
    country_longitude: "-5.54708",
  },
  "cook islands": {
    country_code: "CK",
    country_latitude: "-21.236736",
    country_longitude: "-159.777671",
  },
  chile: {
    country_code: "CL",
    country_latitude: "-35.675147",
    country_longitude: "-71.542969",
  },
  cameroon: {
    country_code: "CM",
    country_latitude: "7.369722",
    country_longitude: "12.354722",
  },
  china: {
    country_code: "CN",
    country_latitude: "35.86166",
    country_longitude: "104.195397",
  },
  colombia: {
    country_code: "CO",
    country_latitude: "4.570868",
    country_longitude: "-74.297333",
  },
  "costa rica": {
    country_code: "CR",
    country_latitude: "9.748917",
    country_longitude: "-83.753428",
  },
  cuba: {
    country_code: "CU",
    country_latitude: "21.521757",
    country_longitude: "-77.781167",
  },
  "cape verde": {
    country_code: "CV",
    country_latitude: "16.002082",
    country_longitude: "-24.013197",
  },
  "christmas island": {
    country_code: "CX",
    country_latitude: "-10.447525",
    country_longitude: "105.690449",
  },
  cyprus: {
    country_code: "CY",
    country_latitude: "35.126413",
    country_longitude: "33.429859",
  },
  "czech republic": {
    country_code: "CZ",
    country_latitude: "49.817492",
    country_longitude: "15.472962",
  },
  germany: {
    country_code: "DE",
    country_latitude: "51.165691",
    country_longitude: "10.451526",
  },
  djibouti: {
    country_code: "DJ",
    country_latitude: "11.825138",
    country_longitude: "42.590275",
  },
  denmark: {
    country_code: "DK",
    country_latitude: "56.26392",
    country_longitude: "9.501785",
  },
  dominica: {
    country_code: "DM",
    country_latitude: "15.414999",
    country_longitude: "-61.370976",
  },
  "dominican republic": {
    country_code: "DO",
    country_latitude: "18.735693",
    country_longitude: "-70.162651",
  },
  algeria: {
    country_code: "DZ",
    country_latitude: "28.033886",
    country_longitude: "1.659626",
  },
  ecuador: {
    country_code: "EC",
    country_latitude: "-1.831239",
    country_longitude: "-78.183406",
  },
  estonia: {
    country_code: "EE",
    country_latitude: "58.595272",
    country_longitude: "25.013607",
  },
  egypt: {
    country_code: "EG",
    country_latitude: "26.820553",
    country_longitude: "30.802498",
  },
  "western sahara": {
    country_code: "EH",
    country_latitude: "24.215527",
    country_longitude: "-12.885834",
  },
  eritrea: {
    country_code: "ER",
    country_latitude: "15.179384",
    country_longitude: "39.782334",
  },
  spain: {
    country_code: "ES",
    country_latitude: "40.463667",
    country_longitude: "-3.74922",
  },
  ethiopia: {
    country_code: "ET",
    country_latitude: "9.145",
    country_longitude: "40.489673",
  },
  finland: {
    country_code: "FI",
    country_latitude: "61.92411",
    country_longitude: "25.748151",
  },
  fiji: {
    country_code: "FJ",
    country_latitude: "-16.578193",
    country_longitude: "179.414413",
  },
  "falkland islands [islas malvinas]": {
    country_code: "FK",
    country_latitude: "-51.796253",
    country_longitude: "-59.523613",
  },
  micronesia: {
    country_code: "FM",
    country_latitude: "7.425554",
    country_longitude: "150.550812",
  },
  "faroe islands": {
    country_code: "FO",
    country_latitude: "61.892635",
    country_longitude: "-6.911806",
  },
  france: {
    country_code: "FR",
    country_latitude: "46.227638",
    country_longitude: "2.213749",
  },
  gabon: {
    country_code: "GA",
    country_latitude: "-0.803689",
    country_longitude: "11.609444",
  },
  "united kingdom": {
    country_code: "GB",
    country_latitude: "55.378051",
    country_longitude: "-3.435973",
  },
  grenada: {
    country_code: "GD",
    country_latitude: "12.262776",
    country_longitude: "-61.604171",
  },
  georgia: {
    country_code: "GE",
    country_latitude: "42.315407",
    country_longitude: "43.356892",
  },
  "french guiana": {
    country_code: "GF",
    country_latitude: "3.933889",
    country_longitude: "-53.125782",
  },
  guernsey: {
    country_code: "GG",
    country_latitude: "49.465691",
    country_longitude: "-2.585278",
  },
  ghana: {
    country_code: "GH",
    country_latitude: "7.946527",
    country_longitude: "-1.023194",
  },
  gibraltar: {
    country_code: "GI",
    country_latitude: "36.137741",
    country_longitude: "-5.345374",
  },
  greenland: {
    country_code: "GL",
    country_latitude: "71.706936",
    country_longitude: "-42.604303",
  },
  gambia: {
    country_code: "GM",
    country_latitude: "13.443182",
    country_longitude: "-15.310139",
  },
  guinea: {
    country_code: "GN",
    country_latitude: "9.945587",
    country_longitude: "-9.696645",
  },
  guadeloupe: {
    country_code: "GP",
    country_latitude: "16.995971",
    country_longitude: "-62.067641",
  },
  "equatorial guinea": {
    country_code: "GQ",
    country_latitude: "1.650801",
    country_longitude: "10.267895",
  },
  greece: {
    country_code: "GR",
    country_latitude: "39.074208",
    country_longitude: "21.824312",
  },
  "south georgia and the south sandwich islands": {
    country_code: "GS",
    country_latitude: "-54.429579",
    country_longitude: "-36.587909",
  },
  guatemala: {
    country_code: "GT",
    country_latitude: "15.783471",
    country_longitude: "-90.230759",
  },
  guam: {
    country_code: "GU",
    country_latitude: "13.444304",
    country_longitude: "144.793731",
  },
  "guinea-bissau": {
    country_code: "GW",
    country_latitude: "11.803749",
    country_longitude: "-15.180413",
  },
  guyana: {
    country_code: "GY",
    country_latitude: "4.860416",
    country_longitude: "-58.93018",
  },
  "gaza strip": {
    country_code: "GZ",
    country_latitude: "31.354676",
    country_longitude: "34.308825",
  },
  "hong kong": {
    country_code: "HK",
    country_latitude: "22.396428",
    country_longitude: "114.109497",
  },
  "heard island and mcdonald islands": {
    country_code: "HM",
    country_latitude: "-53.08181",
    country_longitude: "73.504158",
  },
  honduras: {
    country_code: "HN",
    country_latitude: "15.199999",
    country_longitude: "-86.241905",
  },
  croatia: {
    country_code: "HR",
    country_latitude: "45.1",
    country_longitude: "15.2",
  },
  haiti: {
    country_code: "HT",
    country_latitude: "18.971187",
    country_longitude: "-72.285215",
  },
  hungary: {
    country_code: "HU",
    country_latitude: "47.162494",
    country_longitude: "19.503304",
  },
  indonesia: {
    country_code: "ID",
    country_latitude: "-0.789275",
    country_longitude: "113.921327",
  },
  ireland: {
    country_code: "IE",
    country_latitude: "53.41291",
    country_longitude: "-8.24389",
  },
  israel: {
    country_code: "IL",
    country_latitude: "31.046051",
    country_longitude: "34.851612",
  },
  "isle of man": {
    country_code: "IM",
    country_latitude: "54.236107",
    country_longitude: "-4.548056",
  },
  india: {
    country_code: "IN",
    country_latitude: "20.593684",
    country_longitude: "78.96288",
  },
  "british indian ocean territory": {
    country_code: "IO",
    country_latitude: "-6.343194",
    country_longitude: "71.876519",
  },
  iraq: {
    country_code: "IQ",
    country_latitude: "33.223191",
    country_longitude: "43.679291",
  },
  iran: {
    country_code: "IR",
    country_latitude: "32.427908",
    country_longitude: "53.688046",
  },
  iceland: {
    country_code: "IS",
    country_latitude: "64.963051",
    country_longitude: "-19.020835",
  },
  italy: {
    country_code: "IT",
    country_latitude: "41.87194",
    country_longitude: "12.56738",
  },
  jersey: {
    country_code: "JE",
    country_latitude: "49.214439",
    country_longitude: "-2.13125",
  },
  jamaica: {
    country_code: "JM",
    country_latitude: "18.109581",
    country_longitude: "-77.297508",
  },
  jordan: {
    country_code: "JO",
    country_latitude: "30.585164",
    country_longitude: "36.238414",
  },
  japan: {
    country_code: "JP",
    country_latitude: "36.204824",
    country_longitude: "138.252924",
  },
  kenya: {
    country_code: "KE",
    country_latitude: "-0.023559",
    country_longitude: "37.906193",
  },
  kyrgyzstan: {
    country_code: "KG",
    country_latitude: "41.20438",
    country_longitude: "74.766098",
  },
  cambodia: {
    country_code: "KH",
    country_latitude: "12.565679",
    country_longitude: "104.990963",
  },
  kiribati: {
    country_code: "KI",
    country_latitude: "-3.370417",
    country_longitude: "-168.734039",
  },
  comoros: {
    country_code: "KM",
    country_latitude: "-11.875001",
    country_longitude: "43.872219",
  },
  "saint kitts and nevis": {
    country_code: "KN",
    country_latitude: "17.357822",
    country_longitude: "-62.782998",
  },
  "north korea": {
    country_code: "KP",
    country_latitude: "40.339852",
    country_longitude: "127.510093",
  },
  "south korea": {
    country_code: "KR",
    country_latitude: "35.907757",
    country_longitude: "127.766922",
  },
  kuwait: {
    country_code: "KW",
    country_latitude: "29.31166",
    country_longitude: "47.481766",
  },
  "cayman islands": {
    country_code: "KY",
    country_latitude: "19.513469",
    country_longitude: "-80.566956",
  },
  kazakhstan: {
    country_code: "KZ",
    country_latitude: "48.019573",
    country_longitude: "66.923684",
  },
  laos: {
    country_code: "LA",
    country_latitude: "19.85627",
    country_longitude: "102.495496",
  },
  lebanon: {
    country_code: "LB",
    country_latitude: "33.854721",
    country_longitude: "35.862285",
  },
  "saint lucia": {
    country_code: "LC",
    country_latitude: "13.909444",
    country_longitude: "-60.978893",
  },
  liechtenstein: {
    country_code: "LI",
    country_latitude: "47.166",
    country_longitude: "9.555373",
  },
  "sri lanka": {
    country_code: "LK",
    country_latitude: "7.873054",
    country_longitude: "80.771797",
  },
  liberia: {
    country_code: "LR",
    country_latitude: "6.428055",
    country_longitude: "-9.429499",
  },
  lesotho: {
    country_code: "LS",
    country_latitude: "-29.609988",
    country_longitude: "28.233608",
  },
  lithuania: {
    country_code: "LT",
    country_latitude: "55.169438",
    country_longitude: "23.881275",
  },
  luxembourg: {
    country_code: "LU",
    country_latitude: "49.815273",
    country_longitude: "6.129583",
  },
  latvia: {
    country_code: "LV",
    country_latitude: "56.879635",
    country_longitude: "24.603189",
  },
  libya: {
    country_code: "LY",
    country_latitude: "26.3351",
    country_longitude: "17.228331",
  },
  morocco: {
    country_code: "MA",
    country_latitude: "31.791702",
    country_longitude: "-7.09262",
  },
  monaco: {
    country_code: "MC",
    country_latitude: "43.750298",
    country_longitude: "7.412841",
  },
  moldova: {
    country_code: "MD",
    country_latitude: "47.411631",
    country_longitude: "28.369885",
  },
  montenegro: {
    country_code: "ME",
    country_latitude: "42.708678",
    country_longitude: "19.37439",
  },
  madagascar: {
    country_code: "MG",
    country_latitude: "-18.766947",
    country_longitude: "46.869107",
  },
  "marshall islands": {
    country_code: "MH",
    country_latitude: "7.131474",
    country_longitude: "171.184478",
  },
  "macedonia [fyrom]": {
    country_code: "MK",
    country_latitude: "41.608635",
    country_longitude: "21.745275",
  },
  mali: {
    country_code: "ML",
    country_latitude: "17.570692",
    country_longitude: "-3.996166",
  },
  "myanmar [burma]": {
    country_code: "MM",
    country_latitude: "21.913965",
    country_longitude: "95.956223",
  },
  mongolia: {
    country_code: "MN",
    country_latitude: "46.862496",
    country_longitude: "103.846656",
  },
  macau: {
    country_code: "MO",
    country_latitude: "22.198745",
    country_longitude: "113.543873",
  },
  "northern mariana islands": {
    country_code: "MP",
    country_latitude: "17.33083",
    country_longitude: "145.38469",
  },
  martinique: {
    country_code: "MQ",
    country_latitude: "14.641528",
    country_longitude: "-61.024174",
  },
  mauritania: {
    country_code: "MR",
    country_latitude: "21.00789",
    country_longitude: "-10.940835",
  },
  montserrat: {
    country_code: "MS",
    country_latitude: "16.742498",
    country_longitude: "-62.187366",
  },
  malta: {
    country_code: "MT",
    country_latitude: "35.937496",
    country_longitude: "14.375416",
  },
  mauritius: {
    country_code: "MU",
    country_latitude: "-20.348404",
    country_longitude: "57.552152",
  },
  maldives: {
    country_code: "MV",
    country_latitude: "3.202778",
    country_longitude: "73.22068",
  },
  malawi: {
    country_code: "MW",
    country_latitude: "-13.254308",
    country_longitude: "34.301525",
  },
  mexico: {
    country_code: "MX",
    country_latitude: "23.634501",
    country_longitude: "-102.552784",
  },
  malaysia: {
    country_code: "MY",
    country_latitude: "4.210484",
    country_longitude: "101.975766",
  },
  mozambique: {
    country_code: "MZ",
    country_latitude: "-18.665695",
    country_longitude: "35.529562",
  },
  namibia: {
    country_code: "NA",
    country_latitude: "-22.95764",
    country_longitude: "18.49041",
  },
  "new caledonia": {
    country_code: "NC",
    country_latitude: "-20.904305",
    country_longitude: "165.618042",
  },
  niger: {
    country_code: "NE",
    country_latitude: "17.607789",
    country_longitude: "8.081666",
  },
  "norfolk island": {
    country_code: "NF",
    country_latitude: "-29.040835",
    country_longitude: "167.954712",
  },
  nigeria: {
    country_code: "NG",
    country_latitude: "9.081999",
    country_longitude: "8.675277",
  },
  nicaragua: {
    country_code: "NI",
    country_latitude: "12.865416",
    country_longitude: "-85.207229",
  },
  netherlands: {
    country_code: "NL",
    country_latitude: "52.132633",
    country_longitude: "5.291266",
  },
  norway: {
    country_code: "NO",
    country_latitude: "60.472024",
    country_longitude: "8.468946",
  },
  nepal: {
    country_code: "NP",
    country_latitude: "28.394857",
    country_longitude: "84.124008",
  },
  nauru: {
    country_code: "NR",
    country_latitude: "-0.522778",
    country_longitude: "166.931503",
  },
  niue: {
    country_code: "NU",
    country_latitude: "-19.054445",
    country_longitude: "-169.867233",
  },
  "new zealand": {
    country_code: "NZ",
    country_latitude: "-40.900557",
    country_longitude: "174.885971",
  },
  oman: {
    country_code: "OM",
    country_latitude: "21.512583",
    country_longitude: "55.923255",
  },
  panama: {
    country_code: "PA",
    country_latitude: "8.537981",
    country_longitude: "-80.782127",
  },
  peru: {
    country_code: "PE",
    country_latitude: "-9.189967",
    country_longitude: "-75.015152",
  },
  "french polynesia": {
    country_code: "PF",
    country_latitude: "-17.679742",
    country_longitude: "-149.406843",
  },
  "papua new guinea": {
    country_code: "PG",
    country_latitude: "-6.314993",
    country_longitude: "143.95555",
  },
  philippines: {
    country_code: "PH",
    country_latitude: "12.879721",
    country_longitude: "121.774017",
  },
  pakistan: {
    country_code: "PK",
    country_latitude: "30.375321",
    country_longitude: "69.345116",
  },
  poland: {
    country_code: "PL",
    country_latitude: "51.919438",
    country_longitude: "19.145136",
  },
  "saint pierre and miquelon": {
    country_code: "PM",
    country_latitude: "46.941936",
    country_longitude: "-56.27111",
  },
  "pitcairn islands": {
    country_code: "PN",
    country_latitude: "-24.703615",
    country_longitude: "-127.439308",
  },
  "puerto rico": {
    country_code: "PR",
    country_latitude: "18.220833",
    country_longitude: "-66.590149",
  },
  "palestinian territories": {
    country_code: "PS",
    country_latitude: "31.952162",
    country_longitude: "35.233154",
  },
  portugal: {
    country_code: "PT",
    country_latitude: "39.399872",
    country_longitude: "-8.224454",
  },
  palau: {
    country_code: "PW",
    country_latitude: "7.51498",
    country_longitude: "134.58252",
  },
  paraguay: {
    country_code: "PY",
    country_latitude: "-23.442503",
    country_longitude: "-58.443832",
  },
  qatar: {
    country_code: "QA",
    country_latitude: "25.354826",
    country_longitude: "51.183884",
  },
  "r\u00e3\u00a9union": {
    country_code: "RE",
    country_latitude: "-21.115141",
    country_longitude: "55.536384",
  },
  romania: {
    country_code: "RO",
    country_latitude: "45.943161",
    country_longitude: "24.96676",
  },
  serbia: {
    country_code: "RS",
    country_latitude: "44.016521",
    country_longitude: "21.005859",
  },
  russia: {
    country_code: "RU",
    country_latitude: "61.52401",
    country_longitude: "105.318756",
  },
  rwanda: {
    country_code: "RW",
    country_latitude: "-1.940278",
    country_longitude: "29.873888",
  },
  "saudi arabia": {
    country_code: "SA",
    country_latitude: "23.885942",
    country_longitude: "45.079162",
  },
  "solomon islands": {
    country_code: "SB",
    country_latitude: "-9.64571",
    country_longitude: "160.156194",
  },
  seychelles: {
    country_code: "SC",
    country_latitude: "-4.679574",
    country_longitude: "55.491977",
  },
  sudan: {
    country_code: "SD",
    country_latitude: "12.862807",
    country_longitude: "30.217636",
  },
  sweden: {
    country_code: "SE",
    country_latitude: "60.128161",
    country_longitude: "18.643501",
  },
  singapore: {
    country_code: "SG",
    country_latitude: "1.352083",
    country_longitude: "103.819836",
  },
  "saint helena": {
    country_code: "SH",
    country_latitude: "-24.143474",
    country_longitude: "-10.030696",
  },
  slovenia: {
    country_code: "SI",
    country_latitude: "46.151241",
    country_longitude: "14.995463",
  },
  "svalbard and jan mayen": {
    country_code: "SJ",
    country_latitude: "77.553604",
    country_longitude: "23.670272",
  },
  slovakia: {
    country_code: "SK",
    country_latitude: "48.669026",
    country_longitude: "19.699024",
  },
  "sierra leone": {
    country_code: "SL",
    country_latitude: "8.460555",
    country_longitude: "-11.779889",
  },
  "san marino": {
    country_code: "SM",
    country_latitude: "43.94236",
    country_longitude: "12.457777",
  },
  senegal: {
    country_code: "SN",
    country_latitude: "14.497401",
    country_longitude: "-14.452362",
  },
  somalia: {
    country_code: "SO",
    country_latitude: "5.152149",
    country_longitude: "46.199616",
  },
  suriname: {
    country_code: "SR",
    country_latitude: "3.919305",
    country_longitude: "-56.027783",
  },
  "s\u00e3\u00a3o tom\u00e3\u00a9 and pr\u00e3\u00adncipe": {
    country_code: "ST",
    country_latitude: "0.18636",
    country_longitude: "6.613081",
  },
  "el salvador": {
    country_code: "SV",
    country_latitude: "13.794185",
    country_longitude: "-88.89653",
  },
  syria: {
    country_code: "SY",
    country_latitude: "34.802075",
    country_longitude: "38.996815",
  },
  swaziland: {
    country_code: "SZ",
    country_latitude: "-26.522503",
    country_longitude: "31.465866",
  },
  "turks and caicos islands": {
    country_code: "TC",
    country_latitude: "21.694025",
    country_longitude: "-71.797928",
  },
  chad: {
    country_code: "TD",
    country_latitude: "15.454166",
    country_longitude: "18.732207",
  },
  "french southern territories": {
    country_code: "TF",
    country_latitude: "-49.280366",
    country_longitude: "69.348557",
  },
  togo: {
    country_code: "TG",
    country_latitude: "8.619543",
    country_longitude: "0.824782",
  },
  thailand: {
    country_code: "TH",
    country_latitude: "15.870032",
    country_longitude: "100.992541",
  },
  tajikistan: {
    country_code: "TJ",
    country_latitude: "38.861034",
    country_longitude: "71.276093",
  },
  tokelau: {
    country_code: "TK",
    country_latitude: "-8.967363",
    country_longitude: "-171.855881",
  },
  "timor-leste": {
    country_code: "TL",
    country_latitude: "-8.874217",
    country_longitude: "125.727539",
  },
  turkmenistan: {
    country_code: "TM",
    country_latitude: "38.969719",
    country_longitude: "59.556278",
  },
  tunisia: {
    country_code: "TN",
    country_latitude: "33.886917",
    country_longitude: "9.537499",
  },
  tonga: {
    country_code: "TO",
    country_latitude: "-21.178986",
    country_longitude: "-175.198242",
  },
  turkey: {
    country_code: "TR",
    country_latitude: "38.963745",
    country_longitude: "35.243322",
  },
  "trinidad and tobago": {
    country_code: "TT",
    country_latitude: "10.691803",
    country_longitude: "-61.222503",
  },
  tuvalu: {
    country_code: "TV",
    country_latitude: "-7.109535",
    country_longitude: "177.64933",
  },
  taiwan: {
    country_code: "TW",
    country_latitude: "23.69781",
    country_longitude: "120.960515",
  },
  tanzania: {
    country_code: "TZ",
    country_latitude: "-6.369028",
    country_longitude: "34.888822",
  },
  ukraine: {
    country_code: "UA",
    country_latitude: "48.379433",
    country_longitude: "31.16558",
  },
  uganda: {
    country_code: "UG",
    country_latitude: "1.373333",
    country_longitude: "32.290275",
  },
  "u.s. minor outlying islands": {
    country_code: "UM",
    country_latitude: "",
    country_longitude: "",
  },
  uruguay: {
    country_code: "UY",
    country_latitude: "-32.522779",
    country_longitude: "-55.765835",
  },
  uzbekistan: {
    country_code: "UZ",
    country_latitude: "41.377491",
    country_longitude: "64.585262",
  },
  "vatican city": {
    country_code: "VA",
    country_latitude: "41.902916",
    country_longitude: "12.453389",
  },
  "saint vincent and the grenadines": {
    country_code: "VC",
    country_latitude: "12.984305",
    country_longitude: "-61.287228",
  },
  venezuela: {
    country_code: "VE",
    country_latitude: "6.42375",
    country_longitude: "-66.58973",
  },
  "british virgin islands": {
    country_code: "VG",
    country_latitude: "18.420695",
    country_longitude: "-64.639968",
  },
  "u.s. virgin islands": {
    country_code: "VI",
    country_latitude: "18.335765",
    country_longitude: "-64.896335",
  },
  vietnam: {
    country_code: "VN",
    country_latitude: "14.058324",
    country_longitude: "108.277199",
  },
  vanuatu: {
    country_code: "VU",
    country_latitude: "-15.376706",
    country_longitude: "166.959158",
  },
  "wallis and futuna": {
    country_code: "WF",
    country_latitude: "-13.768752",
    country_longitude: "-177.156097",
  },
  samoa: {
    country_code: "WS",
    country_latitude: "-13.759029",
    country_longitude: "-172.104629",
  },
  kosovo: {
    country_code: "XK",
    country_latitude: "42.602636",
    country_longitude: "20.902977",
  },
  yemen: {
    country_code: "YE",
    country_latitude: "15.552727",
    country_longitude: "48.516388",
  },
  mayotte: {
    country_code: "YT",
    country_latitude: "-12.8275",
    country_longitude: "45.166244",
  },
  "south africa": {
    country_code: "ZA",
    country_latitude: "-30.559482",
    country_longitude: "22.937506",
  },
  zambia: {
    country_code: "ZM",
    country_latitude: "-13.133897",
    country_longitude: "27.849332",
  },
  zimbabwe: {
    country_code: "ZW",
    country_latitude: "-19.015438",
    country_longitude: "29.154857",
  },
};

class ColorGenerator {
  constructor(palette = "sunnyBeachDay", reverse = false) {
    this.palette =
      this.colorPalettes(palette) ?? this.colorPalettes("sunnyBeachDay"); // <-- string
    this.reverse = reverse;
  }
  colorPalettes(palette) {
    const palettes = {
      vibrantTones: [
        "#F94144",
        "#277DA1",
        "#F3722C",
        "#577590",
        "#F8961E",
        "#4D908E",
        "#F9844A",
        "#43AA8B",
        "#F9C74F",
        "#43AA8B",
        "#90BE6D",
      ],
      sunnyBeachDay: ["#264653", "#2A9D8F", "#E9C46A", "#F4A261", "#E76F51"],
      warmAutumnGlow: ["#003049", "#d62828", "#f77f00", "#fcbf49", "#eae2b7"],
      warmAutumnGlow2: ["#003049", "#fcbf49", "#d62828", "#f77f00"],

      refreshingSummerFun: [
        "#fb8500",
        "#ffb703",
        "#023047",
        "#219ebc",
        "#8ecae6",
      ],

      purpleSunset: ["#390099", "#9e0059", "#ff0054", "#ff5400", "#ffbd00"],
      oceanSunset: ["#001427", "#708d81", "#f4d58d", "#bf0603", "#8d0801"],

      warmEarthTones: ["#8c1c13", "#bf4342", "#e7d7c1", "#a78a7f", "#735751"],

      vibrantFusion: [
        "#ff0000",
        "#ff8700",
        "#ffd300",
        "#deff0a",
        "#a1ff0a",
        "#0aff99",
        "#0aefff",
        "#147df5",
        "#580aff",
        "#be0aff",
      ],
    };
    return palettes[palette];
  }

  *getBarColor() {
    const colors = this.reverse ? [...this.palette].reverse() : this.palette; // do not mutate
    let i = 0;
    while (true) yield colors[i++ % colors.length];
  }

  static createDiagonalPattern(color = "black", backgroundAlpha = 0.4) {
    // create a 10x10 px canvas for the pattern's base shape
    const shape = document.createElement("canvas");
    shape.width = 10;
    shape.height = 10;

    const c = shape.getContext("2d");

    // background: same color, but with alpha
    c.save();
    c.fillStyle = color;
    c.globalAlpha = backgroundAlpha; // 0..1
    c.fillRect(0, 0, shape.width, shape.height);
    c.restore();

    // diagonal lines in full opacity (same color)
    c.strokeStyle = color;
    c.lineWidth = 2;

    c.beginPath();
    c.moveTo(2, 0);
    c.lineTo(10, 8);
    c.stroke();

    c.beginPath();
    c.moveTo(0, 8);
    c.lineTo(2, 10);
    c.stroke();

    // create and return the repeatable pattern
    return c.createPattern(shape, "repeat");
  }
}

/**
 * SharedRegistries - Singleton that holds all string-to-ID mappings.
 * Instead of each LocationData duplicating string storage, all locations
 * share these registries and store only integer IDs locally.
 *
 * Memory savings: O(locations × unique_values) → O(unique_values)
 */
class SharedRegistries {
  static #instance = null;

  /**
   * Get or create the singleton instance.
   * @param {string[]} filterCategories - List of filter dimension names
   * @param {Object} aliasMap - Optional alias mappings for normalization
   * @returns {SharedRegistries}
   */
  static getInstance(filterCategories = [], aliasMap = null) {
    if (!SharedRegistries.#instance) {
      SharedRegistries.#instance = new SharedRegistries(filterCategories, aliasMap);
    }
    return SharedRegistries.#instance;
  }

  /**
   * Reset the singleton (useful for testing or loading new datasets).
   */
  static reset() {
    SharedRegistries.#instance = null;
  }

  /**
   * Check if instance exists without creating one.
   * @returns {boolean}
   */
  static hasInstance() {
    return SharedRegistries.#instance !== null;
  }

  constructor(filterCategories, aliasMap) {
    this.aliasMap = aliasMap;

    // Core registries for dataset, species, genus
    this.dataset = new IdRegistry("dataset", { aliasMap });
    this.species = new IdRegistry("species", { aliasMap });
    this.genus = new IdRegistry("genus", { aliasMap });

    // One registry per filter dimension
    this.dimensions = Object.fromEntries(
      filterCategories.map((dim) => [dim, new IdRegistry(dim, { aliasMap })])
    );

    // Track which dimensions are registered
    this.filterCategories = new Set(filterCategories);
  }

  /**
   * Ensure a dimension registry exists (for dynamically added dimensions).
   * @param {string} dim - Dimension name
   * @returns {IdRegistry}
   */
  ensureDimension(dim) {
    if (!this.dimensions[dim]) {
      this.dimensions[dim] = new IdRegistry(dim, { aliasMap: this.aliasMap });
      this.filterCategories.add(dim);
    }
    return this.dimensions[dim];
  }

  /**
   * Get registry for a dimension.
   * @param {string} dim - Dimension name
   * @returns {IdRegistry|undefined}
   */
  getDimRegistry(dim) {
    return this.dimensions[dim];
  }
}

class LocationData {
  constructor(firstRow, filterCategories, aliasMap, linkedFields = null) {
    this.country = normalizeCountry(firstRow.country);
    this.stateProv = firstRow.state_province;
    this.isGlobalLevel = false;
    this.isStateLevel = false;
    this.isCountryLevel = true;
    this.name = this.country;
    this.genomeCount = 0;
    this.latitude;
    this.longitude;
    this.changeOnZoom =
      this.stateProv || this.country === "United States" ? true : false;
    this.filterCategories = filterCategories;
    this.aliasMap = aliasMap;

    // Use shared registries instead of creating local copies
    // This dramatically reduces memory when there are many locations
    const shared = SharedRegistries.getInstance(filterCategories, aliasMap);
    this.reg = {
      dataset: shared.dataset,
      species: shared.species,
      genus: shared.genus,
    };
    // Reference to shared dimension registries
    this.dimReg = shared.dimensions;

    // Local taxonomy mapping (species->genus relationships seen in THIS location)
    this.taxonomy = {
      speciesToGenusId: new Map(), // speciesId -> genusId
    };

    // Species and genus counts for color palette generation
    this.speciesCounts = new Map(); // speciesId -> count
    this.genusCounts = new Map(); // genusId -> count

    // timeSeriesIndex: dimension -> characteristicLabelId -> datasetId -> yearLabelId -> count
    // Pre-computes AMR characteristic × collection_year relationships per dataset
    this.timeSeriesIndex = new Map();
    // yearTotalsByDataset: datasetId -> yearLabelId -> total samples
    this.yearTotalsByDataset = new Map();

    // Relational indexes for gene observation relationships
    // relationalIndex: datasetId -> "dim1:dim2" -> RelationalCrosstab
    this.relationalIndex = new Map();
    // Track total gene observations (vs genomeCount for samples)
    this.observationCount = 0;
    // Store linked fields configuration
    this.linkedFields = linkedFields;

    // Filter dimension totals for pie charts: dimension -> labelId -> count
    this.filterTotals = new Map();

    this.updateLocationData(firstRow);
    this.#setCoordinates();
  }

  #setCoordinates() {
    if (this.global) {
      this.latitude = 0;
      this.longitude = 0;
    } else if (this.stateProv && !this.isCountryLevel) {
      // Currently the lookup table only accommodates US states
      const stateEntry =
        geoLookup["united states"]["states"][this.stateProv.toLowerCase()];
      if (stateEntry) {
        this.latitude = stateEntry["state_latitude"];
        this.longitude = stateEntry["state_longitude"];
      } else {
        this.latitude = null;
        this.longitude = null;
      }
    } else if (this.country && this.isCountryLevel) {
      // "United States" is hardcoded due to the BVBRC convention to
      // refer to the united states as "USA" rather than its
      // full name.
      const country =
        this.country.toLowerCase() === "usa"
          ? "united states"
          : this.country.toLowerCase();

      if (geoLookup[country]) {
        this.latitude = geoLookup[country]["country_latitude"];
        this.longitude = geoLookup[country]["country_longitude"];
      }
    } else {
      this.latitude = null;
      this.longitude = null;
    }
    this.latitude = Number(this.latitude);
    this.longitude = Number(this.longitude);
  }

  setStateLevel() {
    if (this.isGlobalLevel) {
      throw new Error("Cannot set both global and state level.");
    }
    this.isStateLevel = true;
    this.isCountryLevel = false;
    this.name = `${this.stateProv}, ${this.country}`;
    this.#setCoordinates();
  }

  setGlobalLevel() {
    if (this.isStateLevel) {
      throw new Error("Cannot set both global and state level.");
    }
    this.isGlobalLevel = true;
    this.isCountryLevel = false;
    this.name = "Global";
    this.latitude = null;
    this.longitude = null;
    this.stateProv = null;
    this.country = null;
  }

  updateLocationData(row) {
    this.genomeCount += 1;

    const datasetId = this.reg.dataset.idOf(row.dataset ?? "User Data");
    const speciesId = this.reg.species.idOf(row.species ?? "Unknown species");
    const genusId = this.reg.genus.idOf(row.genus ?? "Unknown genus");

    if (!this.taxonomy.speciesToGenusId.has(speciesId)) {
      this.taxonomy.speciesToGenusId.set(speciesId, genusId);
    }

    // Track species and genus counts for color palette generation
    this.speciesCounts.set(speciesId, (this.speciesCounts.get(speciesId) ?? 0) + 1);
    this.genusCounts.set(genusId, (this.genusCounts.get(genusId) ?? 0) + 1);

    // Get collection_year value for time-series indexing
    const yearReg = this.dimReg["collection_year"];
    let yearValue = null;
    let yearLabelId = null;
    if (yearReg && row["collection_year"]) {
      if (Array.isArray(row["collection_year"])) {
        yearValue = row["collection_year"].filter(Boolean)[0];
      } else if (
        typeof row["collection_year"] === "string" &&
        row["collection_year"]
      ) {
        yearValue = row["collection_year"];
      } else if (typeof row["collection_year"] === "number") {
        yearValue = String(row["collection_year"]);
      }
      if (yearValue) {
        yearLabelId = yearReg.idOf(yearValue);
      }
    }

    if (yearLabelId !== null) {
      let totalsIndex = this.yearTotalsByDataset.get(datasetId);
      if (!totalsIndex) {
        totalsIndex = new Map();
        this.yearTotalsByDataset.set(datasetId, totalsIndex);
      }
      totalsIndex.set(yearLabelId, (totalsIndex.get(yearLabelId) ?? 0) + 1);
    }

    // Update filter totals and time-series index for each dimension
    const linkedSet = this.linkedFields ? new Set(this.linkedFields) : null;

    for (const dim of this.filterCategories) {
      if (dim === "collection_year") continue;

      const reg = this.dimReg[dim];

      // Normalize to array of unique labels
      let values = [];
      if (linkedSet && linkedSet.has(dim) && Array.isArray(row.observations)) {
        // Linked field: extract values from observations array
        for (const obs of row.observations) {
          const v = obs[dim];
          if (v != null && v !== "") values.push(v);
        }
      } else if (Array.isArray(row[dim])) {
        values = row[dim].filter(Boolean);
      } else if (typeof row[dim] === "string" && row[dim]) {
        values = [row[dim]];
      }
      if (values.length === 0) continue;

      // de-dupe within the row to avoid double counting
      const uniq = new Set(values.map((v) => reg.idOf(v)));

      // Update filter totals for pie charts
      let dimTotals = this.filterTotals.get(dim);
      if (!dimTotals) {
        dimTotals = new Map();
        this.filterTotals.set(dim, dimTotals);
      }
      for (const labelId of uniq) {
        dimTotals.set(labelId, (dimTotals.get(labelId) ?? 0) + 1);
      }

      // Update time-series index if year data is available
      if (yearLabelId === null) continue;

      for (const labelId of uniq) {
        let dimIndex = this.timeSeriesIndex.get(dim);
        if (!dimIndex) {
          dimIndex = new Map();
          this.timeSeriesIndex.set(dim, dimIndex);
        }

        let charIndex = dimIndex.get(labelId);
        if (!charIndex) {
          charIndex = new Map();
          dimIndex.set(labelId, charIndex);
        }

        let datasetIndex = charIndex.get(datasetId);
        if (!datasetIndex) {
          datasetIndex = new Map();
          charIndex.set(datasetId, datasetIndex);
        }

        datasetIndex.set(
          yearLabelId,
          (datasetIndex.get(yearLabelId) ?? 0) + 1
        );
      }
    }
  }

  getTotalsByLabel(dimension) {
    const reg = this.dimReg[dimension];
    if (!reg) return new Map();

    const dimTotals = this.filterTotals.get(dimension);
    if (!dimTotals) return new Map();

    // Convert labelIds to strings
    const m = new Map();
    for (const [labelId, count] of dimTotals) {
      m.set(reg.strOf(labelId), count);
    }
    return m;
  }
  /**
   * Top-N labels + counts for one dimension, with optional "Other".
   * @param {'evidence'|'mechanism'|'antibiotic'} dimension
   * @param {number} topN
   * @param {boolean} includeOther
   * @returns {{ labels: string[], counts: number[] }}
   */
  getTopNDatasetForDimension(dimension, topN = 5, includeOther = true) {
    // Reuse the earlier helper you have (or implement inline)
    const totals = this.getTotalsByLabel(dimension); // Map<label,count>
    const entries = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);

    const top = entries.slice(0, Math.max(0, topN));
    const labels = top.map(([l]) => l);
    const counts = top.map(([, c]) => c);

    if (includeOther && entries.length > top.length) {
      let other = 0;
      for (let i = top.length; i < entries.length; i++) other += entries[i][1];
      if (other > 0) {
        labels.push("Other");
        counts.push(other);
      }
    }
    return { labels, counts };
  }

  /**
   * Multi-ring doughnut data:
  
   * @param {Object} opts
   * @param {number} [opts.topN=5]
   * @param {boolean} [opts.includeOther=true]
   * @returns {{ labels: string[], datasets: { label: string, data: number[], labelsLocal: string[] }[] }}
   */
  getMultiRingDonutData({ topN = 5, includeOther = true } = {}) {
    const dims = this.filterCategories;

    const perDim = Object.fromEntries(
      dims.map((d) => [d, this.getTopN(d, topN, includeOther)])
    );

    const labelUnionSet = new Set();
    // Preserve readable ring-first ordering:
    for (const d of dims) {
      for (const l of perDim[d].labels) labelUnionSet.add(l);
    }
    const labels = Array.from(labelUnionSet);

    const datasets = dims.map((d) => {
      const { labels: localLabels, counts } = perDim[d];
      // Map local -> count for fast lookup
      const mapLocal = new Map(localLabels.map((l, i) => [l, counts[i]]));

      // data must align to global labels
      const data = labels.map((l) => mapLocal.get(l) ?? null);

      return {
        label: toTitleCase(d),
        data,
        customLabels: localLabels,
      };
    });

    return { labels, datasets };
  }

  getCoordinates() {
    return { lat: this.latitude, lng: this.longitude };
  }

  /**
   * Applies cumulative transformation to an array of values.
   * @param {number[]} values
   * @returns {number[]}
   */
  #applyCumulative(values) {
    let runningSum = 0;
    return values.map((value) => {
      runningSum += value;
      return runningSum;
    });
  }

  /**
   * Checks if a year string is valid (numeric, positive, reasonable range).
   * @param {string} yearStr
   * @returns {boolean}
   */
  #isValidYear(yearStr) {
    if (!yearStr || typeof yearStr !== "string") return false;
    const trimmed = yearStr.trim().toLowerCase();
    if (/^(na|n\/a|null|none|unknown|)$/i.test(trimmed)) return false;
    const yearNum = parseInt(trimmed, 10);
    return !isNaN(yearNum) && yearNum > 0 && yearNum <= 9999;
  }

  /**
   * Collects and validates years from dimension index, returns sorted year arrays.
   * @param {Map} dimIndex - The dimension's time series index
   * @param {IdRegistry} yearReg - The year registry
   * @returns {{ sortedYearIds: number[], sortedYearStrings: string[] } | null}
   */
  #collectYearRange(dimIndex, yearReg) {
    const yearSet = new Set();
    for (const charIndex of dimIndex.values()) {
      for (const datasetIndex of charIndex.values()) {
        for (const yearId of datasetIndex.keys()) {
          yearSet.add(yearId);
        }
      }
    }

    if (yearSet.size === 0) return null;

    const validYearValues = Array.from(yearSet)
      .map((yearId) => {
        const yearStr = yearReg.strOf(yearId);
        if (!this.#isValidYear(yearStr)) return null;
        return parseInt(yearStr, 10);
      })
      .filter((year) => year !== null);

    if (validYearValues.length === 0) return null;

    const minYear = Math.min(...validYearValues);
    const maxYear = Math.max(...validYearValues);

    const sortedYearStrings = [];
    const sortedYearIds = [];
    for (let year = minYear; year <= maxYear; year++) {
      const yearStr = String(year);
      sortedYearStrings.push(yearStr);
      sortedYearIds.push(yearReg.idOf(yearStr));
    }

    return { sortedYearIds, sortedYearStrings };
  }

  /**
   * Builds year totals for time series, either per-dataset or merged.
   * @param {number[]} sortedYearIds
   * @param {number[]} datasetIds
   * @param {boolean} cumulative
   * @param {string} dataMode - "compare" or "merge"
   * @returns {{ yearTotals: number[] | null, yearTotalsByDataset: Map | null }}
   */
  #buildYearTotals(sortedYearIds, datasetIds, cumulative, dataMode) {
    const buildArray = (totalsMap) =>
      sortedYearIds.map((yearId) => totalsMap?.get(yearId) ?? 0);

    if (dataMode === "compare") {
      const yearTotalsByDataset = new Map();
      for (const dsId of datasetIds) {
        const totalsMap = this.yearTotalsByDataset.get(dsId);
        let totals = buildArray(totalsMap);
        if (cumulative) totals = this.#applyCumulative(totals);
        yearTotalsByDataset.set(dsId, totals);
      }
      return { yearTotals: null, yearTotalsByDataset };
    }

    let yearTotals = sortedYearIds.map((yearId) => {
      let total = 0;
      for (const dsId of datasetIds) {
        const totalsMap = this.yearTotalsByDataset.get(dsId);
        total += totalsMap?.get(yearId) ?? 0;
      }
      return total;
    });
    if (cumulative) yearTotals = this.#applyCumulative(yearTotals);

    return { yearTotals, yearTotalsByDataset: null };
  }

  /**
   * Calculates totals for each characteristic for sorting purposes.
   * @param {Map} dimIndex
   * @param {number[]} characteristicIds
   * @param {number[]} sortedYearIds
   * @returns {Map<number, { total: number, recentYearCount: number }>}
   */
  #calculateCharacteristicTotals(dimIndex, characteristicIds, sortedYearIds) {
    const charTotals = new Map();
    const mostRecentYearId = sortedYearIds.length > 0
      ? sortedYearIds[sortedYearIds.length - 1]
      : null;

    for (const charId of characteristicIds) {
      const charIndex = dimIndex.get(charId);
      if (!charIndex) continue;

      let total = 0;
      let recentYearCount = 0;

      for (const datasetIndex of charIndex.values()) {
        for (const [yearId, count] of datasetIndex.entries()) {
          total += count;
          if (yearId === mostRecentYearId) {
            recentYearCount += count;
          }
        }
      }

      charTotals.set(charId, { total, recentYearCount });
    }

    return charTotals;
  }

  /**
   * Builds time series datasets based on data mode.
   * @param {Object} params
   * @returns {Object[]}
   */
  #buildTimeSeriesDatasets({
    characteristicIds,
    dimIndex,
    sortedYearIds,
    datasetIds,
    cumulative,
    dataMode,
    charReg,
    datasetReg,
  }) {
    const datasets = [];

    for (const charId of characteristicIds) {
      const charIndex = dimIndex.get(charId);
      if (!charIndex) continue;

      const charName = charReg.strOf(charId);

      if (dataMode === "compare") {
        for (const dsId of datasetIds) {
          const datasetIndex = charIndex.get(dsId);
          if (!datasetIndex || datasetIndex.size === 0) continue;

          const datasetName = datasetReg.strOf(dsId);
          const isUserData = datasetName === "User Data";

          let data = sortedYearIds.map((yearId) => datasetIndex.get(yearId) ?? 0);
          if (cumulative) data = this.#applyCumulative(data);

          datasets.push({
            label: isUserData ? `${charName} (User Data)` : charName,
            data,
            borderColor: "#3b82f6",
            backgroundColor: "transparent",
            tension: 0.1,
            datasetId: dsId,
            isUserData,
          });
        }
      } else {
        let data = sortedYearIds.map((yearId) => {
          let total = 0;
          for (const datasetIndex of charIndex.values()) {
            total += datasetIndex.get(yearId) ?? 0;
          }
          return total;
        });
        if (cumulative) data = this.#applyCumulative(data);

        datasets.push({
          label: charName,
          data,
          borderColor: "#3b82f6",
          backgroundColor: "transparent",
          tension: 0.1,
        });
      }
    }

    return datasets;
  }

  /**
   * Get time-series data for a given AMR characteristic dimension.
   * @param {string} dimension - The AMR characteristic dimension (e.g., "resistance_mechanism")
   * @param {boolean} cumulative - If true, return cumulative sums; if false, return per-year counts
   * @param {string} dataMode - "compare" or "merge" for dataset handling
   * @param {number} maxLines - Maximum number of lines to display (default: unlimited)
   * @param {string} lineSelection - How to select lines: "totalCount" (default), "recentYear", "alphanumeric"
   * @param {Map<string, Map<string, number>>|null} unfilteredYearTotalsInput - Pre-filter year totals from DataLoader
   * @returns {{ labels: string[], datasets: Object[], yearTotals: number[] | null, yearTotalsByDataset: Map | null, unfilteredYearTotals: number[] | null, unfilteredYearTotalsByDataset: Map | null }}
   */
  getTimeSeriesData(
    dimension,
    cumulative = false,
    dataMode = "merge",
    maxLines = null,
    lineSelection = "totalCount",
    unfilteredYearTotalsInput = null
  ) {
    const emptyResult = { labels: [], datasets: [] };

    const dimIndex = this.timeSeriesIndex.get(dimension);
    if (!dimIndex || dimIndex.size === 0) return emptyResult;

    const yearReg = this.dimReg["collection_year"];
    if (!yearReg) return emptyResult;

    const yearRange = this.#collectYearRange(dimIndex, yearReg);
    if (!yearRange) return emptyResult;

    const { sortedYearIds, sortedYearStrings } = yearRange;
    const charReg = this.dimReg[dimension];
    const characteristicIds = Array.from(dimIndex.keys());
    const datasetIds = Array.from(this.relationalIndex.keys());
    const datasetReg = this.reg.dataset;

    const { yearTotals, yearTotalsByDataset } = this.#buildYearTotals(
      sortedYearIds,
      datasetIds,
      cumulative,
      dataMode
    );

    const charTotals = this.#calculateCharacteristicTotals(
      dimIndex,
      characteristicIds,
      sortedYearIds
    );

    // Sort characteristics based on lineSelection
    if (lineSelection === "totalCount") {
      characteristicIds.sort((a, b) =>
        (charTotals.get(b)?.total ?? 0) - (charTotals.get(a)?.total ?? 0)
      );
    } else if (lineSelection === "recentYear") {
      characteristicIds.sort((a, b) =>
        (charTotals.get(b)?.recentYearCount ?? 0) - (charTotals.get(a)?.recentYearCount ?? 0)
      );
    } else {
      characteristicIds.sort((a, b) =>
        charReg.strOf(a).localeCompare(charReg.strOf(b))
      );
    }

    if (typeof maxLines === "number" && maxLines > 0) {
      characteristicIds.splice(maxLines);
    }

    const datasets = this.#buildTimeSeriesDatasets({
      characteristicIds,
      dimIndex,
      sortedYearIds,
      datasetIds,
      cumulative,
      dataMode,
      charReg,
      datasetReg,
    });

    // Build unfiltered year totals if provided
    let unfilteredYearTotals = null;
    let unfilteredYearTotalsByDataset = null;

    if (unfilteredYearTotalsInput) {
      if (dataMode === "compare") {
        unfilteredYearTotalsByDataset = new Map();
        for (const dsId of datasetIds) {
          const dsName = datasetReg.strOf(dsId);
          const totalsMap = unfilteredYearTotalsInput.get(dsName);
          let totals = sortedYearStrings.map(
            (yearStr) => totalsMap?.get(yearStr) ?? 0
          );
          if (cumulative) totals = this.#applyCumulative(totals);
          unfilteredYearTotalsByDataset.set(dsId, totals);
        }
      } else {
        // Merge mode: sum across all datasets
        unfilteredYearTotals = sortedYearStrings.map((yearStr) => {
          let total = 0;
          for (const [, totalsMap] of unfilteredYearTotalsInput) {
            total += totalsMap?.get(yearStr) ?? 0;
          }
          return total;
        });
        if (cumulative) {
          unfilteredYearTotals = this.#applyCumulative(unfilteredYearTotals);
        }
      }
    }

    return {
      labels: sortedYearStrings,
      datasets,
      yearTotals,
      yearTotalsByDataset,
      unfilteredYearTotals,
      unfilteredYearTotalsByDataset,
    };
  }

  /**
   * Set linked fields configuration for observation processing
   * @param {string[]} linkedFields - Array of field names that are grouped in observations
   */
  setLinkedFields(linkedFields) {
    this.linkedFields = linkedFields;
  }

  /**
   * Get the relational crosstab for a dimension pair
   * @param {number} datasetId
   * @param {string} dim1 - First dimension name
   * @param {string} dim2 - Second dimension name
   * @returns {RelationalCrosstab}
   */
  #getRelationalCrosstab(datasetId, dim1, dim2) {
    let perDataset = this.relationalIndex.get(datasetId);
    if (!perDataset) {
      perDataset = new Map();
      this.relationalIndex.set(datasetId, perDataset);
    }

    const key = `${dim1}:${dim2}`;
    let crosstab = perDataset.get(key);
    if (!crosstab) {
      crosstab = new RelationalCrosstab();
      perDataset.set(key, crosstab);
    }
    return crosstab;
  }

  /**
   * Process a single gene observation from an exploded row.
   * Updates relational crosstabs for all linked dimension pairs.
   *
   * @param {Object} observation - A single observation object with scalar values
   */
  updateFromObservation(observation) {
    if (!observation) return;

    this.observationCount += 1;

    const datasetId = this.reg.dataset.idOf(observation.dataset ?? "User Data");
    const speciesId = this.reg.species.idOf(observation.species ?? "Unknown species");
    const genusId = this.reg.genus.idOf(observation.genus ?? "Unknown genus");

    // Get linked fields - use stored config or default
    const linkedFields = this.linkedFields || [
      "gene", "evidence", "drug_class", "resistance_mechanism",
      "gene_short_name", "gene_family_name"
    ];

    // Filter to only fields that exist in this observation with valid values
    const presentFields = linkedFields.filter(field => {
      const val = observation[field];
      return val !== null && val !== undefined && val !== "";
    });

    if (presentFields.length < 2) return;

    // Build relational crosstabs for all pairs of present linked fields
    for (let i = 0; i < presentFields.length; i++) {
      for (let j = i + 1; j < presentFields.length; j++) {
        const dim1 = presentFields[i];
        const dim2 = presentFields[j];

        const dim1Reg = this.dimReg[dim1];
        const dim2Reg = this.dimReg[dim2];

        if (!dim1Reg || !dim2Reg) continue;

        const dim1Value = observation[dim1];
        const dim2Value = observation[dim2];

        const dim1Id = dim1Reg.idOf(dim1Value);
        const dim2Id = dim2Reg.idOf(dim2Value);

        // Update both directions of the relationship
        const crosstab12 = this.#getRelationalCrosstab(datasetId, dim1, dim2);
        crosstab12.bump(dim1Id, dim2Id, speciesId, genusId, 1);

        const crosstab21 = this.#getRelationalCrosstab(datasetId, dim2, dim1);
        crosstab21.bump(dim2Id, dim1Id, speciesId, genusId, 1);
      }
    }
  }

  /**
   * Gets dimension registries and taxonomy flags for hierarchical data.
   * @param {string} primaryDim
   * @param {string} secondaryDim
   * @returns {Object|null} Dimension info or null if invalid
   */
  #getDimensionInfo(primaryDim, secondaryDim) {
    const isSpeciesPrimary = primaryDim === "species";
    const isGenusPrimary = primaryDim === "genus";
    const isTaxonomyPrimary = isSpeciesPrimary || isGenusPrimary;

    const primaryReg = isTaxonomyPrimary
      ? (isSpeciesPrimary ? this.reg.species : this.reg.genus)
      : this.dimReg[primaryDim];

    if (!primaryReg) return null;

    const isSpeciesSecondary = secondaryDim === "species";
    const isGenusSecondary = secondaryDim === "genus";
    const isTaxonomySecondary = isSpeciesSecondary || isGenusSecondary;

    const secondaryReg = isTaxonomySecondary
      ? (isSpeciesSecondary ? this.reg.species : this.reg.genus)
      : this.dimReg[secondaryDim];

    if (!secondaryReg) return null;

    return {
      primaryReg,
      secondaryReg,
      isSpeciesPrimary,
      isTaxonomyPrimary,
      isSpeciesSecondary,
      isTaxonomySecondary,
    };
  }

  /**
   * Identifies user data dataset ID from dataset list.
   * @param {number[]} datasetIds
   * @returns {number|null}
   */
  #findUserDatasetId(datasetIds) {
    const datasetReg = this.reg.dataset;
    for (const dsId of datasetIds) {
      if (datasetReg.strOf(dsId).toLowerCase() === "user data") {
        return dsId;
      }
    }
    return null;
  }

  /**
   * Aggregates hierarchical data from relational indexes.
   * Handles three cases: taxonomy primary, taxonomy secondary, or linked-field both.
   * @returns {Object} Aggregation results
   */
  #aggregateHierarchicalData({
    datasetIds,
    primaryDim,
    secondaryDim,
    dimInfo,
    userDataDsId,
    isCompareMode,
  }) {
    const { isSpeciesPrimary, isTaxonomyPrimary, isSpeciesSecondary, isTaxonomySecondary } = dimInfo;

    const aggregatedByGroup = new Map();
    const primaryTotals = new Map();
    const primaryTotalsByGroup = new Map();
    const secondarySet = new Set();

    const getGroupKey = (dsId) => {
      if (!isCompareMode) return "merged";
      return dsId === userDataDsId ? "user" : "base";
    };

    const getOrCreateGroup = (dsId) => {
      const key = getGroupKey(dsId);
      if (!aggregatedByGroup.has(key)) {
        aggregatedByGroup.set(key, new Map());
      }
      return aggregatedByGroup.get(key);
    };

    const ensureGroupTotals = (dsId) => {
      const groupKey = getGroupKey(dsId);
      if (!primaryTotalsByGroup.has(groupKey)) {
        primaryTotalsByGroup.set(groupKey, new Map());
      }
      return primaryTotalsByGroup.get(groupKey);
    };

    for (const dsId of datasetIds) {
      const perDataset = this.relationalIndex.get(dsId);
      if (!perDataset) continue;

      const aggregated = getOrCreateGroup(dsId);
      const groupTotals = ensureGroupTotals(dsId);

      if (isTaxonomyPrimary) {
        this.#aggregateTaxonomyPrimary({
          perDataset, aggregated, groupTotals, primaryTotals, secondarySet,
          secondaryDim, isSpeciesPrimary, isTaxonomySecondary, isSpeciesSecondary,
        });
      } else if (isTaxonomySecondary) {
        this.#aggregateTaxonomySecondary({
          perDataset, aggregated, groupTotals, primaryTotals, secondarySet,
          primaryDim, isSpeciesSecondary,
        });
      } else {
        this.#aggregateLinkedFields({
          perDataset, aggregated, groupTotals, primaryTotals, secondarySet,
          primaryDim, secondaryDim,
        });
      }
    }

    return { aggregatedByGroup, primaryTotals, primaryTotalsByGroup, secondarySet };
  }

  /**
   * Aggregates when primary dimension is species or genus.
   */
  #aggregateTaxonomyPrimary({
    perDataset, aggregated, groupTotals, primaryTotals, secondarySet,
    secondaryDim, isSpeciesPrimary, isTaxonomySecondary, isSpeciesSecondary,
  }) {
    for (const [key, crosstab] of perDataset) {
      const [dim1, dim2] = key.split(":");
      const useSecondaryFromDim1 = dim1 === secondaryDim;
      const useSecondaryFromDim2 = dim2 === secondaryDim;

      if (!useSecondaryFromDim1 && !useSecondaryFromDim2 && !isTaxonomySecondary) continue;

      for (const dim1Id of crosstab.dim1Ids()) {
        const breakdown = crosstab.getBreakdown(dim1Id);

        for (const [dim2Id, entry] of breakdown) {
          const taxonomyMap = isSpeciesPrimary ? entry.species : entry.genus;

          for (const [taxId, count] of taxonomyMap) {
            if (!aggregated.has(taxId)) {
              aggregated.set(taxId, new Map());
            }
            const primaryEntry = aggregated.get(taxId);

            if (isTaxonomySecondary) {
              const otherTaxMap = isSpeciesSecondary ? entry.species : entry.genus;
              for (const [otherTaxId, otherCount] of otherTaxMap) {
                secondarySet.add(otherTaxId);
                primaryEntry.set(otherTaxId, (primaryEntry.get(otherTaxId) ?? 0) + otherCount);
              }
            } else if (useSecondaryFromDim1) {
              secondarySet.add(dim1Id);
              primaryEntry.set(dim1Id, (primaryEntry.get(dim1Id) ?? 0) + count);
            } else if (useSecondaryFromDim2) {
              secondarySet.add(dim2Id);
              primaryEntry.set(dim2Id, (primaryEntry.get(dim2Id) ?? 0) + count);
            }

            primaryTotals.set(taxId, (primaryTotals.get(taxId) ?? 0) + count);
            groupTotals.set(taxId, (groupTotals.get(taxId) ?? 0) + count);
          }
        }
      }

      if (isTaxonomySecondary) break;
    }
  }

  /**
   * Aggregates when secondary dimension is species or genus (but primary is not).
   */
  #aggregateTaxonomySecondary({
    perDataset, aggregated, groupTotals, primaryTotals, secondarySet,
    primaryDim, isSpeciesSecondary,
  }) {
    for (const [key, crosstab] of perDataset) {
      if (!key.startsWith(primaryDim + ":")) continue;

      for (const primaryId of crosstab.dim1Ids()) {
        if (!aggregated.has(primaryId)) {
          aggregated.set(primaryId, new Map());
        }
        const primaryEntry = aggregated.get(primaryId);

        const breakdown = crosstab.getBreakdown(primaryId);
        for (const [, entry] of breakdown) {
          const taxonomyMap = isSpeciesSecondary ? entry.species : entry.genus;
          for (const [taxId, count] of taxonomyMap) {
            secondarySet.add(taxId);
            primaryEntry.set(taxId, (primaryEntry.get(taxId) ?? 0) + count);
          }
        }

        const dimTotal = crosstab.getDim1Total(primaryId);
        primaryTotals.set(primaryId, (primaryTotals.get(primaryId) ?? 0) + dimTotal);
        groupTotals.set(primaryId, (groupTotals.get(primaryId) ?? 0) + dimTotal);
      }

      break;
    }
  }

  /**
   * Aggregates when both dimensions are linked fields (not taxonomy).
   */
  #aggregateLinkedFields({
    perDataset, aggregated, groupTotals, primaryTotals, secondarySet,
    primaryDim, secondaryDim,
  }) {
    const key = `${primaryDim}:${secondaryDim}`;
    const crosstab = perDataset.get(key);
    if (!crosstab) return;

    for (const primaryId of crosstab.dim1Ids()) {
      if (!aggregated.has(primaryId)) {
        aggregated.set(primaryId, new Map());
      }
      const primaryEntry = aggregated.get(primaryId);

      const breakdown = crosstab.getBreakdown(primaryId);
      for (const [secondaryId, entry] of breakdown) {
        secondarySet.add(secondaryId);
        primaryEntry.set(secondaryId, (primaryEntry.get(secondaryId) ?? 0) + entry.total);
      }

      const dimTotal = crosstab.getDim1Total(primaryId);
      primaryTotals.set(primaryId, (primaryTotals.get(primaryId) ?? 0) + dimTotal);
      groupTotals.set(primaryId, (groupTotals.get(primaryId) ?? 0) + dimTotal);
    }
  }

  /**
   * Sorts primary IDs based on sort option.
   * @returns {number[]} Sorted primary IDs
   */
  #sortPrimaryIds(primaryIds, sort, primaryReg, primaryTotals, primaryTotalsByGroup) {
    if (sort === "alphanumeric") {
      primaryIds.sort((a, b) => primaryReg.strOf(a).localeCompare(primaryReg.strOf(b)));
    } else if (sort.startsWith("count")) {
      const want = sort.split(":")[1]?.trim()?.toLowerCase();
      const userTotals = primaryTotalsByGroup.get("user");
      const baseTotals = primaryTotalsByGroup.get("base");

      primaryIds.sort((a, b) => {
        if ((want === "userdata" || want === "user data") && userTotals) {
          return (userTotals.get(b) ?? 0) - (userTotals.get(a) ?? 0);
        }
        if (want === "camra" && baseTotals) {
          return (baseTotals.get(b) ?? 0) - (baseTotals.get(a) ?? 0);
        }
        return (primaryTotals.get(b) ?? 0) - (primaryTotals.get(a) ?? 0);
      });
    } else {
      primaryIds.sort((a, b) => primaryReg.strOf(a).localeCompare(primaryReg.strOf(b)));
    }
    return primaryIds;
  }

  /**
   * Calculates secondary totals and returns sorted secondary IDs.
   * @returns {number[]} Sorted secondary IDs
   */
  #sortSecondaryIds(secondarySet, aggregatedByGroup) {
    const secondaryTotals = new Map();
    for (const [, groupAgg] of aggregatedByGroup) {
      for (const [, secondaryMap] of groupAgg) {
        for (const [secId, count] of secondaryMap) {
          secondaryTotals.set(secId, (secondaryTotals.get(secId) ?? 0) + count);
        }
      }
    }
    return Array.from(secondarySet).sort(
      (a, b) => (secondaryTotals.get(b) ?? 0) - (secondaryTotals.get(a) ?? 0)
    );
  }

  /**
   * Generates a color for a given index using golden angle distribution.
   * @param {number} idx
   * @returns {string} HSL color string
   */
  #generateColor(idx) {
    const hue = (idx * 137.508) % 360;
    return `hsl(${hue}, 65%, 55%)`;
  }

  /**
   * Builds hierarchical datasets for Chart.js.
   * @returns {Object[]} Datasets array
   */
  #buildHierarchicalDatasets({
    primaryIds,
    secondaryIds,
    aggregatedByGroup,
    secondaryReg,
    palette,
    isCompareMode,
  }) {
    const datasets = [];

    if (isCompareMode) {
      const groupOrder = ["base", "user"];

      for (const groupKey of groupOrder) {
        const groupAgg = aggregatedByGroup.get(groupKey);
        if (!groupAgg) continue;

        const isUserData = groupKey === "user";

        for (let idx = 0; idx < secondaryIds.length; idx++) {
          const secId = secondaryIds[idx];
          const label = secondaryReg.strOf(secId);

          const data = primaryIds.map(primaryId => {
            const entry = groupAgg.get(primaryId);
            return entry?.get(secId) ?? 0;
          });

          if (data.every(v => v === 0)) continue;

          const baseColor = palette?.[label] ?? this.#generateColor(idx);
          const backgroundColor = isUserData
            ? ColorGenerator.createDiagonalPattern(baseColor)
            : baseColor;

          datasets.push({
            label: isUserData ? `${label} (User)` : label,
            data,
            backgroundColor,
            stack: groupKey,
            isUserData,
            _baseLabel: label,
          });
        }
      }
    } else {
      for (let idx = 0; idx < secondaryIds.length; idx++) {
        const secId = secondaryIds[idx];
        const label = secondaryReg.strOf(secId);

        const data = primaryIds.map(primaryId => {
          let total = 0;
          for (const [, groupAgg] of aggregatedByGroup) {
            const entry = groupAgg.get(primaryId);
            total += entry?.get(secId) ?? 0;
          }
          return total;
        });

        datasets.push({
          label,
          data,
          backgroundColor: palette?.[label] ?? this.#generateColor(idx),
          stack: "0",
        });
      }
    }

    return datasets;
  }

  /**
   * Get hierarchical data for nested bar charts showing cross-dimension relationships.
   * @param {Object} options
   * @param {string} options.primaryDim - Primary dimension (x-axis categories)
   * @param {string} options.secondaryDim - Secondary dimension (stacks/groups within categories)
   * @param {string} [options.groupBy='species'] - Group by 'species' or 'genus' for coloring
   * @param {number} [options.topN] - Limit to top N primary dimension values
   * @param {string} [options.sort='count'] - Sort by 'count' or 'alphanumeric'
   * @param {Object} [options.palette] - Color palette for secondary dimension values
   * @param {string} [options.dataMode] - "compare" or "merge"
   * @returns {{ labels: string[], datasets: Object[], secondaryLabels: string[], maxLength: number }}
   */
  getHierarchicalData({
    primaryDim,
    secondaryDim,
    groupBy = "species",
    topN = null,
    sort = "count",
    palette = null,
    dataMode = null,
  } = {}) {
    const emptyResult = { labels: [], datasets: [], secondaryLabels: [], maxLength: 0 };

    const datasetIds = Array.from(this.relationalIndex.keys());
    if (datasetIds.length === 0) return emptyResult;

    const dimInfo = this.#getDimensionInfo(primaryDim, secondaryDim);
    if (!dimInfo) return emptyResult;

    const { primaryReg, secondaryReg } = dimInfo;
    const isCompareMode = dataMode === "compare";
    const userDataDsId = this.#findUserDatasetId(datasetIds);

    const { aggregatedByGroup, primaryTotals, primaryTotalsByGroup, secondarySet } =
      this.#aggregateHierarchicalData({
        datasetIds,
        primaryDim,
        secondaryDim,
        dimInfo,
        userDataDsId,
        isCompareMode,
      });

    // Collect all primary IDs
    const allPrimaryIds = new Set();
    for (const [, groupAgg] of aggregatedByGroup) {
      for (const primaryId of groupAgg.keys()) {
        allPrimaryIds.add(primaryId);
      }
    }

    let primaryIds = Array.from(allPrimaryIds);
    const maxLength = primaryIds.length;

    primaryIds = this.#sortPrimaryIds(primaryIds, sort, primaryReg, primaryTotals, primaryTotalsByGroup);

    if (typeof topN === "number" && topN > 0) {
      primaryIds = primaryIds.slice(0, topN);
    }

    const secondaryIds = this.#sortSecondaryIds(secondarySet, aggregatedByGroup);

    const datasets = this.#buildHierarchicalDatasets({
      primaryIds,
      secondaryIds,
      aggregatedByGroup,
      secondaryReg,
      palette,
      isCompareMode,
    });

    return {
      labels: primaryIds.map(id => primaryReg.strOf(id)),
      datasets,
      secondaryLabels: secondaryIds.map(id => secondaryReg.strOf(id)),
      maxLength,
    };
  }

  /**
   * Get the distribution of dim2 values for a specific dim1 value.
   * Useful for drill-down views.
   *
   * @param {string} dim1 - First dimension name
   * @param {string} value1 - Value in dim1 to get breakdown for
   * @param {string} dim2 - Second dimension to break down by
   * @returns {{ labels: string[], counts: number[], total: number }}
   */
  getRelationalBreakdown(dim1, value1, dim2) {
    const datasetIds = Array.from(this.relationalIndex.keys());
    if (datasetIds.length === 0) {
      return { labels: [], counts: [], total: 0 };
    }

    const dim1Reg = this.dimReg[dim1];
    const dim2Reg = this.dimReg[dim2];

    if (!dim1Reg || !dim2Reg) {
      return { labels: [], counts: [], total: 0 };
    }

    const dim1Id = dim1Reg.peekId(value1);
    if (dim1Id === undefined) {
      return { labels: [], counts: [], total: 0 };
    }

    const key = `${dim1}:${dim2}`;
    const aggregated = new Map(); // dim2Id -> count
    let total = 0;

    for (const dsId of datasetIds) {
      const perDataset = this.relationalIndex.get(dsId);
      if (!perDataset) continue;

      const crosstab = perDataset.get(key);
      if (!crosstab) continue;

      const breakdown = crosstab.getBreakdown(dim1Id);
      for (const [dim2Id, entry] of breakdown) {
        aggregated.set(dim2Id, (aggregated.get(dim2Id) ?? 0) + entry.total);
        total += entry.total;
      }
    }

    // Sort by count descending
    const sorted = Array.from(aggregated.entries()).sort((a, b) => b[1] - a[1]);

    return {
      labels: sorted.map(([id]) => dim2Reg.strOf(id)),
      counts: sorted.map(([, count]) => count),
      total,
    };
  }
}

class IdRegistry {
  constructor(name, { aliasMap } = {}) {
    this.name = name;
    this.aliasMap = aliasMap ?? null;
    this.byStr = new Map(); // string -> int
    this.byId = []; // int -> string
  }
  _canon(s) {
    const k = s ?? "Unknown";
    return this.aliasMap?.[k] ?? k;
  }
  idOf(s) {
    const key = this._canon(s == null ? s : String(s));
    let id = this.byStr.get(key);
    if (id !== undefined) return id;
    id = this.byId.length;
    this.byStr.set(key, id);
    this.byId.push(key);
    return id;
  }
  strOf(id) {
    return this.byId[id] ?? "Unknown";
  }
  size() {
    return this.byId.length;
  }
}

/**
 * RelationalCrosstab - Captures relationships between two dimensions
 * Tracks how values from dim1 relate to values from dim2, with species/genus breakdown.
 *
 * Structure: dim1Id -> dim2Id -> { speciesId -> count, genusId -> count, total }
 */
class RelationalCrosstab {
  constructor() {
    // dim1Id -> Map<dim2Id, { species: Map<speciesId, count>, genus: Map<genusId, count>, total }>
    this.data = new Map();
    this.dim1Totals = new Map(); // dim1Id -> total observations
    this.dim2Totals = new Map(); // dim2Id -> total observations
    this.totalCount = 0;
  }

  /**
   * Record a relationship between dim1 and dim2 values
   * @param {number} dim1Id - ID of the first dimension value
   * @param {number} dim2Id - ID of the second dimension value
   * @param {number} speciesId - Species ID for grouping
   * @param {number} genusId - Genus ID for grouping
   * @param {number} count - Count to add (default: 1)
   */
  bump(dim1Id, dim2Id, speciesId, genusId, count = 1) {
    let dim1Entry = this.data.get(dim1Id);
    if (!dim1Entry) {
      dim1Entry = new Map();
      this.data.set(dim1Id, dim1Entry);
    }

    let dim2Entry = dim1Entry.get(dim2Id);
    if (!dim2Entry) {
      dim2Entry = {
        species: new Map(),
        genus: new Map(),
        total: 0
      };
      dim1Entry.set(dim2Id, dim2Entry);
    }

    dim2Entry.species.set(speciesId, (dim2Entry.species.get(speciesId) ?? 0) + count);
    dim2Entry.genus.set(genusId, (dim2Entry.genus.get(genusId) ?? 0) + count);
    dim2Entry.total += count;

    this.dim1Totals.set(dim1Id, (this.dim1Totals.get(dim1Id) ?? 0) + count);
    this.dim2Totals.set(dim2Id, (this.dim2Totals.get(dim2Id) ?? 0) + count);
    this.totalCount += count;
  }

  /**
   * Get breakdown of dim2 values for a specific dim1 value
   * @param {number} dim1Id - ID of the first dimension value
   * @returns {Map<dim2Id, { species: Map, genus: Map, total: number }>}
   */
  getBreakdown(dim1Id) {
    return this.data.get(dim1Id) || new Map();
  }

  /**
   * Get the count for a specific dim1/dim2 combination
   * @param {number} dim1Id
   * @param {number} dim2Id
   * @returns {number}
   */
  getValue(dim1Id, dim2Id) {
    const dim1Entry = this.data.get(dim1Id);
    if (!dim1Entry) return 0;
    const dim2Entry = dim1Entry.get(dim2Id);
    return dim2Entry?.total ?? 0;
  }

  /**
   * Get all dim1 IDs that have data
   * @returns {IterableIterator<number>}
   */
  dim1Ids() {
    return this.data.keys();
  }

  /**
   * Get all dim2 IDs for a specific dim1 value
   * @param {number} dim1Id
   * @returns {IterableIterator<number>}
   */
  dim2IdsFor(dim1Id) {
    const entry = this.data.get(dim1Id);
    return entry ? entry.keys() : [][Symbol.iterator]();
  }

  /**
   * Get total count for a dim1 value
   * @param {number} dim1Id
   * @returns {number}
   */
  getDim1Total(dim1Id) {
    return this.dim1Totals.get(dim1Id) ?? 0;
  }

  /**
   * Get total count for a dim2 value
   * @param {number} dim2Id
   * @returns {number}
   */
  getDim2Total(dim2Id) {
    return this.dim2Totals.get(dim2Id) ?? 0;
  }

  /**
   * Get species breakdown for a dim1/dim2 combination
   * @param {number} dim1Id
   * @param {number} dim2Id
   * @returns {Map<speciesId, count>}
   */
  getSpeciesBreakdown(dim1Id, dim2Id) {
    const dim1Entry = this.data.get(dim1Id);
    if (!dim1Entry) return new Map();
    const dim2Entry = dim1Entry.get(dim2Id);
    return dim2Entry?.species ?? new Map();
  }

  /**
   * Get genus breakdown for a dim1/dim2 combination
   * @param {number} dim1Id
   * @param {number} dim2Id
   * @returns {Map<genusId, count>}
   */
  getGenusBreakdown(dim1Id, dim2Id) {
    const dim1Entry = this.data.get(dim1Id);
    if (!dim1Entry) return new Map();
    const dim2Entry = dim1Entry.get(dim2Id);
    return dim2Entry?.genus ?? new Map();
  }
}

IdRegistry.prototype.peekId = function (s) {
  const key = this._canon(String(s));
  return this.byStr.get(key); // may be undefined; does not insert
};

function normalizeCountry(rawCountry, stateProvince = null) {
  if (!rawCountry && stateProvince) {
    // If country is missing but we know it's a US state, assume United States
    return "United States";
  }

  if (!rawCountry || typeof rawCountry !== "string") {
    return "Unknown";
  }

  const cleaned = rawCountry.trim().toLowerCase();

  const aliases = {
    usa: "United States",
    us: "United States",
    "u.s.": "United States",
    "u.s.a.": "United States",
    "united states": "United States",
    "united states of america": "United States",
    america: "United States",
    zaire: "Democratic Republic Of The Congo",
    "drc": "Democratic Republic Of The Congo",
    // Add more known variants here if needed
  };

  // Normalize if it's a known alias
  if (aliases[cleaned]) {
    return aliases[cleaned];
  }

  // Otherwise just capitalize first letters as a fallback
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

var mainStyles = "/* Main styles for mGO web component - extracted from HTMLHelper.js */\r\n\r\n:host {\r\n  /* Color variables (mirrors HTMLhelper.color object) */\r\n  --color-text-default: #000;\r\n  --color-menu-bg: #f8f9fa;\r\n  --color-chart-settings-bg: #fff;\r\n  --color-chart-settings-text: #000;\r\n  --color-modal-bg: #fff;\r\n  --color-filter-menu-section-bg: #fff;\r\n  --color-white-btn-hover: #f3f4f6;\r\n  --color-scroll-thumb-fill: #adb5bd;\r\n  --color-header-border: #929292;\r\n\r\n  --search-shadow-px: 3px;\r\n  --search-shadow: 0 0 0 var(--search-shadow-px) rgba(80, 120, 255, 0.15);\r\n  --menu-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);\r\n  display: flex;\r\n  flex-direction: column;\r\n  width: 100%;\r\n  height: 100% !important;\r\n  min-height: 400px;\r\n  overflow: hidden;\r\n}\r\n\r\n#map {\r\n  position: absolute;\r\n  inset: 0;\r\n  z-index: 0;\r\n}\r\n\r\n/* Leaflet container styles for Shadow DOM */\r\n#map .leaflet-container {\r\n  width: 100%;\r\n  height: 100%;\r\n  z-index: 0;\r\n}\r\n\r\n#map .leaflet-tile-pane {\r\n  z-index: 1;\r\n}\r\n\r\n#map .leaflet-overlay-pane {\r\n  z-index: 2;\r\n}\r\n\r\n#map .leaflet-marker-pane {\r\n  z-index: 3;\r\n}\r\n\r\n#map .leaflet-tooltip-pane {\r\n  z-index: 4;\r\n}\r\n\r\n#map .leaflet-popup-pane {\r\n  z-index: 5;\r\n}\r\n\r\n#map .leaflet-control {\r\n  z-index: 6;\r\n}\r\n\r\n/* Leaflet pie chart marker styles */\r\n.pie-chart-marker {\r\n  background: transparent !important;\r\n  border: none !important;\r\n}\r\n\r\n.leaflet-marker-icon.pie-chart-marker {\r\n  background: transparent;\r\n  border: none;\r\n}\r\n\r\n/* Country shading tooltip */\r\n.country-tooltip {\r\n  background-color: rgba(255, 255, 255, 0.95);\r\n  border: 1px solid #999;\r\n  border-radius: 4px;\r\n  padding: 6px 10px;\r\n  font-size: 12px;\r\n  font-weight: 500;\r\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);\r\n}\r\n\r\n/* Country shading legend */\r\n#country-shading-legend {\r\n  display: none; /* temporarily hidden */\r\n  position: absolute;\r\n  bottom: 20px;\r\n  left: 80px;\r\n  z-index: 2;\r\n  background-color: rgba(255, 255, 255, 0.95);\r\n  border: 1px solid #ccc;\r\n  border-radius: 6px;\r\n  padding: 10px 12px;\r\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);\r\n  font-size: 11px;\r\n  min-width: 140px;\r\n  max-width: 180px;\r\n}\r\n\r\n#country-shading-legend.sidebar-closed {\r\n  left: 20px;\r\n}\r\n\r\n#country-shading-legend .legend-title {\r\n  font-weight: 600;\r\n  font-size: 12px;\r\n  margin-bottom: 8px;\r\n  color: #333;\r\n}\r\n\r\n#country-shading-legend .legend-gradient {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n}\r\n\r\n#country-shading-legend .legend-gradient-bar {\r\n  height: 12px;\r\n  width: 100%;\r\n  border-radius: 2px;\r\n  border: 1px solid #ddd;\r\n}\r\n\r\n#country-shading-legend .legend-labels {\r\n  display: flex;\r\n  justify-content: space-between;\r\n  font-size: 10px;\r\n  color: #666;\r\n  margin-top: 2px;\r\n}\r\n\r\n#country-shading-legend .legend-no-data {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 6px;\r\n  margin-top: 8px;\r\n  padding-top: 8px;\r\n  border-top: 1px solid #eee;\r\n}\r\n\r\n#country-shading-legend .legend-no-data-swatch {\r\n  width: 16px;\r\n  height: 12px;\r\n  border-radius: 2px;\r\n  border: 1px solid #ddd;\r\n}\r\n\r\n#country-shading-legend .legend-no-data-label {\r\n  font-size: 10px;\r\n  color: #666;\r\n}\r\n#amr-geo-mapper-wrapper {\r\n  flex: 1 1 0;\r\n  min-height: 0;\r\n}\r\nh1 {\r\n  font-size: 0.8rem;\r\n  margin-bottom: 0;\r\n}\r\n\r\nh2 {\r\n  font-size: 1.1rem;\r\n  font-weight: 450;\r\n  margin: 0;\r\n}\r\n\r\ninput[type=\"checkbox\"] {\r\n  border: 1px solid #dee2e6;\r\n}\r\ninput[type=\"checkbox\"]:focus {\r\n  box-shadow: none;\r\n  border-color: #dee2e6;\r\n}\r\ninput[type=\"checkbox\"]:hover {\r\n  border-color: #96989b;\r\n}\r\n\r\ninput[type=\"search\"]:focus {\r\n  outline: none;\r\n  border-color: #9bb4ff;\r\n  box-shadow: var(--search-shadow);\r\n}\r\n\r\n.map-wrap {\r\n  position: relative;\r\n  overflow: hidden;\r\n  box-sizing: border-box;\r\n}\r\n.italic {\r\n  font-style: italic;\r\n}\r\n.backdrop {\r\n  position: absolute;\r\n  inset: 0;\r\n  display: none;\r\n  background: rgba(0, 0, 0, 0.08);\r\n  backdrop-filter: blur(3px);\r\n  -webkit-backdrop-filter: blur(3px);\r\n  z-index: 9998;\r\n}\r\n\r\n.modal {\r\n  position: absolute;\r\n  inset: 0;\r\n  display: none;\r\n  z-index: 9999;\r\n  place-items: center;\r\n  pointer-events: none;\r\n  overflow: hidden;\r\n}\r\n\r\n:host([open]) .backdrop,\r\n:host([open]) .modal {\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n}\r\n:host([loading]) .modal {\r\n  display: none;\r\n}\r\n\r\n:host([loading]) #load-animation {\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n}\r\n\r\n#load-animation {\r\n  position: absolute;\r\n  inset: 0;\r\n  display: none;\r\n  z-index: 9999;\r\n  place-items: center;\r\n  pointer-events: none;\r\n  overflow: hidden;\r\n  z-index: 9999;\r\n  display: none;\r\n}\r\n\r\n/* https://css-loaders.com */\r\n.loader {\r\n  width: 100px;\r\n  aspect-ratio: 1;\r\n  border-radius: 50%;\r\n  border: 16px solid lightblue;\r\n  border-right-color: orange;\r\n  animation: l2 1s infinite linear;\r\n}\r\n@keyframes l2 {\r\n  to {\r\n    transform: rotate(1turn);\r\n  }\r\n}\r\n\r\n.modal {\r\n  height: 100%;\r\n}\r\n\r\n.modal .dialog {\r\n  --x-padding: calc(\r\n    32px - var(--search-shadow-px)\r\n  ); /*This, and the margin rules of several child elements, is so that the modal search box box-shadow is not clipped by the overflow rules.*/\r\n  --y-padding: 24px;\r\n  pointer-events: auto;\r\n  width: 760px;\r\n  height: 80%;\r\n  max-height: 80%;\r\n  background-color: var(--color-menu-bg);\r\n  box-shadow: var(--menu-shadow);\r\n  padding: var(--y-padding) var(--x-padding);\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 1rem;\r\n}\r\n\r\n.modal .header {\r\n  margin: 0 var(--search-shadow-px);\r\n  width: 100%;\r\n  height: fit-content;\r\n  display: flex;\r\n  flex-direction: column;\r\n  justify-content: center;\r\n  align-items: start;\r\n}\r\n.modal .header .title-block {\r\n  width: 100%;\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: center;\r\n  justify-content: space-between;\r\n  gap: 12px;\r\n}\r\n\r\n.modal h1 {\r\n  font-size: 32px;\r\n}\r\n.modal .title {\r\n  font-weight: 600;\r\n}\r\n.modal .close {\r\n  border: 0;\r\n  background: transparent;\r\n  cursor: pointer;\r\n  font-size: 18px;\r\n}\r\n\r\n.modal #msgBanner {\r\n  margin-top: 4px;\r\n  padding-left: 0.5rem;\r\n  border-left: 4px solid orange;\r\n}\r\n\r\n.modal #msgBanner.success {\r\n  border-left: 4px solid green;\r\n}\r\n\r\n.modal #msgBanner.warn {\r\n  border-left: 4px solid red;\r\n}\r\n.modal #msgBanner p {\r\n  color: black;\r\n  margin-bottom: 0;\r\n}\r\n\r\n#taxonomyModalBody {\r\n  overflow: hidden;\r\n  flex-grow: 1;\r\n  min-height: 0;\r\n  max-height: 100%;\r\n  width: 100%;\r\n  display: flex;\r\n  flex-direction: row;\r\n  gap: 0.5rem;\r\n}\r\n\r\n#taxonomyModalBody #taxonomySelection {\r\n  overflow: hidden;\r\n  flex-grow: 1;\r\n}\r\n#dataSetSelection {\r\n  height: auto;\r\n}\r\n\r\n#taxonomyModalBody #available-selected section {\r\n  width: 100%;\r\n  height: 100%;\r\n  display: grid;\r\n  grid-template-rows: auto auto 1fr; /* title | search/intro | scroll area */\r\n  min-height: 0;\r\n}\r\n#taxonomyModalBody #available-selected section#user-files-section {\r\n  display: grid;\r\n  grid-template-rows: auto 1fr auto; /* title | search/intro | scroll area */\r\n  min-height: 0;\r\n}\r\n\r\nsection#user-files-section div#user-files {\r\n  margin: 8px 0 8px 3px;\r\n}\r\n\r\n#taxonomyModalBody #available-selected {\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: start;\r\n  justify-content: space-between;\r\n  height: 100%;\r\n  column-gap: 1rem;\r\n  border-bottom: 1px solid #e3e6ea;\r\n}\r\n#taxonomyModalBody section:first-of-type {\r\n  border-right: 1px solid #e3e6ea;\r\n}\r\n#taxonomyModalBody #userDataLoading {\r\n  display: flex;\r\n  flex-direction: column;\r\n  height: 100%;\r\n  border-bottom: 1px solid #e3e6ea;\r\n}\r\n#taxonomyModalBody section h2 {\r\n  font-size: 1.1rem;\r\n  font-weight: 500;\r\n}\r\n#available-header {\r\n  margin-left: var(--search-shadow-px);\r\n}\r\n\r\n#modal-search-box {\r\n  margin-left: var(--search-shadow-px);\r\n}\r\n\r\n#taxonomy-search {\r\n  width: 75%;\r\n  flex: 1 1 auto;\r\n  min-width: 0;\r\n  padding: 6px 8px;\r\n  border: 1px solid #d8dde6;\r\n  border-radius: 6px;\r\n}\r\n\r\n#taxonomy-search:focus {\r\n  outline: none;\r\n  border-color: #9bb4ff;\r\n  box-shadow: var(--search-shadow);\r\n}\r\n\r\n#taxonomy-search-clear {\r\n  flex: 0 0 auto;\r\n  border: none;\r\n  background: #f0f2f6;\r\n  padding: 6px 10px;\r\n  border-radius: 6px;\r\n  cursor: pointer;\r\n}\r\n\r\n#taxonomy-search-clear:hover {\r\n  background: var(--color-white-btn-hover);\r\n}\r\n\r\n#available-taxonomy-tree {\r\n  margin-left: var(--search-shadow-px);\r\n  overflow: auto;\r\n  min-height: 0;\r\n  max-height: 100%;\r\n}\r\n.modal div.footer {\r\n  margin: 0 var(--search-shadow-px);\r\n  display: flex;\r\n  height: auto;\r\n  justify-content: space-between;\r\n}\r\n\r\n#footer-buttons {\r\n  display: flex;\r\n  height: min-content;\r\n  justify-content: end;\r\n  gap: 8px;\r\n}\r\n\r\n#data-guarantee {\r\n  font-size: 0.8rem;\r\n}\r\n\r\n#clearBtn,\r\n#loadBtn,\r\n.close {\r\n  font: inherit;\r\n  line-height: 1;\r\n  padding: 8px 12px;\r\n  border-radius: 8px;\r\n}\r\n#clearBtn {\r\n  border: 1px solid #ced4da;\r\n  background: #fff;\r\n}\r\n#loadBtn {\r\n  border: 1px solid #1f1f1f;\r\n  background: #1f1f1f;\r\n  color: #fff;\r\n  pointer-events: auto;\r\n  filter: brightness(1);\r\n}\r\n#loadBtn.disabled {\r\n  filter: brightness(0.7);\r\n  pointer-events: none;\r\n}\r\n#loadBtn.disabled:hover {\r\n  filter: brightness(1);\r\n}\r\n#loadBtn:hover {\r\n  filter: brightness(1.1);\r\n}\r\n#clearBtn:hover {\r\n  background: var(--color-white-btn-hover);\r\n}\r\n\r\n.list-tree,\r\n.list-tree ul {\r\n  list-style: none;\r\n  margin: 0;\r\n  padding: 0;\r\n}\r\n\r\n.list-tree summary::marker,\r\n.list-tree summary::-webkit-details-marker {\r\n  display: none;\r\n}\r\n\r\n.list-tree details > summary {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 0.5rem;\r\n  cursor: pointer;\r\n  line-height: 1.25;\r\n  padding: 4px 2px;\r\n}\r\n\r\n.list-tree summary .tree-chevron {\r\n  width: 8px;\r\n  height: 8px;\r\n  flex: 0 0 8px;\r\n  display: inline-block;\r\n  transform: rotate(0deg); /* open: point down */\r\n  position: relative;\r\n  transition: transform 0.15s ease;\r\n}\r\n.list-tree details[open] > summary .tree-chevron {\r\n  transform: rotate(90deg); /* closed: point to the right */\r\n}\r\n/* draw the chevron shape using borders */\r\n.list-tree summary .tree-chevron::before {\r\n  content: \"\";\r\n  position: absolute;\r\n  inset: 0;\r\n  border-right: 2px solid currentColor;\r\n  border-bottom: 2px solid currentColor;\r\n  transform: rotate(-45deg) translateY(-1px);\r\n  transform-origin: center;\r\n}\r\n\r\n.list-tree > li > details > ul {\r\n  /* level 1 children (genus under family) */\r\n  margin-top: 4px;\r\n  margin-left: 6px;\r\n  padding-left: 1.5rem;\r\n  border-left: 1px solid #e6e9ee;\r\n}\r\n.list-tree > li > details > ul > li > details > ul {\r\n  /* level 2 children (species under genus) */\r\n  margin-top: 2px;\r\n  margin-left: 6px;\r\n\r\n  padding-left: 2.25rem;\r\n  border-left: 1px solid #eef1f5;\r\n}\r\n\r\n.list-tree li.leaf > div {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 0.5rem;\r\n  padding: 4px 2px;\r\n}\r\n\r\n.list-tree input.taxon-checkbox {\r\n  margin: 0;\r\n}\r\n\r\n#sidebar {\r\n  background-color: var(--color-menu-bg);\r\n  box-shadow: 0 0 10px -3px rgba(0, 0, 0, 0.4);\r\n  clip-path: inset(0 -15px 0 0);\r\n}\r\n#menu,\r\n#charts {\r\n  position: absolute;\r\n  transition:\r\n    top 0.3s ease,\r\n    height 0.3s ease;\r\n  overflow: hidden;\r\n  top: 0;\r\n}\r\n\r\n#menu {\r\n  height: 100%;\r\n}\r\n\r\n#menu.menu-container {\r\n  pointer-events: none;\r\n}\r\n\r\n#sidebar-menu-group {\r\n  position: relative;\r\n  right: 238px;\r\n  transition: right 0.4s ease;\r\n  pointer-events: auto;\r\n}\r\n#sidebar-menu-group.open {\r\n  position: relative;\r\n  right: 0px;\r\n}\r\n\r\n#sidebar-menu-control-group {\r\n  position: relative;\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: space-between;\r\n  align-items: center;\r\n  column-gap: 0.4rem;\r\n  margin: 0;\r\n  padding: 0;\r\n}\r\n\r\n#charts {\r\n  --charts-expanded-height: 90%;\r\n  position: absolute;\r\n  z-index: 2;\r\n  right: 10px;\r\n  top: 10px;\r\n  height: var(--charts-expanded-height);\r\n  width: calc(var(--charts-expanded-height) * 0.8);\r\n  transition:\r\n    width 0.4s,\r\n    height 0.4s 0.4s;\r\n  max-width: 900px;\r\n  overflow: visible;\r\n}\r\n\r\n#charts.collapsed {\r\n  transition:\r\n    height 0.4s,\r\n    width 0.4s 0.4s;\r\n  height: calc(50px - 0.5rem) !important;\r\n  width: 180px !important;\r\n}\r\n\r\n#charts.maximized {\r\n  position: absolute; /* stay within the map area */\r\n  z-index: 100;\r\n  margin: 0;\r\n  max-width: none;\r\n  max-height: none;\r\n  overflow: hidden;\r\n}\r\n\r\n#charts.maximized .chartSection {\r\n  height: 100%;\r\n  overflow-x: auto;\r\n}\r\n\r\n.chartSection canvas {\r\n  width: 100%;\r\n  height: 100%;\r\n  display: block;\r\n  overflow-x: hidden !important;\r\n}\r\n\r\n#charts .menu-box {\r\n  display: grid;\r\n  grid-template-rows: auto 1fr;\r\n  position: relative;\r\n  margin-left: auto;\r\n  padding: 0.5rem 1rem 1rem 1rem;\r\n  width: 100%;\r\n  height: 100%;\r\n  max-width: none;\r\n}\r\n\r\n#charts-header-btns {\r\n  display: flex;\r\n  flex-direction: row;\r\n  gap: 0.3rem;\r\n  align-items: center;\r\n  justify-content: end;\r\n  width: min-content;\r\n}\r\n\r\nbutton#charts-menu-chevron {\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n}\r\n#charts #charts-menu-chevron svg {\r\n  margin: auto;\r\n  transition: transform 0.4s ease;\r\n  transform: scaleY(-1);\r\n}\r\n\r\n#charts.collapsed #charts-menu-chevron svg {\r\n  transform: scaleY(1);\r\n}\r\n\r\n#chart-settings-btn {\r\n  display: flex;\r\n  border: none !important;\r\n}\r\n\r\n#chart-settings-btn svg {\r\n  transition: transform 0.4s ease;\r\n  transform: rotate(0deg);\r\n}\r\n#chart-settings-btn.rotate svg {\r\n  transform: rotate(90deg);\r\n}\r\n\r\n#chart-settings-dropdown {\r\n  position: absolute;\r\n  background-color: var(--color-chart-settings-bg);\r\n  color: var(--color-chart-settings-text);\r\n  border: 1px var(--color-header-border) solid;\r\n  bottom: 50px;\r\n  left: 20px;\r\n  max-width: 300px;\r\n  max-height: calc(100% - 100px);\r\n  padding: 0.5rem 1rem;\r\n  z-index: 5;\r\n  overflow-y: auto;\r\n  overflow-x: hidden;\r\n\r\n  opacity: 0;\r\n  pointer-events: none;\r\n  transition: opacity 0.2s ease;\r\n}\r\n\r\n#chart-settings-dropdown.open {\r\n  opacity: 1;\r\n  pointer-events: auto;\r\n}\r\n\r\n#charts,\r\n#charts * {\r\n  box-sizing: border-box;\r\n}\r\n\r\n#chartContent,\r\n#chart_and_toolbar,\r\n#charts-body {\r\n  flex: 1 1 auto;\r\n  min-height: 0;\r\n}\r\n\r\n#chartContent {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  overflow: hidden;\r\n  height: 100%;\r\n}\r\n\r\n#chart_and_toolbar {\r\n  display: flex;\r\n  flex-direction: column;\r\n  width: 100%;\r\n  height: auto;\r\n  flex-grow: 1;\r\n}\r\n#charts.maximized #charts-body {\r\n  overflow-x: auto;\r\n}\r\n#charts-toolbar {\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: space-between;\r\n  align-items: center;\r\n  width: 100%;\r\n  flex-shrink: 1;\r\n}\r\n#toolbar-buttons {\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: start;\r\n  align-items: center;\r\n  gap: 0.3rem;\r\n  width: fit-content;\r\n}\r\n.toolbar-sub-group {\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: center;\r\n  gap: 0.2rem;\r\n  padding: 0.2rem 0.5rem;\r\n  border-right: 1px solid #d0d0d0;\r\n}\r\n.toolbar-sub-group span {\r\n  font-size: 0.9rem;\r\n  font-weight: 600;\r\n  margin-right: 0.2rem;\r\n}\r\n.toolbar-sub-group:last-of-type {\r\n  border: none;\r\n}\r\n#toolbar-hint {\r\n  display: none !important;\r\n  font-size: 0.8em;\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: end;\r\n  align-items: center;\r\n}\r\n.chart-toolbar-btn {\r\n  background-color: inherit;\r\n  border: none;\r\n  padding: 0;\r\n  margin: 0;\r\n}\r\n.chart-toolbar-btn.active-chart-type {\r\n  background-color: rgba(0, 0, 0, 0.1);\r\n  font-weight: 600;\r\n}\r\n#chart-type-selector {\r\n  display: flex;\r\n  flex-direction: row;\r\n  gap: 0.5rem;\r\n  align-items: center;\r\n  justify-content: center;\r\n  flex: 1;\r\n}\r\n.chart-type-selector-group {\r\n  display: flex;\r\n  flex-direction: row;\r\n  gap: 0.25rem;\r\n}\r\n#chart-type-selector .chart-toolbar-btn {\r\n  padding: 0.1rem 0.5rem;\r\n  border-radius: 4px;\r\n  cursor: pointer;\r\n  transition: background-color 0.2s;\r\n}\r\n#chart-type-selector .chart-toolbar-btn:hover:not(:disabled) {\r\n  background-color: rgba(0, 0, 0, 0.05);\r\n}\r\n#chart-type-selector .chart-toolbar-btn:disabled {\r\n  cursor: default;\r\n  opacity: 0.6;\r\n}\r\n#chart-type-selector .chart-toolbar-btn.single-option {\r\n  cursor: default;\r\n}\r\n\r\n/* Dimension Selectors */\r\n#dimension-selectors {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 0.4rem;\r\n}\r\n#primary-dim-selector,\r\n#secondary-dim-selector {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 0.4rem;\r\n}\r\n.secondary-dim-label {\r\n  font-size: 0.85rem;\r\n  color: #555;\r\n  font-style: italic;\r\n}\r\n.dimension-select {\r\n  padding: 0.3rem 0.5rem;\r\n  border: 1px solid #ccc;\r\n  border-radius: 4px;\r\n  font-size: 0.85rem;\r\n  background: white;\r\n  cursor: pointer;\r\n  min-width: 100px;\r\n}\r\n.dimension-select:hover:not(:disabled) {\r\n  border-color: #999;\r\n}\r\n.dimension-select:focus {\r\n  outline: none;\r\n  border-color: #4682b4;\r\n  box-shadow: 0 0 0 2px rgba(70, 130, 180, 0.2);\r\n}\r\n.dimension-select:disabled {\r\n  background-color: #f5f5f5;\r\n  color: #888;\r\n  cursor: not-allowed;\r\n}\r\n\r\n#charts-body .chartSection {\r\n  padding: 0;\r\n  height: 100%;\r\n}\r\n\r\n#charts-body .chartSection > canvas {\r\n  display: block;\r\n  height: 100% !important;\r\n  width: 100% !important;\r\n}\r\n\r\n#charts-body .chartSection.active-chart {\r\n  display: block !important;\r\n}\r\n/* Legacy selector styles - can be removed if tabs fully deprecated */\r\n#charts-selector {\r\n  display: none;\r\n  flex-direction: row;\r\n  align-self: start;\r\n  justify-content: start;\r\n  align-items: center;\r\n  flex-wrap: wrap;\r\n  column-gap: 0.15rem;\r\n  row-gap: 0.15rem;\r\n  width: 80%;\r\n  margin-bottom: 0.5rem;\r\n  margin-top: 0.5rem;\r\n  height: auto;\r\n}\r\n#charts-selector button {\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n  font-size: 1rem;\r\n  color: white;\r\n  text-wrap: no-wrap;\r\n  padding: 0.2rem 0.5rem;\r\n  border-width: 0px !important;\r\n  border-radius: 0.375rem;\r\n  margin: 4px; /*this needs to be the same as the active border width*/\r\n}\r\n#charts-selector button h3 {\r\n  margin: auto;\r\n  font-weight: 400;\r\n  font-size: 0.9rem;\r\n}\r\n#charts-selector .active-chart {\r\n  opacity: 100%;\r\n  border-width: 4px !important;\r\n  margin: 0;\r\n}\r\n#chart-options-header {\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: space-between;\r\n  align-items: center;\r\n}\r\n#chart-options-header h2 {\r\n  font-size: 1.2rem;\r\n  margin-bottom: 0;\r\n}\r\n#chart-options-header button {\r\n  border: 0;\r\n  background: transparent;\r\n  cursor: pointer;\r\n  font-size: 18px;\r\n}\r\nsection#chart-options {\r\n  display: flex;\r\n  flex-direction: column;\r\n  max-width: 100%;\r\n  margin-top: auto;\r\n  margin-bottom: 0.25rem;\r\n  margin-right: 0.75rem;\r\n\r\n  padding-top: 0.2rem;\r\n  justify-content: flex-start;\r\n  align-self: flex-end;\r\n  flex-grow: 1;\r\n  gap: 1.5rem;\r\n  overflow-y: auto;\r\n  overflow-x: hidden;\r\n}\r\nsection#chart-options div.chart-options-group {\r\n  max-width: 100%;\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n}\r\nsection#chart-options div.chart-options-group h3 {\r\n  width: 100%;\r\n  font-size: 1rem;\r\n  margin: 0.1rem;\r\n}\r\nsection#chart-options div.chart-options-group p {\r\n  margin-bottom: 0.25em;\r\n  font-size: 0.75em;\r\n}\r\nsection#chart-options div.chart-options-group div {\r\n  column-gap: 0.75rem;\r\n  max-width: 100%;\r\n}\r\nsection#chart-options div.chart-options-group div input {\r\n  max-width: 100%;\r\n  margin-left: 0;\r\n}\r\nsection#chart-options div.chart-options-group div label {\r\n  margin-left: 0.1rem;\r\n  font-size: 0.9em;\r\n}\r\nsection#chart-options .chart-options-subheading {\r\n  width: 100%;\r\n  font-size: 0.8rem;\r\n  font-weight: 600;\r\n  color: #666;\r\n  text-transform: uppercase;\r\n  letter-spacing: 0.05em;\r\n  margin-top: 0.5rem;\r\n  padding-top: 0.5rem;\r\n  border-top: 1px solid #e0e0e0;\r\n}\r\n\r\n.menu-box .form-check {\r\n  margin-left: 0;\r\n  width: 100%;\r\n  align-items: start;\r\n  gap: 0.25rem;\r\n  min-width: 0;\r\n  box-sizing: border-box;\r\n  padding-right: 0;\r\n}\r\n\r\n.menu-box {\r\n  height: 100%;\r\n  padding-bottom: 0;\r\n  padding-top: 0;\r\n  background-color: var(--color-menu-bg);\r\n  max-width: 290px;\r\n  overflow: hidden;\r\n}\r\n\r\n.menu-section {\r\n  overflow: hidden;\r\n}\r\n\r\n.menu-section > div.form-check:first-of-type {\r\n  margin-top: 1rem;\r\n}\r\n\r\n.menu-box label {\r\n  font-weight: 400;\r\n  margin-left: 0.3rem;\r\n}\r\n\r\n.menu-box .form-check-label {\r\n  flex: 1;\r\n  min-width: 0;\r\n  word-break: break-word;\r\n  overflow-wrap: break-word;\r\n}\r\n\r\n.filter-option-count {\r\n  margin-left: auto;\r\n  flex-shrink: 0;\r\n  font-size: 0.8rem;\r\n  color: #6c757d;\r\n  font-variant-numeric: tabular-nums;\r\n  white-space: nowrap;\r\n  display: none;\r\n}\r\n\r\n.menu-box select {\r\n  border-radius: 0.5rem;\r\n}\r\n\r\n#menu-header {\r\n  width: 100%;\r\n}\r\n\r\n#filter-menu-container {\r\n  display: flex;\r\n  gap: 0.5rem;\r\n  flex-direction: column;\r\n  padding: 16px;\r\n}\r\n\r\n.shadow-normal {\r\n  box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.15);\r\n}\r\n\r\n.menu-title {\r\n  font-size: 1.1rem;\r\n  font-weight: 400;\r\n  white-space: nowrap;\r\n  overflow: hidden;\r\n  max-width: 100%;\r\n}\r\n.menu-title h1 {\r\n  text-overflow: ellipsis;\r\n}\r\n\r\n.menu-content {\r\n  height: 100%;\r\n  visibility: visible;\r\n  display: flex;\r\n  flex-direction: column;\r\n  row-gap: 0.4rem;\r\n  margin-bottom: 0.4rem;\r\n  transition: ease 0.3s width;\r\n}\r\n\r\n.menu-content.scroll-container {\r\n  max-height: 700px;\r\n  overflow-y: scroll;\r\n  margin-right: -1rem; /*Subtract width of padding for scroll gutter*/\r\n}\r\n\r\n.filter-menu-btn,\r\n.menu-section {\r\n  border: 1px solid #dee2e6;\r\n  background-color: var(--color-filter-menu-section-bg);\r\n  width: 100%;\r\n}\r\n.filter-menu-btn {\r\n  text-align: center;\r\n  border-radius: 0.375rem;\r\n}\r\n\r\n.filter-menu-btn:hover {\r\n  filter: brightness(0.75);\r\n}\r\n\r\n.menu-section {\r\n  display: flex;\r\n  flex-direction: column;\r\n  padding-left: 1rem;\r\n  padding-right: 1rem;\r\n  padding-bottom: 0rem;\r\n  height: 44px;\r\n  min-height: 44px;\r\n  overflow-x: hidden;\r\n  transition:\r\n    flex-grow 0.4s ease,\r\n    min-height 0.4s ease;\r\n  flex-grow: 0;\r\n}\r\n\r\n.menu-section.menu-opened {\r\n  flex-grow: 1;\r\n  min-height: 200px;\r\n}\r\n.menu-content.scroll-container .menu-section.menu-opened:not(#date-section) {\r\n  min-height: 400px;\r\n}\r\n\r\n.date-text-input.invalid-date {\r\n  border-color: #dc3545;\r\n  outline-color: #dc3545;\r\n}\r\n\r\n#date-widget {\r\n  display: grid;\r\n  max-width: 100%;\r\n  grid-template-columns: 12px auto;\r\n  grid-template-rows: auto 0.5fr 0.5fr auto auto 0.5fr 0.5fr auto;\r\n  column-gap: 0.4rem;\r\n}\r\n#date-widget label {\r\n  margin: 0;\r\n  width: 100%;\r\n  grid-column: 2/3;\r\n}\r\n#date-widget label#dw-start-label {\r\n  grid-row: 1/2;\r\n}\r\n#date-widget label#dw-end-label {\r\n  grid-row: 5/6;\r\n}\r\n\r\n#date-widget svg {\r\n  width: 100%;\r\n  grid-column: 1/2;\r\n  margin: auto;\r\n}\r\n#date-widget svg#dw-start-circle {\r\n  grid-row: 2/4;\r\n}\r\n#date-widget svg#dw-end-circle {\r\n  grid-row: 6/8;\r\n}\r\n\r\n#date-widget div#dw-bar {\r\n  grid-column: 1/2;\r\n  grid-row: 3/7;\r\n  width: 4px;\r\n  margin-left: auto;\r\n  margin-right: auto;\r\n}\r\n\r\n#date-widget input {\r\n  width: 100%;\r\n  grid-column: 2/3;\r\n}\r\n#date-widget input#dw-start-date-input {\r\n  grid-row: 2/4;\r\n}\r\n#date-widget input#dw-end-date-input {\r\n  grid-row: 6/8;\r\n}\r\n\r\n#date-widget p {\r\n  margin: 0;\r\n  font-size: 0.6rem;\r\n  width: 100%;\r\n  grid-column: 2/3;\r\n}\r\n#date-widget p#dw-start-hint {\r\n  grid-row: 4/5;\r\n}\r\n#date-widget p#dw-end-hint {\r\n  grid-row: 8/9;\r\n}\r\n\r\ninput.form-check-input {\r\n  min-width: 16px;\r\n  height: 16px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.clear-btn {\r\n  font-weight: 500;\r\n  margin-top: auto;\r\n  padding: 0.5rem 1rem;\r\n}\r\n\r\n.menu-section-header .menu-section-header-left {\r\n  display: flex;\r\n  flex-direction: row;\r\n  gap: 0.3rem;\r\n  align-items: center;\r\n}\r\n.menu-section-header div h3 {\r\n  font-weight: 600;\r\n  font-size: 0.9rem;\r\n  padding: 0;\r\n  margin: 0;\r\n}\r\n\r\n.menu-section-search {\r\n  width: 100%;\r\n  padding: 6px 8px;\r\n  border: 1px solid #d8dde6;\r\n  border-radius: 6px;\r\n  font-size: inherit;\r\n  font-family: inherit;\r\n}\r\n\r\n.menu-section-search:focus {\r\n  outline: none;\r\n  border-color: #9bb4ff;\r\n  box-shadow: var(--search-shadow);\r\n}\r\n\r\n#app-surface {\r\n  overflow: hidden;\r\n}\r\n\r\nsection#header-area {\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: space-between;\r\n  align-items: center;\r\n  width: 100%;\r\n  padding: 0.2rem 1rem 0.3rem 1rem;\r\n  box-shadow: 0 0.1rem 0.4rem rgba(0, 0, 0, 0.15);\r\n  z-index: 5;\r\n  flex-shrink: 0;\r\n  background-color: var(--color-menu-bg);\r\n}\r\n\r\nsection#map-area {\r\n  flex: 1 1 0;\r\n  min-height: 0;\r\n  overflow: hidden;\r\n}\r\n#header-area svg {\r\n  max-height: 20px;\r\n}\r\n#taxonomy-selector-header-group {\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: baseline;\r\n}\r\n#taxonomy-selector-header-group span {\r\n  display: inline-block;\r\n  height: 100%;\r\n}\r\n.logo {\r\n  height: 100%;\r\n  margin: auto;\r\n}\r\n#taxonomy-selector-header-group h1 {\r\n  margin-right: 2rem;\r\n}\r\np#taxonomy-hint {\r\n  font-size: 0.8rem;\r\n  margin: 0;\r\n}\r\n\r\n#taxonomy-hint-group {\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: center;\r\n  align-items: center;\r\n  gap: 0.2rem;\r\n}\r\n\r\n.header-btn {\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n  border: none;\r\n  padding: 0 2px;\r\n  margin: auto;\r\n  background-color: inherit !important;\r\n}\r\n.header-btn:hover {\r\n  cursor: pointer;\r\n  background-color: inherit;\r\n}\r\n\r\n#header-additional-btns {\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n  gap: 0.2rem;\r\n}\r\n\r\na#download-data-btn {\r\n  width: auto;\r\n}\r\n\r\n.scroll-container {\r\n  overflow: auto;\r\n}\r\n.scroll-container::-webkit-scrollbar-thumb {\r\n  min-height: 30px;\r\n  background-color: var(--color-scroll-thumb-fill);\r\n  border: 10px solid transparent;\r\n  border-radius: 0.9rem;\r\n  background-clip: padding-box;\r\n}\r\n\r\n.scroll-container::-webkit-scrollbar {\r\n  width: 24px;\r\n}\r\n\r\n.menu-sub-section {\r\n  flex: 1 1 0%;\r\n}\r\n\r\n.menu-content.scroll-container .menu-sub-section {\r\n  scrollbar-gutter: stable;\r\n}\r\n\r\n#taxon-dropdown {\r\n  margin: 0.5rem;\r\n  background-color: var(--color-menu-bg);\r\n  padding: 0.5rem;\r\n  transition: ease 0.4s height;\r\n}\r\n#taxon-dropdown #taxon-header {\r\n  display: flex;\r\n  flex-direction: row;\r\n  justify-content: space-between;\r\n}\r\n\r\n#taxon-dropdown #taxon-tree {\r\n  margin-top: 0.5rem;\r\n}\r\n\r\n.chevron {\r\n  width: 1.2em;\r\n  transition: transform 0.4s ease;\r\n}\r\n\r\n.chevron-button {\r\n  background-color: rgba(0, 0, 0, 0);\r\n  border: none;\r\n  cursor: pointer;\r\n}\r\n\r\n.flip .chevron {\r\n  transform: scaleY(-1);\r\n}\r\n\r\n.sidebar-btn {\r\n  border: none;\r\n  background-color: inherit;\r\n  padding: 0;\r\n  display: flex;\r\n  align-items: center;\r\n}\r\n\r\ndiv#chartjs-tooltip {\r\n  z-index: 4;\r\n  background-color: var(--color-menu-bg);\r\n  box-shadow: 0 0 10px -3px rgba(0, 0, 0, 0.4);\r\n  padding: 0.7rem 1rem;\r\n  font-weight: 400;\r\n}\r\n\r\n.chart-js-tooltip-tr {\r\n  padding: 0;\r\n}\r\n\r\ndiv#chartjs-tooltip td {\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: center;\r\n}\r\n\r\nspan.tooltip-bullet {\r\n  padding-right: 0.5rem;\r\n  font-size: 1.7rem;\r\n}\r\n\r\nsvg line {\r\n  stroke: black;\r\n  stroke-width: 3;\r\n  transition: all 0.4s ease;\r\n  transform-origin: center center;\r\n  transform-box: view-box;\r\n}\r\n\r\n.filter-active > .icon .middle {\r\n  opacity: 0;\r\n}\r\n\r\n.icon {\r\n  display: flex;\r\n  align-items: center;\r\n  margin: auto;\r\n}\r\n\r\n.filter-counter {\r\n  width: 20px;\r\n  height: 20px;\r\n  border-radius: 10px;\r\n  display: flex;\r\n  justify-content: center;\r\n  align-items: center;\r\n  color: white;\r\n  font-weight: 500;\r\n  text-align: center;\r\n  z-index: 5;\r\n}\r\n.filter-counter.hide {\r\n  display: none;\r\n}\r\n#total-filter-count {\r\n  background-color: black;\r\n\r\n  position: absolute;\r\n  top: 9px;\r\n  right: 5px;\r\n}\r\n\r\n.section-filter-count {\r\n  height: 1.3rem;\r\n  width: 1.3rem;\r\n}\r\n\r\n[data-tooltip] {\r\n  anchor-name: --btn-anchor;\r\n}\r\n.mgo-tooltip[popover] {\r\n  border: none;\r\n  padding: 6px 8px;\r\n  background: #fff;\r\n  color: #000;\r\n  border: 1px solid grey;\r\n  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);\r\n  font:\r\n    12px/1.25 system-ui,\r\n    sans-serif;\r\n  pointer-events: none;\r\n  margin: 0;\r\n}\r\n\r\n.mgo-tooltip {\r\n  position: absolute;\r\n  inset: auto;\r\n  left: anchor(center);\r\n  top: calc(anchor(bottom) + 4px);\r\n  transform: translateX(-50%);\r\n}\r\n\r\n.mgo-tooltip[data-placement=\"top\"] {\r\n  left: anchor(center);\r\n  top: anchor(top);\r\n  transform: translate(-50%, calc(-100% - 8px));\r\n}\r\n.mgo-tooltip[data-placement=\"left\"] {\r\n  left: calc(anchor(left) - 4px);\r\n  top: anchor(center);\r\n  transform: translate(-100%, -50%);\r\n}\r\n.mgo-tooltip[data-placement=\"right\"] {\r\n  left: calc(anchor(right) + 4px);\r\n  top: anchor(center);\r\n  transform: translate(0, -50%);\r\n}\r\n";

var bootstrapStyles = "/*\r\n * Minimal Bootstrap 5.3.0 extract\r\n * Only includes the utility classes used by AMR GeoMapper.\r\n * Source: https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css\r\n */\r\n\r\n:host {\r\n  box-sizing: border-box;\r\n  font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\",\r\n    \"Noto Sans\", \"Liberation Sans\", Arial, sans-serif, \"Apple Color Emoji\",\r\n    \"Segoe UI Emoji\", \"Segoe UI Symbol\", \"Noto Color Emoji\";\r\n  line-height: 1.5;\r\n}\r\n\r\n*,\r\n*::before,\r\n*::after {\r\n  box-sizing: border-box;\r\n}\r\n\r\n/* Reboot — margin/font normalization from Bootstrap 5.3.0 */\r\nh1, h2, h3, h4, h5, h6 {\r\n  margin-top: 0;\r\n  margin-bottom: 0.5rem;\r\n  font-weight: 500;\r\n  line-height: 1.2;\r\n}\r\np {\r\n  margin-top: 0;\r\n  margin-bottom: 1rem;\r\n}\r\nlabel {\r\n  display: inline-block;\r\n}\r\n\r\n/* Display */\r\n.d-flex {\r\n  display: flex !important;\r\n}\r\n\r\n/* Flex direction */\r\n.flex-row {\r\n  flex-direction: row !important;\r\n}\r\n.flex-column {\r\n  flex-direction: column !important;\r\n}\r\n.flex-wrap {\r\n  flex-wrap: wrap !important;\r\n}\r\n\r\n/* Justify content */\r\n.justify-content-start {\r\n  justify-content: flex-start !important;\r\n}\r\n.justify-content-center {\r\n  justify-content: center !important;\r\n}\r\n.justify-content-between {\r\n  justify-content: space-between !important;\r\n}\r\n\r\n/* Align items */\r\n.align-items-center {\r\n  align-items: center !important;\r\n}\r\n\r\n/* Position */\r\n.position-relative {\r\n  position: relative !important;\r\n}\r\n\r\n/* Sizing */\r\n.w-100 {\r\n  width: 100% !important;\r\n}\r\n.h-100 {\r\n  height: 100% !important;\r\n}\r\n\r\n/* Margins */\r\n.mb-0 {\r\n  margin-bottom: 0 !important;\r\n}\r\n.mb-2 {\r\n  margin-bottom: 0.5rem !important;\r\n}\r\n.mb-3 {\r\n  margin-bottom: 1rem !important;\r\n}\r\n.me-2 {\r\n  margin-inline-end: 0.5rem !important;\r\n}\r\n.mt-2 {\r\n  margin-top: 0.5rem !important;\r\n}\r\n\r\n/* Padding */\r\n.p-0 {\r\n  padding: 0 !important;\r\n}\r\n\r\n/* Form check */\r\n.form-check {\r\n  display: block;\r\n  min-height: 1.5rem;\r\n  padding-left: 1.5em;\r\n  margin-bottom: 0.125rem;\r\n}\r\n.form-check-input {\r\n  --bs-form-check-bg: #fff;\r\n  flex-shrink: 0;\r\n  width: 1em;\r\n  height: 1em;\r\n  margin-top: 0.25em;\r\n  vertical-align: top;\r\n  appearance: auto;\r\n  background-color: var(--bs-form-check-bg);\r\n  background-image: var(--bs-form-check-bg-image);\r\n  background-repeat: no-repeat;\r\n  background-position: center;\r\n  background-size: contain;\r\n  border: 1px solid rgba(0, 0, 0, 0.25);\r\n  border-radius: 0.25em;\r\n}\r\n.form-check-input[type=\"checkbox\"] {\r\n  border-radius: 0.25em;\r\n}\r\n.form-check-input[type=\"radio\"] {\r\n  border-radius: 50%;\r\n}\r\n.form-check-input:checked {\r\n  background-color: #0d6efd;\r\n  border-color: #0d6efd;\r\n}\r\n.form-check-input:focus {\r\n  border-color: #86b7fe;\r\n  outline: 0;\r\n  box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25);\r\n}\r\n.form-check-label {\r\n  cursor: pointer;\r\n}\r\n\r\n/* Form control */\r\n.form-control {\r\n  display: block;\r\n  width: 100%;\r\n  padding: 0.375rem 0.75rem;\r\n  font-size: 1rem;\r\n  font-weight: 400;\r\n  line-height: 1.5;\r\n  color: #212529;\r\n  appearance: none;\r\n  background-color: #fff;\r\n  background-clip: padding-box;\r\n  border: 1px solid #dee2e6;\r\n  border-radius: 0.375rem;\r\n  transition: border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;\r\n}\r\n.form-control:focus {\r\n  color: #212529;\r\n  background-color: #fff;\r\n  border-color: #86b7fe;\r\n  outline: 0;\r\n  box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25);\r\n}\r\n.form-control::placeholder {\r\n  color: #6c757d;\r\n  opacity: 1;\r\n}\r\n\r\n/* Text */\r\n.text-break {\r\n  word-wrap: break-word !important;\r\n  word-break: break-word !important;\r\n}\r\n\r\n/* Visibility */\r\n.invisible {\r\n  visibility: hidden !important;\r\n}\r\n\r\n/* Shadow */\r\n.shadow {\r\n  box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.15) !important;\r\n}\r\n\r\n/* Z-index */\r\n.z-2 {\r\n  z-index: 2 !important;\r\n}\r\n.z-3 {\r\n  z-index: 3 !important;\r\n}\r\n\r\n/* Button */\r\n.btn {\r\n  --bs-btn-padding-x: 0.75rem;\r\n  --bs-btn-padding-y: 0.375rem;\r\n  --bs-btn-font-size: 1rem;\r\n  --bs-btn-font-weight: 400;\r\n  --bs-btn-line-height: 1.5;\r\n  --bs-btn-border-width: 1px;\r\n  --bs-btn-border-radius: 0.375rem;\r\n  display: inline-block;\r\n  padding: var(--bs-btn-padding-y) var(--bs-btn-padding-x);\r\n  font-family: var(--bs-btn-font-family);\r\n  font-size: var(--bs-btn-font-size);\r\n  font-weight: var(--bs-btn-font-weight);\r\n  line-height: var(--bs-btn-line-height);\r\n  color: var(--bs-btn-color);\r\n  text-align: center;\r\n  text-decoration: none;\r\n  vertical-align: middle;\r\n  cursor: pointer;\r\n  user-select: none;\r\n  border: var(--bs-btn-border-width) solid var(--bs-btn-border-color);\r\n  border-radius: var(--bs-btn-border-radius);\r\n  background-color: var(--bs-btn-bg);\r\n  transition: color 0.15s ease-in-out, background-color 0.15s ease-in-out,\r\n    border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;\r\n}\r\n\r\n/* Border */\r\n.border {\r\n  border: 1px solid #dee2e6 !important;\r\n}\r\n";

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML insertion
 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes a string for use in HTML attributes.
 * Same as escapeHtml but exported separately for clarity.
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for attribute values
 */
function escapeAttr(str) {
  return escapeHtml(str);
}

class HTMLhelper {
  constructor() {}

  static color = {
    textDefault: "#000",
    menuBG: "#f8f9fa",
    chartSettingsBG: "#fff",
    chartSettingsText: "#000",
    modalBG: "#fff",
    filterMenuSectionBG: "#fff",
    whiteBtnHover: "#f3f4f6",
    scrollThumbFill: "#adb5bd",
    headerBorder: "#929292",
  };

  static styleSheets() {
    return /*html*/ `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&icon_names=vaccines" />
    `;
  }

  static styleTag() {
    return /*html*/ `
      <style>${bootstrapStyles}${mainStyles}</style>
    `;
  }

  static menuHeader(title, id, filterCount = 0) {
    let button;
    let filterCounter;
    const filterIconHeight = 20;
    const safeId = escapeAttr(id);
    if (id === "filter") {
      button = /*html*/ `
      <div id="sidebar-menu-control-group">
        <button id="show-filters-button" class="sidebar-btn" data-placement="right" data-tooltip="Filter menu">
          <div class="icon" id="filterToggle">
          ${HTMLhelper.icons("filter", filterIconHeight)}

          </div>
        </button>
      </div>

      `;
      filterCounter = /*html*/ `
          <div id="total-filter-count" class="filter-counter ${
            filterCount === 0 ? "hide" : ""
          }">
            ${filterCount}
          </div>
        `;
    } else {
      button = /*html*/ `
        <button id="chart-fullscreen-btn" class="chart-toolbar-btn" data-placement="bottom" data-tooltip="Maximize chart to view all data"></button>

        <button id="${safeId}-menu-chevron" class="p-0 chevron-button justify-content-center align-items-center">
          <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f">
            <g transform="rotate(90, 480, -480)">
              <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z"/>
            </g>
          </svg>
        </button>
      `;
    }

    return /*html*/ `
          <div
            id="menu-header"
            class="d-flex flex-row justify-content-between align-items-center"
          >
            <div class="menu-title mb-0"><h2>${escapeHtml(title)}</h2></div>
            <div class="d-flex justify-content-center align-items-center">
              ${filterCounter ? filterCounter : ""}

              
              <div id="charts-header-btns" class="">  
                ${button}
              </div>
            </div>
          </div>
        `;
  }

  static template() {
    const toolbarHintIconSize = 20;
    return /*html*/ `
      ${HTMLhelper.styleSheets()} ${HTMLhelper.styleTag()}
      <div class="h-100 border map-wrap">

        <div class="backdrop" aria-hidden="true"></div>

        <div id="load-animation">
          <div class="loader"></div>
        </div>

        <form id="dataForm" class="" method="POST">
          <div class="modal" aria-hidden="true">
            <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
              <div class="header">
                <div class="title-block">
                  <h1 class="title" id="dlg-title">Genome Selection</h1>
                  <button class="close" type="button" aria-label="Close">✕</button>
                </div>          
                <div id="msgBanner" class="me-2">
                  <p></p>
                </div>
              </div>
              <div id="taxonomyModalBody"></div>
              <div class="footer">
                <div id="" class="taxon-modal-footer-group d-flex align-items-center">
     
                </div>
                <div id="footer-buttons" class="taxon-modal-footer-group">
                  <button type="button" id="clearBtn" data-placement="bottom" data-tooltip="Clear current selection.">Clear All</button>
                  <button type="submit" id="loadBtn">Display Selection</button>
                </div>
              </div>
            </div>
          </div>
        </form>

       
        <div id="app-surface" class="d-flex flex-column w-100 h-100 position-relative">
          <section id="header-area">
            
          </section>
          <section id="map-area" class="position-relative">
            <div id="menu" class="menu-container center z-3"></div>
            <div
              id="charts"
              class="charts-container menu-container collapsed collapsible"
            >
              <div class="menu-box shadow">
                ${HTMLhelper.menuHeader("Charts", "charts")}
                <div id="chartContent" class="">
                  <div id="chart_and_toolbar">
                    <div id="charts-body">${HTMLhelper.chartOptions()}</div>
                    <div id="charts-toolbar">
                      <div id="toolbar-buttons" class="toolbar-group">
                        <div class="toolbar-sub-group">
                          <button
                            id="chart-settings-btn"
                            class="chart-toolbar-btn"
                            data-placement="bottom"
                            data-tooltip="Chart settings"
                          >
                            ${HTMLhelper.icons("settingsCog")}
                          </button>
                          <div id="chart-settings-dropdown" class="shadow-normal"></div>
                          <button
                            id="chart-download-btn"
                            class="chart-toolbar-btn"
                            data-placement="bottom"
                            data-tooltip="Download chart as image"
                          >
                            ${HTMLhelper.icons("download")}
                          </button>
                        </div>
                        <div class="toolbar-sub-group">
                          <div id="chart-type-selector"></div>
                        </div>
                        <div id="dimension-selectors" class="toolbar-sub-group">
                          <div id="primary-dim-selector"></div>
                          <div id="secondary-dim-selector"></div>
                        </div>
                      </div>

                      <div id="toolbar-hint" class="toolbar-group">
                        Click
                        <span style="margin: 0 3px"
                          >${HTMLhelper.icons("maximize", toolbarHintIconSize)}</span
                        >
                        above to view all data.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div id="map" class="w-100"></div>
          </section>

        </div>
      </div>
      ${HTMLhelper.scriptTag()}
      `;
  }
  static scriptTag() {
    return /*html*/ `
        <script
            async
            src="https://cdn.jsdelivr.net/npm/es-module-shims@1/dist/es-module-shims.min.js"
            crossorigin="anonymous"
        ></script>

      `;
  }

  static filterRow(section, value, index, isChecked) {
    const safeSection = escapeAttr(section);
    const safeValue = escapeAttr(value);
    return /*html*/ `
      <div class="form-check d-flex flex-row justify-content-start w-100 text-break">
        <input class="form-check-input" filter-type="${safeSection}" value="${safeValue}"
        type="checkbox" id="${safeSection}-option-${index}" ${
          isChecked ? "checked" : ""
        } />
        <label class="form-check-label ${
          section === "species" ? "italic" : ""
        }" for="${safeSection}-option-${index}">${escapeHtml(value)}</label>
        <span class="filter-option-count" data-count="0">0</span>
      </div>
          `;
  }

  static icons(key, height = 24) {
    switch (key) {
      case "download":
        return /*html*/ `
        <svg
          xmlns="http://www.w3.org/2000/svg"
          height="${height}px"
          viewBox="0 -960 960 960"
          width="${height}px"
          fill="#1f1f1f"
        >
          <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z" />
        </svg>`;

      case "settingsCog":
        return /*html*/ `
          <svg id="chart-settings-svg" style="max-height: 20px;" xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z"/></svg>
        `;

      case "filter":
        return /*html*/ `
          <svg width="${height}px" height="${height}px" viewBox="0 0 40 40">
            <line class="top" x1="0" y1="7" x2="40" y2="7" />
            <line class="middle" x1="8" y1="20" x2="32" y2="20" />
            <line class="bottom" x1="15" y1="33" x2="25  " y2="33" />
          </svg>  
        `;
      case "nofilter":
        return /*html*/ `
<svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M791-55 55-791l57-57 736 736-57 57ZM633-440l-80-80h167v80h-87ZM433-640l-80-80h487v80H433Zm-33 400v-80h160v80H400ZM240-440v-80h166v80H240ZM120-640v-80h86v80h-86Z"/></svg>
        `;
      case "edit":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/></svg>
        `;
      case "share":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M680-80q-50 0-85-35t-35-85q0-6 3-28L282-392q-16 15-37 23.5t-45 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q24 0 45 8.5t37 23.5l281-164q-2-7-2.5-13.5T560-760q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-24 0-45-8.5T598-672L317-508q2 7 2.5 13.5t.5 14.5q0 8-.5 14.5T317-452l281 164q16-15 37-23.5t45-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Zm0-80q17 0 28.5-11.5T720-200q0-17-11.5-28.5T680-240q-17 0-28.5 11.5T640-200q0 17 11.5 28.5T680-160ZM200-440q17 0 28.5-11.5T240-480q0-17-11.5-28.5T200-520q-17 0-28.5 11.5T160-480q0 17 11.5 28.5T200-440Zm480-280q17 0 28.5-11.5T720-760q0-17-11.5-28.5T680-800q-17 0-28.5 11.5T640-760q0 17 11.5 28.5T680-720Zm0 520ZM200-480Zm480-280Z"/></svg>
        `;
      case "info":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M440-280h80v-240h-80v240Zm40-320q17 0 28.5-11.5T520-640q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640q0 17 11.5 28.5T480-600Zm0 520q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>
        `;
      case "maximize":
        return /*html*/ `
          <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z"/></svg>
          `;
      case "minimize":
        return /*html*/ `
          <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M240-120v-120H120v-80h200v200h-80Zm400 0v-200h200v80H720v120h-80ZM120-640v-80h120v-120h80v200H120Zm520 0v-200h80v120h120v80H640Z"/></svg>
        `;
      case "stackedBar":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M160-160v-440h160v440H160Zm0-480v-160h160v160H160Zm240 480v-320h160v320H400Zm0-360v-160h160v160H400Zm240 360v-200h160v200H640Zm0-240v-160h160v160H640Z"/></svg>
        `;
      case "lineGraph":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="m140-100-60-60 300-300 160 160 284-320 56 56-340 384-160-160-240 240Zm0-240-60-60 300-300 160 160 284-320 56 56-340 384-160-160-240 240Z"/></svg>
        `;
      case "stackedArea":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M120-160v-520l160 120 200-280 200 160h160v520H120Zm200-120 160-220 280 218v-318H652L496-725 298-447l-98-73v144l120 96Z"/></svg>
        `;
      case "plus":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="currentColor"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>
        `;
      case "close":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="currentColor"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>
        `;

      case "github":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M237.9 461.4C237.9 463.4 235.6 465 232.7 465C229.4 465.3 227.1 463.7 227.1 461.4C227.1 459.4 229.4 457.8 232.3 457.8C235.3 457.5 237.9 459.1 237.9 461.4zM206.8 456.9C206.1 458.9 208.1 461.2 211.1 461.8C213.7 462.8 216.7 461.8 217.3 459.8C217.9 457.8 216 455.5 213 454.6C210.4 453.9 207.5 454.9 206.8 456.9zM251 455.2C248.1 455.9 246.1 457.8 246.4 460.1C246.7 462.1 249.3 463.4 252.3 462.7C255.2 462 257.2 460.1 256.9 458.1C256.6 456.2 253.9 454.9 251 455.2zM316.8 72C178.1 72 72 177.3 72 316C72 426.9 141.8 521.8 241.5 555.2C254.3 557.5 258.8 549.6 258.8 543.1C258.8 536.9 258.5 502.7 258.5 481.7C258.5 481.7 188.5 496.7 173.8 451.9C173.8 451.9 162.4 422.8 146 415.3C146 415.3 123.1 399.6 147.6 399.9C147.6 399.9 172.5 401.9 186.2 425.7C208.1 464.3 244.8 453.2 259.1 446.6C261.4 430.6 267.9 419.5 275.1 412.9C219.2 406.7 162.8 398.6 162.8 302.4C162.8 274.9 170.4 261.1 186.4 243.5C183.8 237 175.3 210.2 189 175.6C209.9 169.1 258 202.6 258 202.6C278 197 299.5 194.1 320.8 194.1C342.1 194.1 363.6 197 383.6 202.6C383.6 202.6 431.7 169 452.6 175.6C466.3 210.3 457.8 237 455.2 243.5C471.2 261.2 481 275 481 302.4C481 398.9 422.1 406.6 366.2 412.9C375.4 420.8 383.2 435.8 383.2 459.3C383.2 493 382.9 534.7 382.9 542.9C382.9 549.4 387.5 557.3 400.2 555C500.2 521.8 568 426.9 568 316C568 177.3 455.5 72 316.8 72zM169.2 416.9C167.9 417.9 168.2 420.2 169.9 422.1C171.5 423.7 173.8 424.4 175.1 423.1C176.4 422.1 176.1 419.8 174.4 417.9C172.8 416.3 170.5 415.6 169.2 416.9zM158.4 408.8C157.7 410.1 158.7 411.7 160.7 412.7C162.3 413.7 164.3 413.4 165 412C165.7 410.7 164.7 409.1 162.7 408.1C160.7 407.5 159.1 407.8 158.4 408.8zM190.8 444.4C189.2 445.7 189.8 448.7 192.1 450.6C194.4 452.9 197.3 453.2 198.6 451.6C199.9 450.3 199.3 447.3 197.3 445.4C195.1 443.1 192.1 442.8 190.8 444.4zM179.4 429.7C177.8 430.7 177.8 433.3 179.4 435.6C181 437.9 183.7 438.9 185 437.9C186.6 436.6 186.6 434 185 431.7C183.6 429.4 181 428.4 179.4 429.7z"/></svg>
        `;
      default:
        return "";
    }
  }

  static headerArea(firstSpecies, additionalSpeciesCount = 0) {
    let selectedHint = `Showing <span class="italic">${escapeHtml(firstSpecies)}</span>`;
    if (additionalSpeciesCount > 0) {
      selectedHint += ` +${additionalSpeciesCount} others...`;
    }

    return /*html*/ `
      <div id="taxonomy-selector-header-group">
        <h1>AMR GeoMapper <span style="color: red;">BETA</span></h1>
        <div id="taxonomy-hint-group">
          <p id="taxonomy-hint" class="">
            ${selectedHint}
          </p>
          <button id="openTaxonModal" class="header-btn" data-placement="bottom" data-tooltip="Load new data">${HTMLhelper.icons(
            "edit",
          )}</button>
        </div>
      </div>
      <div id="header-additional-btns">
        <a id="download-data-btn" class="header-btn" data-placement="bottom" data-tooltip="Download raw map data as .csv">${HTMLhelper.icons(
          "download",
        )}</a>

        <a id="github-button" class="header-btn" href="https://github.com/JCVenterInstitute/AMR-GeoMapper" data-tooltip="Project GitHub">
          ${HTMLhelper.icons("github")}
        </a>
        <button id="information-button" class="header-btn" data-placement="left" data-tooltip="Software information">${HTMLhelper.icons(
          "info",
        )}</button>
      </div>
    `;
  }

  static menuStructure(filterSections, totalFilterCount = 0) {
    let sections = "";
    filterSections.forEach((section) => {
      const safeName = escapeHtml(section.name);
      const safeNameAttr = escapeAttr(section.name);
      const safeColumn = escapeAttr(section.column ?? "");
      const safeIcon = section.icon ? escapeAttr(section.icon) : "";
      sections += /*html*/ `
        <div
            class="menu-section" id="${safeNameAttr.toLowerCase()}-section"
            data-filter-column="${safeColumn}"
        >
            <div class="menu-section-header d-flex justify-content-between mt-2 mb-3">
              <div class="menu-section-header-left">

                ${
                  section.icon
                    ? `<img width="24px" height="24px" src="${safeIcon}" />`
                    : ""
                }
                <h3>
                ${safeName}
                </h3>
              </div>
              <div class="d-flex flex-row justify-end align-center">
                <div class="section-filter-count filter-counter hide">0</div>
                <svg class="chevron chevron-button subsection-chevron" xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z"/></svg>
              </div>

            </div>
            ${
              section.searchable
                ? `
              <input
              type="text"
              id="${safeNameAttr}SearchBox"
              placeholder="Search ${safeName}..."
              class="form-control mb-2 menu-section-search"
              />
              `
                : ""
            }

            <div class="w-100 ${
              section.scrollable ? "scroll-container" : ""
            } menu-sub-section">
                ${section.string}
            </div>
        </div>
    `;
    });
    return /*html*/ `
    <div id="sidebar-menu-group" class="d-flex flex-row h-100">
      <div id="filter-menu-container" class="menu-box shadow-normal h-100 z-2">
        ${HTMLhelper.menuHeader("Filters", "filter", totalFilterCount)}

        <div class="menu-content scroll-container invisible">
          ${sections}
        </div>
        <button class="invisible clear-btn filter-menu-btn justify-center align-center">
          <span>${HTMLhelper.icons("nofilter")}</span>Clear Filters
        </button>
      </div>
    </div>

    `;
  }

  static dateSelectionWidget(startDate = null, endDate = null) {
    const braceColor = "#4682B4";
    const svgCircle = (id) => {
      return /*html*/ `
      <svg id="${id}" height="14px" viewbox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
        <circle r="5" cx="5" cy="5" fill="${braceColor}"/>
      </svg>
    `;
    };
    const widget =
      /*html*/
      `
    <div id="date-widget">
      <div id="dw-bar" style="background-color: ${braceColor}"></div>
      <label id="dw-start-label" for="dw-start-date-input">Start Date</label>
      ${svgCircle("dw-start-circle")}
      <input ${
        !!startDate ? `value=${escapeAttr(startDate)}` : ""
      } type="text" id="dw-start-date-input" name="dw-start-date-input" class="date-text-input" filter-type="date-start" />
      <p id="dw-start-hint" class="form-hint">YYYY/MM/DD or YYYY</p>
    
      <label id="dw-end-label" for="dw-end-date-input">End Date</label>
      ${svgCircle("dw-end-circle")}
      <input ${
        !!endDate ? `value=${escapeAttr(endDate)}` : ""
      } type="text" id="dw-end-date-input" name="dw-end-date-input" class="date-text-input" filter-type="date-end"/>
      <p id="dw-end-hint" class="form-hint">YYYY/MM/DD or YYYY</p>

      <p
        id="dw-error"
        class="form-hint hide"
        style="color: #b00020; margin-top: 0.25rem;"
      ></p>
    </div>
    `;

    return widget;
  }

  static chartSelector(
    chartSection,
    backgroundColor,
    svg = null,
    svgOnly = false,
  ) {
    const percentWhite = 40;
    const safeColor = escapeAttr(backgroundColor);
    const border = `border: solid color-mix(in srgb, ${safeColor}, white ${percentWhite}%);`;

    const safeAlias = escapeHtml(chartSection.alias);
    const content = svg ? (svgOnly ? svg : svg + " " + safeAlias) : safeAlias;

    return /*html*/ `
      <button id="${escapeAttr(chartSection.column)}" style="background-color: ${safeColor}; ${border}" class="btn chart-selector-btn">
        <h3>
          ${content}
        </h3>
      </button>
    `;
  }
  static chartTypeSelector(chartTypes, activeType) {
    const typeLabels = {
      stackedBar: "Bar Chart",
      lineGraph: "Line Graph",
      stackedArea: "Stacked Area Chart",
    };
    const typeIcons = {
      stackedBar: HTMLhelper.icons("stackedBar"),
      lineGraph: HTMLhelper.icons("lineGraph"),
      stackedArea: HTMLhelper.icons("stackedArea"),
    };

    const isSingleOption = chartTypes.length === 1;

    const buttons = chartTypes
      .map((type) => {
        const svgIcon = typeIcons[type] || "";
        const isActive = type === activeType;
        const disabledAttr = isSingleOption ? "disabled" : "";
        const disabledClass = isSingleOption ? "single-option" : "";
        return /*html*/ `
          <button
            class="chart-toolbar-btn chart-type-svg-btn ${
              isActive ? "active-chart-type" : ""
            } ${disabledClass}"
            data-chart-type="${type}"
            data-placement="bottom"
            data-tooltip="${
              typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1)
            }"
            aria-label="${
              typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1)
            }"
            type="button"
            ${disabledAttr}
            tabindex="0"
          >
            ${svgIcon}
          </button>
        `;
      })
      .join("");

    return /*html*/ `
      <div id="chart-type-selector-buttons" class="chart-type-selector-group">
        ${buttons}
      </div>
    `;
  }

  /**
   * Generate primary dimension selector dropdown.
   * @param {Array} options - Array of {value, label} for available primary dimensions
   * @param {string} activeValue - Currently selected primary dimension
   * @returns {string} HTML string
   */
  static primaryDimensionSelector(options = [], activeValue = null) {
    if (!options || options.length === 0) {
      return "";
    }

    const optionsHtml = options
      .map((opt) => {
        const selected = opt.value === activeValue ? "selected" : "";
        return `<option value="${escapeAttr(opt.value)}" ${selected}>${escapeHtml(opt.label)}</option>`;
      })
      .join("");

    return /*html*/ `
      <select id="primary-dim-dropdown" class="dimension-select" title="Select primary dimension">
        ${optionsHtml}
      </select>
    `;
  }

  /**
   * Generate secondary dimension selector for hierarchical charts.
   * @param {Array} options - Array of {value, label} for available secondary dimensions
   * @param {string} activeValue - Currently selected secondary dimension
   * @param {boolean} disabled - Whether the dropdown should be disabled (for time series)
   * @returns {string} HTML string
   */
  static secondaryDimensionSelector(
    options = [],
    activeValue = null,
    disabled = false,
  ) {
    if (!options || options.length === 0) {
      return "";
    }

    const optionsHtml = options
      .map((opt) => {
        const selected = opt.value === activeValue ? "selected" : "";
        return `<option value="${escapeAttr(opt.value)}" ${selected}>${escapeHtml(opt.label)}</option>`;
      })
      .join("");

    const disabledAttr = disabled ? "disabled" : "";

    return /*html*/ `
      <span class="secondary-dim-label">by</span>
      <select id="secondary-dim-dropdown" class="dimension-select" title="Select dimension to break down by" ${disabledAttr}>
        ${optionsHtml}
      </select>
    `;
  }

  static chartOptions(savedOptions = null) {
    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";

    // Y-Axis modes (common to all charts)
    const yAxisModes = [
      { label: "Absolute", value: "absolute" },
      { label: "Relative / Percentage", value: "relative" },
    ];
    const savedYAxis = savedOptions?.yAxis || "absolute";
    const yAxisSectionString = yAxisModes
      .map((type) => {
        const isChecked = type.value === savedYAxis;
        return /*html*/ `
          <div>
            <input type="radio" id="${type.value}-yAxis-radio" name="yAxis-radio" value="${type.value}" ${isChecked ? "checked" : ""}>
            <label for="${type.value}-yAxis-radio">${type.label}</label>
          </div>
        `;
      })
      .join("");

    // Data mode (when user data loaded)
    const dataModes = ["Compare", "Merge"];
    const savedDataMode =
      savedOptions?.dataMode || (userDataLoaded ? "compare" : "merge");
    const dataModeSectionString = dataModes
      .map((type) => {
        const isChecked = type.toLowerCase() === savedDataMode;
        return /*html*/ `
          <div>
            <input type="radio" id="${type}-data-mode-radio" name="data-mode-radio" value="${type.toLowerCase()}" ${isChecked ? "checked" : ""}>
            <label for="${type}-data-mode-radio">${type}</label>
          </div>
        `;
      })
      .join("");

    // Sort types for bar charts
    const sortTypes = userDataLoaded
      ? ["Alphanumeric", "Count: CAMRA", "Count: User data", "Count: Combined"]
      : ["Alphanumeric", "Count"];
    const savedSort = savedOptions?.sort || "alphanumeric";
    const sortSectionString = sortTypes
      .map((type) => {
        const sortValue =
          type === "Count: CAMRA"
            ? "count:camra"
            : type === "Count: User data"
              ? "count:userdata"
              : type === "Count: Combined"
                ? "count:combined"
                : type === "Count"
                  ? "count"
                  : "alphanumeric";
        const isChecked = sortValue.toLowerCase() === savedSort?.toLowerCase();
        return /*html*/ `
          <div>
            <input type="radio" id="${type.replace(/[:\s]/g, "")}-sort-radio" name="sort-radio" value="${sortValue}" ${isChecked ? "checked" : ""}>
            <label for="${type.replace(/[:\s]/g, "")}-sort-radio">${type}</label>
          </div>
        `;
      })
      .join("");

    // Time series modes
    const timeSeriesModes = [
      { label: "Per Year", value: "perYear" },
      { label: "Cumulative", value: "cumulative" },
    ];
    const savedTimeSeriesMode = savedOptions?.timeSeriesMode || "perYear";
    const timeSeriesSectionString = timeSeriesModes
      .map((type) => {
        const isChecked = type.value === savedTimeSeriesMode;
        return /*html*/ `
          <div>
            <input type="radio" id="${type.label.replace(" ", "")}-timeSeries-radio" name="timeSeries-radio" value="${type.value}" ${isChecked ? "checked" : ""}>
            <label for="${type.label.replace(" ", "")}-timeSeries-radio">${type.label}</label>
          </div>
        `;
      })
      .join("");

    // Line selection modes
    const lineSelectionModes = [
      { label: "Top by Total Count", value: "totalCount" },
      { label: "Top by Recent Year", value: "recentYear" },
      { label: "Alphanumeric", value: "alphanumeric" },
    ];
    const savedLineSelection = savedOptions?.lineSelection || "totalCount";
    const lineSelectionSectionString = lineSelectionModes
      .map((type) => {
        const isChecked = type.value === savedLineSelection;
        return /*html*/ `
          <div>
            <input type="radio" id="${type.value}-lineSelection-radio" name="lineSelection-radio" value="${type.value}" ${isChecked ? "checked" : ""}>
            <label for="${type.value}-lineSelection-radio">${type.label}</label>
          </div>
        `;
      })
      .join("");

    return /*html*/ `
      <div id="chart-options-header">
        <h2>Chart Settings</h2>
        <button id="close-chart-settings-btn">✕</button>
      </div>
      <section id="chart-options">
        <div id="yAxis-mode" class="chart-options-group">
          <h3>Y-Axis:</h3>
          <p>Sets the y-axis scale for all chart types.</p>
          <div class="d-flex flex-wrap flex-row">
            ${yAxisSectionString}
          </div>
        </div>

        <div class="chart-options-subheading">Bar Chart Options</div>
        <div id="sort-mode" class="chart-options-group">
          <h3>Sort:</h3>
          <p>How the x-axis values are ordered.</p>
          <div class="d-flex flex-wrap flex-row">
            ${sortSectionString}
          </div>
        </div>

        <div class="chart-options-subheading">Time Series Options</div>
        <div id="timeSeries-mode" class="chart-options-group">
          <h3>Time Series Mode:</h3>
          <p>Display frequency per year or cumulative sum over time.</p>
          <div class="d-flex flex-wrap flex-row">
            ${timeSeriesSectionString}
          </div>
        </div>
        <div id="lineSelection-mode" class="chart-options-group">
          <h3>Line Selection:</h3>
          <p>How lines are selected and ordered for time series charts.</p>
          <div class="d-flex flex-wrap flex-row">
            ${lineSelectionSectionString}
          </div>
        </div>

        ${
          userDataLoaded
            ? /*html*/ `
        <div class="chart-options-subheading">Data Options</div>
        <div id="data-set-mode" class="chart-options-group">
          <h3>User Data:</h3>
          <p>How user data is integrated into the charts.</p>
          <div class="d-flex flex-wrap flex-row">
            ${dataModeSectionString}
          </div>
        </div>
        `
            : ""
        }
      </section>
    `;
  }

  static taxonomyModal(taxonJSON, levelNames = ["family", "genus", "species"]) {
    const taxonomyTree = HTMLhelper.taxon(taxonJSON, levelNames);
    let htmlString = /*html*/ `
      <div id="taxonomySelection">
        <div id="available-selected">
          <section id="available-taxonomies">
            <h2 id="available-header">Available Genomes</h2>
            <div id="modal-search-box" class="mt-2 mb-2">
              <input id="taxonomy-search" type="search" placeholder="Search family, genus, species" autocomplete="off" />
            </div>
            <div id="available-taxonomy-tree" class="scroll-container">
              ${taxonomyTree}
            </div>
          </section>
              <section id="user-files-section">
                <h2 id="available-header">Load User Data
                  <a class="" href="https://github.com/JCVenterInstitute/AMR-GeoMapper/blob/b835203e1b5a8e3ab5f8eb55492f2f4f651f60b5/docs/user-data-guide.md">
                    <svg id="help-icon" xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="#1f1f1f"><path d="M478-240q21 0 35.5-14.5T528-290q0-21-14.5-35.5T478-340q-21 0-35.5 14.5T428-290q0 21 14.5 35.5T478-240Zm-36-154h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>
                  </a>
                </h2>
                <div id="user-files" class="scroll-container">
                  <csv-upload-button></csv-upload-button>
                </div>
                <div id="data-guarantee">Your data is always private and only loaded locally.</div>
              </section>
        </div>
        </div>
      </div>
    `;

    return htmlString;
  }

  static taxon(taxonData, levelNames = ["family", "genus", "species"]) {
    const taxonHTMLContainer = document.createElement("section");
    const taxonUlEl = document.createElement("ul");
    taxonUlEl.classList.add("list-tree");
    taxonHTMLContainer.appendChild(taxonUlEl);

    const slug = (s) =>
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");

    // Build ID from path array
    const mkId = (side, level, path) =>
      `${side}-${level}-${path.filter(Boolean).map(slug).join("__")}`;

    // Build checkbox with data attributes from path
    const mkCheckbox = (side, level, path, text) => {
      const id = mkId(side, level, path);

      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "taxon-checkbox";
      input.id = id;
      input.dataset.level = level;

      // Set data attributes for each level in path
      levelNames.forEach((levelName, index) => {
        if (path[index]) {
          input.dataset[levelName] = path[index];
        }
      });

      input.dataset.label = text;

      const label = document.createElement("label");
      label.setAttribute("for", id);
      // First level (e.g., "order" or "family") is not italicized
      if (level === levelNames[0]) {
        label.textContent = text;
      } else {
        const span = document.createElement("span");
        span.className = "italic";
        span.textContent = text;
        label.appendChild(span);
      }

      return { input, label };
    };

    // Recursive function to build tree
    const buildTree = (data, parentUl, currentPath = [], currentLevel = 0) => {
      if (currentLevel >= levelNames.length) return;

      const levelName = levelNames[currentLevel];
      const isLeafLevel = currentLevel === levelNames.length - 1;

      if (isLeafLevel && Array.isArray(data)) {
        // Leaf level: data is an array of species
        data.forEach((species) => {
          const spLi = document.createElement("li");
          spLi.classList.add("leaf");
          const spWrap = document.createElement("div");
          const spCb = mkCheckbox(
            "avail",
            levelName,
            [...currentPath, species],
            species,
          );
          spWrap.append(spCb.input, spCb.label);
          spLi.appendChild(spWrap);
          parentUl.appendChild(spLi);
        });
      } else if (
        typeof data === "object" &&
        data !== null &&
        !Array.isArray(data)
      ) {
        // Non-leaf level: data is an object
        Object.keys(data).forEach((key) => {
          const newPath = [...currentPath, key];
          const li = document.createElement("li");
          const details = document.createElement("details");
          details.open = false;
          const summary = document.createElement("summary");

          const chevron = document.createElement("span");
          chevron.classList.add("tree-chevron");
          chevron.setAttribute("aria-hidden", "true");
          summary.appendChild(chevron);

          const cb = mkCheckbox("avail", levelName, newPath, key);
          summary.append(cb.input, cb.label);
          details.appendChild(summary);

          const ul = document.createElement("ul");
          details.appendChild(ul);
          li.appendChild(details);
          parentUl.appendChild(li);

          // Recursively build children
          buildTree(data[key], ul, newPath, currentLevel + 1);
        });
      }
    };

    buildTree(taxonData, taxonUlEl);

    // return HTML string for your template usage
    return taxonHTMLContainer.innerHTML;
  }
}

/**
 * Country population data (2023 estimates)
 * Population values in millions for per-capita calculations
 * Source: UN World Population Prospects / World Bank
 */
const countryPopulation = {
  afghanistan: 42239854,
  albania: 2832439,
  algeria: 45606480,
  andorra: 80088,
  angola: 36684202,
  "antigua and barbuda": 94298,
  argentina: 45773884,
  armenia: 2777970,
  australia: 26439111,
  austria: 9104772,
  azerbaijan: 10412651,
  bahamas: 412623,
  bahrain: 1485509,
  bangladesh: 172954319,
  barbados: 281995,
  belarus: 9498238,
  belgium: 11686140,
  belize: 410825,
  benin: 13712828,
  bhutan: 787424,
  bolivia: 12388571,
  "bosnia and herzegovina": 3210847,
  botswana: 2675352,
  brazil: 216422446,
  brunei: 452524,
  bulgaria: 6687717,
  "burkina faso": 23251485,
  burundi: 13238559,
  cambodia: 16944826,
  cameroon: 28647293,
  canada: 39742430,
  "cape verde": 598682,
  "central african republic": 5742315,
  chad: 18278568,
  chile: 19629590,
  china: 1425671352,
  colombia: 52085168,
  comoros: 852075,
  congo: 6106869,
  "democratic republic of the congo": 102262808,
  "costa rica": 5212173,
  croatia: 3850894,
  cuba: 11194449,
  cyprus: 1260138,
  "czech republic": 10495295,
  czechia: 10495295,
  denmark: 5910913,
  djibouti: 1136455,
  dominica: 73040,
  "dominican republic": 11332972,
  "east timor": 1360596,
  "timor-leste": 1360596,
  ecuador: 18190484,
  egypt: 112716598,
  "el salvador": 6364943,
  "equatorial guinea": 1714671,
  eritrea: 3748901,
  estonia: 1322765,
  eswatini: 1210822,
  swaziland: 1210822,
  ethiopia: 126527060,
  fiji: 936375,
  finland: 5545475,
  france: 64756584,
  gabon: 2436566,
  gambia: 2773168,
  georgia: 3728282,
  germany: 83294633,
  ghana: 34121985,
  greece: 10341277,
  grenada: 126183,
  guatemala: 18092026,
  guinea: 14190612,
  "guinea-bissau": 2150842,
  guyana: 813834,
  haiti: 11724763,
  honduras: 10593798,
  hungary: 9597085,
  iceland: 375318,
  india: 1428627663,
  indonesia: 277534122,
  iran: 89172767,
  iraq: 45504560,
  ireland: 5149139,
  israel: 9174520,
  italy: 58870762,
  "ivory coast": 28873034,
  "cote d'ivoire": 28873034,
  jamaica: 2825544,
  japan: 123294513,
  jordan: 11337052,
  kazakhstan: 19606633,
  kenya: 55100586,
  kiribati: 133515,
  "north korea": 26160821,
  "south korea": 51784059,
  korea: 51784059,
  kuwait: 4310108,
  kyrgyzstan: 6735347,
  laos: 7633779,
  latvia: 1830211,
  lebanon: 5353930,
  lesotho: 2330318,
  liberia: 5418377,
  libya: 6888388,
  liechtenstein: 39584,
  lithuania: 2718352,
  luxembourg: 660809,
  madagascar: 30325732,
  malawi: 20931751,
  malaysia: 34308525,
  maldives: 521021,
  mali: 23293698,
  malta: 535064,
  "marshall islands": 41996,
  mauritania: 4862989,
  mauritius: 1300557,
  mexico: 128455567,
  micronesia: 115224,
  moldova: 3435931,
  monaco: 36297,
  mongolia: 3447157,
  montenegro: 616177,
  morocco: 37840044,
  mozambique: 33897354,
  myanmar: 54577997,
  burma: 54577997,
  namibia: 2604172,
  nauru: 12780,
  nepal: 30896590,
  netherlands: 17618299,
  "new zealand": 5228100,
  nicaragua: 7046310,
  niger: 27202843,
  nigeria: 223804632,
  "north macedonia": 2085679,
  macedonia: 2085679,
  norway: 5474360,
  oman: 4644384,
  pakistan: 240485658,
  palau: 18058,
  palestine: 5371230,
  panama: 4468087,
  "papua new guinea": 10329931,
  paraguay: 6861524,
  peru: 34352719,
  philippines: 117337368,
  poland: 41026067,
  portugal: 10247605,
  qatar: 2716391,
  romania: 19892812,
  russia: 144444359,
  "russian federation": 144444359,
  rwanda: 14094683,
  "saint kitts and nevis": 47755,
  "saint lucia": 180251,
  "saint vincent and the grenadines": 103698,
  samoa: 225681,
  "san marino": 33642,
  "sao tome and principe": 231856,
  "saudi arabia": 36947025,
  senegal: 17763163,
  serbia: 7149077,
  seychelles: 107660,
  "sierra leone": 8791092,
  singapore: 6014723,
  slovakia: 5795199,
  slovenia: 2119675,
  "solomon islands": 740424,
  somalia: 18143378,
  "south africa": 60414495,
  "south sudan": 11088796,
  spain: 47519628,
  "sri lanka": 21893579,
  sudan: 48109006,
  suriname: 623236,
  sweden: 10612086,
  switzerland: 8796669,
  syria: 23227014,
  taiwan: 23894394,
  tajikistan: 10143543,
  tanzania: 67438106,
  thailand: 71801279,
  togo: 9053799,
  tonga: 107773,
  "trinidad and tobago": 1534937,
  tunisia: 12458223,
  turkey: 85816199,
  turkmenistan: 6516100,
  tuvalu: 11312,
  uganda: 48582334,
  ukraine: 37000000,
  "united arab emirates": 9516871,
  "united kingdom": 67736802,
  uk: 67736802,
  "great britain": 67736802,
  "united states": 339996563,
  usa: 339996563,
  uruguay: 3423108,
  uzbekistan: 35163944,
  vanuatu: 334506,
  "vatican city": 518,
  venezuela: 28838499,
  vietnam: 98858950,
  "viet nam": 98858950,
  yemen: 34449825,
  zambia: 20569737,
  zimbabwe: 16665409,
  // Territories and special regions
  "puerto rico": 3205691,
  "hong kong": 7491609,
  macau: 704149,
  greenland: 56643,
  "french polynesia": 308872,
  "new caledonia": 292991,
  guam: 172952,
  "us virgin islands": 87146,
  "british virgin islands": 31538,
  "cayman islands": 69310,
  bermuda: 64069,
  aruba: 108166,
  curacao: 153671,
  "sint maarten": 44175,
  "turks and caicos islands": 46062,
  "isle of man": 84069,
  jersey: 103267,
  guernsey: 63950,
  "faeroe islands": 54548,
  "faroe islands": 54548,
  gibraltar: 32688,
  "american samoa": 44273,
  "northern mariana islands": 51659,
};

/**
 * Get population for a country by name
 * @param {string} countryName - Normalized country name (lowercase)
 * @returns {number|null} Population or null if not found
 */
function getPopulation(countryName) {
  if (!countryName) return null;
  const normalized = countryName.toLowerCase().trim();
  return countryPopulation[normalized] ?? null;
}

class CountryShadingManager {
  constructor(host) {
    this.host = host;
  }

  /**
   * Initialize country shading by loading GeoJSON data
   */
  initCountryShading() {
    this.host._countryGeoJsonPromise = (async () => {
      try {
        const geoJsonUrl =
          "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
        const response = await fetch(geoJsonUrl);
        if (!response.ok) throw new Error("Failed to load country GeoJSON");
        this.host._countryGeoJson = await response.json();

        this._createChoroplethLayer();
        this._createShadingLegend();
      } catch (err) {
        console.error("Error initializing country shading:", err);
      }
    })();
  }

  /**
   * Update country shading when data changes
   */
  async updateCountryShading() {
    if (!this.host.config.mapOptions.countryShading?.enabled) return;

    if (this.host._countryGeoJsonPromise) {
      await this.host._countryGeoJsonPromise;
    }

    if (!this.host._countryGeoJson) return;

    this._createChoroplethLayer();
    this._updateShadingLegend();
  }

  /**
   * Create or update the choropleth layer based on location data
   */
  _createChoroplethLayer() {
    if (!this.host._countryGeoJson || !this.host.map) return;

    const shadingConfig = this.host.config.mapOptions.countryShading ?? {};
    const noDataColor = shadingConfig.noDataColor ?? "#f0f0f0";
    const fillOpacity = shadingConfig.fillOpacity ?? 0.6;
    const borderColor = shadingConfig.borderColor ?? "#999999";
    const borderWeight = shadingConfig.borderWeight ?? 1;

    const { countryData, rawCounts, valueMode } = this._buildCountryDataMap();

    const values = Object.values(countryData).filter((v) => v > 0);
    const minValue = values.length > 0 ? Math.min(...values) : 0;
    const maxValue = values.length > 0 ? Math.max(...values) : 1;

    this.host._choroplethData = {
      countryData,
      rawCounts,
      valueMode,
      minValue,
      maxValue,
    };

    const getStyle = (feature) => {
      const countryName = feature.properties.ADMIN || feature.properties.name;
      const value =
        this.host._choroplethData.countryData[
          this._normalizeCountryName(countryName)
        ] ?? 0;

      return {
        fillColor:
          value > 0
            ? this._getColorForValue(
                value,
                this.host._choroplethData.minValue,
                this.host._choroplethData.maxValue,
              )
            : noDataColor,
        fillOpacity: fillOpacity,
        color: borderColor,
        weight: borderWeight,
      };
    };

    // Remove existing layer to ensure clean SVG renderer state
    if (
      this.host._choroplethLayer &&
      this.host.map.hasLayer(this.host._choroplethLayer)
    ) {
      this.host.map.removeLayer(this.host._choroplethLayer);
      this.host._choroplethLayer = null;
    }

    this.host._choroplethLayer = L.geoJSON(this.host._countryGeoJson, {
      style: getStyle,
      onEachFeature: (feature, layer) => {
        const countryName = feature.properties.ADMIN || feature.properties.name;
        const normalizedName = this._normalizeCountryName(countryName);
        const value = countryData[normalizedName] ?? 0;
        const rawCount = rawCounts[normalizedName] ?? 0;

        const showTooltip = shadingConfig.showTooltip !== false;
        if (showTooltip && rawCount > 0) {
          let tooltipText;
          if (valueMode === "perCapita" && value > 0) {
            tooltipText = `${countryName}: ${value.toFixed(2)} per million (${this.host._countFormatter.format(rawCount)} samples)`;
          } else {
            tooltipText = `${countryName}: ${this.host._countFormatter.format(rawCount)} samples`;
          }
          layer.bindTooltip(tooltipText, {
            sticky: true,
            className: "country-tooltip",
          });
        }

        layer.on("click", () => {
          const locationKey = this._findLocationKeyForCountry(normalizedName);
          if (locationKey && this.host.locationObjs[locationKey]) {
            this.host.activeLocation = locationKey;
            const active =
              this.host.activeChartIDPreference ||
              this.host.activeChartID ||
              null;
            this.host.createCharts(
              this.host.locationObjs[locationKey],
              locationKey,
              active,
            );
            this.host.expandMenu(this.host.shadow.getElementById("charts"));
          }
        });
      },
    });

    this.host._choroplethLayer.addTo(this.host.map);
    this.host._choroplethLayer.bringToBack();
  }

  /**
   * Build a map of normalized country names to values (counts or per-capita)
   */
  _buildCountryDataMap() {
    const shadingConfig = this.host.config.mapOptions.countryShading ?? {};
    const valueMode = shadingConfig.valueMode ?? "perCapita";
    const countryData = {};
    const rawCounts = {};

    if (!this.host.locationObjs) return { countryData, rawCounts, valueMode };

    for (const [key, locationObj] of Object.entries(this.host.locationObjs)) {
      if (key === "global" || !locationObj.country) continue;
      if (locationObj.isStateLevel) continue;

      const normalizedCountry = this._normalizeCountryName(locationObj.country);
      const count = locationObj.genomeCount ?? 0;

      if (normalizedCountry) {
        rawCounts[normalizedCountry] =
          (rawCounts[normalizedCountry] || 0) + count;
      }
    }

    for (const [country, count] of Object.entries(rawCounts)) {
      if (valueMode === "perCapita") {
        const population = getPopulation(country);
        if (population && population > 0) {
          countryData[country] = (count / population) * 1000000;
        } else {
          countryData[country] = 0;
        }
      } else {
        countryData[country] = count;
      }
    }

    return { countryData, rawCounts, valueMode };
  }

  /**
   * Find the location key for a given country name
   */
  _findLocationKeyForCountry(normalizedCountry) {
    if (!this.host.locationObjs) return null;

    for (const [key, locationObj] of Object.entries(this.host.locationObjs)) {
      if (key === "global" || locationObj.isStateLevel) continue;
      if (
        this._normalizeCountryName(locationObj.country) === normalizedCountry
      ) {
        return key;
      }
    }
    return null;
  }

  /**
   * Normalize country name for matching between data and GeoJSON
   */
  _normalizeCountryName(name) {
    if (!name) return "";

    const nameMap = {
      "united states of america": "united states",
      usa: "united states",
      "u.s.a.": "united states",
      "u.s.": "united states",
      uk: "united kingdom",
      "great britain": "united kingdom",
      "russian federation": "russia",
      "people's republic of china": "china",
      "republic of korea": "south korea",
      "korea, republic of": "south korea",
      "democratic people's republic of korea": "north korea",
      "korea, democratic people's republic of": "north korea",
      "viet nam": "vietnam",
      "côte d'ivoire": "ivory coast",
      "cote d'ivoire": "ivory coast",
      "united republic of tanzania": "tanzania",
      "the bahamas": "bahamas",
      "republic of the congo": "congo",
      "republic of congo": "congo",
      "republic of serbia": "serbia",
      "guinea bissau": "guinea-bissau",
      somaliland: "somalia",
      swaziland: "eswatini",
      "east timor": "timor-leste",
      "republic of cameroon": "cameroon",
      zaire: "democratic republic of the congo",
      drc: "democratic republic of the congo",
    };

    const lower = name.toLowerCase().trim();
    return nameMap[lower] || lower;
  }

  /**
   * Get color for a value within a range using the configured gradient
   */
  _getColorForValue(value, min, max) {
    const gradient = this.host.config.mapOptions.countryShading
      ?.colorGradient ?? ["#f7fbff", "#08306b"];

    if (gradient.length === 0) return "#cccccc";
    if (gradient.length === 1) return gradient[0];

    const logMin = Math.log10(Math.max(min, 1));
    const logMax = Math.log10(Math.max(max, 1));
    const logValue = Math.log10(Math.max(value, 1));

    let t = logMax === logMin ? 0.5 : (logValue - logMin) / (logMax - logMin);
    t = Math.max(0, Math.min(1, t));

    const gradientPos = t * (gradient.length - 1);
    const lowerIndex = Math.floor(gradientPos);
    const upperIndex = Math.min(lowerIndex + 1, gradient.length - 1);
    const localT = gradientPos - lowerIndex;

    return this._interpolateColor(
      gradient[lowerIndex],
      gradient[upperIndex],
      localT,
    );
  }

  /**
   * Interpolate between two hex colors
   */
  _interpolateColor(color1, color2, t) {
    const c1 = this._hexToRgb(color1);
    const c2 = this._hexToRgb(color2);

    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b = Math.round(c1.b + (c2.b - c1.b) * t);

    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  /**
   * Convert hex color to RGB object
   */
  _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : { r: 0, g: 0, b: 0 };
  }

  /**
   * Create the country shading legend element
   */
  _createShadingLegend() {
    const existing = this.host.shadow.getElementById("country-shading-legend");
    if (existing) existing.remove();

    const mapArea = this.host.shadow.getElementById("map-area");
    if (!mapArea) return;

    const legend = document.createElement("div");
    legend.id = "country-shading-legend";

    mapArea.appendChild(legend);
    this._updateShadingLegend();

    this._observeSidebarForLegend();
  }

  /**
   * Update the legend content based on current data
   */
  _updateShadingLegend() {
    const legend = this.host.shadow.getElementById("country-shading-legend");
    if (!legend) return;

    const shadingConfig = this.host.config.mapOptions.countryShading ?? {};
    if (!shadingConfig.enabled) {
      legend.style.display = "none";
      return;
    }
    legend.style.display = "block";

    const valueMode = shadingConfig.valueMode ?? "perCapita";
    const gradient = shadingConfig.colorGradient ?? ["#f7fbff", "#08306b"];
    const noDataColor = shadingConfig.noDataColor ?? "#f0f0f0";

    const { countryData } = this._buildCountryDataMap();
    const values = Object.values(countryData).filter((v) => v > 0);
    const minValue = values.length > 0 ? Math.min(...values) : 0;
    const maxValue = values.length > 0 ? Math.max(...values) : 1;

    let minLabel, maxLabel, title;
    if (valueMode === "perCapita") {
      title = "Samples per Million";
      minLabel = minValue > 0 ? minValue.toFixed(1) : "0";
      maxLabel = maxValue.toFixed(1);
    } else {
      title = "Sample Count";
      minLabel = this.host._countFormatter.format(Math.round(minValue));
      maxLabel = this.host._countFormatter.format(Math.round(maxValue));
    }

    const gradientCSS = `linear-gradient(to right, ${gradient.join(", ")})`;

    legend.innerHTML = `
      <div class="legend-title">${title}</div>
      <div class="legend-gradient">
        <div class="legend-gradient-bar" style="background: ${gradientCSS};"></div>
        <div class="legend-labels">
          <span>${minLabel}</span>
          <span>${maxLabel}</span>
        </div>
      </div>
      <div class="legend-no-data">
        <div class="legend-no-data-swatch" style="background-color: ${noDataColor};"></div>
        <span class="legend-no-data-label">No data</span>
      </div>
    `;
  }

  /**
   * Observe sidebar state to update legend position
   */
  _observeSidebarForLegend() {
    const sidebarGroup = this.host.shadow.getElementById("sidebar-menu-group");
    const legend = this.host.shadow.getElementById("country-shading-legend");
    if (!sidebarGroup || !legend) return;

    const updatePosition = () => {
      if (sidebarGroup.classList.contains("open")) {
        legend.classList.remove("sidebar-closed");
      } else {
        legend.classList.add("sidebar-closed");
      }
    };

    updatePosition();

    if (this._legendObserver) {
      this._legendObserver.disconnect();
    }
    this._legendObserver = new MutationObserver(updatePosition);
    this._legendObserver.observe(sidebarGroup, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  /**
   * Remove the shading legend
   */
  _removeShadingLegend() {
    const legend = this.host.shadow.getElementById("country-shading-legend");
    if (legend) legend.remove();
    if (this._legendObserver) {
      this._legendObserver.disconnect();
      this._legendObserver = null;
    }
  }

  /**
   * Clean up all shading resources
   */
  destroy() {
    if (this.host._choroplethLayer && this.host.map) {
      this.host.map.removeLayer(this.host._choroplethLayer);
      this.host._choroplethLayer = null;
    }
    this.host._countryGeoJson = null;
    this.host._countryGeoJsonPromise = null;
    this._removeShadingLegend();
  }
}

class TooltipManager {
  constructor(host) {
    this.host = host;
    this._tooltipAbort = null;
    this._openTip = null;
  }

  setupTooltips({ hoverDelay = 1000, focusDelay = 0 } = {}) {
    const root = this.host.shadow;
    const hasPopover = "showPopover" in HTMLElement.prototype;

    if (this._tooltipAbort) this._tooltipAbort.abort();
    this._tooltipAbort = new AbortController();

    if (this._openTip && hasPopover && this._openTip.isConnected) {
      try {
        this._openTip.hidePopover();
      } catch {
        // hidePopover throws if popover is not currently shown - this is expected
      }
    }
    this._openTip = null;

    root.querySelectorAll(".mgo-tooltip").forEach((el) => el.remove());

    // Fallback for old browsers
    let portal, portalText;
    const bodyPortalShow = (btn, text) => {
      if (!portal) {
        portal = document.createElement("div");
        portalText = document.createElement("div");
        Object.assign(portal.style, {
          position: "fixed",
          zIndex: "2147483647",
          pointerEvents: "none",
        });
        Object.assign(portalText.style, {
          background: "#111",
          color: "#fff",
          padding: "6px 8px",
          borderRadius: "8px",
          boxShadow: "0 8px 24px rgba(0,0,0,.25)",
          font: "12px/1.25 system-ui, sans-serif",
          margin: 0,
        });
        portal.appendChild(portalText);
        document.body.appendChild(portal);
      }
      portalText.textContent = text;
      const r = btn.getBoundingClientRect();
      const x = Math.min(
        Math.max(r.left + r.width / 2, 8),
        window.innerWidth - 8,
      );
      const y = Math.max(r.bottom + 4, 8);
      portal.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`;
      portal.style.display = "block";
      window.addEventListener("scroll", bodyPortalHide, {
        once: true,
        signal: this._tooltipAbort.signal,
      });
    };
    const bodyPortalHide = () => {
      if (portal) portal.style.display = "none";
    };

    root.querySelectorAll("[data-tooltip]").forEach((btn, i) => {
      const tip = document.createElement("div");
      tip.className = "mgo-tooltip";
      tip.setAttribute("popover", "manual");
      tip.textContent = btn.getAttribute("data-tooltip");
      const place = btn.getAttribute("data-placement");
      if (place) tip.dataset.placement = place;

      btn.style.anchorName = `--btn-anchor-${i}`;
      tip.style.positionAnchor = `--btn-anchor-${i}`;

      root.appendChild(tip);

      const connected = () =>
        btn.isConnected && tip.isConnected && root.isConnected;
      const show = () => {
        if (!connected()) return;

        if (this._openTip && this._openTip !== tip) {
          try {
            hasPopover ? this._openTip.hidePopover() : bodyPortalHide();
          } catch {
            // hidePopover throws if popover is not currently shown - this is expected
          }
        }

        if (hasPopover) {
          void tip.offsetWidth;
          tip.showPopover();
        } else {
          bodyPortalShow(btn, tip.textContent);
        }
        this._openTip = tip;
      };
      const hide = () => {
        if (this._openTip === tip) {
          if (hasPopover && tip.isConnected) {
            try {
              tip.hidePopover();
            } catch {
              // hidePopover throws if popover is not currently shown - this is expected
            }
          } else {
            bodyPortalHide();
          }
          this._openTip = null;
        }
      };

      let hoverTimer = null;

      const scheduleShow = (delay) => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(show, delay);
      };
      const cancelShow = () => {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      };

      btn.addEventListener("mouseenter", () => scheduleShow(hoverDelay), {
        signal: this._tooltipAbort.signal,
      });
      btn.addEventListener(
        "mouseleave",
        () => {
          cancelShow();
          setTimeout(() => hide(), 120);
        },
        { signal: this._tooltipAbort.signal },
      );

      btn.addEventListener("focusin", () => scheduleShow(focusDelay), {
        signal: this._tooltipAbort.signal,
      });
      btn.addEventListener(
        "focusout",
        () => {
          cancelShow();
          hide();
        },
        { signal: this._tooltipAbort.signal },
      );

      btn.addEventListener(
        "pointerdown",
        () => {
          cancelShow();
          hide();
        },
        { signal: this._tooltipAbort.signal },
      );
    });
  }

  destroy() {
    this._tooltipAbort?.abort();
    this._tooltipAbort = null;
    this._openTip = null;
  }
}

class TaxonomyTree {
  constructor(config = {}) {
    // Level names (e.g., ["family", "genus", "species"] or ["order", "family", "genus", "species"])
    // Required: must be provided in configuration
    if (
      !config.levelNames ||
      !Array.isArray(config.levelNames) ||
      config.levelNames.length === 0
    ) {
      throw new Error(
        "TaxonomyTree requires levelNames configuration. " +
          "Example: new TaxonomyTree({ levelNames: ['family', 'genus', 'species'] })",
      );
    }
    this.levelNames = config.levelNames;

    // Root element references (set during initialization)
    this.leftRoot = null;
    this.shadowRoot = null;
  }

  /**
   * Initialize tree with DOM roots
   * @param {HTMLElement} leftRoot - Left tree root element (#available-taxonomy-tree)
   * @param {ShadowRoot} shadowRoot - Shadow root for queries
   */
  initialize(leftRoot, shadowRoot) {
    this.leftRoot = leftRoot;
    this.shadowRoot = shadowRoot;
  }

  /**
   * Get path from a checkbox element using data attributes
   * @param {HTMLInputElement} checkbox - Checkbox element
   * @returns {Array} - Path array
   */
  getPathFromCheckbox(checkbox) {
    if (!checkbox) return [];

    const levelNames = this.levelNames;
    const path = [];

    // Build path from data attributes in order
    levelNames.forEach((levelName) => {
      const value = checkbox.dataset[levelName];
      if (value) path.push(value);
    });

    return path;
  }

  /**
   * Convert a path array to a string key (for backward compatibility)
   * @param {Array} path - Array of values representing the path
   * @returns {string} - Pipe-separated key
   */
  pathToKey(path) {
    return path.join("|");
  }

  /**
   * Convert a key string back to a path array
   * @param {string} key - Pipe-separated key
   * @returns {Array} - Path array
   */
  keyToPath(key) {
    return key.split("|");
  }

  /**
   * Get the leaf level name
   * @returns {string} - Leaf level name
   */
  getLeafLevelName() {
    const levelNames = this.levelNames;
    return levelNames[levelNames.length - 1];
  }

  /**
   * Build selector for finding checkboxes by path
   * @param {Array} path - Path array
   * @param {boolean} leafOnly - Only match leaf nodes
   * @returns {string} - CSS selector
   */
  buildPathSelector(path, leafOnly = false) {
    const levelNames = this.levelNames;

    const conditions = [];
    path.forEach((value, index) => {
      if (index < levelNames.length && value) {
        conditions.push(`[data-${levelNames[index]}="${CSS.escape(value)}"]`);
      }
    });

    const levelCondition = leafOnly
      ? `[data-level="${this.getLeafLevelName()}"]`
      : "";

    return `#available-taxonomy-tree input.taxon-checkbox${levelCondition}${conditions.join(
      "",
    )}`;
  }

  /**
   * Find checkbox by path
   * @param {Array} path - Path array
   * @param {boolean} leafOnly - Only match leaf nodes
   * @returns {HTMLInputElement|null} - Checkbox element or null
   */
  findCheckboxByPath(path, leafOnly = false) {
    if (!this.shadowRoot) return null;
    const selector = this.buildPathSelector(path, leafOnly);
    return this.shadowRoot.querySelector(selector);
  }

  /**
   * Get all selected leaf nodes
   * @param {HTMLElement} root - Root element to search (default: leftRoot)
   * @returns {Array} - Array of objects with path and checkbox
   */
  getSelectedLeaves(root = null) {
    const searchRoot = root || this.leftRoot;
    if (!searchRoot || !this.shadowRoot) return [];

    const leafLevelName = this.getLeafLevelName();
    const checkboxes = Array.from(
      searchRoot.querySelectorAll(
        `input.taxon-checkbox[data-level="${leafLevelName}"]:checked`,
      ),
    );

    const unique = new Map();
    checkboxes.forEach((cb) => {
      const path = this.getPathFromCheckbox(cb);
      const key = this.pathToKey(path);
      if (!unique.has(key)) {
        unique.set(key, {
          path,
          checkbox: cb,
          // For backward compatibility, include family/genus/species if present
          family: cb.dataset.family || null,
          genus: cb.dataset.genus || null,
          species: cb.dataset.species || path[path.length - 1] || null,
        });
      }
    });

    return Array.from(unique.values());
  }

  /**
   * Update parent checkbox state based on children
   * @param {HTMLElement} detailsEl - Details element containing the parent checkbox
   */
  updateParentCheckboxState(detailsEl) {
    if (!detailsEl) return;

    const parentCb = detailsEl.querySelector("summary input.taxon-checkbox");
    if (!parentCb) return;

    parentCb.checked = false;
    parentCb.indeterminate = false;

    const leafLevelName = this.getLeafLevelName();

    const leafBoxes = Array.from(
      detailsEl.querySelectorAll(
        `li.leaf input.taxon-checkbox[data-level="${leafLevelName}"]`,
      ),
    );
    const total = leafBoxes.length;
    const checked = leafBoxes.filter((n) => n.checked).length;

    if (total === 0) {
      parentCb.checked = false;
      parentCb.indeterminate = false;
      return;
    }

    if (checked === 0) {
      parentCb.checked = false;
      parentCb.indeterminate = false;
    } else if (checked === total) {
      parentCb.checked = true;
      parentCb.indeterminate = false;
    } else {
      parentCb.checked = false;
      parentCb.indeterminate = true;
    }
  }

  /**
   * Recompute checkbox states upward from a node
   * @param {HTMLElement} node - Starting node
   */
  recomputeUpwardsFrom(node) {
    let d = node ? node.closest("details") : null;
    while (d) {
      this.updateParentCheckboxState(d);
      d = d.parentElement?.closest("details");
    }
  }

  /**
   * Recompute entire subtree
   * @param {HTMLElement} rootDetails - Root details element
   */
  recomputeSubtree(rootDetails) {
    if (!rootDetails) return;
    const all = Array.from(rootDetails.querySelectorAll("details"));
    all.forEach((d) => this.updateParentCheckboxState(d));
    this.updateParentCheckboxState(rootDetails);
  }

  /**
   * Sync selection from left tree checkbox change
   * @param {HTMLInputElement} checkbox - Checkbox that was changed
   */
  syncFromLeft(checkbox) {
    if (!checkbox || !this.shadowRoot) return;

    const level = checkbox.dataset.level;
    const checked = checkbox.checked;
    const leafLevelName = this.getLeafLevelName();

    if (level === leafLevelName) {
      // Leaf node — just recompute parents upward
      this.recomputeUpwardsFrom(checkbox);
      return;
    }

    // Non-leaf node — cascade to all descendants
    const details = checkbox.closest("details");
    if (!details) return;

    const descendants = Array.from(
      details.querySelectorAll("input.taxon-checkbox"),
    ).filter((n) => n !== checkbox);
    descendants.forEach((d) => {
      d.checked = checked;
      d.indeterminate = false;
    });

    // Recompute parent states
    this.recomputeSubtree(details);
    this.recomputeUpwardsFrom(details);
  }

  /**
   * Clear all selections
   */
  clearAllSelections() {
    if (!this.leftRoot) return;

    // Clear checked state
    this.leftRoot
      .querySelectorAll("input.taxon-checkbox:checked")
      .forEach((cb) => {
        cb.checked = false;
      });

    // Clear indeterminate state
    this.leftRoot.querySelectorAll("input.taxon-checkbox").forEach((cb) => {
      cb.indeterminate = false;
    });
  }

  /**
   * Apply selection set to tree
   * @param {Set|Array} selectionSet - Set of path keys or array of path arrays
   * @param {Function} keyOf - Function to convert object to key (for backward compatibility)
   */
  applySelectionSet(selectionSet, keyOf = null) {
    this.clearAllSelections();

    // Batch-set all leaf checkboxes
    selectionSet.forEach((item) => {
      let path;
      if (typeof item === "string") {
        path = this.keyToPath(item);
      } else if (Array.isArray(item)) {
        path = item;
      } else if (keyOf) {
        const key = keyOf(item);
        path = this.keyToPath(key);
      } else {
        return;
      }

      const cb = this.findCheckboxByPath(path, true);
      if (cb) {
        cb.checked = true;
      }
    });

    // Single recompute pass over the entire left tree
    if (this.leftRoot) {
      this.leftRoot
        .querySelectorAll("details")
        .forEach((d) => this.updateParentCheckboxState(d));
    }
  }

  /**
   * Filter tree by search query
   * @param {string} query - Search query
   * @param {HTMLElement} root - Root element to filter (default: leftRoot)
   */
  filterTree(query, root = null) {
    const searchRoot = root || this.leftRoot;
    if (!searchRoot) return;

    const q = (query || "").trim().toLowerCase();
    const rootUl = searchRoot.querySelector("ul.list-tree");
    if (!rootUl) return;

    // Get all top-level details (first level)
    const topLevelDetails = Array.from(
      rootUl.querySelectorAll(":scope > li > details"),
    );

    if (!q) {
      // Show all
      topLevelDetails.forEach((details) => {
        const li = details.closest("li");
        li.style.display = "";
        Array.from(details.querySelectorAll("li")).forEach((childLi) => {
          childLi.style.display = "";
        });
      });
      return;
    }

    // Recursive function to check if a node or its descendants match
    const checkNode = (node) => {
      const cb = node.querySelector(
        "summary input.taxon-checkbox, input.taxon-checkbox",
      );
      if (!cb) return { matches: false, hasVisibleDescendant: false };

      const label = cb.dataset.label || "";
      const labelMatch = label.toLowerCase().includes(q);

      // Check children
      const children = Array.from(node.querySelectorAll(":scope > ul > li"));
      let hasVisibleChild = false;

      children.forEach((childLi) => {
        const childDetails = childLi.querySelector("details");
        if (childDetails) {
          const childResult = checkNode(childDetails);
          if (childResult.matches || childResult.hasVisibleDescendant) {
            hasVisibleChild = true;
            childLi.style.display = "";
            childDetails.open = true;
          } else {
            childLi.style.display = "none";
          }
        } else {
          // Leaf node
          const leafLabel = childLi.querySelector("label");
          const leafText = (leafLabel?.textContent || "").toLowerCase();
          const leafMatch = leafText.includes(q);
          if (leafMatch || labelMatch) {
            hasVisibleChild = true;
            childLi.style.display = "";
          } else {
            childLi.style.display = "none";
          }
        }
      });

      const matches = labelMatch || hasVisibleChild;
      return { matches, hasVisibleDescendant: hasVisibleChild };
    };

    // Filter each top-level node
    topLevelDetails.forEach((details) => {
      const result = checkNode(details);
      const li = details.closest("li");
      li.style.display = result.matches ? "" : "none";
      details.open = result.matches;
    });
  }
}

function debounce(func, duration) {
  let timeout;
  return function (...args) {
    const effect = () => {
      timeout = null;
      return func.apply(this, args);
    };

    clearTimeout(timeout);
    timeout = setTimeout(effect, duration);
  };
}

function hexToRgba(hex, alpha) {
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  hex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);

  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
}

class TaxonomyModalManager {
  constructor(host) {
    this.host = host;
    this.taxonomyTree = null;
    this.ui = null;
    this.selectionCommitted = new Set();
    this.selectionWorking = new Set();
    this._taxonomyTreesWired = false;
    this._storageListenerAdded = false;
    this._onKeydown = null;
  }

  /**
   * Loads and initializes the taxonomy selection modal
   * @param {string} taxonURL - URL to fetch taxonomy JSON data
   */
  async loadTaxonomyModal(taxonURL) {
    this.host.setAttribute("firstLoad", "");

    const response = await fetch(taxonURL);
    const taxonJSON = await response.json();

    this._initializeTaxonomyTree(taxonJSON);
    this._setupTaxonomySelectionHelpers();
    this._cacheModalUIReferences();
    this._bindTaxonomyTreeEvents();
    this._bindTaxonomySearch();
    this._bindModalCloseHandlers();
    this._bindTaxonomyFormSubmit();
    this._bindUserDataStorageListeners();

    this.ui.closeBtn.style.visibility = "hidden";
    this.host.shadow.querySelector("#available-taxonomy-tree").style.height = "fit-content";

    this._updateTaxonomyMessage();
  }

  _initializeTaxonomyTree(taxonJSON) {
    const modalBody = this.host.shadow.querySelector("#taxonomyModalBody");
    const taxonomyLevels = this.host.config?.taxonomy?.levelNames || [
      "family",
      "genus",
      "species",
    ];

    this.taxonomyTree = new TaxonomyTree({ levelNames: taxonomyLevels });
    modalBody.innerHTML = HTMLhelper.taxonomyModal(taxonJSON, taxonomyLevels);

    const leftRoot = this.host.shadow.querySelector("#available-taxonomy-tree");
    this.taxonomyTree.initialize(leftRoot, this.host.shadow);
  }

  _setupTaxonomySelectionHelpers() {
    this.keyOf = (item) => {
      if (item.path && Array.isArray(item.path)) {
        return this.taxonomyTree.pathToKey(item.path);
      }
      return `${item.family || ""}|${item.genus || ""}|${item.species || ""}`;
    };

    this.readSelectionSet = () => {
      const selected = this.taxonomyTree.getSelectedLeaves();
      return new Set(
        selected.map((item) => {
          if (item.path && item.path.length > 0) {
            return this.taxonomyTree.pathToKey(item.path);
          }
          return this.keyOf(item);
        })
      );
    };

    this.applySelectionSet = (selSet) => {
      this.taxonomyTree.applySelectionSet(selSet, this.keyOf);
    };
  }

  _cacheModalUIReferences() {
    const modal = this.host.shadow.querySelector(".modal");

    this.ui = {
      mapWrap: this.host.shadow.querySelector(".map-wrap"),
      content: this.host.shadow.querySelector("#app-surface"),
      backdrop: this.host.shadow.querySelector(".backdrop"),
      modal: modal,
      dialog: this.host.shadow.querySelector(".dialog"),
      closeBtn: modal.querySelector(".close"),
      clearBtn: modal.querySelector("#clearBtn"),
      modalBanner: modal.querySelector("#msgBanner"),
      loadBtn: modal.querySelector("#loadBtn"),
    };
  }

  _getSelectedSpecies() {
    const selectedLeaves = this.taxonomyTree.getSelectedLeaves();
    return selectedLeaves.map((item) => ({
      family: item.family || item.path?.[0] || "",
      genus: item.genus || item.path?.[1] || "",
      species: item.species || item.path?.[item.path.length - 1] || "",
    }));
  }

  _getSelectedTaxonomyCount() {
    return this._getSelectedSpecies().length;
  }

  _updateTaxonomyMessage() {
    if (!this.ui?.modalBanner || !this.ui?.loadBtn) return;

    const count = this._getSelectedTaxonomyCount();
    const userDataLoaded = localStorage.getItem("AMRTrackerUserDataLoaded") === "true";
    let messageText;

    this.ui.modalBanner.classList.remove("warn", "success");

    if (count === 0) {
      if (userDataLoaded) {
        this.ui.loadBtn.classList.remove("disabled");
        messageText = "User data loaded. Click 'Display Selection' to view your data.";
        this.ui.modalBanner.classList.add("success");
      } else {
        messageText = "Please select at least 1 genome.";
        this.ui.loadBtn.classList.add("disabled");
      }
    } else if (count >= this.host.constructor.TAXONOMY_SELECTION_WARNING_THRESHOLD) {
      this.ui.loadBtn.classList.remove("disabled");
      messageText = `You have selected ${count} genomes, which may result in long load time.`;
      this.ui.modalBanner.classList.add("warn");
    } else {
      this.ui.loadBtn.classList.remove("disabled");
      messageText = `You have selected ${count} genomes.`;
      this.ui.modalBanner.classList.add("success");
    }

    this.ui.modalBanner.querySelector("p").textContent = messageText;
  }

  _bindTaxonomyTreeEvents() {
    if (this._taxonomyTreesWired) return;

    const leftRoot = this.host.shadow.querySelector("#available-taxonomy-tree");

    if (leftRoot) {
      leftRoot.addEventListener(
        "click",
        (e) => {
          const checkbox = e.target.closest("input.taxon-checkbox");
          if (checkbox) {
            e.stopPropagation();
          }
        },
        true
      );

      leftRoot.addEventListener("change", (e) => {
        const checkbox = e.target.closest("input.taxon-checkbox");
        if (!checkbox) return;
        this.taxonomyTree.syncFromLeft(checkbox);
        this.selectionWorking = this.readSelectionSet();
        this._updateTaxonomyMessage();
      });
    }

    this._taxonomyTreesWired = true;
  }

  _bindTaxonomySearch() {
    const searchInput = this.host.shadow.querySelector("#taxonomy-search");
    const leftRoot = this.host.shadow.querySelector("#available-taxonomy-tree");

    if (searchInput && leftRoot) {
      searchInput.addEventListener(
        "input",
        debounce(() => {
          this.taxonomyTree.filterTree(searchInput.value, leftRoot);
        }, 120)
      );
    }
  }

  _bindModalCloseHandlers() {
    const modal = this.ui.modal;
    const backdrop = this.ui.backdrop;
    const closeBtn = this.ui.closeBtn;
    const clearBtn = this.ui.clearBtn;

    this._onKeydown = (e) => {
      if (e.key === "Escape") {
        if (!this.host.hasAttribute("firstLoad") && !this.host.hasAttribute("loading")) {
          this.closeModal();
        }
      }
    };

    modal.addEventListener("click", (e) => {
      if (!this.host.hasAttribute("firstLoad") && !this.host.hasAttribute("loading")) {
        if (e.target === modal) this.closeModal();
      }
    });

    backdrop.addEventListener("click", () => {
      if (!this.host.hasAttribute("firstLoad") && !this.host.hasAttribute("loading")) {
        this.closeModal();
      }
    });

    closeBtn.addEventListener("click", () => {
      if (!this.host.hasAttribute("firstLoad") && !this.host.hasAttribute("loading")) {
        this.closeModal();
      }
    });

    clearBtn.addEventListener("click", () => {
      if (!this.host.hasAttribute("loading")) {
        this.taxonomyTree.clearAllSelections();
        this._updateTaxonomyMessage();
      }
    });
  }

  _bindTaxonomyFormSubmit() {
    const form = this.host.shadow.querySelector("#dataForm");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      this.host.setAttribute("loading", "");

      const species = this._getSelectedSpecies();
      const userDataLoaded = localStorage.getItem("AMRTrackerUserDataLoaded") === "true";

      if (species.length > 0) {
        await this.host.dataLoader.updateDataObject(this.host.config.dataAPI.url, species, this.host.config);
        await this.host.loadData();
      } else if (userDataLoaded) {
        this.host.dataLoader.dataObj = [];
        await this.host.loadData();
      } else {
        this.host.removeAttribute("loading");
        return;
      }

      const allFilters = this.host.dataLoader.getAllFilters();
      this.host.generateFilters(allFilters);
      this.host.clearMapMarkers();
      this.host.loadMap(true);

      this.host.removeAttribute("firstLoad");
      this.ui.closeBtn.style.visibility = "visible";

      this.selectionCommitted = this.readSelectionSet();
      this.selectionWorking = new Set(this.selectionCommitted);
      this.closeModal(true);
    });
  }

  _bindUserDataStorageListeners() {
    if (this._storageListenerAdded) return;

    const updateMessage = () => this._updateTaxonomyMessage();

    window.addEventListener("storage", (e) => {
      if (e.key === "AMRTrackerUserDataLoaded") {
        updateMessage();
      }
    });

    document.addEventListener("userDataLoaded", () => {
      updateMessage();
    });

    this._storageListenerAdded = true;
  }

  openModal() {
    if (this.host.hasAttribute("open")) return;
    this.host.setAttribute("open", "");
    document.addEventListener("keydown", this._onKeydown);

    this.ui?.backdrop?.setAttribute("aria-hidden", "false");
    this.ui?.modal?.setAttribute("aria-hidden", "false");
    this.ui?.content?.setAttribute("inert", "");

    this._updateTaxonomyMessage();

    const first = this.host.shadowRoot.querySelector(
      ".dialog button, .dialog [href], .dialog input, .dialog select, .dialog textarea, .dialog [tabindex]:not([tabindex='-1'])"
    );
    if (first) first.focus();
  }

  closeModal(loaded = false) {
    if (!this.host.hasAttribute("open")) return;
    try {
      this.host.removeAttribute("open");
    } catch (err) {
      console.error(err);
    }
    document.removeEventListener("keydown", this._onKeydown);

    this.ui?.content?.removeAttribute("inert");

    if (loaded) {
      this.selectionCommitted = new Set(this.selectionWorking || []);
    } else {
      this.applySelectionSet(this.selectionCommitted || new Set());
    }
  }
}

// PieChart.js
/**
 * Creates multi-ring pie charts for map markers using Chart.js
 * This type of chart is separate from the baseChart.js class.
 * @class PieChart
 */
class PieChart {
  /**
   * @param {Object} options - Configuration options
   * @param {number} [options.size=80] - Chart size in pixels
   * @param {number} [options.topN=5] - Number of top items to display per ring
   * @param {boolean} [options.includeOther=false] - Whether to include "Other" category
   * @param {Object} options.config - Filter configuration object
   * @param {Object} options.speciesColorMap - Color mapping for species
   * @param {ShadowRoot} options.shadowRoot - Shadow DOM root for tooltip
   */
  constructor(options) {
    this.size = options.size ?? 80;
    this.topN = options.topN ?? 5;
    this.includeOther = options.includeOther ?? false;
    this.config = options.config;
    this.speciesColorMap = options.speciesColorMap;
    this.shadowRoot = options.shadowRoot;

    // Ring geometry configuration (outer to inner)
    this.ringGeom = [
      { cutout: "75%", radius: "90%" }, // outer
      { cutout: "55%", radius: "75%" }, // middle
      { cutout: "20%", radius: "55%" }, // inner
    ];

    // Cache for filter lookups to avoid repeated find() calls
    this._filterCache = new Map();
    this._tooltipEl = null;
  }

  /**
   * Main entry point - creates and returns the pie chart container
   * @param {LocationData} locationObj - Location data object
   * @returns {HTMLElement|null} Chart container element or null if no data
   */
  create(locationObj) {
    // Process candidates from location data
    const candidates = this._processCandidates(locationObj);
    const nonEmpty = candidates.filter(
      (r) => r.display && Array.isArray(r.counts) && r.counts.some((v) => v > 0)
    );

    // Return null if no data to display
    if (nonEmpty.length === 0) {
      return null;
    }

    // Create container and canvases
    const chartContainer = this._createContainer();
    const canvases = this._createCanvases();
    canvases.forEach((c) => chartContainer.appendChild(c));

    // Map candidates to rings with geometry (inner first)
    const innerFirstGeom = [...this.ringGeom].reverse();
    const rings = nonEmpty
      .slice(0, innerFirstGeom.length)
      .map((r, i) => ({ ...r, ...innerFirstGeom[i] }));

    // Show/hide canvases based on number of rings
    canvases.forEach((c, i) => {
      if (i < rings.length) {
        c.style.display = "block";
        c.style.zIndex = String(i + 1); // inner lowest, outer highest
      } else {
        c.style.display = "none";
      }
    });

    // Create Chart.js instances
    const charts = this._createCharts(rings, canvases);

    // Setup tooltip
    this._setupTooltip();

    // Create overlay for interactions
    const overlay = this._createOverlay();
    chartContainer.appendChild(overlay);

    // Setup event handlers
    this._setupInteractions(overlay, rings, charts, canvases, locationObj.name);

    // Expose cleanup on the container for marker lifecycle management
    chartContainer._pieCharts = charts;
    chartContainer._destroyPieCharts = () => {
      charts.forEach((chart) => chart?.destroy?.());
    };

    return chartContainer;
  }

  /**
   * Creates the main chart container element
   * @private
   * @returns {HTMLElement} Container element
   */
  _createContainer() {
    const container = document.createElement("div");
    container.style.position = "relative";
    container.style.width = `${this.size}px`;
    container.style.height = `${this.size}px`;
    container.style.overflow = "visible";
    return container;
  }

  /**
   * Creates layered canvas elements for multi-ring charts
   * @private
   * @returns {HTMLCanvasElement[]} Array of canvas elements
   */
  _createCanvases() {
    const mkCanvas = (z) => {
      const c = document.createElement("canvas");
      c.width = this.size;
      c.height = this.size;
      c.style.position = "absolute";
      c.style.left = "0";
      c.style.top = "0";
      c.style.width = `${this.size}px`;
      c.style.height = `${this.size}px`;
      c.style.zIndex = String(z);
      c.style.pointerEvents = "none";
      return c;
    };
    return [mkCanvas(1), mkCanvas(2), mkCanvas(3)];
  }

  /**
   * Processes location data into chart candidates
   * Optimized to cache filter lookups
   * @private
   * @param {LocationData} locationObj - Location data object
   * @returns {Array} Array of candidate objects with title, labels, counts, backgroundColor, display
   */
  _processCandidates(locationObj) {
    return locationObj.filterCategories.map((dim) => {
      // Cache filter lookup to avoid repeated find() calls
      const filter = this._getFilter(dim);
      if (!filter) {
        return {
          title: dim,
          labels: [],
          counts: [],
          backgroundColor: [],
          display: false,
        };
      }

      const title = filter.alias;
      const display = filter.onPieChart;
      const { labels, counts } = locationObj.getTopNDatasetForDimension(
        dim,
        this.topN,
        this.includeOther
      );

      let backgroundColor;
      if (dim === "species") {
        backgroundColor = labels.map(
          (label) => this.speciesColorMap?.[label] ?? "#000"
        );
      } else {
        const palette = filter.chartColors?.pie ?? ["#000"];
        backgroundColor = labels.map((_, idx) => palette[idx % palette.length]);
      }

      return { title, labels, counts, backgroundColor, display };
    });
  }

  /**
   * Gets filter config for a dimension, using cache
   * @private
   * @param {string} dim - Dimension/column name
   * @returns {Object|null} Filter configuration object
   */
  _getFilter(dim) {
    if (!this._filterCache.has(dim)) {
      const filter = this.config.filters?.find((f) => f.column === dim);
      this._filterCache.set(dim, filter || null);
    }
    return this._filterCache.get(dim);
  }

  /**
   * Creates Chart.js instances for each ring
   * @private
   * @param {Array} rings - Array of ring data with geometry
   * @param {HTMLCanvasElement[]} canvases - Array of canvas elements
   * @returns {Chart[]} Array of Chart.js instances
   */
  _createCharts(rings, canvases) {
    return rings.map((ring, i) => {
      const ctx = canvases[i].getContext("2d");
      return new Chart(ctx, {
        type: "doughnut",
        data: {
          labels: ring.labels,
          datasets: [
            {
              label: ring.title,
              data: ring.counts,
              backgroundColor: ring.backgroundColor,
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          events: [],
          cutout: ring.cutout,
          radius: ring.radius,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          },
        },
      });
    });
  }

  /**
   * Creates overlay element for mouse/touch interactions
   * @private
   * @returns {HTMLElement} Overlay element
   */
  _createOverlay() {
    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.width = `${this.size}px`;
    overlay.style.height = `${this.size}px`;
    overlay.style.zIndex = "999";
    overlay.style.pointerEvents = "auto";
    return overlay;
  }

  /**
   * Ensures tooltip element exists in shadow DOM
   * @private
   * @returns {HTMLElement} Tooltip element
   */
  _setupTooltip() {
    if (!this._tooltipEl) {
      let el = this.shadowRoot.getElementById("chartjs-tooltip");
      if (!el) {
        el = document.createElement("div");
        el.id = "chartjs-tooltip";
        el.style.position = "absolute";
        el.style.pointerEvents = "none";
        el.style.opacity = "0";
        el.innerHTML = "<table></table>";
        this.shadowRoot.appendChild(el);
      }
      this._tooltipEl = el;
    }
    return this._tooltipEl;
  }

  /**
   * Gets ring radii from a Chart.js instance
   * @private
   * @param {Chart} chart - Chart.js instance
   * @returns {Object|null} Object with inner and outer radius, or null
   */
  _getRingRadii(chart) {
    const meta = chart.getDatasetMeta(0);
    const el = meta?.data?.[0];
    if (!el) return null;
    return { inner: el.innerRadius, outer: el.outerRadius };
  }

  /**
   * Shows tooltip for a specific ring
   * @private
   * @param {Object} ring - Ring data object
   * @param {number} clientX - Mouse X coordinate
   * @param {number} clientY - Mouse Y coordinate
   * @param {string} locationName - Location name for tooltip header
   */
  _showTooltip(ring, clientX, clientY, locationName) {
    if (!ring || !this._tooltipEl) return;

    // Build table rows for all segments in ring
    let rowsHtml = "";
    for (let i = 0; i < ring.labels.length; i++) {
      const color = ring.backgroundColor[i];
      const bullet = `<span class="tooltip-bullet" style="color:${escapeAttr(color)}">•</span>`;
      const label = ring.labels[i];
      const value = ring.counts[i];
      rowsHtml += `<tr><td>${bullet}${escapeHtml(label)}: ${escapeHtml(String(value))}</td></tr>`;
    }

    const html = `
      <thead><tr><th>${escapeHtml(locationName)} - ${escapeHtml(ring.title)}</th></tr></thead>
      <tbody class="chart-js-tooltip-tr">${rowsHtml}</tbody>
    `;
    this._tooltipEl.querySelector("table").innerHTML = html;

    this._tooltipEl.style.opacity = "1";

    // Position relative to shadow host to avoid layout offsets in production
    const hostRect = this.shadowRoot?.host?.getBoundingClientRect?.();
    const left = hostRect ? clientX - hostRect.left : clientX;
    const top = hostRect ? clientY - hostRect.top : clientY;
    this._tooltipEl.style.left = `${left + 8}px`;
    this._tooltipEl.style.top = `${top + 8}px`;
  }

  /**
   * Hides the tooltip
   * @private
   */
  _hideTooltip() {
    if (this._tooltipEl) {
      this._tooltipEl.style.opacity = "0";
    }
  }

  /**
   * Sets up mouse and touch event handlers for tooltip interactions
   * Optimized to cache center calculations
   * @private
   * @param {HTMLElement} overlay - Overlay element
   * @param {Array} rings - Array of ring data
   * @param {Chart[]} charts - Array of Chart.js instances
   * @param {HTMLCanvasElement[]} canvases - Array of canvas elements
   * @param {string} locationName - Location name for tooltip
   */
  _setupInteractions(overlay, rings, charts, canvases, locationName) {
    // Cache center calculation - only recalculate when needed
    let cachedCenter = null;
    let cachedRect = null;

    const getCenter = () => {
      // Only recalculate if canvas position might have changed
      const rect = canvases[0].getBoundingClientRect();
      if (
        !cachedRect ||
        cachedRect.left !== rect.left ||
        cachedRect.top !== rect.top ||
        cachedRect.width !== rect.width ||
        cachedRect.height !== rect.height
      ) {
        cachedRect = rect;
        cachedCenter = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      return cachedCenter;
    };

    overlay.addEventListener("mousemove", (e) => {
      const { x: cx, y: cy } = getCenter();
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const r = Math.hypot(dx, dy);

      // Find which ring the mouse is over (check from outer to inner)
      let activeRingIndex = -1;
      for (let i = charts.length - 1; i >= 0; i--) {
        const rr = this._getRingRadii(charts[i]);
        if (!rr) continue;
        if (r >= rr.inner && r <= rr.outer) {
          activeRingIndex = i;
          break;
        }
      }

      if (activeRingIndex === -1) {
        this._hideTooltip();
        return;
      }

      this._showTooltip(
        rings[activeRingIndex],
        e.clientX,
        e.clientY,
        locationName
      );
    });

    overlay.addEventListener("mouseleave", () => this._hideTooltip());

    // Touch event handlers
    const handleTouch = (e) => {
      const t = e.touches?.[0];
      if (t) {
        overlay.dispatchEvent(
          new MouseEvent("mousemove", {
            clientX: t.clientX,
            clientY: t.clientY,
          })
        );
      }
    };

    overlay.addEventListener("touchstart", handleTouch, { passive: true });
    overlay.addEventListener("touchmove", handleTouch, { passive: true });
    overlay.addEventListener("touchend", () => this._hideTooltip());
  }
}

class MapMarkerManager {
  constructor(host) {
    this.host = host;
  }

  clearMapMarkers() {
    this.host.markersArray.forEach((marker) => {
      const content = marker?._pieChartContent;
      if (content?._destroyPieCharts) {
        content._destroyPieCharts();
      } else if (Array.isArray(content?._pieCharts)) {
        content._pieCharts.forEach((chart) => chart?.destroy?.());
      }
      marker.remove();
    });
    this.host.markersArray.length = 0;

    this._removeZoomListener();
  }

  _getMarkerPieChartSizeConfig() {
    const sizeConfig = this.host.config?.mapOptions?.markerPieChartSize ?? {};
    const minSize = Number.isFinite(sizeConfig.min) ? sizeConfig.min : 40;
    const maxSize = Number.isFinite(sizeConfig.max) ? sizeConfig.max : 120;
    return {
      min: Math.min(minSize, maxSize),
      max: Math.max(minSize, maxSize),
    };
  }

  computeMarkerSizeScale() {
    const { min, max } = this._getMarkerPieChartSizeConfig();
    let minCount = Infinity;
    let maxCount = -Infinity;

    if (this.host.locationObjs) {
      for (const key of Object.keys(this.host.locationObjs)) {
        const locationObj = this.host.locationObjs[key];
        if (!locationObj?.country) continue;
        const count = Number(locationObj.genomeCount ?? 0);
        if (!Number.isFinite(count)) continue;
        minCount = Math.min(minCount, count);
        maxCount = Math.max(maxCount, count);
      }
    }

    if (!Number.isFinite(minCount)) minCount = 0;
    if (!Number.isFinite(maxCount)) maxCount = 0;

    this.host._markerSizeScale = {
      minCount,
      maxCount,
      minSize: min,
      maxSize: max,
    };
    return this.host._markerSizeScale;
  }

  _getMarkerPieChartSize(locationObj) {
    const scale = this.host._markerSizeScale || this.computeMarkerSizeScale();
    const count = Number(locationObj?.genomeCount ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      return Math.round(scale.minSize);
    }

    const minCount = Math.max(scale.minCount, 1);
    const maxCount = Math.max(scale.maxCount, minCount);
    if (maxCount === minCount) {
      return Math.round(scale.minSize);
    }

    const logMin = Math.log10(minCount);
    const logMax = Math.log10(maxCount);
    const logVal = Math.log10(Math.max(count, minCount));
    const t = (logVal - logMin) / (logMax - logMin);
    const clamped = Math.min(1, Math.max(0, t));
    return Math.round(
      scale.minSize + (scale.maxSize - scale.minSize) * clamped,
    );
  }

  createPin(locationObj, key) {
    const position = locationObj.getCoordinates();
    const chartsEnabled = this.host.config.mapOptions.showMarkerPieCharts;
    const markerContent = chartsEnabled
      ? this.createPieChart(locationObj)
      : null;

    if (!Number.isNaN(position.lat) && !Number.isNaN(position.lng)) {
      let marker;

      if (markerContent) {
        const size = this._getMarkerPieChartSize(locationObj);
        const icon = L.divIcon({
          className: "pie-chart-marker",
          html: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });

        marker = L.marker([position.lat, position.lng], { icon }).addTo(
          this.host.map,
        );

        requestAnimationFrame(() => {
          const iconElement = marker.getElement();
          if (iconElement) {
            iconElement.innerHTML = "";
            iconElement.appendChild(markerContent);
          }
        });

        marker._pieChartContent = markerContent;
      } else {
        marker = L.marker([position.lat, position.lng]).addTo(this.host.map);
      }

      marker.on("click", () => {
        const active =
          this.host.activeChartIDPreference || this.host.activeChartID || null;

        this.host.activeLocation = key;
        this.host.createCharts(locationObj, key, active);
        this.host.expandMenu(this.host.shadow.getElementById("charts"));

        if (this.host.config.mapOptions.centerOnMarkerClick) {
          this.host.map.panTo(marker.getLatLng());
        }
      });
      marker.isStateLevel = locationObj.isStateLevel;
      marker.isUSACountry =
        locationObj.country === "United States" && !locationObj.isStateLevel;

      if (locationObj.isStateLevel || marker.isUSACountry) {
        this._checkMarkerZoom(marker);
      }

      this._setupZoomListener();

      return marker;
    }
    return false;
  }

  createPieChart(locationObj) {
    const size = this._getMarkerPieChartSize(locationObj);
    const pieChart = new PieChart({
      size,
      topN: this.host.constructor.PIE_CHART_TOP_N,
      includeOther: false,
      config: this.host.config,
      speciesColorMap: this.host.speciesColorMap,
      shadowRoot: this.host.shadow,
    });
    return pieChart.create(locationObj);
  }

  _checkMarkerZoom(marker) {
    if (!this.host.map || !marker) return;

    const zoom = this.host.map.getZoom();
    const isZoomedIn = zoom >= this.host.constructor.STATE_LEVEL_ZOOM_THRESHOLD;

    if (marker.isStateLevel) {
      if (isZoomedIn) {
        if (!this.host.map.hasLayer(marker)) {
          marker.addTo(this.host.map);
          this._reattachPieChartContent(marker);
        }
      } else {
        if (this.host.map.hasLayer(marker)) {
          marker.remove();
        }
      }
    }
    // else if (marker.isUSACountry) {
    //   if (isZoomedIn) {
    //     if (this.host.map.hasLayer(marker)) {
    //       marker.remove();
    //     }
    //   } else {
    //     if (!this.host.map.hasLayer(marker)) {
    //       marker.addTo(this.host.map);
    //       this._reattachPieChartContent(marker);
    //     }
    //   }
    // }
  }

  _reattachPieChartContent(marker) {
    const content = marker._pieChartContent;
    if (!content) return;

    requestAnimationFrame(() => {
      const iconElement = marker.getElement();
      if (iconElement) {
        iconElement.innerHTML = "";
        iconElement.appendChild(content);
      }
    });
  }

  _setupZoomListener() {
    if (this.host._zoomChangeListener) return;

    this.host._zoomChangeListener = () => {
      this.host.markersArray.forEach((marker) => {
        if (marker.isStateLevel || marker.isUSACountry) {
          this._checkMarkerZoom(marker);
        }
      });
    };
    this.host.map.on("zoomend", this.host._zoomChangeListener);
  }

  _removeZoomListener() {
    if (this.host._zoomChangeListener && this.host.map) {
      this.host.map.off("zoomend", this.host._zoomChangeListener);
      this.host._zoomChangeListener = null;
    }
  }

  destroy() {
    if (this.host.markersArray) {
      for (const marker of this.host.markersArray) {
        if (marker._pieChartContent?._destroyPieCharts) {
          marker._pieChartContent._destroyPieCharts();
        }
        marker.remove();
      }
      this.host.markersArray = [];
    }

    if (this.host._zoomChangeListener && this.host.map) {
      this.host.map.off("zoomend", this.host._zoomChangeListener);
      this.host._zoomChangeListener = null;
    }
  }
}

// BaseChart.js

// --- Shared Constants ---
const CHART_DEFAULTS = {
  TOOLTIP_ITEM_LIMIT: 10,
  BASE_COLORS: [
    "#3b82f6", // blue
    "#ef4444", // red
    "#10b981", // green
    "#f59e0b", // amber
    "#8b5cf6", // purple
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#84cc16", // lime
    "#f97316", // orange
    "#6366f1", // indigo
  ],
};

class BaseChart {
  constructor(container, config = {}) {
    this.container = container;
    this.config = config; // { colors, fonts, interaction settings }
    this.chartInstance = null;
    this.resizeObserver = null;
    this.isMaximized = false;
  }

  /**
   * Main render entry point.
   * @param {any} data - Raw data (usually LocationData)
   * @param {object} context - { filterConfig, viewMode, etc }
   */
  render(locationObj, context) {
    this.destroy();

    if (typeof Chart !== "undefined") {
      Chart.defaults.font.family = "Inter, system-ui, sans-serif";
      // Chart.defaults.color = "#333";
    }

    const { data, options, layoutLogic } = this._prepareConfig(
      locationObj,
      context
    );
    // 1. Prepare DOM
    this._setupContainer(layoutLogic);

    // 2. Transform Data (Child implements this)

    // 3. Create Chart
    const canvas = this._createCanvas();
    this.chartInstance = new Chart(canvas.getContext("2d"), {
      type: this._getType(),
      data: data,
      options: options,
      plugins: this._getPlugins(context),
    });

    // 4. Observe
    this._attachResizeObserver();
    this.container._chartRenderer = this;
  }

  destroy() {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.container.innerHTML = "";
  }

  // --- Helpers ---

  _createCanvas() {
    const canvas = document.createElement("canvas");
    canvas.role = "img";
    Object.assign(this.container.style, {
      position: "relative",
      minWidth: "0",
    });
    this.container.appendChild(canvas);
    return canvas;
  }

  _attachResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => {
      // Safety check: ensure instance exists and canvas is attached
      if (this.chartInstance && this.chartInstance.canvas.isConnected) {
        this.chartInstance.resize();
      }
    });
    this.resizeObserver.observe(this.container);
  }

  _getType() {
    throw new Error("Method '_getType()' must be implemented.");
  }
  _prepareConfig(data, context) {
    throw new Error("Method '_prepareConfig()' must be implemented.");
  }
  _getPlugins(context) {
    return [];
  }

  _setupContainer() {
    Object.assign(this.container.style, {
      flex: "1 1 auto",
      minHeight: "0",
      minWidth: "0",
      position: "relative",
      width: "100%",
      height: "100%",
    });
  }

  // --- Shared Utility Methods ---

  /**
   * Generate an array of colors for chart datasets
   * @param {number} count - Number of colors needed
   * @returns {Array<string>} Array of color hex codes
   */
  _generateColors(count) {
    const baseColors = CHART_DEFAULTS.BASE_COLORS;

    if (count <= baseColors.length) {
      return baseColors.slice(0, count);
    }

    const colors = [...baseColors];
    for (let i = baseColors.length; i < count; i++) {
      const hue = (i * 137.508) % 360; // Golden angle for distribution
      colors.push(`hsl(${hue}, 70%, 50%)`);
    }
    return colors;
  }

  /**
   * Convert hex color to rgba string
   * @param {string} hex - Hex color code (e.g., "#3b82f6")
   * @param {number} alpha - Alpha value (0-1)
   * @returns {string} RGBA color string
   */
  _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Plugin to display message when chart has no data
   * @param {string} message - Message to display
   * @returns {object} Chart.js plugin
   */
  _getNoDataPlugin(message = "No matching data") {
    return {
      id: "noData",
      afterDraw(chart) {
        const hasData = chart.data.datasets.some(
          (ds) => ds.data && ds.data.length > 0 && ds.data.some((v) => v > 0)
        );
        if (hasData) return;
        const {
          ctx,
          chartArea: { width, height },
        } = chart;
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(100,100,100,0.8)";
        ctx.fillText(message, width / 2, height / 2);
        ctx.restore();
      },
    };
  }

  /**
   * Plugin to limit tooltip items to top N by value
   * @param {number} limit - Maximum items to show
   * @returns {object} Chart.js plugin
   */
  _getTooltipLimitPlugin(limit = CHART_DEFAULTS.TOOLTIP_ITEM_LIMIT) {
    return {
      id: "tooltipLimit",
      beforeTooltipDraw: (chart) => {
        const tooltip = chart.tooltip;
        if (!tooltip) return;

        const allItems = tooltip.items || tooltip.dataPoints || [];
        if (!Array.isArray(allItems) || allItems.length <= limit) return;

        const itemsWithValues = allItems.map((item, index) => {
          let value;
          if (item.dataset.originalData) {
            value = item.dataset.originalData[item.dataIndex] ?? 0;
          } else {
            value = item.parsed?.y ?? item.parsedY ?? 0;
          }
          return { item, value, originalIndex: index };
        });

        const validItems = itemsWithValues
          .filter(
            ({ value }) =>
              value !== null &&
              value !== undefined &&
              !isNaN(value) &&
              value > 0
          )
          .sort((a, b) => b.value - a.value)
          .slice(0, limit);

        const topItems = new Set(validItems.map(({ item }) => item));
        tooltip.items = allItems.filter((item) => topItems.has(item));

        if (tooltip.dataPoints && Array.isArray(tooltip.dataPoints)) {
          tooltip.dataPoints = tooltip.items;
        }
      },
    };
  }

  /**
   * Apply styling for compare mode with matched colors between base and user data
   * @param {Array} datasets - Raw datasets
   * @param {object} options - Chart-specific styling options
   * @param {boolean} options.fill - Whether to fill area under line
   * @param {string} options.stack - Stack group name (null for no stacking)
   * @param {number} options.fillOpacity - Opacity multiplier for fill color
   * @param {number} options.pointRadius - Point radius (0 to hide)
   * @returns {Array} Styled datasets
   */
  _applyCompareModeStyling(datasets, options = {}) {
    const {
      fill = false,
      stack = null,
      fillOpacity = 0.125,
      pointRadius = 3,
    } = options;

    const hasBaseData = datasets.some((ds) => ds.isUserData !== true);
    const userDataSuffix = " (User Data)";

    // Group datasets by characteristic name
    const charNames = new Set();
    for (const ds of datasets) {
      let charName = ds.label;
      if (ds.isUserData && charName.endsWith(userDataSuffix)) {
        charName = charName.slice(0, -userDataSuffix.length);
      }
      charNames.add(charName);
    }

    const colors = this._generateColors(charNames.size);
    const colorMap = new Map();
    Array.from(charNames).forEach((name, index) => {
      colorMap.set(name, colors[index]);
    });

    return datasets.map((ds) => {
      let charName = ds.label;
      const isUserData = ds.isUserData === true;

      if (isUserData && charName.endsWith(userDataSuffix)) {
        charName = charName.slice(0, -userDataSuffix.length);
      }

      const baseColor = colorMap.get(charName) || CHART_DEFAULTS.BASE_COLORS[0];
      const opacity = isUserData ? 0.7 : 1.0;
      const borderColor = this._hexToRgba(baseColor, opacity);
      const borderDash = hasBaseData && isUserData ? [6, 4] : undefined;

      return {
        ...ds,
        borderColor,
        backgroundColor: this._hexToRgba(baseColor, opacity * fillOpacity),
        borderDash,
        fill,
        ...(stack && { stack }),
        tension: 0.1,
        pointRadius,
        pointHoverRadius: 5,
        pointBackgroundColor: borderColor,
        pointBorderColor: "#fff",
        pointBorderWidth: 2,
      };
    });
  }
}

// StackedBarChart.js

// --- Layout Constants ---
const LAYOUT$2 = {
  MIN_BAR_PX: 15,
  MAX_BAR_PX: 80,
  GAP_PX: 3,
  MIN_SIDE_PAD_PX: 8,
  BAR_PCT_SINGLE: 0.75,
};

/**
 * StackedBarChart - Displays relationships between two dimensions.
 * Shows primary dimension on x-axis with stacks colored by secondary dimension.
 * Uses relational indexes from gene observation processing.
 */
class StackedBarChart extends BaseChart {
  constructor(container, config) {
    super(container, config);
    this.layoutState = {
      calculatedTickWidth: 0,
      calculatedGroupWidth: 0,
      calculatedSidePad: 0,
    };
  }

  _getType() {
    return "bar";
  }

  _prepareConfig(locationObj, context) {
    const { filterConfig, userOptions, isFullscreen, colorMaps } = context;

    const safeLocation = locationObj || {
      genomeCount: 0,
      observationCount: 0,
      name: "No Data",
      getHierarchicalData: () => ({
        labels: [],
        datasets: [],
        secondaryLabels: [],
        maxLength: 0,
      }),
    };

    // --- 1. Determine secondary dimension ---
    const secondaryDim = userOptions?.secondaryDim ||
      filterConfig.hierarchicalOptions?.secondaryDimensions?.[0] ||
      "species";

    const primaryDim = filterConfig.column;
    const isRelative = (userOptions?.yAxis ?? "absolute") === "relative";
    const numberToDisplay = isFullscreen ? undefined : 10;

    // --- 2. Determine color palette based on secondary dimension ---
    let palette = colorMaps?.secondary;
    if (secondaryDim === "species") {
      palette = colorMaps?.species;
    } else if (secondaryDim === "genus") {
      palette = colorMaps?.genus;
    }

    // --- 3. Fetch Hierarchical Data ---
    const dataMode = userOptions?.dataMode ?? null;
    const rawData = safeLocation.getHierarchicalData({
      primaryDim: primaryDim,
      secondaryDim: secondaryDim,
      topN: numberToDisplay,
      sort: userOptions?.sort ?? "count",
      palette: palette,
      dataMode: dataMode,
    });

    // --- 3. Process Data (Percentages & Styling) ---
    const labelCount = rawData.labels.length;
    const labelTotals = new Array(labelCount).fill(0);
    if (isRelative) {
      for (const ds of rawData.datasets) {
        for (let i = 0; i < labelCount; i++) {
          labelTotals[i] += ds.data[i] || 0;
        }
      }
    }

    const datasets = rawData.datasets.map((ds) => {
      // Styling
      ds.minBarLength = 6;
      ds.borderColor = "#fff";
      ds.borderWidth = 1;

      // Keep absolute copy for tooltips
      ds._absData = ds.data.map((v) => (v === 0 ? null : v));

      // Transform to Relative if needed (per-label percentage)
      ds.data = ds._absData.map((v, i) => {
        if (v == null) return null;
        if (isRelative) return labelTotals[i] > 0 ? (v / labelTotals[i]) * 100 : 0;
        return v;
      });

      return ds;
    });

    // --- 4. Generate Titles ---
    const secondaryAlias = this.#getDimensionAlias(secondaryDim, context);
    const primaryAlias = filterConfig.alias || primaryDim;

    const title = `${safeLocation.name || "No Name"} ${primaryAlias} by ${secondaryAlias}`;
    let subtitle;
    if (
      numberToDisplay === undefined ||
      rawData.labels.length < numberToDisplay
    ) {
      subtitle = `${rawData.labels.length} ${primaryAlias.toLowerCase()} values`;
    } else {
      subtitle = `Top ${numberToDisplay} of ${rawData.maxLength} ${primaryAlias.toLowerCase()} values`;
    }

    // --- 5. Prepare Layout State ---
    // Count unique stack groups (1 for merge mode, 2 for compare mode with both data sources)
    const uniqueStacks = new Set(datasets.map(ds => ds.stack));
    const stackCount = uniqueStacks.size || 1;

    const layoutLogic = {
      labelsCount: rawData.labels.length,
      barsPerCategory: stackCount,
      barPercentage: LAYOUT$2.BAR_PCT_SINGLE,
      isRelative,
      title,
      subtitle,
      secondaryDim,
      secondaryLabels: rawData.secondaryLabels,
    };

    // --- 6. Build Chart Options ---
    const options = {
      responsive: true,
      animation: false,
      maintainAspectRatio: false,
      indexAxis: "x",
      layout: {},
      scales: this._getScales(isRelative),
      datasets: {
        bar: {
          barThickness: (ctx) =>
            this._clampBarThickness(ctx, stackCount, LAYOUT$2.BAR_PCT_SINGLE),
          barPercentage: LAYOUT$2.BAR_PCT_SINGLE,
          categoryPercentage: 1,
        },
        borderColor: "#000",
        borderWidth: 1,
        borderSkipped: false,
      },
      plugins: {
        legend: this._getLegendConfig(rawData.secondaryLabels),
        title: {
          display: true,
          text: title,
          color: "#000",
          position: "top",
        },
        subtitle: {
          display: true,
          text: subtitle,
          padding: { bottom: 2 },
        },
        tooltip: this._getTooltipConfig(isRelative, primaryAlias, secondaryAlias),
      },
    };

    return {
      data: { labels: rawData.labels, datasets },
      options,
      layoutLogic,
    };
  }

  #getDimensionAlias(dim, context) {
    // Try to find alias from filter config
    const filterConfigs = context.filterConfigs || [];
    const filterConfig = filterConfigs.find(f => f.column === dim);
    return filterConfig?.alias || dim.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  // --- Layout Helpers ---

  _setupContainer(layoutLogic) {
    const { labelsCount, barsPerCategory, barPercentage } = layoutLogic;

    const { MIN_BAR_PX, MIN_SIDE_PAD_PX, GAP_PX } = LAYOUT$2;
    const minBarsBlock = (MIN_BAR_PX * barsPerCategory) / barPercentage;
    const minCategoryWidth = minBarsBlock + MIN_SIDE_PAD_PX * 2;
    const minSlotWidth = minCategoryWidth;
    const neededWidth = Math.ceil(labelsCount * (minSlotWidth + GAP_PX));

    Object.assign(this.container.style, {
      flex: "1 1 auto",
      minHeight: "0",
      minWidth: "0",
      position: "relative",
      width: `max(100%, ${neededWidth}px)`,
      height: "100%",
    });
  }

  _clampBarThickness(chartCtx, barsPerCategory, barPercentage) {
    const chart = chartCtx.chart;
    const area = chart.chartArea;
    if (!area || (!area.width && !area.height)) return;

    const { MIN_BAR_PX, MAX_BAR_PX, MIN_SIDE_PAD_PX } = LAYOUT$2;

    const catSize = area.width;
    const catCount = Math.max(1, chart.data.labels?.length ?? 1);
    const categoryWidth = catSize / catCount;

    const sidePad = Math.max(MIN_SIDE_PAD_PX, Math.ceil(0.4 * MIN_BAR_PX));
    const availableForBars = Math.max(0, categoryWidth - sidePad * 2);

    const naturalBarPx = (availableForBars * barPercentage) / barsPerCategory;
    const barPx = Math.max(
      MIN_BAR_PX,
      Math.min(MAX_BAR_PX, Math.floor(naturalBarPx))
    );

    this.layoutState.calculatedGroupWidth = barPx * barsPerCategory;
    this.layoutState.calculatedSidePad = sidePad;
    this.layoutState.calculatedTickWidth =
      this.layoutState.calculatedGroupWidth + sidePad * 2 + LAYOUT$2.GAP_PX;

    return barPx;
  }

  // --- Configuration Generators ---

  _getScales(isRelative) {
    if (isRelative) {
      return {
        y: {
          grid: {
            display: false,
          },
          beginAtZero: true,
          stacked: true,
          min: 0,
          max: 100,
          grace: 0,
          ticks: { callback: (v) => `${v}%` },
        },
        x: { grid: { display: false }, ticks: { display: false, padding: 10 }, stacked: true },
      };
    }
    return {
      y: { beginAtZero: true, stacked: true, grace: 5, min: 0, grid: { display: false } },
      x: { grid: { display: false }, ticks: { display: false, padding: 10 }, stacked: true },
    };
  }

  _getTooltipConfig(isRelative, primaryAlias, secondaryAlias) {
    return {
      callbacks: {
        title: (items) => {
          if (items.length === 0) return "";
          return `${primaryAlias}: ${items[0].label}`;
        },
        label: (ctx) => {
          const ds = ctx.dataset;
          const abs = ds._absData?.[ctx.dataIndex];
          const val = ctx.raw;
          const label = ds.label || "Value";
          const absStr = abs == null ? "0" : abs.toLocaleString();

          if (isRelative) {
            const pctStr = (val == null ? 0 : val).toFixed(1) + "%";
            return `${secondaryAlias} - ${label}: ${pctStr} (${absStr})`;
          }
          return `${secondaryAlias} - ${label}: ${absStr}`;
        },
      },
    };
  }

  _getLegendConfig(secondaryLabels) {
    return {
      display: false,
      position: "left",
      labels: {
        font: { size: 12 },
        generateLabels: (chart) => {
          const defaults =
            Chart.defaults.plugins.legend.labels.generateLabels(chart);

          // Return unique labels for secondary dimension values
          const byText = new Map();
          for (const item of defaults) {
            const text = item.text ?? `Series ${item.datasetIndex + 1}`;
            if (!byText.has(text)) {
              item.datasetIndices = [item.datasetIndex];
              item.text = text;
              byText.set(text, item);
            } else {
              const tgt = byText.get(text);
              tgt.datasetIndices.push(item.datasetIndex);
              tgt.hidden = tgt.hidden && item.hidden;
            }
          }
          return Array.from(byText.values());
        },
        onClick: (e, legendItem, legend) => {
          const { chart } = legend;
          const idxs =
            legendItem.datasetIndices ||
            (legendItem.datasetIndex != null ? [legendItem.datasetIndex] : []);

          const anyVisible = idxs.some((i) => chart.isDatasetVisible(i));
          idxs.forEach((i) => chart.setDatasetVisibility(i, !anyVisible));
          chart.update();
        },
      },
    };
  }

  // --- Plugins ---

  _getPlugins(context) {
    return [
      this._getNoDataPlugin("No data available"),
      this._getBaselineCategoryLabelsPlugin(context.filterConfig),
    ];
  }

  _getBaselineCategoryLabelsPlugin(filterConfig) {
    const self = this;

    return {
      id: "baselineCategoryLabels",
      afterDatasetsDraw(chart, _args, opts) {
        const {
          ctx,
          scales: { x, y },
          chartArea,
        } = chart;
        const labels = chart.data.labels || [];
        const y0 = y.getPixelForValue(0);

        const { calculatedGroupWidth, calculatedSidePad } = self.layoutState;
        const margin = Math.min(calculatedSidePad - 2, 6);

        const glowBlur = opts?.glow ?? 0;
        const glowColor = opts?.glowColor ?? "rgba(255,255,255,.5)";
        const haloWidth = opts?.halo ?? 0;
        const haloColor = opts?.haloColor ?? "rgba(255,255,255,.85)";

        ctx.save();
        ctx.beginPath();
        ctx.rect(
          chartArea.left,
          chartArea.top,
          chartArea.width,
          chartArea.height
        );
        ctx.clip();

        const fontFamily =
          chart.options.font?.family || chart.defaults?.font?.family || "sans-serif";
        ctx.font = opts?.font || `500 14px ${fontFamily}`;
        ctx.fillStyle = opts?.color || "#000";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";

        labels.forEach((label, i) => {
          const xPos = x.getPixelForTick(i);
          const labelX = xPos - calculatedGroupWidth / 2 + 2;

          ctx.save();
          ctx.translate(labelX, y0);
          ctx.rotate(-Math.PI / 2);

          if (glowBlur > 0) {
            ctx.shadowColor = glowColor;
            ctx.shadowBlur = glowBlur;
          }

          if (haloWidth > 0) {
            ctx.lineJoin = "round";
            ctx.miterLimit = 2;
            ctx.strokeStyle = haloColor;
            ctx.lineWidth = haloWidth;
            ctx.strokeText(label, margin, 0);
          }

          if (glowBlur > 0) ctx.shadowBlur = 0;
          ctx.fillText(label, margin, 0);
          ctx.restore();
        });

        ctx.restore();
      },
    };
  }
}

// LineChart.js

// --- Layout Constants ---
const LAYOUT$1 = {
  MAX_LINES: 5,
  OVERLAP_OFFSET_RATIO: 0.02,
  OVERLAP_THRESHOLD_RATIO: 0.05,
};

class LineChart extends BaseChart {

  constructor(container, config) {
    super(container, config);
  }

  _getType() {
    return "line";
  }

  _prepareConfig(locationObj, context) {
    const { filterConfig, userOptions, isFullscreen, colorMaps, unfilteredYearTotals } = context;

    const safeLocation = locationObj || {
      genomeCount: 0,
      name: "No Data",
      getTimeSeriesData: () => ({ labels: [], datasets: [] }),
    };

    const timeSeriesMode = userOptions?.timeSeriesMode ?? "perYear";
    const cumulative = timeSeriesMode === "cumulative";

    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";
    let dataMode = userOptions?.dataMode;
    if (dataMode === undefined) {
      dataMode = userDataLoaded ? "compare" : "merge";
    }

    const lineSelection = userOptions?.lineSelection ?? "totalCount";
    const isPercentage = userOptions?.yAxis === "relative";

    //  1. Fetch Time-Series Data
    const rawData = safeLocation.getTimeSeriesData(
      filterConfig.column,
      cumulative,
      dataMode,
      LAYOUT$1.MAX_LINES,
      lineSelection,
      unfilteredYearTotals
    );

    // 2. Process Data & Apply Styling
    let datasets = rawData.datasets;
    if (isPercentage) {
      datasets = datasets.map((ds) => {
        // Use unfiltered year totals for relative mode (percentage of pre-filter data)
        const totals =
          dataMode === "compare"
            ? rawData.unfilteredYearTotalsByDataset?.get(ds.datasetId) ??
              rawData.yearTotalsByDataset?.get(ds.datasetId)
            : rawData.unfilteredYearTotals ?? rawData.yearTotals;
        const data = ds.data.map((value, index) => {
          if (value == null) return null;
          const total = totals?.[index] ?? 0;
          return total > 0 ? (value / total) * 100 : 0;
        });
        return { ...ds, data };
      });
    }

    if (dataMode === "compare") {
      datasets = this._applyCompareModeStyling(datasets, {
        fill: false,
        fillOpacity: 0.125,
        pointRadius: 3,
      });
    } else {
      const colors = this._generateColors(rawData.datasets.length);
      datasets = datasets.map((ds, index) => {
        const color = colors[index % colors.length];
        return {
          ...ds,
          borderColor: color,
          backgroundColor: color + "20",
          fill: false,
          tension: 0.1,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        };
      });
    }

    //  3. Apply overlap offset
    datasets = this._offsetOverlappingLines(datasets, rawData.labels);

    //  4. Generate Titles
    const title = `${safeLocation.name || "No Name"} ${
      filterConfig.alias
    } per Genome Over Time`;
    const subtitle = cumulative
      ? `Top ${LAYOUT$1.MAX_LINES} cumulative frequency`
      : `Top ${LAYOUT$1.MAX_LINES} frequency per year (${rawData.labels.length} years)`;

    const layoutLogic = {
      title,
      subtitle,
      isCumulative: cumulative,
    };

    //  5. Build Chart Options
    const options = {
      responsive: true,
      animation: false,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      scales: this._getScales(rawData.labels, isPercentage),
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: {
            font: { size: 12 },
            usePointStyle: true,
            padding: 15,
          },
        },
        title: {
          display: true,
          text: title,
          color: "#000",
          position: "top",
        },
        subtitle: {
          display: true,
          text: subtitle,
          padding: { bottom: 2 },
        },
        tooltip: this._getTooltipConfig(cumulative, isPercentage),
      },
    };

    return {
      data: { labels: rawData.labels, datasets },
      options,
      layoutLogic,
    };
  }

  _getScales(yearLabels, isPercentage) {
    // Use category scale for years (simpler than time scale, no adapter needed)
    return {
      x: {
        type: "category",
        title: {
          display: true,
          text: "Year",
        },
        ticks: {
          maxRotation: 45,
          minRotation: 45,
        },
        grid: {
          display: false,
        }
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: isPercentage ? "Percentage of Total" : "Frequency",
        },
        ticks: {
          precision: isPercentage ? 1 : 0,
          callback: (value) => {
            if (!isPercentage) return value;
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue)) return value;
            const formatted = Number.isInteger(numericValue)
              ? numericValue.toString()
              : numericValue.toFixed(1);
            return `${formatted}%`;
          },
        },
        grid: {
          display: false,
        }
      },
    };
  }

  _getTooltipConfig(cumulative, isPercentage) {
    return {
      // Sort items by original value (descending - highest frequency first)
      itemSort: (a, b) => {
        // Use original data for sorting if available
        const valueA = a.dataset.originalData
          ? a.dataset.originalData[a.dataIndex] ?? 0
          : a.parsed.y ?? 0;
        const valueB = b.dataset.originalData
          ? b.dataset.originalData[b.dataIndex] ?? 0
          : b.parsed.y ?? 0;
        return valueB - valueA; // Descending order (highest first)
      },
      callbacks: {
        title: (items) => {
          if (items.length === 0) return "";
          const year = items[0].label;
          return `Year: ${year}`;
        },
        label: (context) => {
          const label = context.dataset.label || "Value";
          // Use original data if available (for offset lines), otherwise use parsed value
          const value = context.dataset.originalData
            ? context.dataset.originalData[context.dataIndex]
            : context.parsed.y;
          if (isPercentage) {
            const numericValue = Number(value ?? 0);
            const formatted = Number.isInteger(numericValue)
              ? numericValue.toString()
              : numericValue.toFixed(1);
            return `${label}: ${formatted}%`;
          }
          return `${label}: ${value.toLocaleString()}`;
        },
        footer: (items) => {
          if (isPercentage) {
            return cumulative
              ? "Cumulative percent of all samples"
              : "Percent of all samples per year";
          }
          if (cumulative) {
            return "Cumulative sum";
          }
          return "Per year count";
        },
      },
    };
  }

  _getPlugins() {
    return [this._getNoDataPlugin(), this._getTooltipLimitPlugin()];
  }

  /**
   * Detect and offset overlapping lines to make them visible
   * @param {Array} datasets - Chart datasets with styled data
   * @param {Array} labels - X-axis labels (years)
   * @returns {Array} Datasets with y-values adjusted to prevent overlap
   */
  _offsetOverlappingLines(datasets, labels) {
    if (!datasets || datasets.length < 2 || !labels || labels.length < 2) {
      return datasets;
    }

    // Clone datasets and store original values
    const offsetDatasets = datasets.map((ds) => ({
      ...ds,
      data: [...ds.data],
      originalData: [...ds.data], // Store original values for tooltips
    }));

    // Calculate offset in data units (convert from pixels)
    // We'll use a fixed pixel offset of 3-5 pixels
    const allValues = offsetDatasets
      .flatMap((ds) => ds.data)
      .filter((v) => v != null && !isNaN(v) && v > 0);

    if (allValues.length === 0) {
      return offsetDatasets;
    }

    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const dataRange = maxValue - minValue || maxValue || 1;

    const offsetAmount = dataRange * LAYOUT$1.OVERLAP_OFFSET_RATIO;

    for (let pointIndex = 0; pointIndex < labels.length - 1; pointIndex++) {
      const overlappingGroups = this._findConsecutiveOverlaps(
        offsetDatasets,
        pointIndex,
        offsetAmount * LAYOUT$1.OVERLAP_THRESHOLD_RATIO
      );

      // Apply centered offsets to each group
      overlappingGroups.forEach((group) => {
        if (group.length > 1) {
          this._applyCenteredOffsets(
            group,
            offsetDatasets,
            pointIndex,
            offsetAmount
          );
        }
      });
    }

    return offsetDatasets;
  }

  /**
   * Find groups of datasets that have overlapping values at consecutive points
   * @param {Array} datasets - All datasets
   * @param {number} startPointIndex - Starting point index to check
   * @param {number} threshold - Overlap threshold
   * @returns {Array} Array of groups, each group is array of dataset indices
   */
  _findConsecutiveOverlaps(datasets, startPointIndex, threshold) {
    const groups = [];
    const processed = new Set();

    for (let i = 0; i < datasets.length; i++) {
      if (processed.has(i)) continue;

      const ds1 = datasets[i];
      const val1_point1 = ds1.data[startPointIndex];
      const val1_point2 = ds1.data[startPointIndex + 1];

      // Skip if either value is null/undefined
      if (val1_point1 == null || val1_point2 == null) {
        processed.add(i);
        continue;
      }

      // Start a new group with this dataset
      const group = [i];
      processed.add(i);

      // Find all other datasets that overlap at both consecutive points
      for (let j = i + 1; j < datasets.length; j++) {
        if (processed.has(j)) continue;

        const ds2 = datasets[j];
        const val2_point1 = ds2.data[startPointIndex];
        const val2_point2 = ds2.data[startPointIndex + 1];

        if (val2_point1 == null || val2_point2 == null) continue;

        // Check if both consecutive points overlap
        const overlap1 = Math.abs(val1_point1 - val2_point1) <= threshold;
        const overlap2 = Math.abs(val1_point2 - val2_point2) <= threshold;

        if (overlap1 && overlap2) {
          group.push(j);
          processed.add(j);
        }
      }

      if (group.length > 1) {
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * Apply centered offsets to a group of overlapping datasets
   * @param {Array} group - Array of dataset indices
   * @param {Array} datasets - All datasets
   * @param {number} pointIndex - Point index where offset starts
   * @param {number} offsetAmount - Base offset amount
   */
  _applyCenteredOffsets(group, datasets, pointIndex, offsetAmount) {
    const groupSize = group.length;

    // Calculate offsets centered around 0
    // For example: 3 lines -> [-1, 0, 1] * offsetAmount
    const offsets = [];
    for (let i = 0; i < groupSize; i++) {
      const position = i - (groupSize - 1) / 2;
      offsets.push(position * offsetAmount);
    }

    // Apply offsets to both consecutive points
    group.forEach((datasetIndex, i) => {
      const ds = datasets[datasetIndex];
      const offset = offsets[i];

      // Apply to both consecutive points
      if (ds.data[pointIndex] != null) {
        ds.data[pointIndex] += offset;
      }
      if (ds.data[pointIndex + 1] != null) {
        ds.data[pointIndex + 1] += offset;
      }
    });
  }
}

// StackedAreaChart.js

const LAYOUT = {
  MAX_LINES: 5,
};

class StackedAreaChart extends BaseChart {

  constructor(container, config) {
    super(container, config);
  }

  _getType() {
    return "line";
  }

  _prepareConfig(locationObj, context) {
    const { filterConfig, userOptions, isFullscreen, colorMaps } = context;

    const safeLocation = locationObj || {
      genomeCount: 0,
      name: "No Data",
      getTimeSeriesData: () => ({ labels: [], datasets: [] }),
    };

    const timeSeriesMode = userOptions?.timeSeriesMode ?? "perYear";
    const cumulative = timeSeriesMode === "cumulative";

    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";
    let dataMode = userOptions?.dataMode;
    if (dataMode === undefined) {
      dataMode = userDataLoaded ? "compare" : "merge";
    }

    const lineSelection = userOptions?.lineSelection ?? "totalCount";
    const isRelative = (userOptions?.yAxis ?? "absolute") === "relative";

    //  1. Fetch Time-Series Data
    const rawData = safeLocation.getTimeSeriesData(
      filterConfig.column,
      cumulative,
      dataMode,
      LAYOUT.MAX_LINES,
      lineSelection
    );

    // 2. Normalize data to percentages (100% stacked) only if relative mode
    let processedData;
    if (isRelative) {
      processedData = this._normalizeToPercentages(
        rawData.datasets,
        rawData.labels
      );
    } else {
      // In absolute mode, preserve original data but store it for tooltips
      processedData = {
        datasets: rawData.datasets.map((ds) => ({
          ...ds,
          originalData: [...ds.data], // Store original for tooltips
        })),
        labels: rawData.labels,
      };
    }

    // 3. Process Data & Apply Styling
    let datasets;
    if (dataMode === "compare") {
      datasets = this._applyCompareModeStyling(processedData.datasets, {
        fill: true,
        stack: "single",
        fillOpacity: 0.6,
        pointRadius: 0,
      });
    } else {
      const colors = this._generateColors(processedData.datasets.length);
      datasets = processedData.datasets.map((ds, index) => {
        const color = colors[index % colors.length];
        return {
          ...ds,
          borderColor: color,
          backgroundColor: color + "80",
          fill: true,
          stack: "single",
          tension: 0.1,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        };
      });
    }

    //  4. Generate Titles
    const title = `${safeLocation.name || "No Name"} ${filterConfig.alias} ${
      isRelative ? "Proportion" : "Frequency"
    } Over Time`;
    const subtitle = isRelative
      ? cumulative
        ? `Top ${LAYOUT.MAX_LINES} cumulative`
        : `Top ${LAYOUT.MAX_LINES} per year`
      : cumulative
      ? `Top ${LAYOUT.MAX_LINES} cumulative frequency`
      : `Top ${LAYOUT.MAX_LINES} frequency per year`;

    const layoutLogic = {
      title,
      subtitle,
      isCumulative: cumulative,
      isRelative,
    };

    //  5. Build Chart Options
    const options = {
      responsive: true,
      animation: false,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      scales: this._getScales(rawData.labels, isRelative),
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: {
            font: { size: 12 },
            usePointStyle: true,
            padding: 15,
          },
        },
        title: {
          display: true,
          text: title,
          color: "#000",
          position: "top",
        },
        subtitle: {
          display: true,
          text: subtitle,
          padding: { bottom: 2 },
        },
        tooltip: this._getTooltipConfig(cumulative, isRelative),
      },
    };

    return {
      data: { labels: rawData.labels, datasets },
      options,
      layoutLogic,
    };
  }

  /**
   * Normalize time-series data to percentages (100% stacked)
   * @param {Array} datasets - Raw datasets from getTimeSeriesData
   * @param {Array} labels - Time point labels (years)
   * @returns {{datasets: Array, labels: Array}} Normalized datasets with original data preserved
   */
  _normalizeToPercentages(datasets, labels) {
    if (!datasets || datasets.length === 0 || !labels || labels.length === 0) {
      return { datasets: [], labels };
    }

    // Clone datasets and preserve original data
    const normalizedDatasets = datasets.map((ds) => ({
      ...ds,
      data: [...ds.data],
      originalData: [...ds.data], // Store original absolute values
    }));

    // For each time point, calculate total and normalize
    for (let timeIndex = 0; timeIndex < labels.length; timeIndex++) {
      // Calculate total across all datasets for this time point
      let total = 0;
      for (const ds of normalizedDatasets) {
        const value = ds.data[timeIndex];
        if (value != null && !isNaN(value) && value > 0) {
          total += value;
        }
      }

      // Normalize each dataset value to percentage
      if (total > 0) {
        for (const ds of normalizedDatasets) {
          const originalValue = ds.data[timeIndex];
          if (
            originalValue != null &&
            !isNaN(originalValue) &&
            originalValue > 0
          ) {
            ds.data[timeIndex] = (originalValue / total) * 100;
          } else {
            ds.data[timeIndex] = 0; // Set to 0 for null/undefined/NaN values
          }
        }
      } else {
        // If total is 0, set all values to 0
        for (const ds of normalizedDatasets) {
          ds.data[timeIndex] = 0;
        }
      }
    }

    return { datasets: normalizedDatasets, labels };
  }

  _getScales(yearLabels, isRelative) {
    // Use category scale for years (simpler than time scale, no adapter needed)
    return {
      x: {
        type: "category",
        title: {
          display: true,
          text: "Year",
        },
        ticks: {
          maxRotation: 45,
          minRotation: 45,
        },
        grid: {
          display: false,
        }
      },
      y: {
        stacked: true,
        beginAtZero: true,
        ...(isRelative
          ? {
              min: 0,
              max: 100,
              title: {
                display: true,
                text: "Proportion (%)",
              },
              ticks: {
                callback: (value) => `${value}%`,
                precision: 0,
              },
            }
          : {
              title: {
                display: true,
                text: "Frequency",
              },
              ticks: {
                precision: 0,
              },
              grace: 5,
            }),
        grid: {
          display: false,
        }
      },
    };
  }

  _getTooltipConfig(cumulative, isRelative) {
    return {
      // Sort items by original value (descending - highest frequency first)
      itemSort: (a, b) => {
        // Use original data for sorting if available
        const valueA = a.dataset.originalData
          ? a.dataset.originalData[a.dataIndex] ?? 0
          : a.parsed.y ?? 0;
        const valueB = b.dataset.originalData
          ? b.dataset.originalData[b.dataIndex] ?? 0
          : b.parsed.y ?? 0;
        return valueB - valueA; // Descending order (highest first)
      },
      callbacks: {
        title: (items) => {
          if (items.length === 0) return "";
          const year = items[0].label;
          return `Year: ${year}`;
        },
        label: (context) => {
          const label = context.dataset.label || "Value";
          if (isRelative) {
            // Get percentage from normalized data
            const percentage = context.parsed.y ?? 0;
            // Get absolute value from original data
            const absoluteValue = context.dataset.originalData
              ? context.dataset.originalData[context.dataIndex] ?? 0
              : 0;
            return `${label}: ${percentage.toFixed(
              1
            )}% (${absoluteValue.toLocaleString()})`;
          } else {
            // In absolute mode, show the value directly
            const value = context.parsed.y ?? 0;
            return `${label}: ${value.toLocaleString()}`;
          }
        },
        footer: (items) => {
          if (isRelative) {
            if (cumulative) {
              return "Cumulative proportion";
            }
            return "Per year proportion";
          } else {
            if (cumulative) {
              return "Cumulative sum";
            }
            return "Per year count";
          }
        },
      },
    };
  }

  _getPlugins() {
    return [this._getNoDataPlugin(), this._getTooltipLimitPlugin()];
  }
}

class ChartPanelManager {
  constructor(host) {
    this.host = host;
  }

  _getDefaultOptions() {
    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";
    return {
      yAxis: "absolute",
      dataMode: userDataLoaded ? "compare" : "merge",
      sort: "alphanumeric",
      timeSeriesMode: "perYear",
      lineSelection: "totalCount",
      secondaryDim: null,
    };
  }

  maximizeMenu(menuContainer) {
    const minimizeIconHeight = this.host.constructor.ICON_HEIGHT;
    const mapEl = this.host.shadow.getElementById("map-area");
    if (!mapEl) return;

    const charts = menuContainer;
    const btn = charts.querySelector("#chart-fullscreen-btn");

    charts.classList.add("maximized");
    charts.classList.remove("collapsed");

    const reflow = () => {
      const mapRect = mapEl.getBoundingClientRect();

      const side = this.host.shadow.querySelector("#sidebar-menu-group");
      const sideRect = side?.getBoundingClientRect?.();
      const leftInsetPx = Math.max(
        10,
        sideRect ? Math.round(sideRect.right - mapRect.left) + 10 : 10
      );

      const targetWidth = Math.floor(mapRect.width - leftInsetPx - 10);
      const targetHeight = Math.floor(mapRect.height - 20);

      Object.assign(charts.style, {
        position: "absolute",
        top: "10px",
        right: "10px",
        left: "auto",
        bottom: "auto",
        width: `${targetWidth}px`,
        height: `${targetHeight}px`,
        margin: "0",
        maxWidth: "none",
        maxHeight: "none",
        overflow: "hidden",
      });
    };

    this.host._reflowMaxCharts = reflow;
    requestAnimationFrame(() => {
      this.host._reflowMaxCharts?.();
      this.host.createCharts(
        this.host.locationObjs[this.host.activeLocation],
        this.host.activeLocation,
        this.host.activeChartIDPreference || this.host.activeChartID
      );
    });

    this.host._maxChartsRO?.disconnect?.();
    try {
      this.host._maxChartsRO = new ResizeObserver(() => this.host._reflowMaxCharts?.());
      this.host._maxChartsRO.observe(mapEl);
      const side = this.host.shadow.querySelector("#sidebar-menu-group");
      if (side) this.host._maxChartsRO.observe(side);
    } catch (err) {
      console.error("ResizeObserver not supported, falling back to window resize listener:", err);
      this.host._onMaxChartsWinResize = () => this.host._reflowMaxCharts?.();
      window.addEventListener("resize", this.host._onMaxChartsWinResize);
    }

    if (btn) btn.innerHTML = HTMLhelper.icons("minimize", minimizeIconHeight);
  }

  minimizeMenu(menuContainer) {
    const maximizeIconHeight = this.host.constructor.ICON_HEIGHT;
    const chartContainer = menuContainer;
    const chartMaxMinBtn = chartContainer.querySelector("#chart-fullscreen-btn");

    chartContainer.classList.remove("maximized");

    this.host._maxChartsRO?.disconnect?.();
    this.host._maxChartsRO = null;
    if (this.host._onMaxChartsWinResize) {
      window.removeEventListener("resize", this.host._onMaxChartsWinResize);
      this.host._onMaxChartsWinResize = null;
    }
    this.host._reflowMaxCharts = null;

    [
      "top", "right", "bottom", "left", "width", "height",
      "margin", "maxWidth", "maxHeight", "overflow",
    ].forEach((k) => (chartContainer.style[k] = ""));

    if (chartMaxMinBtn)
      chartMaxMinBtn.innerHTML = HTMLhelper.icons("maximize", maximizeIconHeight);
    this.host.createCharts(
      this.host.locationObjs[this.host.activeLocation],
      this.host.activeLocation,
      this.host.activeChartID
    );
  }

  expandMenu(menuContainer) {
    menuContainer.querySelector("span.genome-counter").style.display = "inline";
    menuContainer.querySelector("button#chart-fullscreen-btn").style.visibility = "visible";
    menuContainer.classList.remove("collapsed");
    menuContainer.querySelector(".chartSection canvas").style.display = "block";
  }

  collapseMenu(menuContainer) {
    menuContainer.style.height = getComputedStyle(menuContainer).height;
    menuContainer.style.width = getComputedStyle(menuContainer).width;

    menuContainer.querySelector(".chartSection canvas").style.display = "none";
    menuContainer.classList.add("collapsed");

    menuContainer.querySelector("span.genome-counter").style.display = "none";
    menuContainer.querySelector("button#chart-fullscreen-btn").style.visibility = "hidden";
  }

  downloadChartImage(
    chart,
    {
      format = "png",
      scale = 2,
      fileName = "chart",
      background = "#ffffff",
    } = {}
  ) {
    const legendPlugin = chart.options.plugins.legend;
    const originalDisplay = legendPlugin?.display ?? false;

    if (legendPlugin) {
      legendPlugin.display = true;
      chart.update("none");
    }

    const src = chart.canvas;
    const cssW = src.clientWidth;
    const cssH = src.clientHeight;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cssW * scale));
    out.height = Math.max(1, Math.round(cssH * scale));

    const ctx = out.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0, out.width, out.height);

    if (legendPlugin) {
      legendPlugin.display = originalDisplay;
      chart.update("none");
    }

    const mime =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
        ? "image/webp"
        : "image/png";

    out.toBlob(
      (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileName}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      },
      mime,
      0.92
    );
  }

  renderChartInPanel(locationObj, filterConfig, container) {
    const chartType =
      container.dataset.activeChartType ||
      (Array.isArray(filterConfig.chartType)
        ? filterConfig.chartType[0]
        : filterConfig.chartType) ||
      "stackedBar";

    const ChartClass =
      chartType === "lineGraph"
        ? LineChart
        : chartType === "stackedArea"
        ? StackedAreaChart
        : StackedBarChart;

    container.dataset.activeChartType = chartType;

    if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
      this.host.userChartOptions = this._getDefaultOptions();
    }
    const options = this.host.userChartOptions;

    if (container._chartRenderer) {
      container._chartRenderer.destroy();
      container._chartRenderer = null;
    }
    if (container._chartInstance) {
      container._chartInstance.destroy();
      container._chartInstance = null;
    }

    const chartRenderer = new ChartClass(container);

    chartRenderer.render(locationObj, {
      filterConfig,
      filterConfigs: this.host.config.filters,
      userOptions: options,
      isFullscreen: this.host.shadow
        .querySelector("#charts")
        .classList.contains("maximized"),
      colorMaps: {
        species: this.host.speciesColorMap,
        genus: this.host.genusColorMap,
      },
      unfilteredYearTotals: this.host.dataLoader.getUnfilteredYearTotals(),
    });

    container._chartRenderer = chartRenderer;
  }

  createCharts(locationObj, key, active = null) {
    const name = locationObj?.name ?? "No data";
    const chartContainer = this.host.shadow.getElementById("charts");
    chartContainer.setAttribute("locationKey", key);

    this.host.mapHeight = getComputedStyle(this.host.shadow.querySelector("#map")).height;

    chartContainer.querySelector(
      ".menu-title"
    ).innerHTML = `<span style="font-weight: 600;">${escapeHtml(name)}</span> <span class="genome-counter">- ${
      locationObj?.genomeCount ?? 0
    } Genomes</span>`;

    const chartBody = chartContainer.querySelector("#charts-body");

    chartBody.querySelectorAll(".chartSection").forEach((section) => {
      if (section._chartRenderer) {
        section._chartRenderer.destroy();
        section._chartRenderer = null;
      }
    });
    while (chartBody.firstChild) {
      chartBody.removeChild(chartBody.firstChild);
    }

    const primaryDimOptions = this.host.config.filters
      .filter(f => f.hasBarChart)
      .map(f => ({
        value: f.column,
        label: f.alias || f.column.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      }));

    const activeChartID =
      active || this.host.activeChartIDPreference || this.host.activeChartID || primaryDimOptions[0]?.value || null;

    const validActiveID = primaryDimOptions.find(opt => opt.value === activeChartID)
      ? activeChartID
      : primaryDimOptions[0]?.value || null;

    this.host.activeChartID = validActiveID;
    this.host.activeChartIDPreference = validActiveID;

    const activeFilter = this.host.config.filters.find(f => f.column === validActiveID);
    if (!activeFilter) return;

    const sectionContainer = document.createElement("div");
    sectionContainer.classList.add("chartSection", "active-chart");
    sectionContainer.id = "main-chart";
    sectionContainer.style.height = "100%";
    sectionContainer.dataset.primaryDim = validActiveID;
    chartBody.appendChild(sectionContainer);

    const chartTypes = Array.isArray(activeFilter.chartType)
      ? activeFilter.chartType
      : [activeFilter.chartType || "stackedBar"];

    const activeType = (this.host.activeChartType && chartTypes.includes(this.host.activeChartType))
      ? this.host.activeChartType
      : chartTypes[0];
    sectionContainer.dataset.activeChartType = activeType;

    this.host.activeChartType = activeType;

    this.renderChartInPanel(locationObj, activeFilter, sectionContainer);

    const primaryContainer = chartContainer.querySelector("#primary-dim-selector");
    if (primaryContainer) {
      primaryContainer.innerHTML = HTMLhelper.primaryDimensionSelector(
        primaryDimOptions,
        validActiveID
      );
    }

    if (chartContainer._bindPrimaryDimDropdown) {
      chartContainer._bindPrimaryDimDropdown();
    }

    if (chartContainer._updateChartTypeSelector) {
      chartContainer._updateChartTypeSelector();
    }
  }

  // --- Chart menu bindings ---

  bindChartMenu(signal) {
    const chartContainer = this.host.shadow.getElementById("charts");

    this._bindChartExpandCollapse(signal, chartContainer);
    this._bindChartMaximize(signal, chartContainer);
    this._bindChartDownload(signal, chartContainer);
    this._bindDimensionSelectors(signal, chartContainer);
    this._bindChartOptionsPanel(signal, chartContainer);
  }

  _bindChartExpandCollapse(signal, chartContainer) {
    const chartMaxMinBtn = chartContainer.querySelector("#chart-fullscreen-btn");

    chartContainer.querySelector("#charts-menu-chevron").addEventListener(
      "click",
      () => {
        if (chartContainer.classList.contains("collapsed")) {
          this.expandMenu(chartContainer);
        } else {
          if (chartContainer.classList.contains("maximized")) {
            const onTransitionEnd = (e) => {
              if (
                e.target === chartContainer &&
                (e.propertyName === "height" || e.propertyName === "width")
              ) {
                this.collapseMenu(chartContainer);
              }
            };
            chartContainer.addEventListener("transitionend", onTransitionEnd, {
              once: true,
            });

            const activeID = this.host.activeChartID ?? null;
            const location = chartContainer.getAttribute("locationKey") ?? null;
            this.minimizeMenu(chartContainer, activeID, location);
            chartMaxMinBtn.innerHTML = HTMLhelper.icons("maximize");

            const transitionDuration = getComputedStyle(chartContainer).transitionDuration;
            if (!transitionDuration || transitionDuration === "0s") {
              requestAnimationFrame(() => this.collapseMenu(chartContainer));
            }
          } else {
            this.collapseMenu(chartContainer);
          }
        }
      },
      { signal }
    );
  }

  _bindChartMaximize(signal, chartContainer) {
    const chartMaxMinBtn = chartContainer.querySelector("#chart-fullscreen-btn");

    chartMaxMinBtn.innerHTML = chartContainer.classList.contains("maximized")
      ? HTMLhelper.icons("minimize")
      : HTMLhelper.icons("maximize");

    chartMaxMinBtn.addEventListener(
      "click",
      () => {
        this.host.activeLocation = chartContainer.getAttribute("locationKey") ?? null;
        if (chartContainer.classList.contains("maximized")) {
          this.minimizeMenu(chartContainer);
          chartMaxMinBtn.innerHTML = HTMLhelper.icons("maximize");
        } else {
          this.maximizeMenu(chartContainer);
          chartMaxMinBtn.innerHTML = HTMLhelper.icons("minimize");
        }
      },
      { signal }
    );
  }

  _bindChartDownload(signal, chartContainer) {
    const chartDownloadBtn = chartContainer.querySelector("#chart-download-btn");

    chartDownloadBtn.addEventListener(
      "click",
      () => {
        const activeSection = this.host.shadowRoot.querySelector(".chartSection.active-chart");
        const chart = activeSection?._chartRenderer?.chartInstance;

        if (!chart) return;

        chart.update("none");
        if (confirm("Download this chart as .png?")) {
          this.downloadChartImage(chart, {
            format: "png",
            scale: 2,
            fileName: "my-chart",
            background: "#ffffff",
          });
        }
      },
      { signal }
    );
  }

  _getActivePrimaryDim(chartContainer) {
    const mainChart = chartContainer.querySelector("#main-chart");
    return mainChart?.dataset.primaryDim || this.host.activeChartID;
  }

  _getActiveFilterConfig(chartContainer) {
    const primaryDim = this._getActivePrimaryDim(chartContainer);
    return this.host.config.filters.find(f => f.column === primaryDim);
  }

  _getActiveChartType(chartContainer) {
    const mainChart = chartContainer.querySelector("#main-chart");
    if (mainChart?.dataset.activeChartType) {
      return mainChart.dataset.activeChartType;
    }

    const filterConfig = this._getActiveFilterConfig(chartContainer);
    if (filterConfig) {
      if (Array.isArray(filterConfig.chartType)) {
        return filterConfig.chartType[0];
      }
      return filterConfig.chartType || "stackedBar";
    }
    return "stackedBar";
  }

  _getActiveChartSection(chartContainer) {
    return chartContainer.querySelector("#main-chart");
  }

  _handlePrimaryDimChange(newPrimaryDim, chartContainer, updateChartTypeSelector) {
    const locationKey = chartContainer.getAttribute("locationKey");
    const locationObj = this.host.locationObjs[locationKey];
    if (!locationObj) return;

    this.host.activeChartID = newPrimaryDim;
    this.host.activeChartIDPreference = newPrimaryDim;

    const filterConfig = this.host.config.filters.find(f => f.column === newPrimaryDim);
    if (!filterConfig) return;

    const chartBody = chartContainer.querySelector("#charts-body");
    chartBody.querySelectorAll(".chartSection").forEach(section => {
      if (section._chartRenderer) {
        section._chartRenderer.destroy();
        section._chartRenderer = null;
      }
    });
    while (chartBody.firstChild) {
      chartBody.removeChild(chartBody.firstChild);
    }

    const sectionContainer = document.createElement("div");
    sectionContainer.classList.add("chartSection", "active-chart");
    sectionContainer.id = "main-chart";
    sectionContainer.style.height = "100%";
    sectionContainer.dataset.primaryDim = newPrimaryDim;
    chartBody.appendChild(sectionContainer);

    const chartTypes = Array.isArray(filterConfig.chartType)
      ? filterConfig.chartType
      : [filterConfig.chartType || "stackedBar"];

    const activeType = (this.host.activeChartType && chartTypes.includes(this.host.activeChartType))
      ? this.host.activeChartType
      : chartTypes[0];
    sectionContainer.dataset.activeChartType = activeType;

    this.host.activeChartType = activeType;

    this.renderChartInPanel(locationObj, filterConfig, sectionContainer);

    updateChartTypeSelector();
  }

  _bindDimensionSelectors(signal, chartContainer) {
    const updateSecondaryDimSelector = (chartType, filterConfig) => {
      const secondaryContainer = chartContainer.querySelector("#secondary-dim-selector");
      if (!secondaryContainer) return;

      const isTimeSeries = chartType === "lineGraph" || chartType === "stackedArea";

      if (isTimeSeries) {
        secondaryContainer.innerHTML = HTMLhelper.secondaryDimensionSelector(
          [{ value: "time", label: "Time" }],
          "time",
          true
        );
        secondaryContainer.style.display = "flex";
        return;
      }

      if (chartType === "stackedBar" && filterConfig?.hierarchicalOptions?.secondaryDimensions) {
        const secondaryDims = filterConfig.hierarchicalOptions.secondaryDimensions;

        const options = secondaryDims.map(dimName => {
          const dimConfig = this.host.config.filters?.find(f => f.column === dimName);
          return {
            value: dimName,
            label: dimConfig?.alias || dimName.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
          };
        });

        const activeSecondaryDim = this.host.userChartOptions?.secondaryDim || secondaryDims[0];

        secondaryContainer.innerHTML = HTMLhelper.secondaryDimensionSelector(
          options,
          activeSecondaryDim,
          false
        );
        secondaryContainer.style.display = "flex";

        const dropdown = secondaryContainer.querySelector("#secondary-dim-dropdown");
        if (dropdown) {
          dropdown.addEventListener("change", (e) => {
            const selectedDim = e.target.value;

            if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
              this.host.userChartOptions = this._getDefaultOptions();
            }
            this.host.userChartOptions.secondaryDim = selectedDim;

            const chartSection = this._getActiveChartSection(chartContainer);
            const locationKey = chartContainer.getAttribute("locationKey");
            const locationObj = this.host.locationObjs[locationKey];

            if (locationObj && chartSection) {
              this.renderChartInPanel(locationObj, filterConfig, chartSection);
            }
          }, { signal });
        }
        return;
      }

      secondaryContainer.style.display = "none";
      secondaryContainer.innerHTML = "";
    };

    const updateChartTypeSelector = () => {
      const selectorContainer = chartContainer.querySelector("#chart-type-selector");
      if (!selectorContainer) return;

      const filterConfig = this._getActiveFilterConfig(chartContainer);
      if (!filterConfig || !filterConfig.chartType) {
        selectorContainer.innerHTML = "";
        selectorContainer.style.display = "none";
        return;
      }

      const chartTypes = Array.isArray(filterConfig.chartType)
        ? filterConfig.chartType
        : [filterConfig.chartType];

      const mainChart = this._getActiveChartSection(chartContainer);
      const activeType = mainChart?.dataset.activeChartType || chartTypes[0];

      selectorContainer.innerHTML = HTMLhelper.chartTypeSelector(chartTypes, activeType);
      selectorContainer.style.display = "flex";

      selectorContainer.querySelectorAll("button[data-chart-type]").forEach((btn) => {
        btn.addEventListener(
          "click",
          () => {
            if (chartTypes.length === 1) return;

            const selectedType = btn.getAttribute("data-chart-type");
            const chartSection = this._getActiveChartSection(chartContainer);
            if (!chartSection) return;

            const locationKey = chartContainer.getAttribute("locationKey");

            chartSection.dataset.activeChartType = selectedType;
            this.host.activeChartType = selectedType;

            selectorContainer.querySelectorAll("button[data-chart-type]").forEach((b) => {
              b.classList.remove("active-chart-type");
            });
            btn.classList.add("active-chart-type");

            const locationObj = this.host.locationObjs[locationKey];
            if (locationObj) {
              this.renderChartInPanel(locationObj, filterConfig, chartSection);
              if (chartContainer._regenerateOptionsDropdown) {
                chartContainer._regenerateOptionsDropdown();
              }
              updateSecondaryDimSelector(selectedType, filterConfig);
            }
          },
          { signal }
        );
      });

      updateSecondaryDimSelector(activeType, filterConfig);
    };

    const bindPrimaryDimDropdown = () => {
      const primaryContainer = chartContainer.querySelector("#primary-dim-selector");
      const dropdown = primaryContainer?.querySelector("#primary-dim-dropdown");
      if (dropdown) {
        dropdown.addEventListener("change", (e) => {
          this._handlePrimaryDimChange(e.target.value, chartContainer, updateChartTypeSelector);
        }, { signal });
      }
    };

    bindPrimaryDimDropdown();
    updateChartTypeSelector();

    chartContainer._updateChartTypeSelector = updateChartTypeSelector;
    chartContainer._bindPrimaryDimDropdown = bindPrimaryDimDropdown;
  }

  _bindChartOptionsPanel(signal, chartContainer) {
    const optionsBtn = chartContainer.querySelector("button#chart-settings-btn");

    const showOptionsDropdown = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;
      optionsDropdown.style.display = "block";
      optionsDropdown.classList.add("open");
    };

    const hideOptionsDropdown = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;
      optionsDropdown.addEventListener(
        "transitionend",
        (e) => {
          if (e.target !== optionsDropdown || e.propertyName !== "opacity") return;
          optionsDropdown.style.display = "none";
        },
        { once: true }
      );
      optionsDropdown.classList.remove("open");
    };

    const toggleOptionsDropdown = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;
      const isOpen = optionsDropdown.classList.contains("open");
      if (isOpen) {
        hideOptionsDropdown();
      } else {
        showOptionsDropdown();
      }
      optionsBtn.classList.toggle("rotate");
    };

    const bindCloseButton = () => {
      const closeOptionsBtn = chartContainer.querySelector("button#close-chart-settings-btn");
      if (closeOptionsBtn) {
        const newBtn = closeOptionsBtn.cloneNode(true);
        closeOptionsBtn.parentNode.replaceChild(newBtn, closeOptionsBtn);
        newBtn.addEventListener("click", toggleOptionsDropdown, { signal });
      }
    };

    const bindOptionsInputs = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;

      optionsDropdown.querySelectorAll("input").forEach((input) => {
        const newInput = input.cloneNode(true);
        input.parentNode.replaceChild(newInput, input);

        newInput.addEventListener(
          "change",
          () => {
            this._updateChartOptionsFromForm(chartContainer);
            const locationKey = chartContainer.getAttribute("locationKey");
            try {
              this.host.activeLocation = locationKey;
              this.host.createCharts(this.host.locationObjs[locationKey], locationKey, this.host.activeChartID);
            } catch (err) {
              console.error("Failed to update charts after options change:", err);
            }
          },
          { signal }
        );
      });

      bindCloseButton();
    };

    const regenerateOptionsDropdown = () => {
      if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
        this.host.userChartOptions = this._getDefaultOptions();
      }

      const optionsBodyInnerHtml = HTMLhelper.chartOptions(this.host.userChartOptions);
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (optionsDropdown) {
        const wasOpen = optionsDropdown.classList.contains("open");
        optionsDropdown.innerHTML = optionsBodyInnerHtml;
        bindOptionsInputs();
        if (wasOpen) {
          optionsDropdown.classList.add("open");
        }
      }
    };

    chartContainer._regenerateOptionsDropdown = regenerateOptionsDropdown;

    regenerateOptionsDropdown();
    optionsBtn.addEventListener("click", toggleOptionsDropdown, { signal });
    bindCloseButton();
    this._updateChartOptionsFromForm(chartContainer);
  }

  _updateChartOptionsFromForm(chartContainer) {
    const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
    if (!optionsDropdown) return;

    if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
      this.host.userChartOptions = this._getDefaultOptions();
    }

    const updatedOptions = { ...this.host.userChartOptions };

    optionsDropdown.querySelectorAll("input").forEach((input) => {
      if (input.checked) {
        const categoryID = input.parentElement.parentElement.parentElement.id;
        switch (categoryID) {
          case "yAxis-mode":
            updatedOptions.yAxis = input.value;
            break;
          case "sort-mode":
            updatedOptions.sort = input.value;
            break;
          case "data-set-mode":
            updatedOptions.dataMode = input.value;
            break;
          case "timeSeries-mode":
            updatedOptions.timeSeriesMode = input.value;
            break;
          case "lineSelection-mode":
            updatedOptions.lineSelection = input.value;
            break;
        }
      }
    });

    this.host.userChartOptions = updatedOptions;
  }

  destroy() {
    this.host._maxChartsRO?.disconnect?.();
    this.host._maxChartsRO = null;
    if (this.host._onMaxChartsWinResize) {
      window.removeEventListener("resize", this.host._onMaxChartsWinResize);
      this.host._onMaxChartsWinResize = null;
    }
    this.host._reflowMaxCharts = null;

    if (this.host._activeCharts) {
      for (const chart of Object.values(this.host._activeCharts)) {
        chart?.destroy?.();
      }
      this.host._activeCharts = {};
    }
  }
}

class FilterMenuManager {
  constructor(host) {
    this.host = host;
  }

  generateMenu() {
    this.host._menuAbort?.abort();
    this.host._menuAbort = new AbortController();
    const { signal } = this.host._menuAbort;

    const activeFilterSummary = this._summarizeActiveFilters();
    this._renderMenuUI(activeFilterSummary);
    this.updateTaxonomyHint();

    this._hydrateSectionCounters(activeFilterSummary);

    this._bindFilterCheckboxes(signal);
    this._bindDateWidget(signal);
    this._bindSidebarToggles(signal);
    this.host._chartPanel.bindChartMenu(signal);
    this._bindDataDownload(signal);

    this.updateFilterValueCounters();
  }

  _renderMenuUI(summary) {
    const menuContainer = this.host.shadow.getElementById("menu");
    const filterSections = this._buildFilterSectionsConfig();

    menuContainer.innerHTML = HTMLhelper.menuStructure(
      filterSections,
      summary.total
    );
  }

  _buildFilterSectionsConfig() {
    const isChecked = (section, value) => {
      if (
        this.host.dataLoader.getActiveFilters()[section] &&
        this.host.dataLoader.getActiveFilters()[section].has(value)
      ) {
        return true;
      }
      return false;
    };
    let filterSections = [];

    for (let section in this.host.availableFilters) {
      const sectionConfig = this.host.config.filters.find(
        (filter) => filter.column === section
      );

      let htmlString = "";
      if (sectionConfig.hasDropdown) {
        this.host.availableFilters[section].sort((a, b) => {
          a = a.toString();
          b = b.toString();
          const aIsUnknown = a.toLowerCase() === "unknown";
          const bIsUnknown = b.toLowerCase() === "unknown";

          if (aIsUnknown && !bIsUnknown) return -1;
          if (!aIsUnknown && bIsUnknown) return 1;
          return a.localeCompare(b, "en", { sensitivity: "base" });
        });
        if (sectionConfig.specialType === null) {
          for (let i in this.host.availableFilters[section]) {
            let value = this.host.availableFilters[section][i];
            const checked = isChecked(section, value);
            const filterRow = HTMLhelper.filterRow(section, value, i, checked);
            htmlString += filterRow;
          }
        } else if (sectionConfig.specialType === "date") {
          const filters = this.host.dataLoader.getActiveFilters();

          const fmtDate = (d) => {
            if (!(d instanceof Date)) return "";
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            return `${yyyy}/${mm}/${dd}`;
          };

          const startDateStr = fmtDate(filters?.["date-start"]);
          const endDateStr = fmtDate(filters?.["date-end"]);

          htmlString = HTMLhelper.dateSelectionWidget(startDateStr, endDateStr);
        }
        filterSections.push({
          name: sectionConfig.alias,
          column: section,
          string: htmlString,
          icon: sectionConfig.svgIcon,
          searchable: sectionConfig.searchable ?? false,
          scrollable: sectionConfig.specialType === "date" ? false : true,
        });
      }
    }
    return filterSections;
  }

  updateTaxonomyHint() {
    const speciesMeta = this.host.dataLoader.meta.groups?.species;
    const uniqueSpecies = speciesMeta?.unique ?? new Set();
    const firstSpecies = uniqueSpecies.values().next().value ?? "";
    const hintEl = this.host.shadow.getElementById("taxonomy-hint");
    if (hintEl) {
      const rest = uniqueSpecies.size - 1;
      hintEl.innerHTML =
        rest > 0
          ? `Showing <span class="italic">${escapeHtml(firstSpecies)}</span> +${rest} others...`
          : `Showing <span class="italic">${escapeHtml(firstSpecies)}</span>`;
    }
  }

  _bindFilterCheckboxes(signal) {
    const menuContainer = this.host.shadow.getElementById("menu");
    const checkboxes = menuContainer.querySelectorAll(".form-check-input");
    const totalFilterCounter = menuContainer.querySelector("#total-filter-count");

    checkboxes.forEach((checkbox) => {
      checkbox.addEventListener(
        "change",
        (e) => {
          let checkbox = e.currentTarget;
          let type = checkbox.getAttribute("filter-type");
          const menuHeader =
            checkbox.parentElement.parentElement.parentElement.querySelector(
              ".menu-section-header"
            );
          let sectionFilterCounter = menuHeader.querySelector(
            ".section-filter-count"
          );
          sectionFilterCounter.style.backgroundColor = hexToRgba(
            this.host.config.filters.find((obj) => obj.column === type).chartColors
              .general[0],
            0.7
          );
          if (checkbox.checked) {
            this.host.dataLoader.addFilter(type, checkbox.value);
            totalFilterCounter.textContent =
              Number(totalFilterCounter.textContent) + 1;
            sectionFilterCounter.textContent =
              Number(sectionFilterCounter.textContent) + 1;
            sectionFilterCounter.classList.remove("hide");
          } else {
            this.host.dataLoader.removeFilter(type, checkbox.value);
            totalFilterCounter.textContent =
              Number(totalFilterCounter.textContent) - 1;
            sectionFilterCounter.textContent =
              Number(sectionFilterCounter.textContent) - 1;
            if (Number(sectionFilterCounter.textContent) === 0) {
              sectionFilterCounter.classList.add("hide");
            }
          }

          this.host.reload({
            reloadMenu: false,
            focusID: this.host.activeChartID,
            focusLocation: this.host.activeLocation,
          });
        },
        { signal }
      );
    });
  }

  _bindDateWidget(signal) {
    const menuContainer = this.host.shadow.getElementById("menu");

    const startInput = menuContainer.querySelector(
      'input.date-text-input[filter-type="date-start"]'
    );
    const endInput = menuContainer.querySelector(
      'input.date-text-input[filter-type="date-end"]'
    );

    const errorEl = menuContainer.querySelector("#dw-error");

    const applyDateRange = () => {
      if (!startInput || !endInput) return;

      const filters = this.host.dataLoader.getActiveFilters();

      const rawStart = startInput.value.trim();
      const rawEnd = endInput.value.trim();

      const hasStart = rawStart.length > 0;
      const hasEnd = rawEnd.length > 0;

      const startDate = hasStart ? this._validateDate(rawStart, "start") : null;
      const endDate = hasEnd ? this._validateDate(rawEnd, "end") : null;

      [startInput, endInput].forEach((el) =>
        el.classList.remove("invalid-date")
      );
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hide");
      }

      let hasError = false;
      if (hasStart && !startDate) {
        startInput.classList.add("invalid-date");
        hasError = true;
      }
      if (hasEnd && !endDate) {
        endInput.classList.add("invalid-date");
        hasError = true;
      }
      if (hasError) {
        if (errorEl) {
          errorEl.textContent = "Enter dates as YYYY/MM/DD or YYYY.";
          errorEl.classList.remove("hide");
        }
        return;
      }

      if (startDate && endDate && startDate > endDate) {
        startInput.classList.add("invalid-date");
        endInput.classList.add("invalid-date");
        if (errorEl) {
          errorEl.textContent =
            "Start date must be before or equal to the end date.";
          errorEl.classList.remove("hide");
        }
        return;
      }

      if (filters["date-start"]) {
        this.host.dataLoader.removeFilter("date-start");
      }
      if (filters["date-end"]) {
        this.host.dataLoader.removeFilter("date-end");
      }

      if (startDate) {
        this.host.dataLoader.addFilter("date-start", startDate, "date");
      }
      if (endDate) {
        this.host.dataLoader.addFilter("date-end", endDate, "date");
      }

      if (!startDate && !endDate && errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hide");
      }

      this.host.reload({
        reloadMenu: false,
        focusID: this.host.activeChartID,
        focusLocation: this.host.activeLocation ?? "global",
      });
    };

    [startInput, endInput].forEach((input) => {
      if (!input) return;
      input.addEventListener("change", applyDateRange, { signal });
    });
  }

  _validateDate(raw, role = "start") {
    const dateString = String(raw || "").trim();
    if (dateString.length < 4) return false;

    const yearOnlyPattern = /^(\d{4})$/;
    const yearMonthDayPattern = /^(\d{4})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/;

    let match;
    if ((match = dateString.match(yearOnlyPattern))) {
      const year = +match[1];
      if (role === "end") {
        return new Date(year, 11, 31);
      }
      return new Date(year, 0, 1);
    }

    if ((match = dateString.match(yearMonthDayPattern))) {
      const year = +match[1];
      const month = +match[2];
      const day = +match[3];

      const daysInMonth = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
      ];

      if (day >= 1 && day <= daysInMonth[month - 1]) {
        return new Date(year, month - 1, day);
      }
    }

    return false;
  };

  _bindSidebarToggles(signal) {
    const menuSearchFunction = function () {
      const filterContainer = this.parentNode;
      const searchTerm = this.value.toLowerCase();

      const checkboxes = filterContainer.querySelectorAll(".form-check");
      checkboxes.forEach((box) => {
        let labelElement = box.querySelector(".form-check-label");
        let labelText = labelElement.textContent.toLowerCase();
        let checkboxElement = box.querySelector(".form-check-input");
        if (!labelText.includes(searchTerm)) {
          labelElement.style.display = "none";
          checkboxElement.style.display = "none";
          box.style.height = "0px";
          box.style.minHeight = "0px";
          box.setAttribute("style", "display: none !important");
        } else {
          labelElement.style.display = "";
          checkboxElement.style.display = "";
          box.style.height = "";
          box.style.display = "";
        }
      });
    };
    const menuContainer = this.host.shadow.getElementById("menu");
    const chartContainer = this.host.shadow.getElementById("charts");

    const sidebarContainer = menuContainer.querySelector("div#sidebar-menu-group");

    const clearAllFilters = () => {
      const totalFilterCounter = menuContainer.querySelector("#total-filter-count");
      for (let filter of Object.keys(this.host.dataLoader.activeFilters)) {
        delete this.host.dataLoader.activeFilters[filter];
        sidebarContainer.querySelectorAll(".date-text-input").forEach(input => {
          input.value = "";
        });
      }
      totalFilterCounter.textContent = 0;
      sidebarContainer
        .querySelectorAll(".section-filter-count")
        .forEach((counter) => {
          counter.textContent = 0;
          counter.classList.add("hide");
        });
      sidebarContainer
        .querySelectorAll("input.form-check-input")
        .forEach((checkbox) => {
          checkbox.checked = false;
        });
      this.host.reload({
        reloadMenu: false,
        focusID: this.host.activeChartID,
        focusLocation: this.host.activeLocation,
      });
    };

    sidebarContainer
      .querySelector(".clear-btn")
      .addEventListener("click", clearAllFilters, { signal });

    menuContainer
      .querySelectorAll(".menu-section input.menu-section-search")
      .forEach(function (section) {
        section.addEventListener("input", menuSearchFunction, { signal });
      });

    const showFiltersBtn = menuContainer.querySelector("#show-filters-button");

    showFiltersBtn.addEventListener(
      "click",
      () => {
        const toggleSidebar = () => {
          sidebarContainer.classList.toggle("open");

          sidebarContainer
            .querySelector(".menu-content")
            ?.classList.toggle("invisible");
          sidebarContainer
            .querySelector(".clear-btn")
            ?.classList.toggle("invisible");
          const totalFilterCounter = menuContainer.querySelector(
            "#total-filter-count"
          );
          if (totalFilterCounter) {
            const count = Number(totalFilterCounter.textContent || "0");
            if (sidebarContainer.classList.contains("open")) {
              totalFilterCounter.classList.add("hide");
            } else if (count !== 0) {
              totalFilterCounter.classList.remove("hide");
            }
          }

          const topLine = showFiltersBtn.querySelector("line.top");
          const bottomLine = showFiltersBtn.querySelector("line.bottom");
          showFiltersBtn.classList.toggle("filter-active");
          if (topLine && bottomLine) {
            const y1Top = parseFloat(topLine.getAttribute("y1") || "0");
            const y1Bottom = parseFloat(bottomLine.getAttribute("y1") || "0");
            const translation = (y1Bottom - y1Top) / 2;
            if (showFiltersBtn.classList.contains("filter-active")) {
              requestAnimationFrame(() => {
                topLine.setAttribute(
                  "transform",
                  `rotate(45) translate(0, ${translation})`
                );
                bottomLine.setAttribute(
                  "transform",
                  `rotate(-45) translate(0, -${translation})`
                );
                bottomLine.setAttribute("x1", "0");
                bottomLine.setAttribute("x2", "40");
              });
            } else {
              requestAnimationFrame(() => {
                topLine.setAttribute("transform", "rotate(0) translate(0, 0)");
                bottomLine.setAttribute(
                  "transform",
                  "rotate(0) translate(0, 0)"
                );
                bottomLine.setAttribute("x1", "15");
                bottomLine.setAttribute("x2", "25");
              });
            }
          }
        };

        if (
          chartContainer.classList.contains("maximized") &&
          this.host._reflowMaxCharts
        ) {
          let running = true;
          const tick = () => {
            if (!running) return;
            this.host._reflowMaxCharts();
            requestAnimationFrame(tick);
          };
          const stop = () => {
            running = false;
            this.host._reflowMaxCharts();
          };

          requestAnimationFrame(tick);
          const stopOnce = () => {
            stop();
            sidebarContainer.removeEventListener("transitionend", stopOnce);
            sidebarContainer.removeEventListener("transitioncancel", stopOnce);
          };
          sidebarContainer.addEventListener("transitionend", stopOnce, {
            signal,
            once: true,
          });
          sidebarContainer.addEventListener("transitioncancel", stopOnce, {
            signal,
            once: true,
          });
        }

        toggleSidebar();
      },
      { signal }
    );

    const sectionHeader = menuContainer.querySelectorAll("div.menu-section-header");

    sectionHeader.forEach((section) =>
      section.querySelector(".chevron").addEventListener(
        "click",
        () => {
          sectionHeader.forEach((otherSection) => {
            if (
              section !== otherSection &&
              otherSection.parentElement.classList.contains("menu-opened")
            ) {
              otherSection.parentElement.classList.toggle("menu-opened");
              otherSection.classList.toggle("flip");
            }
          });
          section.parentElement.classList.toggle("menu-opened");
          section.classList.toggle("flip");
        },
        { signal }
      )
    );
  }

  _bindDataDownload(signal) {
    const headerSection = this.host.shadow.getElementById("header-area");
    const downloadATag = headerSection.querySelector("#download-data-btn");

    downloadATag.addEventListener(
      "click",
      (event) => {
        if (!downloadATag.confirmed) {
          const csvBlob = this.host.dataLoader.getAllDataBlob();
          const sizeInBytes = csvBlob.size;

          const formatSize = (bytes) => {
            if (bytes < 1024) return `${bytes} bytes`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
          };

          const readableSize = formatSize(sizeInBytes);
          const userConfirmed = confirm(
            `This download will be approximately ${readableSize}. Do you want to continue?`
          );

          if (userConfirmed) {
            const url = URL.createObjectURL(csvBlob);
            downloadATag.href = url;
            downloadATag.download = "data.csv";
          } else {
            event.preventDefault();
            return;
          }
        }
      },
      { signal }
    );
  }

  _summarizeActiveFilters() {
    const dateFilterColumnName = this.host.config.filters.find(
      (filter) => filter.specialType === "date"
    )?.column;
    const summary = { total: 0, perSection: {} };
    const activeFilters = this.host.dataLoader.getActiveFilters() ?? {};

    const pushCount = (sectionKey, count) => {
      if (!sectionKey || count === 0) return;
      summary.perSection[sectionKey] =
        (summary.perSection[sectionKey] ?? 0) + count;
      summary.total += count;
    };

    for (const [type, values] of Object.entries(activeFilters)) {
      let count = 0;
      if (values instanceof Set) {
        count = values.size;
      } else if (values instanceof Date) {
        count = 1;
      } else if (Array.isArray(values)) {
        count = values.length;
      } else if (values != null) {
        count = 1;
      }

      if (count === 0) continue;

      const sectionKey =
        type === "date-start" || type === "date-end"
          ? dateFilterColumnName
          : type;
      pushCount(sectionKey, count);
    }

    return summary;
  }

  _hydrateSectionCounters(activeFilterSummary) {
    const menuContainer = this.host.shadow?.getElementById("menu");
    const sidebarContainer = menuContainer.querySelector("div#sidebar-menu-group");

    const totalFilterCounter = menuContainer.querySelector("#total-filter-count");
    if (totalFilterCounter) {
      totalFilterCounter.textContent = activeFilterSummary.total;
      totalFilterCounter.classList.toggle(
        "hide",
        activeFilterSummary.total === 0
      );
    }

    if (!sidebarContainer) return;

    sidebarContainer.querySelectorAll(".menu-section").forEach((section) => {
      const columnKey = section.dataset.filterColumn;
      if (!columnKey) return;

      const sectionCounter = section.querySelector(".section-filter-count");
      if (!sectionCounter) return;

      const count = activeFilterSummary.perSection[columnKey] ?? 0;
      sectionCounter.textContent = count;
      if (count > 0) {
        sectionCounter.classList.remove("hide");
        const sectionConfig = this.host.config.filters.find(
          (filter) => filter.column === columnKey
        );
        const baseColor = sectionConfig?.chartColors?.general?.[0] ?? "#000000";
        sectionCounter.style.backgroundColor = hexToRgba(baseColor, 0.7);
      } else {
        sectionCounter.classList.add("hide");
      }
    });
  }

  updateFilterValueCounters() {
    const menuContainer = this.host.shadow?.getElementById("menu");
    if (!menuContainer || !this.host.dataLoader?.getFilterValueCounts) return;

    const countsByType = this.host.dataLoader.getFilterValueCounts() ?? {};

    const formatCount = (value) => {
      const numeric = typeof value === "number" ? value : 0;
      try {
        return this.host._countFormatter?.format(numeric) ?? String(numeric);
      } catch (err) {
        console.warn("Number formatter failed, using fallback:", err);
        return String(numeric);
      }
    };

    menuContainer.querySelectorAll(".form-check-input").forEach((checkbox) => {
      const counterEl = checkbox
        .closest(".form-check")
        ?.querySelector(".filter-option-count");
      if (!counterEl) return;
      const type = checkbox.getAttribute("filter-type");
      const valueKey = checkbox.value ?? "";
      const count = countsByType?.[type]?.[valueKey] ?? 0;
      counterEl.textContent = formatCount(count);
      counterEl.dataset.count = String(count);
      counterEl.setAttribute(
        "aria-label",
        `${count} matching genome${count === 1 ? "" : "s"}`
      );
    });
  }

  destroy() {
    this.host._menuAbort?.abort();
  }
}

class AMRGeoMapper extends HTMLElement {
  static STATE_LEVEL_ZOOM_THRESHOLD = 4;
  static PIE_CHART_TOP_N = 5;
  static TAXONOMY_SELECTION_WARNING_THRESHOLD = 20;
  static ICON_HEIGHT = 22;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.config;
    this.markersArray = [];
    this.availableFilters = [];
    this.map;
    this.dataLoader;
    this.headerLoaded = false;
    this.speciesColorMap = null;
    this.genusColorMap = null;

    this._tooltipHoverDelay = 800;
    this._countFormatter = new Intl.NumberFormat("en-US");
    this.activeChartType = null;
    this.activeChartIDPreference = null;
    this.userChartOptions = {};
    this._markerSizeScale = null;

    // Manager instances
    this._shading = new CountryShadingManager(this);
    this._tooltips = new TooltipManager(this);
    this._taxonomy = new TaxonomyModalManager(this);
    this._markers = new MapMarkerManager(this);
    this._chartPanel = new ChartPanelManager(this);
    this._filterMenu = new FilterMenuManager(this);
  }

  // --- Delegation methods for public API compatibility ---

  createCharts(locationObj, key, active) {
    this._chartPanel.createCharts(locationObj, key, active);
  }

  expandMenu(menuContainer) {
    this._chartPanel.expandMenu(menuContainer);
  }

  collapseMenu(menuContainer) {
    this._chartPanel.collapseMenu(menuContainer);
  }

  clearMapMarkers() {
    this._markers.clearMapMarkers();
  }

  setupTooltips(opts) {
    this._tooltips.setupTooltips(opts);
  }

  openModal() {
    this._taxonomy.openModal();
  }

  closeModal(loaded) {
    this._taxonomy.closeModal(loaded);
  }

  async updateCountryShading() {
    await this._shading.updateCountryShading();
  }

  generateMenu() {
    this._filterMenu.generateMenu();
  }

  updateFilterValueCounters() {
    this._filterMenu.updateFilterValueCounters();
  }

  // --- Core data pipeline ---

  createUpdateLocationObj(key, data, locations, mapLevel, linkedFields = null) {
    if (!key) return;
    if (locations[key]) {
      locations[key].updateLocationData(data);
    } else {
      const filterCategories = this.config.filters?.map((f) => f.column) ?? [];
      locations[key] = new LocationData(
        data,
        filterCategories,
        null,
        linkedFields,
      );
      switch (mapLevel) {
        case "global":
          try {
            locations[key].setGlobalLevel();
          } catch (err) {
            console.error(err);
          }
          break;
        case "stateProv":
          try {
            locations[key].setStateLevel();
          } catch (err) {
            console.error(err);
          }
          break;
      }
    }
  }

  generateFilters(newFilters) {
    for (let filterConfigObj of this.config.filters) {
      const filterType = filterConfigObj.column;
      this.availableFilters[filterType] ??= [];
      if (newFilters[filterType]) {
        this.availableFilters[filterType] = newFilters[filterType].unique || [];
      }
    }
  }

  async loadData() {
    const locations = {};
    const obsProcessor = this.dataLoader.getObservationProcessor();
    const linkedFields = obsProcessor.getLinkedFields();

    SharedRegistries.reset();

    const filterCategories = this.config.filters?.map((f) => f.column) ?? [];
    SharedRegistries.getInstance(filterCategories, null);

    let rowCount = 0;
    for await (const value of this.dataLoader.dataGenerator()) {
      rowCount++;
      if (rowCount % 5000 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const data = value;

      const normCountry = normalizeCountry(
        data.country,
        data.state_province ?? null,
      );

      const updateLocation = (key, mapLevel) => {
        if (!key) return null;
        this.createUpdateLocationObj(
          key,
          data,
          locations,
          mapLevel,
          linkedFields,
        );
        return locations[key];
      };

      if (data.state_province) {
        if (normCountry) {
          updateLocation(normCountry, "country");
        }
        updateLocation(data.state_province, "stateProv");
      } else {
        if (normCountry) {
          updateLocation(normCountry, "country");
        } else {
          updateLocation("stateless", "country");
        }
      }

      updateLocation("global", "global");

      const observations = obsProcessor.explodeRow(data);
      for (const obs of observations) {
        if (data.state_province && normCountry && locations[normCountry]) {
          locations[normCountry].setLinkedFields(linkedFields);
          locations[normCountry].updateFromObservation(obs);
        }
        if (data.state_province && locations[data.state_province]) {
          locations[data.state_province].setLinkedFields(linkedFields);
          locations[data.state_province].updateFromObservation(obs);
        }
        if (!data.state_province && normCountry && locations[normCountry]) {
          locations[normCountry].setLinkedFields(linkedFields);
          locations[normCountry].updateFromObservation(obs);
        }
        if (!data.state_province && !normCountry && locations["stateless"]) {
          locations["stateless"].setLinkedFields(linkedFields);
          locations["stateless"].updateFromObservation(obs);
        }
        if (locations["global"]) {
          locations["global"].setLinkedFields(linkedFields);
          locations["global"].updateFromObservation(obs);
        }
      }

      this.dataLoader.incrementObservationCount(observations.length);
    }

    this.removeAttribute("loading");

    this.locationObjs = locations;
  }

  // --- Map orchestration ---

  loadMap(reloadMenu, { focusID = null, focusLocation = "global" } = {}) {
    this._mapAbort?.abort();
    this._mapAbort = new AbortController();
    const { signal } = this._mapAbort;

    if (this._mapClickHandler) {
      this.map.off("click", this._mapClickHandler);
      this._mapClickHandler = null;
    }

    const makePalette = (groupBy, existingMap = null, colorIterator = null) => {
      const global = this.locationObjs?.global;
      if (!global) {
        return existingMap ? { ...existingMap } : {};
      }

      const reg = groupBy === "species" ? global.reg.species : global.reg.genus;
      const counts =
        groupBy === "species" ? global.speciesCounts : global.genusCounts;

      if (!counts || counts.size === 0) {
        return existingMap ? { ...existingMap } : {};
      }

      const groupIds = Array.from(counts.keys()).sort(
        (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
      );

      const colorMap = existingMap ? { ...existingMap } : {};
      for (const gId of groupIds) {
        const name = reg.strOf(gId);
        if (!colorMap[name]) {
          const nextColor = colorIterator.next().value;
          colorMap[name] = nextColor;
        }
      }
      return colorMap;
    };

    if (this.speciesColorMap === null) {
      this._speciesColorIter = new ColorGenerator(
        "vibrantTones",
        false,
      ).getBarColor();
      this._genusColorIter = new ColorGenerator(
        "vibrantTones",
        true,
      ).getBarColor();
      this.speciesColorMap = makePalette(
        "species",
        null,
        this._speciesColorIter,
      );
      this.genusColorMap = makePalette("genus", null, this._genusColorIter);
    } else {
      this.speciesColorMap = makePalette(
        "species",
        this.speciesColorMap,
        this._speciesColorIter,
      );
      this.genusColorMap = makePalette(
        "genus",
        this.genusColorMap,
        this._genusColorIter,
      );
    }

    this._markers.computeMarkerSizeScale();

    let promises = [];
    const locationKeys = Object.keys(this.locationObjs);

    this.markersArray = [];
    for (let key of locationKeys) {
      if (this.locationObjs[key].country) {
        promises.push(
          new Promise((resolve) => {
            try {
              const marker = this._markers.createPin(
                this.locationObjs[key],
                key,
              );
              if (marker) {
                this.markersArray.push(marker);
              }
              resolve();
            } catch (err) {
              console.error(`Error: ${err}`);
              resolve();
            }
          }),
        );
      }
    }
    promises.push(
      new Promise((resolve) => {
        const targetLocation = focusLocation || "global";
        const locationObj =
          this.locationObjs[targetLocation] || this.locationObjs.global;
        this.activeLocation = targetLocation;
        this.createCharts(locationObj, targetLocation, focusID);
        this.expandMenu(this.shadow.getElementById("charts"));
        resolve();
      }),
    );
    if (reloadMenu) {
      promises.push(
        new Promise((resolve) => {
          this.generateMenu();
          resolve();
        }),
      );
    }
    Promise.all(promises)
      .then(async () => {
        this.updateFilterValueCounters();
        await this.updateCountryShading();
        requestAnimationFrame(() => {
          this.map?.invalidateSize();
        });
      })
      .catch((err) => {
        console.error("Error finalizing map render:", err);
      });

    this.setupTooltips({ hoverDelay: this._tooltipHoverDelay });
    const openModalBtn = this.shadow.querySelector("#openTaxonModal");
    openModalBtn.addEventListener(
      "click",
      () => {
        this._taxonomy.selectionWorking = new Set(
          this._taxonomy.selectionCommitted || [],
        );
        this._taxonomy.applySelectionSet(this._taxonomy.selectionWorking);
        this.openModal();
      },
      { signal },
    );

    this._mapClickHandler = () => {
      this.activeLocation = "global";
      const active = this.activeChartIDPreference || this.activeChartID || null;
      const globalLocation = this.locationObjs?.global;
      if (globalLocation) {
        this.createCharts(globalLocation, "global", active);
        this.expandMenu(this.shadow.getElementById("charts"));
      }
    };
    this.map.on("click", this._mapClickHandler);
  }

  reload({ reloadMenu = true, focusID = null, focusLocation = null } = {}) {
    this.clearMapMarkers();

    this.loadData()
      .then(() => {
        this.loadMap(reloadMenu, { focusID, focusLocation });
      })
      .catch((err) => console.error("Failed to reload: ", err));
  }

  initMap() {
    const mapEl = this.shadow.querySelector("#map");
    const lat = this.config.mapOptions.initialLocation.lat ?? 0;
    const lng = this.config.mapOptions.initialLocation.lng ?? 0;
    const zoom = this.config.mapOptions.initialLocation.zoom ?? 4;

    this.map = L.map(mapEl, {
      center: [lat, lng],
      zoom: zoom,
      minZoom: 2,
      zoomControl: true,
      attributionControl: true,
    });

    const tileConfig = this.config.mapOptions.tileProvider ?? {
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
    };

    L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: tileConfig.maxZoom,
    }).addTo(this.map);

    requestAnimationFrame(() => {
      this.map.invalidateSize();
    });

    if (this.config.mapOptions.countryShading?.enabled) {
      this._shading.initCountryShading();
    }
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // --- Lifecycle ---

  async connectedCallback() {
    try {
      const template = document.createElement("template");
      const wrapper = document.createElement("div");
      wrapper.setAttribute("id", "amr-geo-mapper-wrapper");
      wrapper.innerHTML = HTMLhelper.template();
      template.content.appendChild(wrapper);
      this.shadow.appendChild(template.content);

      const headerSection = this.shadow.getElementById("header-area");
      if (headerSection && !this.headerLoaded) {
        headerSection.innerHTML = HTMLhelper.headerArea("", 0);
        this.headerLoaded = true;
      }

      localStorage.setItem("AMRTrackerUserDataLoaded", false);
    } catch (err) {
      console.error("Error initializing HTML: ", err);
    }

    const configURL = this.getAttribute("config-url");
    if (!configURL) {
      console.error("Missing config-url attribute");
      return;
    }

    const taxonURL = this.getAttribute("taxonomy-info");
    if (!taxonURL) {
      console.error("missing taxonomy-info attribute");
      return;
    }

    try {
      const configRes = await fetch(configURL);
      if (!configRes.ok) {
        throw new Error(`Error loading config. Status: ${configRes.status}`);
      }
      const configData = await configRes.json();
      this.config = configData;

      if (this.config.filters) {
        this.config.filters.forEach((filter) => {
          if (filter.hasBarChart && filter.chartType) {
            if (typeof filter.chartType === "string") {
              filter.chartType = [filter.chartType];
            } else if (!Array.isArray(filter.chartType)) {
              filter.chartType = ["stackedBar"];
            }
          } else if (filter.hasBarChart && !filter.chartType) {
            filter.chartType = ["stackedBar"];
          }
        });
      }

      this.dataLoader = new DataLoader(
        this.config.filters?.map((f) => {
          return { column: f.column, arrayType: f.arrayType };
        }) ?? [],
        this.config,
      );

      const leafletCSSUrl = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";

      const loadCSS = (url, target) => {
        return new Promise((resolve, reject) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = url;
          link.onload = resolve;
          link.onerror = reject;
          target.appendChild(link);
        });
      };

      await Promise.all([
        loadCSS(leafletCSSUrl, document.head),
        loadCSS(leafletCSSUrl, this.shadow),
        this.loadScript(`https://cdn.jsdelivr.net/npm/chart.js`),
        this.loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"),
      ]);

      await this._taxonomy.loadTaxonomyModal(taxonURL);

      // Pass config to the CSV upload button so it can derive column lists
      // (must be after loadTaxonomyModal, which renders the <csv-upload-button> element)
      const uploadBtn = this.shadow.querySelector("csv-upload-button");
      if (uploadBtn) uploadBtn.setConfig(configData);
      this.setupTooltips({ hoverDelay: this._tooltipHoverDelay });
      if (!this.hasAttribute("no-open-on-load")) this.openModal();
      this.initMap();
    } catch (err) {
      console.error("Map loading failed:", err);
    }
  }

  disconnectedCallback() {
    this._menuAbort?.abort();
    this._mapAbort?.abort();

    if (this._mapClickHandler && this.map) {
      this.map.off("click", this._mapClickHandler);
      this._mapClickHandler = null;
    }

    this._markers.destroy();
    this._shading.destroy();
    this._tooltips.destroy();
    this._chartPanel.destroy();
    this._filterMenu.destroy();

    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }
}

customElements.define("amr-geo-mapper", AMRGeoMapper);

/* eslint-disable */
var base64 = 'Lyogcm9sbHVwLXBsdWdpbi13ZWItd29ya2VyLWxvYWRlciAqLwooZnVuY3Rpb24gKCkgewogICd1c2Ugc3RyaWN0JzsKCiAgLyoqDQogICAqIEZldGNoZXMgc3BlY2llcyBuYW1lcyBmb3IgYSBsaXN0IG9mIFNSQSBhY2Nlc3Npb25zIHVzaW5nIEVCSSBFTkEgQVBJLg0KICAgKiBAcGFyYW0ge3N0cmluZ1tdfSBhY2Nlc3Npb25zIC0gQXJyYXkgb2Ygc3RyaW5ncyBsaWtlIFsnU1JSODE5NDg2MicsICdTUlIxMjM0NTYnXQ0KICAgKiBAcmV0dXJucyB7UHJvbWlzZTxPYmplY3Q+fSAtIE9iamVjdCBtYXBwaW5nIGFjY2Vzc2lvbiB0byBzcGVjaWVzIG5hbWUNCiAgICovDQogIGZ1bmN0aW9uIHBhcnNlVHN2TWFwKHRleHQsIGFjY2Vzc2lvbkZpZWxkLCBzcGVjaWVzRmllbGQpIHsNCiAgICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoL1xyP1xuLykuZmlsdGVyKEJvb2xlYW4pOw0KICAgIGlmICghbGluZXMubGVuZ3RoKSByZXR1cm4ge307DQogICAgY29uc3QgaGVhZGVycyA9IGxpbmVzWzBdLnNwbGl0KCJcdCIpOw0KICAgIGNvbnN0IGFjY0lkeCA9IGhlYWRlcnMuaW5kZXhPZihhY2Nlc3Npb25GaWVsZCk7DQogICAgY29uc3Qgc3BlY2llc0lkeCA9IGhlYWRlcnMuaW5kZXhPZihzcGVjaWVzRmllbGQpOw0KICAgIGlmIChhY2NJZHggPT09IC0xIHx8IHNwZWNpZXNJZHggPT09IC0xKSByZXR1cm4ge307DQoNCiAgICBjb25zdCBvdXQgPSB7fTsNCiAgICBmb3IgKGxldCBpID0gMTsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7DQogICAgICBjb25zdCBjb2xzID0gbGluZXNbaV0uc3BsaXQoIlx0Iik7DQogICAgICBjb25zdCBhY2MgPSBjb2xzW2FjY0lkeF07DQogICAgICBjb25zdCBzcGVjaWVzID0gY29sc1tzcGVjaWVzSWR4XTsNCiAgICAgIGlmIChhY2MpIG91dFthY2NdID0gc3BlY2llcyB8fCAiIjsNCiAgICB9DQogICAgcmV0dXJuIG91dDsNCiAgfQ0KDQogIGFzeW5jIGZ1bmN0aW9uIGZldGNoSnNvbk9yVHN2KHVybEpzb24sIHVybFRzdikgew0KICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsSnNvbik7DQogICAgaWYgKCFyZXNwb25zZS5vaykgdGhyb3cgbmV3IEVycm9yKGBBUEkgRXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfWApOw0KICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7DQogICAgdHJ5IHsNCiAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHRleHQpOw0KICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkgJiYgZGF0YS5sZW5ndGggPiAwKSB7DQogICAgICAgIHJldHVybiB7IHR5cGU6ICJqc29uIiwgZGF0YSB9Ow0KICAgICAgfQ0KICAgIH0gY2F0Y2ggKF8pIHsNCiAgICAgIC8vIGZhbGwgdGhyb3VnaCB0byBUU1YNCiAgICB9DQogICAgY29uc3QgdHN2UmVzID0gYXdhaXQgZmV0Y2godXJsVHN2KTsNCiAgICBpZiAoIXRzdlJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBBUEkgRXJyb3I6ICR7dHN2UmVzLnN0YXR1c31gKTsNCiAgICBjb25zdCB0c3ZUZXh0ID0gYXdhaXQgdHN2UmVzLnRleHQoKTsNCiAgICByZXR1cm4geyB0eXBlOiAidHN2IiwgZGF0YTogdHN2VGV4dCB9Ow0KICB9DQoNCiAgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTZWFyY2hGYWxsYmFjayhiYXNlU2VhcmNoVXJsLCBxdWVyeSkgew0KICAgIGNvbnN0IHVybCA9IGAke2Jhc2VTZWFyY2hVcmx9P3Jlc3VsdD1yZWFkX3J1biZxdWVyeT0ke2VuY29kZVVSSUNvbXBvbmVudCgNCiAgICBxdWVyeQ0KICApfSZmaWVsZHM9cnVuX2FjY2Vzc2lvbixzY2llbnRpZmljX25hbWUmZm9ybWF0PWpzb25gOw0KICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2godXJsKTsNCiAgICBpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoYEFQSSBFcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9YCk7DQogICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTsNCiAgICByZXR1cm4gQXJyYXkuaXNBcnJheShkYXRhKSA/IGRhdGEgOiBbXTsNCiAgfQ0KDQogIGFzeW5jIGZ1bmN0aW9uIGdldFNwZWNpZXNCYXRjaChhY2Nlc3Npb25zLCBvcHRpb25zID0ge30pIHsNCiAgICAgIGNvbnN0IHsgb25Qcm9ncmVzcyB9ID0gb3B0aW9uczsNCiAgICAgIC8vIDEuIEVCSSBFTkEgRW5kcG9pbnQgKE1pcnJvcnMgTkNCSSBTUkEpDQogICAgICBjb25zdCBCQVNFX1VSTCA9ICJodHRwczovL3d3dy5lYmkuYWMudWsvZW5hL3BvcnRhbC9hcGkvZmlsZXJlcG9ydCI7DQogICAgICBjb25zdCBTRUFSQ0hfVVJMID0gImh0dHBzOi8vd3d3LmViaS5hYy51ay9lbmEvcG9ydGFsL2FwaS9zZWFyY2giOw0KICAgICAgDQogICAgICAvLyAyLiBDT05GSUdVUkFUSU9ODQogICAgICBjb25zdCBDSFVOS19TSVpFID0gNTA7IC8vIEtlZXAgVVJMIGxlbmd0aCBzYWZlICh1bmRlciAyMDAwIGNoYXJzKQ0KICAgICAgY29uc3QgcmVzdWx0cyA9IHt9Ow0KICAgIA0KICAgICAgLy8gMy4gSEVMUEVSOiBDaHVuayB0aGUgYXJyYXkNCiAgICAgIGNvbnN0IGNsZWFuZWQgPSBBcnJheS5mcm9tKA0KICAgICAgICBuZXcgU2V0KA0KICAgICAgICAgIChhY2Nlc3Npb25zIHx8IFtdKQ0KICAgICAgICAgICAgLm1hcCgoYSkgPT4gU3RyaW5nKGEpLnRyaW0oKSkNCiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbikNCiAgICAgICAgICAgIC5tYXAoKGEpID0+IGEudG9VcHBlckNhc2UoKSkNCiAgICAgICAgKQ0KICAgICAgKTsNCiAgICAgIGlmIChjbGVhbmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlc3VsdHM7DQoNCiAgICAgIGNvbnN0IGNodW5rcyA9IFtdOw0KICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbGVhbmVkLmxlbmd0aDsgaSArPSBDSFVOS19TSVpFKSB7DQogICAgICAgIGNodW5rcy5wdXNoKGNsZWFuZWQuc2xpY2UoaSwgaSArIENIVU5LX1NJWkUpKTsNCiAgICAgIH0NCiAgICANCiAgICAgIC8vIDQuIFBST0NFU1MgQ0hVTktTDQogICAgICAvLyBXZSB1c2UgYSBsb29wIGluc3RlYWQgb2YgUHJvbWlzZS5hbGwgdG8gYXZvaWQgaGl0dGluZyByYXRlIGxpbWl0cyB3aXRoIHRvbyBtYW55IHBhcmFsbGVsIGNvbm5lY3Rpb25zDQogICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykgew0KICAgICAgICBjb25zdCBjaHVuayA9IGNodW5rc1tpXTsNCiAgICAgICAgY29uc3QgaWRzID0gY2h1bmsuam9pbigiLCIpOw0KICAgICAgICANCiAgICAgICAgLy8gQ29uc3RydWN0IFVSTA0KICAgICAgICAvLyByZXN1bHQ9cmVhZF9ydW4gLT4gTG9vayBmb3IgU1JBIHJ1bnMNCiAgICAgICAgLy8gZmllbGRzPXNjaWVudGlmaWNfbmFtZSAtPiBPbmx5IGdldCB0aGUgc3BlY2llcw0KICAgICAgICAvLyBmb3JtYXQ9anNvbiAtPiBFYXN5IGZvciBKUw0KICAgICAgICBjb25zdCB1cmxKc29uID0gYCR7QkFTRV9VUkx9P2FjY2Vzc2lvbj0ke2lkc30mcmVzdWx0PXJlYWRfcnVuJmZpZWxkcz1ydW5fYWNjZXNzaW9uLHNjaWVudGlmaWNfbmFtZSZmb3JtYXQ9anNvbmA7DQogICAgICAgIGNvbnN0IHVybFRzdiA9IGAke0JBU0VfVVJMfT9hY2Nlc3Npb249JHtpZHN9JnJlc3VsdD1yZWFkX3J1biZmaWVsZHM9cnVuX2FjY2Vzc2lvbixzY2llbnRpZmljX25hbWUmZm9ybWF0PXRzdmA7DQogICAgDQogICAgICAgIHRyeSB7DQogICAgICAgICAgbGV0IGZvdW5kQW55ID0gZmFsc2U7DQogICAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2hKc29uT3JUc3YodXJsSnNvbiwgdXJsVHN2KTsNCiAgICAgICAgICBpZiAocmVzLnR5cGUgPT09ICJqc29uIikgew0KICAgICAgICAgICAgcmVzLmRhdGEuZm9yRWFjaCgoaXRlbSkgPT4gew0KICAgICAgICAgICAgICByZXN1bHRzW2l0ZW0ucnVuX2FjY2Vzc2lvbl0gPSBpdGVtLnNjaWVudGlmaWNfbmFtZTsNCiAgICAgICAgICAgIH0pOw0KICAgICAgICAgICAgZm91bmRBbnkgPSByZXMuZGF0YS5sZW5ndGggPiAwOw0KICAgICAgICAgIH0gZWxzZSB7DQogICAgICAgICAgICBjb25zdCBtYXBwZWQgPSBwYXJzZVRzdk1hcCgNCiAgICAgICAgICAgICAgcmVzLmRhdGEsDQogICAgICAgICAgICAgICJydW5fYWNjZXNzaW9uIiwNCiAgICAgICAgICAgICAgInNjaWVudGlmaWNfbmFtZSINCiAgICAgICAgICAgICk7DQogICAgICAgICAgICBPYmplY3QuYXNzaWduKHJlc3VsdHMsIG1hcHBlZCk7DQogICAgICAgICAgICBmb3VuZEFueSA9IE9iamVjdC5rZXlzKG1hcHBlZCkubGVuZ3RoID4gMDsNCiAgICAgICAgICB9DQoNCiAgICAgICAgICBpZiAoIWZvdW5kQW55KSB7DQogICAgICAgICAgICBjb25zdCBxdWVyeSA9IGNodW5rLm1hcCgoaWQpID0+IGBydW5fYWNjZXNzaW9uPSR7aWR9YCkuam9pbigiIE9SICIpOw0KICAgICAgICAgICAgY29uc3QgZmFsbGJhY2tEYXRhID0gYXdhaXQgZmV0Y2hTZWFyY2hGYWxsYmFjayhTRUFSQ0hfVVJMLCBxdWVyeSk7DQogICAgICAgICAgICBmYWxsYmFja0RhdGEuZm9yRWFjaCgoaXRlbSkgPT4gew0KICAgICAgICAgICAgICByZXN1bHRzW2l0ZW0ucnVuX2FjY2Vzc2lvbl0gPSBpdGVtLnNjaWVudGlmaWNfbmFtZTsNCiAgICAgICAgICAgIH0pOw0KICAgICAgICAgIH0NCiAgICAgICAgICANCiAgICAgICAgfSBjYXRjaCAoZXJyKSB7DQogICAgICAgICAgY29uc29sZS5lcnJvcigiQmF0Y2ggZmFpbGVkOiIsIGVycik7DQogICAgICAgICAgLy8gT3B0aW9uYWw6IEFkZCBsb2dpYyB0byByZXRyeSBmYWlsZWQgY2h1bmtzDQogICAgICAgIH0NCiAgICAgICAgb25Qcm9ncmVzcz8uKHsgY29tcGxldGVkOiBpICsgMSwgdG90YWw6IGNodW5rcy5sZW5ndGggfSk7DQogICAgICB9DQogICAgDQogICAgICByZXR1cm4gcmVzdWx0czsNCiAgICB9DQogICAgDQogICAgLy8gTm90ZTogaW50ZW50aW9uYWxseSBubyBpbmxpbmUgdXNhZ2UgdG8gYXZvaWQgc2lkZSBlZmZlY3RzIG9uIGltcG9ydC4KCiAgLyoqDQogICAqIFNoYXJlZCBDU1YgcGFyc2luZyB1dGlsaXRpZXMgdXNlZCBieSBib3RoIHRoZSBtYWluIHRocmVhZCAodXNlckZpbGVIYW5kbGVyKQ0KICAgKiBhbmQgdGhlIHdlYiB3b3JrZXIgKGNzdi13b3JrZXIpLg0KICAgKi8NCg0KICBjb25zdCBBTVJfV0FUQ0hfSEVBREVSUyA9IHsNCiAgICBhY2Nlc3Npb246ICJSdW4gQWNjZXNzaW9uIiwNCiAgICBjb3VudHJ5OiAiQ291bnRyeSBOYW1lIiwNCiAgICBkYXRlOiAiQ29sbGVjdGlvbiBEYXRlIiwNCiAgICBkcnVnQ29sczogew0KICAgICAgIjNHIENFUEhBTE9TUE9SSU4iOiAiY2VwaGFsb3Nwb3JpbiIsDQogICAgICBRVUlOT0xPTkU6ICJxdWlub2xvbmUiLA0KICAgICAgQ0FSQkFQRU5FTTogImNhcmJhcGVuZW0iLA0KICAgIH0sDQogIH07DQoNCiAgLyoqDQogICAqIFBhcnNlIGEgc2luZ2xlIENTViBsaW5lLCBoYW5kbGluZyBxdW90ZWQgZmllbGRzIGFuZCBlc2NhcGVkIHF1b3Rlcy4NCiAgICovDQogIGZ1bmN0aW9uIHBhcnNlQ3N2TGluZShsaW5lLCBkZWxpbWl0ZXIgPSAiLCIpIHsNCiAgICBjb25zdCBvdXQgPSBbXTsNCiAgICBsZXQgY3VyID0gIiI7DQogICAgbGV0IGluUSA9IGZhbHNlOw0KDQogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lLmxlbmd0aDsgaSsrKSB7DQogICAgICBjb25zdCBjaCA9IGxpbmVbaV07DQogICAgICBpZiAoY2ggPT09ICciJykgew0KICAgICAgICBpZiAoaW5RICYmIGxpbmVbaSArIDFdID09PSAnIicpIHsNCiAgICAgICAgICBjdXIgKz0gJyInOw0KICAgICAgICAgIGkrKzsNCiAgICAgICAgfSBlbHNlIHsNCiAgICAgICAgICBpblEgPSAhaW5ROw0KICAgICAgICB9DQogICAgICB9IGVsc2UgaWYgKGNoID09PSBkZWxpbWl0ZXIgJiYgIWluUSkgew0KICAgICAgICBvdXQucHVzaChjdXIpOw0KICAgICAgICBjdXIgPSAiIjsNCiAgICAgIH0gZWxzZSB7DQogICAgICAgIGN1ciArPSBjaDsNCiAgICAgIH0NCiAgICB9DQogICAgb3V0LnB1c2goY3VyKTsNCiAgICAvLyBTdHJpcCBCT00gb24gZmlyc3QgY2VsbCBpZiBwcmVzZW50OyB0cmltIHNwYWNlcw0KICAgIG91dFswXSA9IG91dFswXT8ucmVwbGFjZSgvXlx1RkVGRi8sICIiKSA/PyAiIjsNCiAgICByZXR1cm4gb3V0Lm1hcCgocykgPT4gcy50cmltKCkpOw0KICB9DQoNCiAgLyoqDQogICAqIERldGVjdCB0aGUgZGVsaW1pdGVyIHVzZWQgaW4gYSBDU1Ygc2FtcGxlIGJ5IGNoZWNraW5nIGNvbW1vbiBkZWxpbWl0ZXJzLg0KICAgKi8NCiAgZnVuY3Rpb24gc25pZmZEZWxpbWl0ZXIoc2FtcGxlLCBmYWxsYmFjayA9ICIsIikgew0KICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBbIiwiLCAiXHQiLCAiOyIsICJ8Il07DQogICAgY29uc3Qgc2NvcmVzID0gbmV3IE1hcChjYW5kaWRhdGVzLm1hcCgoZCkgPT4gW2QsIDBdKSk7DQogICAgY29uc3QgbGluZXMgPSBzYW1wbGUuc3BsaXQoL1xyP1xuLykuc2xpY2UoMCwgMTApOw0KDQogICAgZm9yIChjb25zdCBkIG9mIGNhbmRpZGF0ZXMpIHsNCiAgICAgIGxldCBvayA9IDA7DQogICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHsNCiAgICAgICAgaWYgKCFsaW5lKSBjb250aW51ZTsNCiAgICAgICAgY29uc3QgcGFydHMgPSBwYXJzZUNzdkxpbmUobGluZSwgZCk7DQogICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSBvaysrOw0KICAgICAgfQ0KICAgICAgc2NvcmVzLnNldChkLCBvayk7DQogICAgfQ0KDQogICAgbGV0IGJlc3QgPSB7IGQ6IGZhbGxiYWNrLCBzOiAtMSB9Ow0KICAgIGZvciAoY29uc3QgW2QsIHNdIG9mIHNjb3Jlcykgew0KICAgICAgaWYgKHMgPiBiZXN0LnMpIGJlc3QgPSB7IGQsIHMgfTsNCiAgICB9DQogICAgcmV0dXJuIGJlc3QucyA+IDAgPyBiZXN0LmQgOiBmYWxsYmFjazsNCiAgfQ0KDQogIC8qKg0KICAgKiBQYXJzZSB0aGUgaGVhZGVyIHJvdyBmcm9tIGEgQ1NWIHNhbXBsZSwgZGV0ZWN0aW5nIGRlbGltaXRlciBpZiBub3QgcHJvdmlkZWQuDQogICAqLw0KICBmdW5jdGlvbiBwYXJzZUhlYWRlclNhbXBsZShzYW1wbGUsIGRlbGltaXRlciA9IG51bGwpIHsNCiAgICBpZiAoIXNhbXBsZSkgew0KICAgICAgcmV0dXJuIHsgaGVhZGVyczogW10sIGRlbGltaXRlcjogZGVsaW1pdGVyIHx8ICIsIiB9Ow0KICAgIH0NCiAgICBjb25zdCBmaXJzdExpbmUgPSBzYW1wbGUuc3BsaXQoL1xyP1xuLylbMF0gPz8gIiI7DQogICAgY29uc3QgZGVsaW0gPSBkZWxpbWl0ZXIgfHwgc25pZmZEZWxpbWl0ZXIoc2FtcGxlLCAiLCIpOw0KICAgIGNvbnN0IGhlYWRlcnMgPSBwYXJzZUNzdkxpbmUoZmlyc3RMaW5lLCBkZWxpbSk7DQogICAgcmV0dXJuIHsgaGVhZGVycywgZGVsaW1pdGVyOiBkZWxpbSB9Ow0KICB9DQoNCiAgLyoqDQogICAqIENoZWNrIGlmIGhlYWRlcnMgaW5kaWNhdGUgYW4gQU1SLndhdGNoIGZvcm1hdCBmaWxlLg0KICAgKi8NCiAgZnVuY3Rpb24gaXNBbXJXYXRjaEhlYWRlcnMoaGVhZGVycykgew0KICAgIGNvbnN0IHJlcXVpcmVkID0gWw0KICAgICAgQU1SX1dBVENIX0hFQURFUlMuYWNjZXNzaW9uLA0KICAgICAgQU1SX1dBVENIX0hFQURFUlMuY291bnRyeSwNCiAgICAgIEFNUl9XQVRDSF9IRUFERVJTLmRhdGUsDQogICAgXTsNCiAgICByZXR1cm4gcmVxdWlyZWQuZXZlcnkoKGgpID0+IGhlYWRlcnMuaW5jbHVkZXMoaCkpOw0KICB9CgogIC8qKg0KICAgKiBQdXJlIGRhdGEtdHJhbnNmb3JtYXRpb24gZnVuY3Rpb25zIGV4dHJhY3RlZCBmcm9tIGNzdi13b3JrZXIuanMNCiAgICogc28gdGhleSBjYW4gYmUgaW1wb3J0ZWQgYnkgYm90aCB0aGUgd29ya2VyIGFuZCBieSB1bml0IHRlc3RzLg0KICAgKi8NCg0KICBjb25zdCBERUZBVUxUX0xJU1RfU0VQQVJBVE9SID0gIiwiOw0KDQogIC8vIC0tLS0tLS0tLS0gRGF0ZSBoZWxwZXJzIC0tLS0tLS0tLS0NCiAgZnVuY3Rpb24gZXh0cmFjdENvbGxlY3Rpb25ZZWFyKHJhd0RhdGUpIHsNCiAgICBpZiAocmF3RGF0ZSA9PSBudWxsKSByZXR1cm4gbnVsbDsNCiAgICBjb25zdCBzID0gU3RyaW5nKHJhd0RhdGUpLnRyaW0oKTsNCiAgICBpZiAoIXMpIHJldHVybiBudWxsOw0KDQogICAgLy8gTW9zdCBmb3JtYXRzIGFyZSB5ZWFyLWZpcnN0IChZWVlZLCBZWVlZLU1NLURELCBZWVlZL01NL0RELCBJU08gc3RyaW5ncykuDQogICAgbGV0IG1hdGNoID0gcy5tYXRjaCgvXihcZHs0fSkoPzpbXlxkXXwkKS8pOw0KICAgIGlmIChtYXRjaCkgcmV0dXJuIG1hdGNoWzFdOw0KDQogICAgLy8gRmFsbGJhY2s6IGNhcHR1cmUgYSA0LWRpZ2l0IHllYXIgYXQgdGhlIGVuZCAoZS5nLiwgREQvTU0vWVlZWSkuDQogICAgbWF0Y2ggPSBzLm1hdGNoKC8oXGR7NH0pJC8pOw0KICAgIGlmIChtYXRjaCkgcmV0dXJuIG1hdGNoWzFdOw0KDQogICAgLy8gTGFzdCByZXNvcnQ6IERhdGUgcGFyc2VyLg0KICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBEYXRlKHMpOw0KICAgIGlmICghTnVtYmVyLmlzTmFOKHBhcnNlZC5nZXRUaW1lKCkpKSB7DQogICAgICByZXR1cm4gU3RyaW5nKHBhcnNlZC5nZXRGdWxsWWVhcigpKTsNCiAgICB9DQoNCiAgICByZXR1cm4gbnVsbDsNCiAgfQ0KDQogIC8vIC0tLS0tLS0tLS0gVHlwZSBpbmZlcmVuY2UgLS0tLS0tLS0tLQ0KICBmdW5jdGlvbiBpbmZlclZhbHVlKHZhbHVlKSB7DQogICAgaWYgKHZhbHVlID09IG51bGwpIHJldHVybiBudWxsOw0KICAgIGNvbnN0IHMgPSBTdHJpbmcodmFsdWUpLnRyaW0oKTsNCg0KICAgIC8vIG51bGwtaXNoDQogICAgaWYgKHMgPT09ICIiIHx8IC9eKG5hfG5cL2F8bnVsbHxub25lKSQvaS50ZXN0KHMpKSByZXR1cm4gbnVsbDsNCg0KICAgIC8vIGJvb2wNCiAgICBpZiAoL14odHJ1ZXxmYWxzZSkkL2kudGVzdChzKSkgcmV0dXJuIHMudG9Mb3dlckNhc2UoKSA9PT0gInRydWUiOw0KDQogICAgLy8gaW50DQogICAgaWYgKC9eLT9cZCskLy50ZXN0KHMpKSB7DQogICAgICBjb25zdCBuID0gTnVtYmVyKHMpOw0KICAgICAgaWYgKE51bWJlci5pc1NhZmVJbnRlZ2VyKG4pKSByZXR1cm4gbjsNCiAgICB9DQoNCiAgICAvLyBmbG9hdA0KICAgIGNvbnN0IGYgPSBOdW1iZXIocyk7DQogICAgaWYgKCFOdW1iZXIuaXNOYU4oZikpIHJldHVybiBmOw0KDQogICAgcmV0dXJuIHZhbHVlOw0KICB9DQoNCiAgLy8gLS0tLS0tLS0tLSBWYWxpZGF0aW9uIGhlbHBlcnMgLS0tLS0tLS0tLQ0KICBmdW5jdGlvbiB2YWxpZGF0ZUhlYWRlcnMoaGVhZGVycywgcmVxdWlyZUhlYWRlcnMgPSBbXSkgew0KICAgIGNvbnN0IG1pc3NpbmcgPSBbXTsNCiAgICBmb3IgKGNvbnN0IGggb2YgcmVxdWlyZUhlYWRlcnMpIGlmICghaGVhZGVycy5pbmNsdWRlcyhoKSkgbWlzc2luZy5wdXNoKGgpOw0KICAgIHJldHVybiB7IG9rOiBtaXNzaW5nLmxlbmd0aCA9PT0gMCwgbWlzc2luZyB9Ow0KICB9DQoNCiAgZnVuY3Rpb24gdHlwZU9mVmFsdWUodikgew0KICAgIGlmICh2ID09IG51bGwpIHJldHVybiAibnVsbCI7DQogICAgaWYgKEFycmF5LmlzQXJyYXkodikpIHJldHVybiAibGlzdCI7DQogICAgcmV0dXJuIHR5cGVvZiB2OyAvLyAic3RyaW5nIiB8ICJudW1iZXIiIHwgImJvb2xlYW4iIHwgIm9iamVjdCINCiAgfQ0KDQogIGZ1bmN0aW9uIHZhbGlkYXRlUm93QWdhaW5zdFNjaGVtYShyb3csIGlkeCwgc2NoZW1hLCB1bmlxdWVTZXRzKSB7DQogICAgY29uc3QgZXJyb3JzID0gW107DQogICAgY29uc3Qgd2FybmluZ3MgPSBbXTsNCg0KICAgIC8vIHJlcXVpcmVkIG5vbi1lbXB0eSAoZm9yIHJlcXVpcmVkIGhlYWRlcnMsIG1ha2Ugc3VyZSB2YWx1ZXMgYXJlbid0IGJsYW5rKQ0KICAgIGZvciAoY29uc3QgaCBvZiBzY2hlbWEucmVxdWlyZUhlYWRlcnMgfHwgW10pIHsNCiAgICAgIGNvbnN0IHYgPSByb3dbaF07DQogICAgICBjb25zdCBlbXB0eSA9DQogICAgICAgIHYgPT0gbnVsbCB8fA0KICAgICAgICAoQXJyYXkuaXNBcnJheSh2KSA/IHYubGVuZ3RoID09PSAwIDogU3RyaW5nKHYpLnRyaW0oKSA9PT0gIiIpOw0KICAgICAgaWYgKGVtcHR5KQ0KICAgICAgICB3YXJuaW5ncy5wdXNoKHsNCiAgICAgICAgICByb3c6IGlkeCwNCiAgICAgICAgICBjb2x1bW46IGgsDQogICAgICAgICAgY29kZTogInJlcXVpcmVkX2ZpZWxkIiwNCiAgICAgICAgICBtc2c6ICJNaXNzaW5nIHJlcXVpcmVkIHZhbHVlIGluIHJvdyAiICsgaWR4LA0KICAgICAgICB9KTsNCiAgICB9DQoNCiAgICAvLyB0eXBlIGNoZWNrcw0KICAgIGlmIChzY2hlbWEudHlwZXMpIHsNCiAgICAgIGZvciAoY29uc3QgW2NvbCwgZXhwZWN0XSBvZiBPYmplY3QuZW50cmllcyhzY2hlbWEudHlwZXMpKSB7DQogICAgICAgIGNvbnN0IHYgPSByb3dbY29sXTsNCiAgICAgICAgaWYgKHYgPT0gbnVsbCkgY29udGludWU7IC8vIGFsbG93IG51bGwNCiAgICAgICAgY29uc3QgZ290ID0gdHlwZU9mVmFsdWUodik7DQogICAgICAgIGNvbnN0IG9rID0NCiAgICAgICAgICAoZXhwZWN0ID09PSAibGlzdCIgJiYgZ290ID09PSAibGlzdCIpIHx8DQogICAgICAgICAgKGV4cGVjdCA9PT0gIm51bWJlciIgJiYgZ290ID09PSAibnVtYmVyIikgfHwNCiAgICAgICAgICAoZXhwZWN0ID09PSAiYm9vbGVhbiIgJiYgZ290ID09PSAiYm9vbGVhbiIpIHx8DQogICAgICAgICAgKGV4cGVjdCA9PT0gInN0cmluZyIgJiYNCiAgICAgICAgICAgIChnb3QgPT09ICJzdHJpbmciIHx8IGdvdCA9PT0gIm51bWJlciIgfHwgZ290ID09PSAiYm9vbGVhbiIpKTsNCiAgICAgICAgaWYgKCFvaykNCiAgICAgICAgICBlcnJvcnMucHVzaCh7DQogICAgICAgICAgICByb3c6IGlkeCwNCiAgICAgICAgICAgIGNvbHVtbjogY29sLA0KICAgICAgICAgICAgY29kZTogInR5cGUiLA0KICAgICAgICAgICAgbXNnOiBgRXhwZWN0ZWQgJHtleHBlY3R9LCBnb3QgJHtnb3R9YCwNCiAgICAgICAgICB9KTsNCiAgICAgIH0NCiAgICB9DQoNCiAgICAvLyBlbnVtIGNoZWNrcw0KICAgIGlmIChzY2hlbWEuZW51bXMpIHsNCiAgICAgIGZvciAoY29uc3QgW2NvbCwgYWxsb3dlZF0gb2YgT2JqZWN0LmVudHJpZXMoc2NoZW1hLmVudW1zKSkgew0KICAgICAgICBjb25zdCB2ID0gcm93W2NvbF07DQogICAgICAgIGlmICh2ID09IG51bGwpIGNvbnRpbnVlOw0KICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2KSkgew0KICAgICAgICAgIGZvciAoY29uc3QgeCBvZiB2KSB7DQogICAgICAgICAgICBpZiAoIWFsbG93ZWQuaW5jbHVkZXMoU3RyaW5nKHgpKSkgew0KICAgICAgICAgICAgICBlcnJvcnMucHVzaCh7DQogICAgICAgICAgICAgICAgcm93OiBpZHgsDQogICAgICAgICAgICAgICAgY29sdW1uOiBjb2wsDQogICAgICAgICAgICAgICAgY29kZTogImVudW0iLA0KICAgICAgICAgICAgICAgIG1zZzogYEludmFsaWQgdmFsdWUgIiR7eH0iYCwNCiAgICAgICAgICAgICAgfSk7DQogICAgICAgICAgICB9DQogICAgICAgICAgfQ0KICAgICAgICB9IGVsc2UgaWYgKCFhbGxvd2VkLmluY2x1ZGVzKFN0cmluZyh2KSkpIHsNCiAgICAgICAgICBlcnJvcnMucHVzaCh7DQogICAgICAgICAgICByb3c6IGlkeCwNCiAgICAgICAgICAgIGNvbHVtbjogY29sLA0KICAgICAgICAgICAgY29kZTogImVudW0iLA0KICAgICAgICAgICAgbXNnOiBgSW52YWxpZCB2YWx1ZSAiJHt2fSJgLA0KICAgICAgICAgIH0pOw0KICAgICAgICB9DQogICAgICB9DQogICAgfQ0KDQogICAgLy8gdW5pcXVlbmVzcyAoY29tcG9zaXRlIGtleXMgc3VwcG9ydGVkKQ0KICAgIGlmIChzY2hlbWEudW5pcXVlICYmIHNjaGVtYS51bmlxdWUubGVuZ3RoKSB7DQogICAgICBjb25zdCBrZXkgPSBzY2hlbWEudW5pcXVlLm1hcCgoaykgPT4gU3RyaW5nKHJvd1trXSA/PyAiIikpLmpvaW4oInwiKTsNCiAgICAgIGlmICh1bmlxdWVTZXRzLmhhcyhrZXkpKSB7DQogICAgICAgIGVycm9ycy5wdXNoKHsNCiAgICAgICAgICByb3c6IGlkeCwNCiAgICAgICAgICBjb2x1bW46IHNjaGVtYS51bmlxdWUuam9pbigiLCIpLA0KICAgICAgICAgIGNvZGU6ICJkdXBsaWNhdGUiLA0KICAgICAgICAgIG1zZzogIkR1cGxpY2F0ZSBrZXkiLA0KICAgICAgICB9KTsNCiAgICAgIH0gZWxzZSB7DQogICAgICAgIHVuaXF1ZVNldHMuYWRkKGtleSk7DQogICAgICB9DQogICAgfQ0KDQogICAgcmV0dXJuIHsgZXJyb3JzLCB3YXJuaW5ncyB9Ow0KICB9DQoNCiAgLy8gLS0tLS0tLS0tLSBDU1YgaGVscGVycyAtLS0tLS0tLS0tDQogIGZ1bmN0aW9uIGlzTnVsbGlzaENlbGwodmFsdWUpIHsNCiAgICBpZiAodmFsdWUgPT0gbnVsbCkgcmV0dXJuIHRydWU7DQogICAgY29uc3QgcyA9IFN0cmluZyh2YWx1ZSkudHJpbSgpOw0KICAgIHJldHVybiBzID09PSAiIiB8fCAvXihuYXxuXC9hfG51bGx8bm9uZSkkL2kudGVzdChzKTsNCiAgfQ0KDQogIC8vIC0tLS0tLS0tLS0gTGlzdCBjb2x1bW5zIC0tLS0tLS0tLS0NCiAgZnVuY3Rpb24gcGFyc2VMaXN0RmllbGQocmF3LCBzZXAsIGluZmVyRWxlbXMpIHsNCiAgICBpZiAocmF3ID09IG51bGwpIHJldHVybiBbXTsNCiAgICBjb25zdCBzID0gU3RyaW5nKHJhdykudHJpbSgpOw0KICAgIGlmICghcykgcmV0dXJuIFtdOw0KDQogICAgLy8gVHJ5IEpTT04gYXJyYXkgZmlyc3QNCiAgICBpZiAocy5zdGFydHNXaXRoKCJbIikgJiYgcy5lbmRzV2l0aCgiXSIpKSB7DQogICAgICB0cnkgew0KICAgICAgICBjb25zdCB2YWwgPSBKU09OLnBhcnNlKHMpOw0KICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWwpKSB7DQogICAgICAgICAgcmV0dXJuIGluZmVyRWxlbXMNCiAgICAgICAgICAgID8gdmFsLm1hcCgodikgPT4gKHR5cGVvZiB2ID09PSAic3RyaW5nIiA/IGluZmVyVmFsdWUodikgOiB2KSkNCiAgICAgICAgICAgIDogdmFsOw0KICAgICAgICB9DQogICAgICB9IGNhdGNoIChfKSB7DQogICAgICAgIC8qIGlnbm9yZSAqLw0KICAgICAgfQ0KICAgIH0NCg0KICAgIGxldCBlZmZlY3RpdmVTZXAgPSBzZXAgJiYgU3RyaW5nKHNlcCkubGVuZ3RoID4gMCA/IHNlcCA6ICIsIjsNCg0KICAgIGlmICghcy5pbmNsdWRlcyhlZmZlY3RpdmVTZXApKSB7DQogICAgICAvLyBOb3RoaW5nIHRvIHNwbGl0IG9uIC0+IHRyZWF0IHRoZSB3aG9sZSB0aGluZyBhcyBvbmUgdmFsdWUNCiAgICAgIHJldHVybiBpbmZlckVsZW1zID8gW2luZmVyVmFsdWUocyldIDogW3NdOw0KICAgIH0NCg0KICAgIGNvbnN0IHBhcnRzID0gcw0KICAgICAgLnNwbGl0KGVmZmVjdGl2ZVNlcCkNCiAgICAgIC5tYXAoKHApID0+IHAudHJpbSgpKQ0KICAgICAgLmZpbHRlcihCb29sZWFuKTsNCiAgICByZXR1cm4gaW5mZXJFbGVtcyA/IHBhcnRzLm1hcChpbmZlclZhbHVlKSA6IHBhcnRzOw0KICB9DQoNCiAgLy8gLS0tLS0tLS0tLSBSb3cgdHJhbnNmb3JtIC0tLS0tLS0tLS0NCiAgZnVuY3Rpb24gdHJhbnNmb3JtUm93KA0KICAgIHJvd09iaiwNCiAgICB7IGluZmVyVHlwZXMsIGxpc3RDb2xzLCBsaXN0U2VwLCBpbmZlckxpc3RFbGVtcywga2VlcEhlYWRlcnMgfQ0KICApIHsNCiAgICBjb25zdCBvdXQgPSB7fTsNCiAgICBjb25zdCB1c2VBbGwgPSAha2VlcEhlYWRlcnMgfHwga2VlcEhlYWRlcnMubGVuZ3RoID09PSAwOw0KDQogICAgLy8gUGFyc2UgbGlua2VkIChsaXN0KSBjb2x1bW5zIGludG8gaW5kaXZpZHVhbCBhcnJheXMgZmlyc3QNCiAgICBjb25zdCBwYXJzZWRMaXN0cyA9IHt9Ow0KICAgIGxldCBtYXhMZW4gPSAwOw0KICAgIGZvciAoY29uc3QgY29sIG9mIGxpc3RDb2xzKSB7DQogICAgICBjb25zdCByYXcgPSByb3dPYmpbY29sXTsNCiAgICAgIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgY29udGludWU7DQogICAgICBjb25zdCBhcnIgPSBwYXJzZUxpc3RGaWVsZChyYXcsIGxpc3RTZXAsIGluZmVyTGlzdEVsZW1zKTsNCiAgICAgIHBhcnNlZExpc3RzW2NvbF0gPSBhcnI7DQogICAgICBpZiAoYXJyLmxlbmd0aCA+IG1heExlbikgbWF4TGVuID0gYXJyLmxlbmd0aDsNCiAgICB9DQoNCiAgICAvLyBBZGQgbm9uLWxpc3QgY29sdW1ucyB0byB0aGUgb3V0cHV0DQogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocm93T2JqKSkgew0KICAgICAgaWYgKCF1c2VBbGwgJiYgIWtlZXBIZWFkZXJzLmluY2x1ZGVzKGspKSBjb250aW51ZTsNCiAgICAgIGlmIChsaXN0Q29scy5oYXMoaykpIGNvbnRpbnVlOyAvLyBoYW5kbGVkIHZpYSBvYnNlcnZhdGlvbnMNCiAgICAgIC8vIFByZXNlcnZlIHRoZSBvYnNlcnZhdGlvbnMgYXJyYXkgYXMtaXM7IGluZmVyVmFsdWUgd291bGQgY29ycnVwdA0KICAgICAgLy8gZW1wdHkgYXJyYXlzIChTdHJpbmcoW10pID09PSAiIiDihpIgbnVsbCkgYW5kIGhhcyBubyB1c2VmdWwgZWZmZWN0DQogICAgICAvLyBvbiBhcnJheXMgb2Ygb2JqZWN0cy4NCiAgICAgIGlmIChrID09PSAib2JzZXJ2YXRpb25zIikgew0KICAgICAgICBvdXRba10gPSB2Ow0KICAgICAgfSBlbHNlIHsNCiAgICAgICAgb3V0W2tdID0gaW5mZXJUeXBlcyA/IGluZmVyVmFsdWUodikgOiB2Ow0KICAgICAgfQ0KICAgIH0NCg0KICAgIC8vIEJ1aWxkIG9ic2VydmF0aW9ucyBhcnJheSBmcm9tIHBhcnNlZCBsaXN0IGNvbHVtbnMNCiAgICBpZiAobWF4TGVuID4gMCkgew0KICAgICAgY29uc3QgbGlzdENvbE5hbWVzID0gT2JqZWN0LmtleXMocGFyc2VkTGlzdHMpOw0KICAgICAgY29uc3Qgb2JzZXJ2YXRpb25zID0gW107DQogICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heExlbjsgaSsrKSB7DQogICAgICAgIGNvbnN0IG9icyA9IHt9Ow0KICAgICAgICBmb3IgKGNvbnN0IGNvbCBvZiBsaXN0Q29sTmFtZXMpIHsNCiAgICAgICAgICBvYnNbY29sXSA9IHBhcnNlZExpc3RzW2NvbF1baV0gPz8gbnVsbDsNCiAgICAgICAgfQ0KICAgICAgICBvYnNlcnZhdGlvbnMucHVzaChvYnMpOw0KICAgICAgfQ0KICAgICAgb3V0Lm9ic2VydmF0aW9ucyA9IG9ic2VydmF0aW9uczsNCiAgICB9DQoNCiAgICByZXR1cm4gb3V0Ow0KICB9DQoNCiAgLy8gLS0tLS0tLS0tLSBGbGF0LW9ic2VydmF0aW9uIHJvdyB0cmFuc2Zvcm0gLS0tLS0tLS0tLQ0KICAvKioNCiAgICogRXh0cmFjdCBhIHNpbmdsZSBvYnNlcnZhdGlvbiBvYmplY3QgZnJvbSBhIGZsYXQgQ1NWIHJvdy4NCiAgICogUmV0dXJucyB7IHNjYWxhciwgb2JzZXJ2YXRpb24gfSB3aGVyZSBzY2FsYXIgY29udGFpbnMgbm9uLWxpbmtlZCBmaWVsZHMNCiAgICogYW5kIG9ic2VydmF0aW9uIGNvbnRhaW5zIGxpbmtlZCBmaWVsZHMgZm9yIG9uZSBvYnNlcnZhdGlvbi4NCiAgICovDQogIGZ1bmN0aW9uIGV4dHJhY3RGbGF0T2JzZXJ2YXRpb24ocm93T2JqLCBsaW5rZWRGaWVsZHNTZXQsIGluZmVyVHlwZXMpIHsNCiAgICBjb25zdCBzY2FsYXIgPSB7fTsNCiAgICBjb25zdCBvYnNlcnZhdGlvbiA9IHt9Ow0KDQogICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMocm93T2JqKSkgew0KICAgICAgY29uc3QgdmFsID0gaW5mZXJUeXBlcyA/IGluZmVyVmFsdWUodikgOiB2Ow0KICAgICAgaWYgKGxpbmtlZEZpZWxkc1NldC5oYXMoaykpIHsNCiAgICAgICAgb2JzZXJ2YXRpb25ba10gPSB2YWw7DQogICAgICB9IGVsc2Ugew0KICAgICAgICBzY2FsYXJba10gPSB2YWw7DQogICAgICB9DQogICAgfQ0KDQogICAgcmV0dXJuIHsgc2NhbGFyLCBvYnNlcnZhdGlvbiB9Ow0KICB9DQoNCiAgLyoqDQogICAqIEdyb3VwIGZsYXQgcGVyLW9ic2VydmF0aW9uIENTViByb3dzIGludG8gSlNPTkwgc2FtcGxlIHJlY29yZHMuDQogICAqIEVhY2ggb3V0cHV0IHJlY29yZCBoYXMgc2NhbGFyIGZpZWxkcyArIG9ic2VydmF0aW9uc1tdLg0KICAgKg0KICAgKiBAcGFyYW0ge09iamVjdFtdfSByb3dzIC0gUGFyc2VkIENTViByb3dzIChlYWNoIGFuIG9iamVjdCBrZXllZCBieSBoZWFkZXIpDQogICAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zDQogICAqIEBwYXJhbSB7c3RyaW5nfSBvcHRpb25zLmlkQ29sdW1uIC0gQ29sdW1uIHVzZWQgYXMgc2FtcGxlIGdyb3VwaW5nIGtleSAoZGVmYXVsdCAiaWQiKQ0KICAgKiBAcGFyYW0ge3N0cmluZ1tdfSBvcHRpb25zLmxpbmtlZEZpZWxkcyAtIENvbHVtbiBuYW1lcyB0aGF0IGJlbG9uZyBpbiBvYnNlcnZhdGlvbnNbXQ0KICAgKiBAcGFyYW0ge2Jvb2xlYW59IG9wdGlvbnMuaW5mZXJUeXBlcyAtIFdoZXRoZXIgdG8gaW5mZXIgdmFsdWUgdHlwZXMNCiAgICogQHBhcmFtIHtPYmplY3R8bnVsbH0gb3B0aW9ucy5zY2hlbWEgLSBWYWxpZGF0aW9uIHNjaGVtYQ0KICAgKiBAcGFyYW0ge251bWJlcn0gb3B0aW9ucy5tYXhFcnJvcnMgLSBNYXggdmFsaWRhdGlvbiBlcnJvcnMgYmVmb3JlIHN0b3BwaW5nDQogICAqIEBwYXJhbSB7RnVuY3Rpb259IG9wdGlvbnMucHJvZ3Jlc3NDYiAtIFByb2dyZXNzIGNhbGxiYWNrDQogICAqIEByZXR1cm5zIHt7IGpzb25sUm93czogc3RyaW5nW10sIHZhbGlkYXRpb246IE9iamVjdHxudWxsIH19DQogICAqLw0KICBmdW5jdGlvbiBncm91cEZsYXRSb3dzVG9Kc29ubChyb3dzLCB7DQogICAgaWRDb2x1bW4gPSAiaWQiLA0KICAgIGxpbmtlZEZpZWxkcyA9IFtdLA0KICAgIGluZmVyVHlwZXMgPSBmYWxzZSwNCiAgICBzY2hlbWEgPSBudWxsLA0KICAgIG1heEVycm9ycyA9IDIwMCwNCiAgICBwcm9ncmVzc0NiID0gKCkgPT4ge30sDQogIH0pIHsNCiAgICBjb25zdCBsaW5rZWRGaWVsZHNTZXQgPSBuZXcgU2V0KGxpbmtlZEZpZWxkcyk7DQogICAgY29uc3QgZ3JvdXBzID0gbmV3IE1hcCgpOyAvLyBpZFZhbHVlIOKGkiB7IHNjYWxhciwgb2JzZXJ2YXRpb25zW10gfQ0KICAgIGNvbnN0IGdyb3VwT3JkZXIgPSBbXTsgLy8gcHJlc2VydmUgaW5zZXJ0aW9uIG9yZGVyIG9mIElEcw0KDQogICAgY29uc3QgdG90YWwgPSBNYXRoLm1heCgxLCByb3dzLmxlbmd0aCk7DQoNCiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJvd3MubGVuZ3RoOyBpKyspIHsNCiAgICAgIGNvbnN0IHJvdyA9IHJvd3NbaV07DQogICAgICBjb25zdCB7IHNjYWxhciwgb2JzZXJ2YXRpb24gfSA9IGV4dHJhY3RGbGF0T2JzZXJ2YXRpb24ocm93LCBsaW5rZWRGaWVsZHNTZXQsIGluZmVyVHlwZXMpOw0KICAgICAgY29uc3QgaWQgPSBzY2FsYXJbaWRDb2x1bW5dID8/ICIiOw0KICAgICAgY29uc3Qga2V5ID0gU3RyaW5nKGlkKTsNCg0KICAgICAgaWYgKCFncm91cHMuaGFzKGtleSkpIHsNCiAgICAgICAgZ3JvdXBzLnNldChrZXksIHsgc2NhbGFyLCBvYnNlcnZhdGlvbnM6IFtdIH0pOw0KICAgICAgICBncm91cE9yZGVyLnB1c2goa2V5KTsNCiAgICAgIH0NCg0KICAgICAgLy8gT25seSBhZGQgb2JzZXJ2YXRpb24gaWYgaXQgaGFzIGF0IGxlYXN0IG9uZSBub24tbnVsbCBsaW5rZWQgZmllbGQNCiAgICAgIGNvbnN0IGhhc0NvbnRlbnQgPSBPYmplY3QudmFsdWVzKG9ic2VydmF0aW9uKS5zb21lKCh2KSA9PiB2ICE9IG51bGwpOw0KICAgICAgaWYgKGhhc0NvbnRlbnQpIHsNCiAgICAgICAgZ3JvdXBzLmdldChrZXkpLm9ic2VydmF0aW9ucy5wdXNoKG9ic2VydmF0aW9uKTsNCiAgICAgIH0NCg0KICAgICAgaWYgKGkgJSA1MDAgPT09IDApIHByb2dyZXNzQ2IoaSAvIHRvdGFsKTsNCiAgICB9DQoNCiAgICAvLyBCdWlsZCBvdXRwdXQgSlNPTkwgcm93cyArIHZhbGlkYXRlDQogICAgY29uc3QgdW5pcXVlU2V0cyA9IG5ldyBTZXQoKTsNCiAgICBjb25zdCBhbGxFcnJvcnMgPSBbXTsNCiAgICBjb25zdCBhbGxXYXJuaW5ncyA9IFtdOw0KICAgIGNvbnN0IGpzb25sUm93cyA9IFtdOw0KDQogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBncm91cE9yZGVyLmxlbmd0aDsgaSsrKSB7DQogICAgICBjb25zdCBrZXkgPSBncm91cE9yZGVyW2ldOw0KICAgICAgY29uc3QgeyBzY2FsYXIsIG9ic2VydmF0aW9ucyB9ID0gZ3JvdXBzLmdldChrZXkpOw0KICAgICAgY29uc3QgcmVjb3JkID0geyAuLi5zY2FsYXIgfTsNCiAgICAgIGlmIChvYnNlcnZhdGlvbnMubGVuZ3RoID4gMCkgew0KICAgICAgICByZWNvcmQub2JzZXJ2YXRpb25zID0gb2JzZXJ2YXRpb25zOw0KICAgICAgfQ0KDQogICAgICAvLyBEZXJpdmUgY29sbGVjdGlvbl95ZWFyIGZyb20gY29sbGVjdGlvbl9kYXRlIGlmIG5vdCBhbHJlYWR5IHByZXNlbnQNCiAgICAgIGlmIChyZWNvcmQuY29sbGVjdGlvbl9kYXRlICYmICFyZWNvcmQuY29sbGVjdGlvbl95ZWFyKSB7DQogICAgICAgIGNvbnN0IHllYXIgPSBleHRyYWN0Q29sbGVjdGlvblllYXIocmVjb3JkLmNvbGxlY3Rpb25fZGF0ZSk7DQogICAgICAgIGlmICh5ZWFyKSByZWNvcmQuY29sbGVjdGlvbl95ZWFyID0geWVhcjsNCiAgICAgIH0NCg0KICAgICAgaWYgKHNjaGVtYSkgew0KICAgICAgICBjb25zdCB7IGVycm9ycywgd2FybmluZ3MgfSA9IHZhbGlkYXRlUm93QWdhaW5zdFNjaGVtYSgNCiAgICAgICAgICByZWNvcmQsIGkgKyAyLCBzY2hlbWEsIHVuaXF1ZVNldHMsDQogICAgICAgICk7DQogICAgICAgIGlmIChlcnJvcnMubGVuZ3RoKSBhbGxFcnJvcnMucHVzaCguLi5lcnJvcnMpOw0KICAgICAgICBpZiAod2FybmluZ3MubGVuZ3RoKSBhbGxXYXJuaW5ncy5wdXNoKC4uLndhcm5pbmdzKTsNCiAgICAgICAgaWYgKGFsbEVycm9ycy5sZW5ndGggPj0gbWF4RXJyb3JzKSBicmVhazsNCiAgICAgIH0NCg0KICAgICAganNvbmxSb3dzLnB1c2goSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7DQogICAgfQ0KDQogICAgcHJvZ3Jlc3NDYigxKTsNCg0KICAgIGNvbnN0IHZhbGlkYXRpb24gPSBzY2hlbWENCiAgICAgID8gew0KICAgICAgICAgIG9rOiBhbGxFcnJvcnMubGVuZ3RoID09PSAwLA0KICAgICAgICAgIGZhdGFsOiBmYWxzZSwNCiAgICAgICAgICBoZWFkZXI6IHsgbWlzc2luZzogW10gfSwNCiAgICAgICAgICBjb3VudHM6IHsgZXJyb3JzOiBhbGxFcnJvcnMubGVuZ3RoLCB3YXJuaW5nczogYWxsV2FybmluZ3MubGVuZ3RoIH0sDQogICAgICAgICAgZXJyb3JzOiBhbGxFcnJvcnMsDQogICAgICAgICAgd2FybmluZ3M6IGFsbFdhcm5pbmdzLA0KICAgICAgICB9DQogICAgICA6IG51bGw7DQoNCiAgICByZXR1cm4geyBqc29ubFJvd3MsIHZhbGlkYXRpb24gfTsNCiAgfQ0KDQogIC8qKg0KICAgKiBCdWlsZCBhIGZhdGFsIHJlc3VsdCBvYmplY3QgZm9yIGVhcmx5IHRlcm1pbmF0aW9uIGVycm9ycy4NCiAgICovDQogIGZ1bmN0aW9uIGJ1aWxkRmF0YWxSZXN1bHQoZGVsaW1pdGVyLCBoZWFkZXJzLCBjb2RlLCBtc2csIG1pc3NpbmdIZWFkZXJzID0gW10pIHsNCiAgICBjb25zdCBlcnJvckNvdW50ID0gbWlzc2luZ0hlYWRlcnMubGVuZ3RoIHx8IDE7DQogICAgY29uc3QgZXJyb3JzID0gbWlzc2luZ0hlYWRlcnMubGVuZ3RoDQogICAgICA/IG1pc3NpbmdIZWFkZXJzLm1hcCgoaCkgPT4gKHsgcm93OiAxLCBjb2x1bW46IGgsIGNvZGUsIG1zZzogIkhlYWRlciBtaXNzaW5nIiB9KSkNCiAgICAgIDogW3sgcm93OiAxLCBjb2x1bW46ICIiLCBjb2RlLCBtc2cgfV07DQoNCiAgICByZXR1cm4gew0KICAgICAganNvbmw6ICIiLA0KICAgICAgaGVhZGVyczogaGVhZGVycyB8fCBbXSwNCiAgICAgIHJvd3M6IDAsDQogICAgICBkZWxpbWl0ZXI6IGRlbGltaXRlciB8fCAiLCIsDQogICAgICB2YWxpZGF0aW9uOiB7DQogICAgICAgIG9rOiBmYWxzZSwNCiAgICAgICAgZmF0YWw6IHRydWUsDQogICAgICAgIGhlYWRlcjogeyBtaXNzaW5nOiBtaXNzaW5nSGVhZGVycyB9LA0KICAgICAgICBjb3VudHM6IHsgZXJyb3JzOiBlcnJvckNvdW50LCB3YXJuaW5nczogMCB9LA0KICAgICAgICBlcnJvcnMsDQogICAgICAgIHdhcm5pbmdzOiBbXSwNCiAgICAgIH0sDQogICAgfTsNCiAgfQ0KDQogIC8qKg0KICAgKiBFeHRyYWN0IGNvbXBsZXRlIGxpbmVzIGZyb20gYSBidWZmZXIsIHJldHVybmluZyBsaW5lcyBhbmQgdGhlIHJlbWFpbmluZyBwYXJ0aWFsIGxpbmUuDQogICAqLw0KICBmdW5jdGlvbiBleHRyYWN0TGluZXMoYnVmZmVyKSB7DQogICAgY29uc3QgbGluZXMgPSBbXTsNCiAgICBsZXQgbGluZVN0YXJ0ID0gMDsNCg0KICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7DQogICAgICBpZiAoYnVmZmVyW2ldID09PSAiXHIiICYmIGJ1ZmZlcltpICsgMV0gPT09ICJcbiIpIHsNCiAgICAgICAgbGluZXMucHVzaChidWZmZXIuc2xpY2UobGluZVN0YXJ0LCBpKSk7DQogICAgICAgIGkrKzsgLy8gc2tpcCB0aGUgXG4gc28gaXQgaXNuJ3QgcHJvY2Vzc2VkIGFnYWluDQogICAgICAgIGxpbmVTdGFydCA9IGkgKyAxOw0KICAgICAgfSBlbHNlIGlmIChidWZmZXJbaV0gPT09ICJcbiIpIHsNCiAgICAgICAgbGluZXMucHVzaChidWZmZXIuc2xpY2UobGluZVN0YXJ0LCBpKSk7DQogICAgICAgIGxpbmVTdGFydCA9IGkgKyAxOw0KICAgICAgfQ0KICAgIH0NCg0KICAgIHJldHVybiB7IGxpbmVzLCByZW1haW5pbmc6IGJ1ZmZlci5zbGljZShsaW5lU3RhcnQpIH07DQogIH0NCg0KICBmdW5jdGlvbiBidWlsZEFtcldhdGNoUm93TWFwcGVyKA0KICAgIHNwZWNpZXNNYXAsDQogICAgYXZhaWxhYmxlRHJ1Z0NvbHMgPSBudWxsLA0KICAgIHNwZWNpZXNPdmVycmlkZSA9IG51bGwsDQogICAgYW1yV2F0Y2hDb25maWcgPSBudWxsLA0KICApIHsNCiAgICBjb25zdCBkcnVnQ29scyA9IGFtcldhdGNoQ29uZmlnPy5kcnVnQ29scyA/PyBBTVJfV0FUQ0hfSEVBREVSUy5kcnVnQ29sczsNCiAgICBjb25zdCBkcnVnQ2xhc3NGaWVsZCA9IGFtcldhdGNoQ29uZmlnPy5kcnVnQ2xhc3NGaWVsZCA/PyAiZHJ1Z19jbGFzcyI7DQogICAgY29uc3QgZ2VuZUZpZWxkID0gYW1yV2F0Y2hDb25maWc/LmdlbmVGaWVsZCA/PyAiZ2VuZSI7DQogICAgY29uc3QgYWN0aXZlRHJ1Z0NvbHMgPSBBcnJheS5pc0FycmF5KGF2YWlsYWJsZURydWdDb2xzKQ0KICAgICAgPyBhdmFpbGFibGVEcnVnQ29scw0KICAgICAgOiBPYmplY3Qua2V5cyhkcnVnQ29scyk7DQogICAgY29uc3Qgbm9ybWFsaXplZE92ZXJyaWRlID0NCiAgICAgIHR5cGVvZiBzcGVjaWVzT3ZlcnJpZGUgPT09ICJzdHJpbmciICYmIHNwZWNpZXNPdmVycmlkZS50cmltKCkubGVuZ3RoID4gMA0KICAgICAgICA/IHNwZWNpZXNPdmVycmlkZS50cmltKCkNCiAgICAgICAgOiBudWxsOw0KICAgIHJldHVybiAocm93KSA9PiB7DQogICAgICBjb25zdCBhY2Nlc3Npb24gPSByb3dbQU1SX1dBVENIX0hFQURFUlMuYWNjZXNzaW9uXT8udHJpbSgpOw0KICAgICAgY29uc3Qgc3BlY2llcyA9DQogICAgICAgIG5vcm1hbGl6ZWRPdmVycmlkZSB8fCBzcGVjaWVzTWFwPy5bYWNjZXNzaW9uXSB8fCAiVW5rbm93biBzcGVjaWVzIjsNCiAgICAgIGNvbnN0IGdlbnVzID0NCiAgICAgICAgc3BlY2llcyAmJiBzcGVjaWVzICE9PSAiVW5rbm93biBzcGVjaWVzIg0KICAgICAgICAgID8gc3BlY2llcy5zcGxpdCgiICIpWzBdDQogICAgICAgICAgOiAiVW5rbm93biBnZW51cyI7DQogICAgICBjb25zdCBjb3VudHJ5ID0gcm93W0FNUl9XQVRDSF9IRUFERVJTLmNvdW50cnldID8/ICIiOw0KICAgICAgY29uc3QgY29sbGVjdGlvbkRhdGUgPSByb3dbQU1SX1dBVENIX0hFQURFUlMuZGF0ZV0gPz8gIiI7DQogICAgICBjb25zdCBjb2xsZWN0aW9uWWVhciA9IGV4dHJhY3RDb2xsZWN0aW9uWWVhcihjb2xsZWN0aW9uRGF0ZSk7DQoNCiAgICAgIC8vIEJ1aWxkIG9ic2VydmF0aW9uczogZWFjaCBnZW5lIHBhaXJlZCB3aXRoIGl0cyBkcnVnIGNsYXNzDQogICAgICBjb25zdCBvYnNlcnZhdGlvbnMgPSBbXTsNCiAgICAgIGZvciAoY29uc3QgY29sIG9mIGFjdGl2ZURydWdDb2xzKSB7DQogICAgICAgIGNvbnN0IGxhYmVsID0gZHJ1Z0NvbHNbY29sXTsNCiAgICAgICAgaWYgKCFsYWJlbCkgY29udGludWU7IC8vIHNraXAgY29sdW1ucyBub3QgaW4gdGhlIG1hcHBpbmcNCiAgICAgICAgY29uc3QgY2VsbCA9IHJvd1tjb2xdOw0KICAgICAgICBpZiAoIWlzTnVsbGlzaENlbGwoY2VsbCkpIHsNCiAgICAgICAgICBjb25zdCBnZW5lcyA9IFN0cmluZyhjZWxsKQ0KICAgICAgICAgICAgLnNwbGl0KCIsIikNCiAgICAgICAgICAgIC5tYXAoKGcpID0+IGcudHJpbSgpKQ0KICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKTsNCiAgICAgICAgICBmb3IgKGNvbnN0IGdlbmUgb2YgZ2VuZXMpIHsNCiAgICAgICAgICAgIGNvbnN0IG9icyA9IHt9Ow0KICAgICAgICAgICAgb2JzW2RydWdDbGFzc0ZpZWxkXSA9IGxhYmVsOw0KICAgICAgICAgICAgb2JzW2dlbmVGaWVsZF0gPSBnZW5lOw0KICAgICAgICAgICAgb2JzZXJ2YXRpb25zLnB1c2gob2JzKTsNCiAgICAgICAgICB9DQogICAgICAgIH0NCiAgICAgIH0NCg0KICAgICAgcmV0dXJuIHsNCiAgICAgICAgaWQ6IGFjY2Vzc2lvbiB8fCAiIiwNCiAgICAgICAgY291bnRyeSwNCiAgICAgICAgc3BlY2llcywNCiAgICAgICAgZ2VudXMsDQogICAgICAgIGNvbGxlY3Rpb25fZGF0ZTogY29sbGVjdGlvbkRhdGUsDQogICAgICAgIGNvbGxlY3Rpb25feWVhcjogY29sbGVjdGlvblllYXIsDQogICAgICAgIG9ic2VydmF0aW9ucywNCiAgICAgIH07DQogICAgfTsNCiAgfQ0KDQogIC8vIC0tLS0tLS0tLS0gQ1NWIC0+IEpTT05MIChGbGF0IHBlci1vYnNlcnZhdGlvbiBmb3JtYXQpIC0tLS0tLS0tLS0NCiAgZnVuY3Rpb24gY3N2RmxhdFRleHRUb0pzb25sKA0KICAgIHRleHQsDQogICAgew0KICAgICAgZGVsaW1pdGVyID0gbnVsbCwNCiAgICAgIHNuaWZmQnl0ZXMgPSA4MTkyLA0KICAgICAgaW5mZXJUeXBlcyA9IGZhbHNlLA0KICAgICAgaWRDb2x1bW4gPSAiaWQiLA0KICAgICAgbGlua2VkRmllbGRzID0gW10sDQogICAgICBrZWVwSGVhZGVycyA9IFtdLA0KICAgICAgcHJldHR5ID0gZmFsc2UsDQogICAgICBwcm9ncmVzc0NiID0gKCkgPT4ge30sDQogICAgICBzY2hlbWEgPSBudWxsLA0KICAgICAgbWF4RXJyb3JzID0gMjAwLA0KICAgIH0NCiAgKSB7DQogICAgY29uc3Qgc2FtcGxlID0gdGV4dC5zbGljZSgwLCBzbmlmZkJ5dGVzKTsNCiAgICBjb25zdCBkZWxpbSA9IGRlbGltaXRlciB8fCBzbmlmZkRlbGltaXRlcihzYW1wbGUsICIsIik7DQoNCiAgICBjb25zdCBsaW5lcyA9IHRleHQuc3BsaXQoL1xyP1xuLyk7DQogICAgaWYgKCFsaW5lcy5sZW5ndGgpIHJldHVybiB7IGpzb25sOiAiIiwgaGVhZGVyczogW10sIHJvd3M6IDAgfTsNCg0KICAgIGNvbnN0IGhlYWRlckxpbmUgPSBsaW5lcy5zaGlmdCgpIHx8ICIiOw0KICAgIGNvbnN0IGhlYWRlcnMgPSBwYXJzZUNzdkxpbmUoaGVhZGVyTGluZSwgZGVsaW0pOw0KDQogICAgLy8gSGVhZGVyIHZhbGlkYXRpb24NCiAgICBpZiAoc2NoZW1hICYmIHNjaGVtYS5yZXF1aXJlSGVhZGVycz8ubGVuZ3RoKSB7DQogICAgICBjb25zdCBocmVzID0gdmFsaWRhdGVIZWFkZXJzKGhlYWRlcnMsIHNjaGVtYS5yZXF1aXJlSGVhZGVycyk7DQogICAgICBpZiAoIWhyZXMub2spIHsNCiAgICAgICAgcmV0dXJuIGJ1aWxkRmF0YWxSZXN1bHQoZGVsaW0sIGhlYWRlcnMsICJtaXNzaW5nX2hlYWRlciIsICJIZWFkZXIgbWlzc2luZyIsIGhyZXMubWlzc2luZyk7DQogICAgICB9DQogICAgfQ0KDQogICAgLy8gUGFyc2UgYWxsIGRhdGEgcm93cyBpbnRvIG9iamVjdHMNCiAgICBjb25zdCByb3dzID0gW107DQogICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykgew0KICAgICAgY29uc3QgbGluZSA9IGxpbmVzW2ldOw0KICAgICAgaWYgKCFsaW5lKSBjb250aW51ZTsNCiAgICAgIGNvbnN0IGNlbGxzID0gcGFyc2VDc3ZMaW5lKGxpbmUsIGRlbGltKTsNCiAgICAgIGNvbnN0IHJvd09iaiA9IHt9Ow0KICAgICAgZm9yIChsZXQgYyA9IDA7IGMgPCBoZWFkZXJzLmxlbmd0aDsgYysrKSB7DQogICAgICAgIHJvd09ialtoZWFkZXJzW2NdXSA9IGNlbGxzW2NdID8/ICIiOw0KICAgICAgfQ0KICAgICAgcm93cy5wdXNoKHJvd09iaik7DQogICAgfQ0KDQogICAgLy8gR3JvdXAgYnkgc2FtcGxlIElEIGFuZCBidWlsZCBKU09OTA0KICAgIGNvbnN0IHsganNvbmxSb3dzLCB2YWxpZGF0aW9uIH0gPSBncm91cEZsYXRSb3dzVG9Kc29ubChyb3dzLCB7DQogICAgICBpZENvbHVtbiwNCiAgICAgIGxpbmtlZEZpZWxkcywNCiAgICAgIGluZmVyVHlwZXMsDQogICAgICBzY2hlbWEsDQogICAgICBtYXhFcnJvcnMsDQogICAgICBwcm9ncmVzc0NiLA0KICAgIH0pOw0KDQogICAgY29uc3QganNvbmwgPSBqc29ubFJvd3MubWFwKChyKSA9Pg0KICAgICAgcHJldHR5ID8gSlNPTi5zdHJpbmdpZnkoSlNPTi5wYXJzZShyKSwgbnVsbCwgMikgOiByLA0KICAgICkuam9pbigiXG4iKSArIChqc29ubFJvd3MubGVuZ3RoID8gIlxuIiA6ICIiKTsNCg0KICAgIHJldHVybiB7IGpzb25sLCBoZWFkZXJzLCByb3dzOiBqc29ubFJvd3MubGVuZ3RoLCBkZWxpbWl0ZXI6IGRlbGltLCB2YWxpZGF0aW9uIH07DQogIH0NCg0KICAvLyAtLS0tLS0tLS0tIENTViAtPiBKU09OTCAoTGVnYWN5IC0gbGlzdC1jb2x1bW4gZm9ybWF0KSAtLS0tLS0tLS0tDQogIGZ1bmN0aW9uIGNzdlRleHRUb0pzb25sKA0KICAgIHRleHQsDQogICAgew0KICAgICAgZGVsaW1pdGVyID0gbnVsbCwNCiAgICAgIHNuaWZmQnl0ZXMgPSA4MTkyLA0KICAgICAgaW5mZXJUeXBlcyA9IGZhbHNlLA0KICAgICAgbGlzdENvbHMgPSBuZXcgU2V0KCksDQogICAgICBsaXN0U2VwID0gREVGQVVMVF9MSVNUX1NFUEFSQVRPUiwNCiAgICAgIGluZmVyTGlzdEVsZW1zID0gZmFsc2UsDQogICAgICBrZWVwSGVhZGVycyA9IFtdLA0KICAgICAgcHJldHR5ID0gZmFsc2UsDQogICAgICBwcm9ncmVzc0NiID0gKCkgPT4ge30sDQogICAgICBzY2hlbWEgPSBudWxsLA0KICAgICAgcm93TWFwcGVyID0gbnVsbCwNCiAgICAgIG1heEVycm9ycyA9IDIwMCwNCiAgICB9DQogICkgew0KICAgIC8vIERlbGltaXRlciBzbmlmZjogc2FtcGxlIGZpcnN0IHNuaWZmQnl0ZXMNCiAgICBjb25zdCBzYW1wbGUgPSB0ZXh0LnNsaWNlKDAsIHNuaWZmQnl0ZXMpOw0KICAgIGNvbnN0IGRlbGltID0gZGVsaW1pdGVyIHx8IHNuaWZmRGVsaW1pdGVyKHNhbXBsZSwgIiwiKTsNCg0KICAgIGNvbnN0IGxpbmVzID0gdGV4dC5zcGxpdCgvXHI/XG4vKTsNCiAgICBpZiAoIWxpbmVzLmxlbmd0aCkgcmV0dXJuIHsganNvbmw6ICIiLCBoZWFkZXJzOiBbXSwgcm93czogMCB9Ow0KDQogICAgLy8gSGVhZGVyDQogICAgY29uc3QgaGVhZGVyTGluZSA9IGxpbmVzLnNoaWZ0KCkgfHwgIiI7DQogICAgY29uc3QgaGVhZGVycyA9IHBhcnNlQ3N2TGluZShoZWFkZXJMaW5lLCBkZWxpbSk7DQoNCiAgICAvLyBIZWFkZXIgdmFsaWRhdGlvbg0KICAgIGlmIChzY2hlbWEgJiYgc2NoZW1hLnJlcXVpcmVIZWFkZXJzPy5sZW5ndGgpIHsNCiAgICAgIGNvbnN0IGhyZXMgPSB2YWxpZGF0ZUhlYWRlcnMoaGVhZGVycywgc2NoZW1hLnJlcXVpcmVIZWFkZXJzKTsNCiAgICAgIGlmICghaHJlcy5vaykgew0KICAgICAgICByZXR1cm4gYnVpbGRGYXRhbFJlc3VsdChkZWxpbSwgaGVhZGVycywgIm1pc3NpbmdfaGVhZGVyIiwgIkhlYWRlciBtaXNzaW5nIiwgaHJlcy5taXNzaW5nKTsNCiAgICAgIH0NCiAgICB9DQoNCiAgICAvLyBCdWlsZCByb3dzDQogICAgY29uc3Qgcm93c091dCA9IFtdOw0KICAgIGNvbnN0IHRvdGFsID0gTWF0aC5tYXgoMSwgbGluZXMubGVuZ3RoKTsNCg0KICAgIGNvbnN0IHVuaXF1ZVNldHMgPSBuZXcgU2V0KCk7DQogICAgY29uc3QgYWxsRXJyb3JzID0gW107DQogICAgY29uc3QgYWxsV2FybmluZ3MgPSBbXTsNCg0KICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHsNCiAgICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXTsNCiAgICAgIGlmICghbGluZSkgY29udGludWU7DQoNCiAgICAgIGNvbnN0IGNlbGxzID0gcGFyc2VDc3ZMaW5lKGxpbmUsIGRlbGltKTsNCiAgICAgIGNvbnN0IHJvd09iaiA9IHt9Ow0KICAgICAgZm9yIChsZXQgYyA9IDA7IGMgPCBoZWFkZXJzLmxlbmd0aDsgYysrKSB7DQogICAgICAgIHJvd09ialtoZWFkZXJzW2NdXSA9IGNlbGxzW2NdID8/ICIiOw0KICAgICAgfQ0KDQogICAgICBjb25zdCBtYXBwZWRSb3cgPSByb3dNYXBwZXIgPyByb3dNYXBwZXIocm93T2JqKSA6IHJvd09iajsNCiAgICAgIGlmICghbWFwcGVkUm93KSBjb250aW51ZTsNCg0KICAgICAgY29uc3QgdHIgPSB0cmFuc2Zvcm1Sb3cobWFwcGVkUm93LCB7DQogICAgICAgIGluZmVyVHlwZXMsDQogICAgICAgIGxpc3RDb2xzLA0KICAgICAgICBsaXN0U2VwLA0KICAgICAgICBpbmZlckxpc3RFbGVtcywNCiAgICAgICAga2VlcEhlYWRlcnMsDQogICAgICB9KTsNCg0KICAgICAgLy8gUm93IHZhbGlkYXRpb24gKDItYmFzZWQgcm93IGluZGV4IGluY2x1ZGluZyBoZWFkZXIpDQogICAgICBpZiAoc2NoZW1hKSB7DQogICAgICAgIGNvbnN0IHsgZXJyb3JzLCB3YXJuaW5ncyB9ID0gdmFsaWRhdGVSb3dBZ2FpbnN0U2NoZW1hKA0KICAgICAgICAgIHRyLA0KICAgICAgICAgIGkgKyAyLA0KICAgICAgICAgIHNjaGVtYSwNCiAgICAgICAgICB1bmlxdWVTZXRzDQogICAgICAgICk7DQogICAgICAgIGlmIChlcnJvcnMubGVuZ3RoKSBhbGxFcnJvcnMucHVzaCguLi5lcnJvcnMpOw0KICAgICAgICBpZiAod2FybmluZ3MubGVuZ3RoKSBhbGxXYXJuaW5ncy5wdXNoKC4uLndhcm5pbmdzKTsNCiAgICAgICAgaWYgKGFsbEVycm9ycy5sZW5ndGggPj0gbWF4RXJyb3JzKSBicmVhazsNCiAgICAgIH0NCg0KICAgICAgcm93c091dC5wdXNoKEpTT04uc3RyaW5naWZ5KHRyLCBudWxsLCBwcmV0dHkgPyAyIDogMCkpOw0KICAgICAgaWYgKGkgJSA1MDAgPT09IDApIHByb2dyZXNzQ2IoaSAvIHRvdGFsKTsgLy8gcGVyaW9kaWMgcHJvZ3Jlc3MNCiAgICB9DQogICAgcHJvZ3Jlc3NDYigxKTsNCg0KICAgIGNvbnN0IHZhbGlkYXRpb24gPSBzY2hlbWENCiAgICAgID8gew0KICAgICAgICAgIG9rOiBhbGxFcnJvcnMubGVuZ3RoID09PSAwLA0KICAgICAgICAgIGZhdGFsOiBmYWxzZSwNCiAgICAgICAgICBoZWFkZXI6IHsgbWlzc2luZzogW10gfSwNCiAgICAgICAgICBjb3VudHM6IHsgZXJyb3JzOiBhbGxFcnJvcnMubGVuZ3RoLCB3YXJuaW5nczogYWxsV2FybmluZ3MubGVuZ3RoIH0sDQogICAgICAgICAgZXJyb3JzOiBhbGxFcnJvcnMsDQogICAgICAgICAgd2FybmluZ3M6IGFsbFdhcm5pbmdzLA0KICAgICAgICB9DQogICAgICA6IG51bGw7DQoNCiAgICByZXR1cm4gew0KICAgICAganNvbmw6IHJvd3NPdXQuam9pbigiXG4iKSArIChyb3dzT3V0Lmxlbmd0aCA/ICJcbiIgOiAiIiksDQogICAgICBoZWFkZXJzLA0KICAgICAgcm93czogcm93c091dC5sZW5ndGgsDQogICAgICBkZWxpbWl0ZXI6IGRlbGltLA0KICAgICAgdmFsaWRhdGlvbiwNCiAgICB9Ow0KICB9CgogIGFzeW5jIGZ1bmN0aW9uIHNjYW5Dc3ZDb2x1bW5WYWx1ZXNGcm9tU3RyZWFtKA0KICAgIGZpbGVTdHJlYW0sDQogICAgeyBkZWxpbWl0ZXIsIGNvbHVtbkluZGV4LCBwcm9ncmVzc0NiID0gKCkgPT4ge30sIGZpbGVTaXplID0gbnVsbCB9DQogICkgew0KICAgIGNvbnN0IHJlYWRlciA9IGZpbGVTdHJlYW0uZ2V0UmVhZGVyKCk7DQogICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpOw0KICAgIGxldCBidWZmZXIgPSAiIjsNCiAgICBsZXQgaGVhZGVyU2tpcHBlZCA9IGZhbHNlOw0KICAgIGxldCBieXRlc1Byb2Nlc3NlZCA9IDA7DQogICAgY29uc3QgdmFsdWVzID0gbmV3IFNldCgpOw0KDQogICAgd2hpbGUgKHRydWUpIHsNCiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7DQogICAgICBpZiAoZG9uZSkgYnJlYWs7DQogICAgICBpZiAodmFsdWUpIHsNCiAgICAgICAgYnl0ZXNQcm9jZXNzZWQgKz0gdmFsdWUuYnl0ZUxlbmd0aCB8fCAwOw0KICAgICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pOw0KICAgICAgfQ0KDQogICAgICBsZXQgbGluZVN0YXJ0ID0gMDsNCiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7DQogICAgICAgIGlmIChidWZmZXJbaV0gPT09ICJcbiIgfHwgKGJ1ZmZlcltpXSA9PT0gIlxyIiAmJiBidWZmZXJbaSArIDFdID09PSAiXG4iKSkgew0KICAgICAgICAgIGNvbnN0IGxpbmVFbmQgPSBidWZmZXJbaV0gPT09ICJcciIgPyBpICsgMiA6IGkgKyAxOw0KICAgICAgICAgIGNvbnN0IGxpbmUgPSBidWZmZXIuc2xpY2UobGluZVN0YXJ0LCBpKS5yZXBsYWNlKC9cciQvLCAiIik7DQogICAgICAgICAgbGluZVN0YXJ0ID0gbGluZUVuZDsNCg0KICAgICAgICAgIGlmICghaGVhZGVyU2tpcHBlZCkgew0KICAgICAgICAgICAgaGVhZGVyU2tpcHBlZCA9IHRydWU7DQogICAgICAgICAgfSBlbHNlIGlmIChsaW5lLnRyaW0oKSkgew0KICAgICAgICAgICAgY29uc3QgY2VsbHMgPSBwYXJzZUNzdkxpbmUobGluZSwgZGVsaW1pdGVyKTsNCiAgICAgICAgICAgIGNvbnN0IHZhbCA9IGNlbGxzW2NvbHVtbkluZGV4XTsNCiAgICAgICAgICAgIGlmICghaXNOdWxsaXNoQ2VsbCh2YWwpKSB2YWx1ZXMuYWRkKFN0cmluZyh2YWwpLnRyaW0oKSk7DQogICAgICAgICAgfQ0KICAgICAgICB9DQogICAgICB9DQogICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UobGluZVN0YXJ0KTsNCg0KICAgICAgaWYgKGZpbGVTaXplICYmIGZpbGVTaXplID4gMCkgew0KICAgICAgICBwcm9ncmVzc0NiKE1hdGgubWluKDAuMiwgYnl0ZXNQcm9jZXNzZWQgLyBmaWxlU2l6ZSkpOw0KICAgICAgfQ0KICAgIH0NCg0KICAgIGlmIChidWZmZXIudHJpbSgpKSB7DQogICAgICBpZiAoaGVhZGVyU2tpcHBlZCkgew0KICAgICAgICBjb25zdCBjZWxscyA9IHBhcnNlQ3N2TGluZShidWZmZXIucmVwbGFjZSgvXHIkLywgIiIpLCBkZWxpbWl0ZXIpOw0KICAgICAgICBjb25zdCB2YWwgPSBjZWxsc1tjb2x1bW5JbmRleF07DQogICAgICAgIGlmICghaXNOdWxsaXNoQ2VsbCh2YWwpKSB2YWx1ZXMuYWRkKFN0cmluZyh2YWwpLnRyaW0oKSk7DQogICAgICB9DQogICAgfQ0KDQogICAgcmV0dXJuIHZhbHVlczsNCiAgfQ0KDQogIC8vIC0tLS0tLS0tLS0gQ1NWIC0+IEpTT05MIChTdHJlYW1pbmcpIC0tLS0tLS0tLS0NCiAgYXN5bmMgZnVuY3Rpb24gY3N2U3RyZWFtVG9Kc29ubCgNCiAgICBmaWxlU3RyZWFtLA0KICAgIHsNCiAgICAgIGRlbGltaXRlciA9IG51bGwsDQogICAgICBzbmlmZkJ5dGVzID0gODE5MiwNCiAgICAgIGluZmVyVHlwZXMgPSBmYWxzZSwNCiAgICAgIGxpc3RDb2xzID0gbmV3IFNldCgpLA0KICAgICAgbGlzdFNlcCA9IERFRkFVTFRfTElTVF9TRVBBUkFUT1IsDQogICAgICBpbmZlckxpc3RFbGVtcyA9IGZhbHNlLA0KICAgICAga2VlcEhlYWRlcnMgPSBbXSwNCiAgICAgIHByZXR0eSA9IGZhbHNlLA0KICAgICAgcHJvZ3Jlc3NDYiA9ICgpID0+IHt9LA0KICAgICAgc2NoZW1hID0gbnVsbCwNCiAgICAgIHJvd01hcHBlciA9IG51bGwsDQogICAgICBtYXhFcnJvcnMgPSAyMDAsDQogICAgICBjaHVua0NhbGxiYWNrID0gbnVsbCwgLy8gQ2FsbGJhY2sgdG8gc3RvcmUgY2h1bmtzOiAoY2h1bmtJbmRleCwganNvbmxDaHVuaykgPT4gUHJvbWlzZQ0KICAgICAgY2h1bmtTaXplQnl0ZXMgPSAxMCAqIDEwMjQgKiAxMDI0LCAvLyAxME1CIGNodW5rcw0KICAgICAgZmlsZVNpemUgPSBudWxsLCAvLyBUb3RhbCBmaWxlIHNpemUgZm9yIHByb2dyZXNzIGNhbGN1bGF0aW9uDQogICAgfQ0KICApIHsNCiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7DQogICAgY29uc3QgcmVhZGVyID0gZmlsZVN0cmVhbS5nZXRSZWFkZXIoKTsNCg0KICAgIGxldCBidWZmZXIgPSAiIjsNCiAgICBsZXQgaGVhZGVycyA9IG51bGw7DQogICAgbGV0IGRlbGltaXRlcl9maW5hbCA9IG51bGw7DQogICAgbGV0IHJvd0luZGV4ID0gMDsNCiAgICBsZXQgdG90YWxSb3dzID0gMDsNCiAgICBsZXQgY3VycmVudENodW5rID0gIiI7DQogICAgbGV0IGN1cnJlbnRDaHVua1NpemUgPSAwOw0KICAgIGxldCBjaHVua0luZGV4ID0gMDsNCiAgICBsZXQgcHJldmlldyA9IFtdOw0KICAgIGxldCBwcmV2aWV3TGluZXMgPSA1Ow0KICAgIGxldCBieXRlc1Byb2Nlc3NlZCA9IDA7IC8vIFRyYWNrIGJ5dGVzIHByb2Nlc3NlZCBmb3IgcHJvZ3Jlc3MNCg0KICAgIGNvbnN0IHVuaXF1ZVNldHMgPSBuZXcgU2V0KCk7DQogICAgY29uc3QgYWxsRXJyb3JzID0gW107DQogICAgY29uc3QgYWxsV2FybmluZ3MgPSBbXTsNCg0KICAgIC8vIEZpcnN0LCByZWFkIHNhbXBsZSBmb3IgZGVsaW1pdGVyIGRldGVjdGlvbg0KICAgIGxldCBzYW1wbGVCdWZmZXIgPSAiIjsNCiAgICBsZXQgc2FtcGxlUmVhZCA9IGZhbHNlOw0KDQogICAgd2hpbGUgKCFzYW1wbGVSZWFkKSB7DQogICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpOw0KDQogICAgICBpZiAodmFsdWUpIHsNCiAgICAgICAgY29uc3QgY2h1bmsgPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7DQogICAgICAgIHNhbXBsZUJ1ZmZlciArPSBjaHVuazsNCiAgICAgIH0NCg0KICAgICAgLy8gSWYgd2UgaGF2ZSBlbm91Z2ggYnl0ZXMgb3IgZmlsZSBpcyBkb25lLCBkZXRlY3QgZGVsaW1pdGVyDQogICAgICBpZiAoDQogICAgICAgIHNhbXBsZUJ1ZmZlci5sZW5ndGggPj0gc25pZmZCeXRlcyB8fA0KICAgICAgICAoZG9uZSAmJiBzYW1wbGVCdWZmZXIubGVuZ3RoID4gMCkNCiAgICAgICkgew0KICAgICAgICAvLyBTbmlmZiBkZWxpbWl0ZXIgZnJvbSBzYW1wbGUNCiAgICAgICAgZGVsaW1pdGVyX2ZpbmFsID0NCiAgICAgICAgICBkZWxpbWl0ZXIgfHwNCiAgICAgICAgICBzbmlmZkRlbGltaXRlcigNCiAgICAgICAgICAgIHNhbXBsZUJ1ZmZlci5zbGljZSgwLCBNYXRoLm1pbihzbmlmZkJ5dGVzLCBzYW1wbGVCdWZmZXIubGVuZ3RoKSksDQogICAgICAgICAgICAiLCINCiAgICAgICAgICApOw0KICAgICAgICBidWZmZXIgPSBzYW1wbGVCdWZmZXI7IC8vIENvbnRpbnVlIHdpdGggZnVsbCBidWZmZXINCiAgICAgICAgc2FtcGxlUmVhZCA9IHRydWU7DQogICAgICAgIGlmIChkb25lICYmIHNhbXBsZUJ1ZmZlci5sZW5ndGggPT09IDApIHsNCiAgICAgICAgICByZXR1cm4gYnVpbGRGYXRhbFJlc3VsdCgiLCIsIFtdLCAiZW1wdHlfZmlsZSIsICJGaWxlIGlzIGVtcHR5Iik7DQogICAgICAgIH0NCiAgICAgICAgYnJlYWs7DQogICAgICB9DQoNCiAgICAgIGlmIChkb25lICYmIHNhbXBsZUJ1ZmZlci5sZW5ndGggPT09IDApIHsNCiAgICAgICAgcmV0dXJuIGJ1aWxkRmF0YWxSZXN1bHQoIiwiLCBbXSwgImVtcHR5X2ZpbGUiLCAiRmlsZSBpcyBlbXB0eSIpOw0KICAgICAgfQ0KICAgIH0NCg0KICAgIC8vIFByb2Nlc3MgaGVhZGVyDQogICAgbGV0IGhlYWRlckxpbmUgPSAiIjsNCiAgICBsZXQgaGVhZGVyRW5kID0gLTE7DQoNCiAgICAvLyBGaW5kIGZpcnN0IG5ld2xpbmUgZm9yIGhlYWRlcg0KICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7DQogICAgICBpZiAoYnVmZmVyW2ldID09PSAiXG4iIHx8IChidWZmZXJbaV0gPT09ICJcciIgJiYgYnVmZmVyW2kgKyAxXSA9PT0gIlxuIikpIHsNCiAgICAgICAgaGVhZGVyRW5kID0gYnVmZmVyW2ldID09PSAiXHIiID8gaSArIDIgOiBpICsgMTsNCiAgICAgICAgaGVhZGVyTGluZSA9IGJ1ZmZlci5zbGljZSgwLCBpKS5yZXBsYWNlKC9cciQvLCAiIik7DQogICAgICAgIGJyZWFrOw0KICAgICAgfQ0KICAgIH0NCg0KICAgIGlmIChoZWFkZXJFbmQgPT09IC0xKSB7DQogICAgICAvLyBIZWFkZXIgbWlnaHQgc3BhbiBjaHVua3MsIG5lZWQgdG8gcmVhZCBtb3JlDQogICAgICB3aGlsZSAoaGVhZGVyRW5kID09PSAtMSkgew0KICAgICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpOw0KICAgICAgICBpZiAoZG9uZSkgYnJlYWs7DQogICAgICAgIGNvbnN0IGNodW5rID0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pOw0KICAgICAgICBidWZmZXIgKz0gY2h1bms7DQogICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnVmZmVyLmxlbmd0aDsgaSsrKSB7DQogICAgICAgICAgaWYgKA0KICAgICAgICAgICAgYnVmZmVyW2ldID09PSAiXG4iIHx8DQogICAgICAgICAgICAoYnVmZmVyW2ldID09PSAiXHIiICYmIGJ1ZmZlcltpICsgMV0gPT09ICJcbiIpDQogICAgICAgICAgKSB7DQogICAgICAgICAgICBoZWFkZXJFbmQgPSBidWZmZXJbaV0gPT09ICJcciIgPyBpICsgMiA6IGkgKyAxOw0KICAgICAgICAgICAgaGVhZGVyTGluZSA9IGJ1ZmZlci5zbGljZSgwLCBpKS5yZXBsYWNlKC9cciQvLCAiIik7DQogICAgICAgICAgICBicmVhazsNCiAgICAgICAgICB9DQogICAgICAgIH0NCiAgICAgIH0NCiAgICB9DQoNCiAgICBpZiAoaGVhZGVyRW5kID09PSAtMSkgew0KICAgICAgcmV0dXJuIGJ1aWxkRmF0YWxSZXN1bHQoZGVsaW1pdGVyX2ZpbmFsLCBbXSwgIm5vX2hlYWRlciIsICJObyBoZWFkZXIgbGluZSBmb3VuZCIpOw0KICAgIH0NCg0KICAgIGhlYWRlcnMgPSBwYXJzZUNzdkxpbmUoaGVhZGVyTGluZSwgZGVsaW1pdGVyX2ZpbmFsKTsNCiAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaGVhZGVyRW5kKTsNCg0KICAgIC8vIEhlYWRlciB2YWxpZGF0aW9uDQogICAgaWYgKHNjaGVtYSAmJiBzY2hlbWEucmVxdWlyZUhlYWRlcnM/Lmxlbmd0aCkgew0KICAgICAgY29uc3QgaHJlcyA9IHZhbGlkYXRlSGVhZGVycyhoZWFkZXJzLCBzY2hlbWEucmVxdWlyZUhlYWRlcnMpOw0KICAgICAgaWYgKCFocmVzLm9rKSB7DQogICAgICAgIHJldHVybiBidWlsZEZhdGFsUmVzdWx0KGRlbGltaXRlcl9maW5hbCwgaGVhZGVycywgIm1pc3NpbmdfaGVhZGVyIiwgIkhlYWRlciBtaXNzaW5nIiwgaHJlcy5taXNzaW5nKTsNCiAgICAgIH0NCiAgICB9DQoNCiAgICAvLyBQcm9jZXNzIHJvd3MgbGluZSBieSBsaW5lDQogICAgY29uc3QgcHJvY2Vzc0xpbmUgPSAobGluZSkgPT4gew0KICAgICAgaWYgKCFsaW5lLnRyaW0oKSkgcmV0dXJuIG51bGw7DQoNCiAgICAgIGNvbnN0IGNlbGxzID0gcGFyc2VDc3ZMaW5lKGxpbmUsIGRlbGltaXRlcl9maW5hbCk7DQogICAgICBjb25zdCByb3dPYmogPSB7fTsNCiAgICAgIGZvciAobGV0IGMgPSAwOyBjIDwgaGVhZGVycy5sZW5ndGg7IGMrKykgew0KICAgICAgICByb3dPYmpbaGVhZGVyc1tjXV0gPSBjZWxsc1tjXSA/PyAiIjsNCiAgICAgIH0NCg0KICAgICAgY29uc3QgbWFwcGVkUm93ID0gcm93TWFwcGVyID8gcm93TWFwcGVyKHJvd09iaikgOiByb3dPYmo7DQogICAgICBpZiAoIW1hcHBlZFJvdykgcmV0dXJuIG51bGw7DQoNCiAgICAgIGNvbnN0IHRyID0gdHJhbnNmb3JtUm93KG1hcHBlZFJvdywgew0KICAgICAgICBpbmZlclR5cGVzLA0KICAgICAgICBsaXN0Q29scywNCiAgICAgICAgbGlzdFNlcCwNCiAgICAgICAgaW5mZXJMaXN0RWxlbXMsDQogICAgICAgIGtlZXBIZWFkZXJzLA0KICAgICAgfSk7DQoNCiAgICAgIC8vIFJvdyB2YWxpZGF0aW9uICgyLWJhc2VkIHJvdyBpbmRleCBpbmNsdWRpbmcgaGVhZGVyKQ0KICAgICAgaWYgKHNjaGVtYSkgew0KICAgICAgICBjb25zdCB7IGVycm9ycywgd2FybmluZ3MgfSA9IHZhbGlkYXRlUm93QWdhaW5zdFNjaGVtYSgNCiAgICAgICAgICB0ciwNCiAgICAgICAgICByb3dJbmRleCArIDIsDQogICAgICAgICAgc2NoZW1hLA0KICAgICAgICAgIHVuaXF1ZVNldHMNCiAgICAgICAgKTsNCiAgICAgICAgaWYgKGVycm9ycy5sZW5ndGgpIGFsbEVycm9ycy5wdXNoKC4uLmVycm9ycyk7DQogICAgICAgIGlmICh3YXJuaW5ncy5sZW5ndGgpIGFsbFdhcm5pbmdzLnB1c2goLi4ud2FybmluZ3MpOw0KICAgICAgICBpZiAoYWxsRXJyb3JzLmxlbmd0aCA+PSBtYXhFcnJvcnMpIHJldHVybiBudWxsOw0KICAgICAgfQ0KDQogICAgICBjb25zdCBqc29uTGluZSA9IEpTT04uc3RyaW5naWZ5KHRyLCBudWxsLCBwcmV0dHkgPyAyIDogMCk7DQogICAgICByb3dJbmRleCsrOw0KICAgICAgdG90YWxSb3dzKys7DQoNCiAgICAgIGlmIChwcmV2aWV3Lmxlbmd0aCA8IHByZXZpZXdMaW5lcykgew0KICAgICAgICBwcmV2aWV3LnB1c2goanNvbkxpbmUpOw0KICAgICAgfQ0KDQogICAgICByZXR1cm4ganNvbkxpbmU7DQogICAgfTsNCg0KICAgIC8vIFByb2Nlc3MgYnVmZmVyIGFuZCBoYW5kbGUgY2h1bmtpbmcNCiAgICBjb25zdCBmbHVzaENodW5rID0gYXN5bmMgKCkgPT4gew0KICAgICAgaWYgKGN1cnJlbnRDaHVuayAmJiBjaHVua0NhbGxiYWNrKSB7DQogICAgICAgIGF3YWl0IGNodW5rQ2FsbGJhY2soY2h1bmtJbmRleCwgY3VycmVudENodW5rKTsNCiAgICAgICAgY2h1bmtJbmRleCsrOw0KICAgICAgICBjdXJyZW50Q2h1bmsgPSAiIjsNCiAgICAgICAgY3VycmVudENodW5rU2l6ZSA9IDA7DQogICAgICB9DQogICAgfTsNCg0KICAgIGNvbnN0IGFkZExpbmVUb0NodW5rID0gYXN5bmMgKGxpbmUpID0+IHsNCiAgICAgIGNvbnN0IGpzb25MaW5lID0gcHJvY2Vzc0xpbmUobGluZSk7DQogICAgICBpZiAoanNvbkxpbmUpIHsNCiAgICAgICAgY29uc3QgbGluZVdpdGhOZXdsaW5lID0ganNvbkxpbmUgKyAiXG4iOw0KICAgICAgICBjdXJyZW50Q2h1bmsgKz0gbGluZVdpdGhOZXdsaW5lOw0KICAgICAgICBjdXJyZW50Q2h1bmtTaXplICs9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShsaW5lV2l0aE5ld2xpbmUpLmxlbmd0aDsNCiAgICAgICAgaWYgKGN1cnJlbnRDaHVua1NpemUgPj0gY2h1bmtTaXplQnl0ZXMpIHsNCiAgICAgICAgICBhd2FpdCBmbHVzaENodW5rKCk7DQogICAgICAgIH0NCiAgICAgIH0NCiAgICB9Ow0KDQogICAgLy8gUHJvY2VzcyBpbml0aWFsIGJ1ZmZlcg0KICAgIGNvbnN0IGluaXRpYWxFeHRyYWN0ID0gZXh0cmFjdExpbmVzKGJ1ZmZlcik7DQogICAgZm9yIChjb25zdCBsaW5lIG9mIGluaXRpYWxFeHRyYWN0LmxpbmVzKSB7DQogICAgICBhd2FpdCBhZGRMaW5lVG9DaHVuayhsaW5lKTsNCiAgICB9DQogICAgYnVmZmVyID0gaW5pdGlhbEV4dHJhY3QucmVtYWluaW5nOw0KDQogICAgLy8gQ29udGludWUgcmVhZGluZyBmcm9tIHN0cmVhbQ0KICAgIHdoaWxlICh0cnVlKSB7DQogICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpOw0KICAgICAgaWYgKGRvbmUpIGJyZWFrOw0KDQogICAgICBjb25zdCBjaHVuayA9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTsNCiAgICAgIGNvbnN0IGNodW5rQnl0ZXMgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoY2h1bmspLmxlbmd0aDsNCiAgICAgIGJ5dGVzUHJvY2Vzc2VkICs9IGNodW5rQnl0ZXM7DQogICAgICBidWZmZXIgKz0gY2h1bms7DQoNCiAgICAgIC8vIFByb2Nlc3MgY29tcGxldGUgbGluZXMNCiAgICAgIGNvbnN0IGV4dHJhY3RlZCA9IGV4dHJhY3RMaW5lcyhidWZmZXIpOw0KICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGV4dHJhY3RlZC5saW5lcykgew0KICAgICAgICBhd2FpdCBhZGRMaW5lVG9DaHVuayhsaW5lKTsNCg0KICAgICAgICAvLyBQcm9ncmVzcyB1cGRhdGUgZXZlcnkgMTAwMCByb3dzDQogICAgICAgIGlmICh0b3RhbFJvd3MgJSAxMDAwID09PSAwKSB7DQogICAgICAgICAgY29uc3QgcHJvZ3Jlc3MgPSBmaWxlU2l6ZSAmJiBmaWxlU2l6ZSA+IDANCiAgICAgICAgICAgID8gTWF0aC5taW4oMC45NSwgYnl0ZXNQcm9jZXNzZWQgLyBmaWxlU2l6ZSkNCiAgICAgICAgICAgIDogTWF0aC5taW4oMC45NSwgdG90YWxSb3dzIC8gTWF0aC5tYXgoMTAwMDAwLCB0b3RhbFJvd3MgKiAxLjEpKTsNCiAgICAgICAgICBwcm9ncmVzc0NiKHByb2dyZXNzKTsNCiAgICAgICAgfQ0KICAgICAgfQ0KICAgICAgYnVmZmVyID0gZXh0cmFjdGVkLnJlbWFpbmluZzsNCiAgICB9DQoNCiAgICAvLyBQcm9jZXNzIHJlbWFpbmluZyBidWZmZXINCiAgICBpZiAoYnVmZmVyLnRyaW0oKSkgew0KICAgICAgY29uc3QganNvbkxpbmUgPSBwcm9jZXNzTGluZShidWZmZXIudHJpbSgpKTsNCiAgICAgIGlmIChqc29uTGluZSkgew0KICAgICAgICBjdXJyZW50Q2h1bmsgKz0ganNvbkxpbmUgKyAiXG4iOw0KICAgICAgfQ0KICAgIH0NCg0KICAgIC8vIEZsdXNoIGZpbmFsIGNodW5rDQogICAgaWYgKGN1cnJlbnRDaHVuayAmJiBjaHVua0NhbGxiYWNrKSB7DQogICAgICBhd2FpdCBmbHVzaENodW5rKCk7DQogICAgfQ0KDQogICAgLy8gRmluYWwgcHJvZ3Jlc3MgdXBkYXRlDQogICAgcHJvZ3Jlc3NDYigxKTsNCg0KICAgIGNvbnN0IHZhbGlkYXRpb24gPSBzY2hlbWENCiAgICAgID8gew0KICAgICAgICAgIG9rOiBhbGxFcnJvcnMubGVuZ3RoID09PSAwLA0KICAgICAgICAgIGZhdGFsOiBmYWxzZSwNCiAgICAgICAgICBoZWFkZXI6IHsgbWlzc2luZzogW10gfSwNCiAgICAgICAgICBjb3VudHM6IHsgZXJyb3JzOiBhbGxFcnJvcnMubGVuZ3RoLCB3YXJuaW5nczogYWxsV2FybmluZ3MubGVuZ3RoIH0sDQogICAgICAgICAgZXJyb3JzOiBhbGxFcnJvcnMsDQogICAgICAgICAgd2FybmluZ3M6IGFsbFdhcm5pbmdzLA0KICAgICAgICB9DQogICAgICA6IG51bGw7DQoNCiAgICByZXR1cm4gew0KICAgICAgaGVhZGVycywNCiAgICAgIHJvd3M6IHRvdGFsUm93cywNCiAgICAgIGRlbGltaXRlcjogZGVsaW1pdGVyX2ZpbmFsLA0KICAgICAgdmFsaWRhdGlvbiwNCiAgICAgIHByZXZpZXcsDQogICAgICBjaHVua0NvdW50OiBjaHVua0luZGV4LA0KICAgIH07DQogIH0NCg0KICAvLyBJbmRleGVkREIgc2V0dXAgZm9yIGNodW5rIHN0b3JhZ2UgKGluIHdvcmtlcikNCiAgYXN5bmMgZnVuY3Rpb24gc2V0dXBXb3JrZXJJbmRleGVkREIoZGJOYW1lLCBkYlZlcnNpb24pIHsNCiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gew0KICAgICAgY29uc3QgcmVxID0gaW5kZXhlZERCLm9wZW4oZGJOYW1lLCBkYlZlcnNpb24pOw0KICAgICAgcmVxLm9udXBncmFkZW5lZWRlZCA9IChlKSA9PiB7DQogICAgICAgIGNvbnN0IGRiID0gZS50YXJnZXQucmVzdWx0Ow0KICAgICAgICAvLyBDcmVhdGUgY2h1bmtzIHN0b3JlIGlmIGl0IGRvZXNuJ3QgZXhpc3QNCiAgICAgICAgaWYgKCFkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKCJjaHVua3MiKSkgew0KICAgICAgICAgIGNvbnN0IGNodW5rc1N0b3JlID0gZGIuY3JlYXRlT2JqZWN0U3RvcmUoImNodW5rcyIsIHsNCiAgICAgICAgICAgIGtleVBhdGg6IFsia2V5IiwgImNodW5rSW5kZXgiXSwNCiAgICAgICAgICB9KTsNCiAgICAgICAgICBjaHVua3NTdG9yZS5jcmVhdGVJbmRleCgiYnkta2V5IiwgImtleSIsIHsgdW5pcXVlOiBmYWxzZSB9KTsNCiAgICAgICAgfQ0KICAgICAgICAvLyBDcmVhdGUgbWV0YWRhdGEgc3RvcmUgaWYgaXQgZG9lc24ndCBleGlzdA0KICAgICAgICBpZiAoIWRiLm9iamVjdFN0b3JlTmFtZXMuY29udGFpbnMoIm1ldGFkYXRhIikpIHsNCiAgICAgICAgICBkYi5jcmVhdGVPYmplY3RTdG9yZSgibWV0YWRhdGEiKTsNCiAgICAgICAgfQ0KICAgICAgfTsNCiAgICAgIHJlcS5vbnN1Y2Nlc3MgPSAoKSA9PiB7DQogICAgICAgIGNvbnN0IGRiID0gcmVxLnJlc3VsdDsNCiAgICAgICAgZGIub252ZXJzaW9uY2hhbmdlID0gKCkgPT4gZGIuY2xvc2UoKTsNCiAgICAgICAgcmVzb2x2ZShkYik7DQogICAgICB9Ow0KICAgICAgcmVxLm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxLmVycm9yKTsNCiAgICB9KTsNCiAgfQ0KDQogIGFzeW5jIGZ1bmN0aW9uIHN0b3JlQ2h1bmsoZGIsIGtleSwgY2h1bmtJbmRleCwgY2h1bmtEYXRhKSB7DQogICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHsNCiAgICAgIGNvbnN0IHR4ID0gZGIudHJhbnNhY3Rpb24oImNodW5rcyIsICJyZWFkd3JpdGUiKTsNCiAgICAgIGNvbnN0IHN0b3JlID0gdHgub2JqZWN0U3RvcmUoImNodW5rcyIpOw0KICAgICAgY29uc3QgcmVxID0gc3RvcmUucHV0KHsga2V5LCBjaHVua0luZGV4LCBkYXRhOiBjaHVua0RhdGEgfSk7DQogICAgICByZXEub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZSgpOw0KICAgICAgcmVxLm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxLmVycm9yKTsNCiAgICB9KTsNCiAgfQ0KDQogIGFzeW5jIGZ1bmN0aW9uIHN0b3JlTWV0YWRhdGEoZGIsIGtleSwgbWV0YWRhdGEpIHsNCiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4gew0KICAgICAgY29uc3QgdHggPSBkYi50cmFuc2FjdGlvbigibWV0YWRhdGEiLCAicmVhZHdyaXRlIik7DQogICAgICBjb25zdCBzdG9yZSA9IHR4Lm9iamVjdFN0b3JlKCJtZXRhZGF0YSIpOw0KICAgICAgY29uc3QgcmVxID0gc3RvcmUucHV0KG1ldGFkYXRhLCBrZXkpOw0KICAgICAgcmVxLm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTsNCiAgICAgIHJlcS5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcS5lcnJvcik7DQogICAgfSk7DQogIH0NCg0KICBzZWxmLmFkZEV2ZW50TGlzdGVuZXIoIm1lc3NhZ2UiLCBhc3luYyAoZSkgPT4gew0KICAgIHRyeSB7DQogICAgICBjb25zdCB7IHR5cGUgfSA9IGUuZGF0YSB8fCB7fTsNCg0KICAgICAgaWYgKHR5cGUgPT09ICJsb2FkU2VsZWN0ZWQiKSB7DQogICAgICAgIGNvbnN0IHsNCiAgICAgICAgICBmaWxlLA0KICAgICAgICAgIGhlYWRlcnM6IGtlZXBIZWFkZXJzLA0KICAgICAgICAgIG9wdGlvbnMgPSB7fSwNCiAgICAgICAgICBkYk5hbWUsDQogICAgICAgICAgZGJWZXJzaW9uLA0KICAgICAgICAgIHJlc3VsdEtleSwNCiAgICAgICAgICBzcGVjaWVzT3ZlcnJpZGUsDQogICAgICAgICAgYW1yV2F0Y2hDb25maWcsDQogICAgICAgIH0gPSBlLmRhdGE7DQogICAgICAgIGlmICghZmlsZSkgew0KICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2UoeyB0eXBlOiAiZXJyb3IiLCBlcnJvcjogIk5vIGZpbGUgcHJvdmlkZWQuIiB9KTsNCiAgICAgICAgICByZXR1cm47DQogICAgICAgIH0NCg0KICAgICAgICBjb25zdCB7DQogICAgICAgICAgZGVsaW1pdGVyID0gbnVsbCwNCiAgICAgICAgICBzbmlmZkJ5dGVzID0gODE5MiwNCiAgICAgICAgICBpbmZlclR5cGVzID0gZmFsc2UsDQogICAgICAgICAgbGlzdENvbHMgPSBbXSwgLy8gYXJyYXkgb2YgbmFtZXMgZnJvbSBVSSAobGVnYWN5IGxpc3QtY29sdW1uIG1vZGUpDQogICAgICAgICAgbGlzdFNlcCA9IERFRkFVTFRfTElTVF9TRVBBUkFUT1IsDQogICAgICAgICAgaW5mZXJMaXN0RWxlbXMgPSB0cnVlLA0KICAgICAgICAgIHByZXR0eSA9IGZhbHNlLA0KICAgICAgICAgIHVzZVN0cmVhbWluZyA9IHRydWUsIC8vIEVuYWJsZSBzdHJlYW1pbmcgYnkgZGVmYXVsdCBmb3IgbGFyZ2UgZmlsZXMNCiAgICAgICAgICBjaHVua1NpemVCeXRlcyA9IDEwICogMTAyNCAqIDEwMjQsIC8vIDEwTUIgY2h1bmtzDQogICAgICAgICAgZmxhdE9ic2VydmF0aW9ucyA9IGZhbHNlLCAvLyBmbGF0IHBlci1vYnNlcnZhdGlvbiBDU1YgbW9kZQ0KICAgICAgICAgIGlkQ29sdW1uID0gImlkIiwgLy8gY29sdW1uIGZvciBncm91cGluZyByb3dzIGluIGZsYXQgbW9kZQ0KICAgICAgICAgIGxpbmtlZEZpZWxkcyA9IFtdLCAvLyBvYnNlcnZhdGlvbiBjb2x1bW5zIGluIGZsYXQgbW9kZQ0KICAgICAgICB9ID0gb3B0aW9uczsNCg0KICAgICAgICBjb25zdCBoZWFkZXJTYW1wbGUgPSBhd2FpdCBmaWxlLnNsaWNlKDAsIHNuaWZmQnl0ZXMpLnRleHQoKTsNCiAgICAgICAgY29uc3QgaGVhZGVySW5mbyA9IHBhcnNlSGVhZGVyU2FtcGxlKGhlYWRlclNhbXBsZSwgZGVsaW1pdGVyKTsNCiAgICAgICAgY29uc3QgaXNBbXJXYXRjaCA9IGlzQW1yV2F0Y2hIZWFkZXJzKGhlYWRlckluZm8uaGVhZGVycyk7DQogICAgICAgIGxldCBzY2FuUHJvZ3Jlc3NNYXggPSAwLjI7DQogICAgICAgIGxldCBsb29rdXBQcm9ncmVzc0Jhc2UgPSAwLjI7DQogICAgICAgIGxldCBsb29rdXBQcm9ncmVzc1NwYW4gPSAwLjI7DQogICAgICAgIGxldCBjb252ZXJzaW9uUHJvZ3Jlc3NCYXNlID0gMC40Ow0KICAgICAgICBsZXQgY29udmVyc2lvblByb2dyZXNzU3BhbiA9IDAuNjsNCiAgICAgICAgbGV0IHJvd01hcHBlciA9IG51bGw7DQogICAgICAgIGxldCBlZmZlY3RpdmVTY2hlbWEgPSBvcHRpb25zLnNjaGVtYSA/PyBudWxsOw0KICAgICAgICBsZXQgZWZmZWN0aXZlRGVsaW1pdGVyID0gZGVsaW1pdGVyIHx8IGhlYWRlckluZm8uZGVsaW1pdGVyOw0KDQogICAgICAgIGlmIChpc0FtcldhdGNoKSB7DQogICAgICAgICAgY29uc3QgcmVxdWlyZWRIZWFkZXJzID0gWw0KICAgICAgICAgICAgQU1SX1dBVENIX0hFQURFUlMuYWNjZXNzaW9uLA0KICAgICAgICAgICAgQU1SX1dBVENIX0hFQURFUlMuY291bnRyeSwNCiAgICAgICAgICAgIEFNUl9XQVRDSF9IRUFERVJTLmRhdGUsDQogICAgICAgICAgXTsNCiAgICAgICAgICBjb25zdCBocmVzID0gdmFsaWRhdGVIZWFkZXJzKGhlYWRlckluZm8uaGVhZGVycywgcmVxdWlyZWRIZWFkZXJzKTsNCiAgICAgICAgICBpZiAoIWhyZXMub2spIHsNCiAgICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2Uoew0KICAgICAgICAgICAgICB0eXBlOiAicmVzdWx0IiwNCiAgICAgICAgICAgICAgbWV0YTogbnVsbCwNCiAgICAgICAgICAgICAgcmVzdWx0OiBudWxsLA0KICAgICAgICAgICAgICB2YWxpZGF0aW9uOiB7DQogICAgICAgICAgICAgICAgb2s6IGZhbHNlLA0KICAgICAgICAgICAgICAgIGZhdGFsOiB0cnVlLA0KICAgICAgICAgICAgICAgIGhlYWRlcjogeyBtaXNzaW5nOiBocmVzLm1pc3NpbmcgfSwNCiAgICAgICAgICAgICAgICBjb3VudHM6IHsgZXJyb3JzOiBocmVzLm1pc3NpbmcubGVuZ3RoLCB3YXJuaW5nczogMCB9LA0KICAgICAgICAgICAgICAgIGVycm9yczogaHJlcy5taXNzaW5nLm1hcCgoaCkgPT4gKHsNCiAgICAgICAgICAgICAgICAgIHJvdzogMSwNCiAgICAgICAgICAgICAgICAgIGNvbHVtbjogaCwNCiAgICAgICAgICAgICAgICAgIGNvZGU6ICJtaXNzaW5nX2hlYWRlciIsDQogICAgICAgICAgICAgICAgICBtc2c6ICJIZWFkZXIgbWlzc2luZyIsDQogICAgICAgICAgICAgICAgfSkpLA0KICAgICAgICAgICAgICAgIHdhcm5pbmdzOiBbXSwNCiAgICAgICAgICAgICAgfSwNCiAgICAgICAgICAgIH0pOw0KICAgICAgICAgICAgcmV0dXJuOw0KICAgICAgICAgIH0NCg0KICAgICAgICAgIGNvbnN0IG92ZXJyaWRlID0NCiAgICAgICAgICAgIHR5cGVvZiBzcGVjaWVzT3ZlcnJpZGUgPT09ICJzdHJpbmciID8gc3BlY2llc092ZXJyaWRlLnRyaW0oKSA6ICIiOw0KICAgICAgICAgIGNvbnN0IGhhc092ZXJyaWRlID0gb3ZlcnJpZGUubGVuZ3RoID4gMDsNCiAgICAgICAgICBpZiAoaGFzT3ZlcnJpZGUpIHsNCiAgICAgICAgICAgIHNjYW5Qcm9ncmVzc01heCA9IDA7DQogICAgICAgICAgICBsb29rdXBQcm9ncmVzc0Jhc2UgPSAwOw0KICAgICAgICAgICAgbG9va3VwUHJvZ3Jlc3NTcGFuID0gMDsNCiAgICAgICAgICAgIGNvbnZlcnNpb25Qcm9ncmVzc0Jhc2UgPSAwOw0KICAgICAgICAgICAgY29udmVyc2lvblByb2dyZXNzU3BhbiA9IDE7DQogICAgICAgICAgfQ0KDQogICAgICAgICAgbGV0IHNwZWNpZXNNYXAgPSB7fTsNCiAgICAgICAgICBpZiAoIWhhc092ZXJyaWRlKSB7DQogICAgICAgICAgICBjb25zdCBhY2Nlc3Npb25JbmRleCA9IGhlYWRlckluZm8uaGVhZGVycy5pbmRleE9mKA0KICAgICAgICAgICAgICBBTVJfV0FUQ0hfSEVBREVSUy5hY2Nlc3Npb24NCiAgICAgICAgICAgICk7DQogICAgICAgICAgICBjb25zdCBhY2Nlc3Npb25TZXQgPSBhd2FpdCBzY2FuQ3N2Q29sdW1uVmFsdWVzRnJvbVN0cmVhbSgNCiAgICAgICAgICAgICAgZmlsZS5zdHJlYW0oKSwNCiAgICAgICAgICAgICAgew0KICAgICAgICAgICAgICAgIGRlbGltaXRlcjogZWZmZWN0aXZlRGVsaW1pdGVyLA0KICAgICAgICAgICAgICAgIGNvbHVtbkluZGV4OiBhY2Nlc3Npb25JbmRleCwNCiAgICAgICAgICAgICAgICBwcm9ncmVzc0NiOiAocCkgPT4NCiAgICAgICAgICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2Uoew0KICAgICAgICAgICAgICAgICAgICB0eXBlOiAicHJvZ3Jlc3MiLA0KICAgICAgICAgICAgICAgICAgICBwcm9ncmVzczogTWF0aC5taW4oc2NhblByb2dyZXNzTWF4LCBwKSwNCiAgICAgICAgICAgICAgICAgIH0pLA0KICAgICAgICAgICAgICAgIGZpbGVTaXplOiBmaWxlLnNpemUsDQogICAgICAgICAgICAgIH0NCiAgICAgICAgICAgICk7DQogICAgICAgICAgICB0cnkgew0KICAgICAgICAgICAgICBzcGVjaWVzTWFwID0gYXdhaXQgZ2V0U3BlY2llc0JhdGNoKEFycmF5LmZyb20oYWNjZXNzaW9uU2V0KSwgew0KICAgICAgICAgICAgICAgIG9uUHJvZ3Jlc3M6ICh7IGNvbXBsZXRlZCwgdG90YWwgfSkgPT4gew0KICAgICAgICAgICAgICAgICAgY29uc3QgcmF0aW8gPSB0b3RhbCA+IDAgPyBjb21wbGV0ZWQgLyB0b3RhbCA6IDE7DQogICAgICAgICAgICAgICAgICBjb25zdCBwcm9ncmVzcyA9DQogICAgICAgICAgICAgICAgICAgIGxvb2t1cFByb2dyZXNzQmFzZSArIHJhdGlvICogbG9va3VwUHJvZ3Jlc3NTcGFuOw0KICAgICAgICAgICAgICAgICAgc2VsZi5wb3N0TWVzc2FnZSh7IHR5cGU6ICJwcm9ncmVzcyIsIHByb2dyZXNzIH0pOw0KICAgICAgICAgICAgICAgIH0sDQogICAgICAgICAgICAgIH0pOw0KICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7DQogICAgICAgICAgICAgIGNvbnNvbGUud2FybigiU3BlY2llcyBsb29rdXAgZmFpbGVkLCBjb250aW51aW5nOiIsIGVycik7DQogICAgICAgICAgICAgIHNwZWNpZXNNYXAgPSB7fTsNCiAgICAgICAgICAgIH0NCiAgICAgICAgICB9DQogICAgICAgICAgY29uc3QgY29uZmlnRHJ1Z0NvbHMgPSBhbXJXYXRjaENvbmZpZz8uZHJ1Z0NvbHMgPz8gbnVsbDsNCiAgICAgICAgICBjb25zdCBkcnVnQ29sU291cmNlID0gY29uZmlnRHJ1Z0NvbHMgfHwgQU1SX1dBVENIX0hFQURFUlMuZHJ1Z0NvbHM7DQogICAgICAgICAgY29uc3QgYXZhaWxhYmxlRHJ1Z0NvbHMgPSBPYmplY3Qua2V5cyhkcnVnQ29sU291cmNlKS5maWx0ZXIoDQogICAgICAgICAgICAoY29sKSA9PiBoZWFkZXJJbmZvLmhlYWRlcnMuaW5jbHVkZXMoY29sKQ0KICAgICAgICAgICk7DQogICAgICAgICAgcm93TWFwcGVyID0gYnVpbGRBbXJXYXRjaFJvd01hcHBlcigNCiAgICAgICAgICAgIHNwZWNpZXNNYXAsDQogICAgICAgICAgICBhdmFpbGFibGVEcnVnQ29scywNCiAgICAgICAgICAgIG92ZXJyaWRlLA0KICAgICAgICAgICAgYW1yV2F0Y2hDb25maWcsDQogICAgICAgICAgKTsNCiAgICAgICAgICBlZmZlY3RpdmVTY2hlbWEgPSBudWxsOw0KICAgICAgICB9DQoNCiAgICAgICAgLy8gVXNlIHN0cmVhbWluZyBmb3IgZmlsZXMgbGFyZ2VyIHRoYW4gNTBNQiwgb3IgaWYgZXhwbGljaXRseSByZXF1ZXN0ZWQuDQogICAgICAgIC8vIEZsYXQtb2JzZXJ2YXRpb24gbW9kZSByZXF1aXJlcyBncm91cGluZyBieSBJRCwgc28gaXQgY2Fubm90IHN0cmVhbSByb3ctYnktcm93Lg0KICAgICAgICBjb25zdCB1c2VTdHJlYW0gPQ0KICAgICAgICAgICFmbGF0T2JzZXJ2YXRpb25zICYmDQogICAgICAgICAgdXNlU3RyZWFtaW5nICYmIChmaWxlLnNpemUgPiA1MCAqIDEwMjQgKiAxMDI0IHx8IHVzZVN0cmVhbWluZyA9PT0gdHJ1ZSk7DQoNCiAgICAgICAgaWYgKHVzZVN0cmVhbSAmJiBmaWxlLnN0cmVhbSkgew0KICAgICAgICAgIC8vIFN0cmVhbWluZyBtb2RlOiBwcm9jZXNzIGZpbGUgaW4gY2h1bmtzIGFuZCBzdG9yZSBpbmNyZW1lbnRhbGx5DQogICAgICAgICAgdHJ5IHsNCiAgICAgICAgICAgIGNvbnN0IHN0cmVhbSA9IGZpbGUuc3RyZWFtKCk7DQoNCiAgICAgICAgICAgIC8vIFNldHVwIEluZGV4ZWREQiBpbiB3b3JrZXINCiAgICAgICAgICAgIGNvbnN0IGRiID0gYXdhaXQgc2V0dXBXb3JrZXJJbmRleGVkREIoDQogICAgICAgICAgICAgIGRiTmFtZSB8fCAiQ3N2VXBsb2FkQ2FjaGUiLA0KICAgICAgICAgICAgICBkYlZlcnNpb24gfHwgNA0KICAgICAgICAgICAgKTsNCg0KICAgICAgICAgICAgbGV0IGNodW5rSW5kZXggPSAwOw0KICAgICAgICAgICAgY29uc3QgY2h1bmtDYWxsYmFjayA9IGFzeW5jIChpZHgsIGNodW5rRGF0YSkgPT4gew0KICAgICAgICAgICAgICBhd2FpdCBzdG9yZUNodW5rKGRiLCByZXN1bHRLZXksIGlkeCwgY2h1bmtEYXRhKTsNCiAgICAgICAgICAgICAgc2VsZi5wb3N0TWVzc2FnZSh7DQogICAgICAgICAgICAgICAgdHlwZTogImNodW5rLXN0b3JlZCIsDQogICAgICAgICAgICAgICAgY2h1bmtJbmRleDogaWR4LA0KICAgICAgICAgICAgICAgIGNodW5rU2l6ZTogbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGNodW5rRGF0YSkubGVuZ3RoLA0KICAgICAgICAgICAgICB9KTsNCiAgICAgICAgICAgIH07DQoNCiAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNzdlN0cmVhbVRvSnNvbmwoc3RyZWFtLCB7DQogICAgICAgICAgICAgIGRlbGltaXRlcjogZWZmZWN0aXZlRGVsaW1pdGVyLA0KICAgICAgICAgICAgICBzbmlmZkJ5dGVzLA0KICAgICAgICAgICAgICBpbmZlclR5cGVzLA0KICAgICAgICAgICAgICBsaXN0Q29sczogbmV3IFNldChsaXN0Q29scyksDQogICAgICAgICAgICAgIGxpc3RTZXAsDQogICAgICAgICAgICAgIGluZmVyTGlzdEVsZW1zLA0KICAgICAgICAgICAgICBrZWVwSGVhZGVycywNCiAgICAgICAgICAgICAgcHJldHR5LA0KICAgICAgICAgICAgICBwcm9ncmVzc0NiOiAocCkgPT4NCiAgICAgICAgICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsNCiAgICAgICAgICAgICAgICAgIHR5cGU6ICJwcm9ncmVzcyIsDQogICAgICAgICAgICAgICAgICBwcm9ncmVzczogaXNBbXJXYXRjaA0KICAgICAgICAgICAgICAgICAgICA/IGNvbnZlcnNpb25Qcm9ncmVzc0Jhc2UgKyBwICogY29udmVyc2lvblByb2dyZXNzU3Bhbg0KICAgICAgICAgICAgICAgICAgICA6IHAsDQogICAgICAgICAgICAgICAgfSksDQogICAgICAgICAgICAgIHNjaGVtYTogZWZmZWN0aXZlU2NoZW1hLA0KICAgICAgICAgICAgICByb3dNYXBwZXIsDQogICAgICAgICAgICAgIG1heEVycm9yczogb3B0aW9ucy5tYXhFcnJvcnMgPz8gMjAwLA0KICAgICAgICAgICAgICBjaHVua0NhbGxiYWNrLA0KICAgICAgICAgICAgICBjaHVua1NpemVCeXRlcywNCiAgICAgICAgICAgICAgZmlsZVNpemU6IGZpbGUuc2l6ZSwgLy8gUGFzcyBmaWxlIHNpemUgZm9yIGFjY3VyYXRlIHByb2dyZXNzDQogICAgICAgICAgICB9KTsNCg0KICAgICAgICAgICAgaWYgKHJlcy52YWxpZGF0aW9uICYmIHJlcy52YWxpZGF0aW9uLmZhdGFsKSB7DQogICAgICAgICAgICAgIHNlbGYucG9zdE1lc3NhZ2Uoew0KICAgICAgICAgICAgICAgIHR5cGU6ICJyZXN1bHQiLA0KICAgICAgICAgICAgICAgIG1ldGE6IG51bGwsDQogICAgICAgICAgICAgICAgcmVzdWx0OiBudWxsLA0KICAgICAgICAgICAgICAgIHZhbGlkYXRpb246IHJlcy52YWxpZGF0aW9uLA0KICAgICAgICAgICAgICB9KTsNCiAgICAgICAgICAgICAgcmV0dXJuOw0KICAgICAgICAgICAgfQ0KDQogICAgICAgICAgICAvLyBTdG9yZSBtZXRhZGF0YQ0KICAgICAgICAgICAgY29uc3QgbWV0YSA9IHsNCiAgICAgICAgICAgICAgbmFtZTogZmlsZS5uYW1lLA0KICAgICAgICAgICAgICBzaXplOiBmaWxlLnNpemUsDQogICAgICAgICAgICAgIGxhc3RNb2RpZmllZDogZmlsZS5sYXN0TW9kaWZpZWQsDQogICAgICAgICAgICAgIHJvd3M6IHJlcy5yb3dzLA0KICAgICAgICAgICAgICBkZWxpbWl0ZXI6IHJlcy5kZWxpbWl0ZXIsDQogICAgICAgICAgICAgIHNlbGVjdGVkSGVhZGVyczoga2VlcEhlYWRlcnMsDQogICAgICAgICAgICAgIGNodW5rZWQ6IHRydWUsDQogICAgICAgICAgICAgIGNodW5rQ291bnQ6IHJlcy5jaHVua0NvdW50IHx8IDAsDQogICAgICAgICAgICB9Ow0KDQogICAgICAgICAgICBhd2FpdCBzdG9yZU1ldGFkYXRhKGRiLCByZXN1bHRLZXksIG1ldGEpOw0KICAgICAgICAgICAgZGIuY2xvc2UoKTsNCg0KICAgICAgICAgICAgc2VsZi5wb3N0TWVzc2FnZSh7DQogICAgICAgICAgICAgIHR5cGU6ICJyZXN1bHQiLA0KICAgICAgICAgICAgICBtZXRhLA0KICAgICAgICAgICAgICByZXN1bHQ6IHsgY2h1bmtlZDogdHJ1ZSwgcHJldmlldzogcmVzLnByZXZpZXcgfHwgW10gfSwNCiAgICAgICAgICAgICAgdmFsaWRhdGlvbjogcmVzLnZhbGlkYXRpb24sDQogICAgICAgICAgICB9KTsNCiAgICAgICAgICAgIHJldHVybjsNCiAgICAgICAgICB9IGNhdGNoIChzdHJlYW1FcnIpIHsNCiAgICAgICAgICAgIC8vIEZhbGxiYWNrIHRvIG5vbi1zdHJlYW1pbmcgaWYgc3RyZWFtaW5nIGZhaWxzDQogICAgICAgICAgICBjb25zb2xlLndhcm4oDQogICAgICAgICAgICAgICJTdHJlYW1pbmcgZmFpbGVkLCBmYWxsaW5nIGJhY2sgdG8gbm9uLXN0cmVhbWluZzoiLA0KICAgICAgICAgICAgICBzdHJlYW1FcnINCiAgICAgICAgICAgICk7DQogICAgICAgICAgfQ0KICAgICAgICB9DQoNCiAgICAgICAgLy8gRmFsbGJhY2s6IG5vbi1zdHJlYW1pbmcgbW9kZSAoZm9yIHNtYWxsZXIgZmlsZXMgb3IgY29tcGF0aWJpbGl0eSkNCiAgICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IGZpbGUudGV4dCgpOw0KDQogICAgICAgIGNvbnN0IHByb2dyZXNzRm4gPSAocCkgPT4NCiAgICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsNCiAgICAgICAgICAgIHR5cGU6ICJwcm9ncmVzcyIsDQogICAgICAgICAgICBwcm9ncmVzczogaXNBbXJXYXRjaA0KICAgICAgICAgICAgICA/IGNvbnZlcnNpb25Qcm9ncmVzc0Jhc2UgKyBwICogY29udmVyc2lvblByb2dyZXNzU3Bhbg0KICAgICAgICAgICAgICA6IHAsDQogICAgICAgICAgfSk7DQoNCiAgICAgICAgY29uc3QgcmVzID0gKGZsYXRPYnNlcnZhdGlvbnMgJiYgIWlzQW1yV2F0Y2gpDQogICAgICAgICAgPyBjc3ZGbGF0VGV4dFRvSnNvbmwodGV4dCwgew0KICAgICAgICAgICAgICBkZWxpbWl0ZXI6IGVmZmVjdGl2ZURlbGltaXRlciwNCiAgICAgICAgICAgICAgc25pZmZCeXRlcywNCiAgICAgICAgICAgICAgaW5mZXJUeXBlcywNCiAgICAgICAgICAgICAgaWRDb2x1bW4sDQogICAgICAgICAgICAgIGxpbmtlZEZpZWxkcywNCiAgICAgICAgICAgICAga2VlcEhlYWRlcnMsDQogICAgICAgICAgICAgIHByZXR0eSwNCiAgICAgICAgICAgICAgcHJvZ3Jlc3NDYjogcHJvZ3Jlc3NGbiwNCiAgICAgICAgICAgICAgc2NoZW1hOiBlZmZlY3RpdmVTY2hlbWEsDQogICAgICAgICAgICAgIG1heEVycm9yczogb3B0aW9ucy5tYXhFcnJvcnMgPz8gMjAwLA0KICAgICAgICAgICAgfSkNCiAgICAgICAgICA6IGNzdlRleHRUb0pzb25sKHRleHQsIHsNCiAgICAgICAgICAgICAgZGVsaW1pdGVyOiBlZmZlY3RpdmVEZWxpbWl0ZXIsDQogICAgICAgICAgICAgIHNuaWZmQnl0ZXMsDQogICAgICAgICAgICAgIGluZmVyVHlwZXMsDQogICAgICAgICAgICAgIGxpc3RDb2xzOiBuZXcgU2V0KGxpc3RDb2xzKSwNCiAgICAgICAgICAgICAgbGlzdFNlcCwNCiAgICAgICAgICAgICAgaW5mZXJMaXN0RWxlbXMsDQogICAgICAgICAgICAgIGtlZXBIZWFkZXJzLA0KICAgICAgICAgICAgICBwcmV0dHksDQogICAgICAgICAgICAgIHByb2dyZXNzQ2I6IHByb2dyZXNzRm4sDQogICAgICAgICAgICAgIHNjaGVtYTogZWZmZWN0aXZlU2NoZW1hLA0KICAgICAgICAgICAgICByb3dNYXBwZXIsDQogICAgICAgICAgICAgIG1heEVycm9yczogb3B0aW9ucy5tYXhFcnJvcnMgPz8gMjAwLA0KICAgICAgICAgICAgfSk7DQoNCiAgICAgICAgaWYgKHJlcy52YWxpZGF0aW9uICYmIHJlcy52YWxpZGF0aW9uLmZhdGFsKSB7DQogICAgICAgICAgLy8gU2VuZCBhIGxpZ2h0d2VpZ2h0IHJlc3VsdCB3aXRoIHZhbGlkYXRpb24gb25seTsgbm8gYmxvYi9tZXRhL3ByZXZpZXcNCiAgICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsNCiAgICAgICAgICAgIHR5cGU6ICJyZXN1bHQiLA0KICAgICAgICAgICAgbWV0YTogbnVsbCwNCiAgICAgICAgICAgIHJlc3VsdDogbnVsbCwNCiAgICAgICAgICAgIHZhbGlkYXRpb246IHJlcy52YWxpZGF0aW9uLA0KICAgICAgICAgIH0pOw0KICAgICAgICAgIHJldHVybjsNCiAgICAgICAgfQ0KDQogICAgICAgIC8vIFJldHVybiBhIEJsb2Igc28gdGhlIG1haW4gdGhyZWFkIGNhbiBzYXZlL2Rvd25sb2FkIG9yIHN0b3JlIGl0Lg0KICAgICAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW3Jlcy5qc29ubF0sIHsgdHlwZTogImFwcGxpY2F0aW9uL3gtbmRqc29uIiB9KTsNCiAgICAgICAgY29uc3QgbWV0YSA9IHsNCiAgICAgICAgICBuYW1lOiBmaWxlLm5hbWUsDQogICAgICAgICAgc2l6ZTogZmlsZS5zaXplLA0KICAgICAgICAgIGxhc3RNb2RpZmllZDogZmlsZS5sYXN0TW9kaWZpZWQsDQogICAgICAgICAgcm93czogcmVzLnJvd3MsDQogICAgICAgICAgZGVsaW1pdGVyOiByZXMuZGVsaW1pdGVyLA0KICAgICAgICAgIHNlbGVjdGVkSGVhZGVyczoga2VlcEhlYWRlcnMsDQogICAgICAgICAgY2h1bmtlZDogZmFsc2UsDQogICAgICAgIH07DQoNCiAgICAgICAgLy8gSW5jbHVkZSBhIHRpbnkgcHJldmlldyAoZmlyc3QgNSBsaW5lcykgZm9yIHF1aWNrIFVJIGZlZWRiYWNrDQogICAgICAgIGNvbnN0IHByZXZpZXcgPSByZXMuanNvbmwuc3BsaXQoIlxuIikuc2xpY2UoMCwgNSkuZmlsdGVyKEJvb2xlYW4pOw0KDQogICAgICAgIHNlbGYucG9zdE1lc3NhZ2Uoew0KICAgICAgICAgIHR5cGU6ICJyZXN1bHQiLA0KICAgICAgICAgIG1ldGEsDQogICAgICAgICAgcmVzdWx0OiB7IGJsb2IsIHByZXZpZXcgfSwNCiAgICAgICAgICB2YWxpZGF0aW9uOiByZXMudmFsaWRhdGlvbiwNCiAgICAgICAgfSk7DQogICAgICAgIHJldHVybjsNCiAgICAgIH0NCiAgICB9IGNhdGNoIChlcnIpIHsNCiAgICAgIHNlbGYucG9zdE1lc3NhZ2Uoew0KICAgICAgICB0eXBlOiAiZXJyb3IiLA0KICAgICAgICBlcnJvcjogKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgU3RyaW5nKGVyciksDQogICAgICB9KTsNCiAgICB9DQogIH0pOwoKfSkoKTsKLy8jIHNvdXJjZU1hcHBpbmdVUkw9Y3N2LXdvcmtlci5qcy5tYXAKCg==';
/* eslint-enable */

/**
 * Shared CSV parsing utilities used by both the main thread (userFileHandler)
 * and the web worker (csv-worker).
 */

const AMR_WATCH_HEADERS = {
  accession: "Run Accession",
  country: "Country Name",
  date: "Collection Date"};

/**
 * Parse a single CSV line, handling quoted fields and escaped quotes.
 */
function parseCsvLine(line, delimiter = ",") {
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
function sniffDelimiter(sample, fallback = ",") {
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
function parseHeaderSample(sample, delimiter = null) {
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
function isAmrWatchHeaders(headers) {
  const required = [
    AMR_WATCH_HEADERS.accession,
    AMR_WATCH_HEADERS.country,
    AMR_WATCH_HEADERS.date,
  ];
  return required.every((h) => headers.includes(h));
}

var styles = ":host { display:inline-block; font: 14px/1.4 system-ui, sans-serif; width: 100%; }\r\nbutton { font: inherit; cursor: pointer; }\r\n\r\n.hint{color:#6a737d; font-size:.9rem}\r\n#main-button-group div.main-content {\r\n  display: flex;\r\n  flex-direction: column;\r\n  width: 100%;\r\n  height: auto;\r\n  justify-content: center;\r\n  align-items: start;\r\n}\r\n.main-content {\r\n  align-items: start;\r\n}\r\n#data-guarantee {\r\n  margin-top: 4px;\r\n  margin-left: calc(1px + 8px);\r\n  font-size: 0.8em;\r\n}\r\n#state-open {\r\n  display: flex;\r\n  flex-direction: column;\r\n}\r\nlabel, #state-open input {display: block}\r\n\r\n#loaded-files {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  justify-content: start;\r\n}\r\n\r\n#file-snitch {\r\n  display: flex;\r\n  flex-direction: row;\r\n  align-items: center;\r\n  justify-content: start;\r\n  gap: 0.25rem;\r\n  width: 100%;\r\n  margin-top: 0.5rem;\r\n}\r\n#file-snitch button {height: auto; color: red; font-weight: 600; padding: 6px 8px;}\r\n#file-snitch p {margin: 0; max-width: 100%; overflow: hidden;}\r\n\r\n#template-download {\r\n  display: flex; align-items: center;\r\n  cursor: pointer;\r\n  color: inherit;\r\n  text-decoration: none;\r\n}\r\n\r\n#help-icon {\r\n  margin-left: 0.5rem;\r\n}\r\n\r\n.flex {display:flex;}\r\n.open-row {gap:0.5rem;}\r\n.open-input-group {display: flex; align-items: center;}\r\n\r\n.flex-row {display:flex; flex-direction:row;}\r\n.align-center {align-items: center;}\r\n.button {\r\n  cursor: pointer;\r\n  border-radius: 8px;\r\n  padding: 6px 8px;\r\n  border: 1px solid #ced4da;\r\n  background-color: #fff;\r\n}\r\n.button:hover {\r\n  background-color: #f3f4f6;\r\n}\r\n.fade {\r\n  mask-image: linear-gradient(90deg, #000 85%, transparent);\r\n}\r\n.hidden {display: none !important;}\r\n.amrwatch-hidden {display: none !important;}\r\n.amrwatch-modal {\r\n  position: fixed;\r\n  inset: 0;\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  background: rgba(0, 0, 0, 0.45);\r\n  z-index: 1000;\r\n}\r\n.amrwatch-dialog {\r\n  background: #fff;\r\n  color: #111;\r\n  border-radius: 12px;\r\n  padding: 16px;\r\n  width: min(440px, 92vw);\r\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 10px;\r\n}\r\n.amrwatch-header {\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: space-between;\r\n  gap: 8px;\r\n}\r\n.amrwatch-title {\r\n  font-weight: 600;\r\n  font-size: 1rem;\r\n  margin: 0;\r\n}\r\n.amrwatch-input {\r\n  border: 1px solid #ced4da;\r\n  border-radius: 8px;\r\n  padding: 8px 10px;\r\n  font: inherit;\r\n}\r\n.amrwatch-actions {\r\n  display: flex;\r\n  justify-content: flex-end;\r\n  gap: 0.5rem;\r\n  margin-top: 6px;\r\n}\r\n\r\n#state-uploading {\r\n  display: flex;\r\n  flex-direction: column;\r\n  width: 100%;\r\n  gap: 0.5rem;\r\n}\r\n\r\n.progress-container {\r\n  display: flex;\r\n  flex-direction: column;\r\n  width: 100%;\r\n  gap: 0.25rem;\r\n}\r\n\r\n.progress-bar-wrapper {\r\n  width: 100%;\r\n  height: 8px;\r\n  background-color: #e9ecef;\r\n  border-radius: 4px;\r\n  overflow: hidden;\r\n  position: relative;\r\n}\r\n\r\n.progress-bar {\r\n  height: 100%;\r\n  background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%);\r\n  border-radius: 4px;\r\n  transition: width 0.2s ease-out;\r\n  width: 0%;\r\n}\r\n\r\n.progress-text {\r\n  font-size: 0.85rem;\r\n  color: #6b7280;\r\n  text-align: center;\r\n}\r\n\r\n.progress-info {\r\n  display: flex;\r\n  justify-content: space-between;\r\n  align-items: center;\r\n  font-size: 0.8rem;\r\n  color: #6b7280;\r\n}\r\n";

var template = "<div id=\"main-button-group\">\r\n  <div class=\"flex-row align-center\">\r\n    <div id=\"state-open\" class=\"main-content\">\r\n      <div class=\"flex-row open-row\">\r\n        <div class=\"open-input-group\">\r\n          <label class=\"button\" for=\"fileInput\" id=\"uploadLabel\">Load Custom Data</label>\r\n          <input class=\"hidden\" name=\"fileInput\" id=\"fileInput\" type=\"file\" accept=\".csv,text/csv\" />\r\n        </div>\r\n        <div class=\"open-input-group\">\r\n          <a id=\"template-download\">\r\n            <svg\r\n              xmlns=\"http://www.w3.org/2000/svg\"\r\n              height=\"24px\"\r\n              viewBox=\"0 -960 960 960\"\r\n              width=\"24px\"\r\n              fill=\"#1f1f1f\"\r\n            >\r\n              <path d=\"M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z\" />\r\n            </svg>\r\n            Download Template\r\n          </a>\r\n        </div>\r\n      </div>\r\n    </div>\r\n    <div id=\"state-uploading\" class=\"hidden main-content\">\r\n      <div class=\"progress-container\">\r\n        <div class=\"progress-info\">\r\n          <span id=\"progress-status\">Processing...</span>\r\n          <span id=\"progress-percent\">0%</span>\r\n        </div>\r\n        <div class=\"progress-bar-wrapper\">\r\n          <div class=\"progress-bar\" id=\"progress-bar\"></div>\r\n        </div>\r\n        <div class=\"progress-text\" id=\"progress-details\">Reading file...</div>\r\n      </div>\r\n    </div>\r\n  </div>\r\n  <div id=\"loaded-files\"></div>\r\n</div>\r\n<div id=\"amrwatch-modal\" class=\"amrwatch-modal amrwatch-hidden\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"amrwatch-title\">\r\n  <div class=\"amrwatch-dialog\">\r\n    <div class=\"amrwatch-header\">\r\n      <p id=\"amrwatch-title\" class=\"amrwatch-title\">AMR.watch file detected</p>\r\n      <button class=\"button\" id=\"amrwatch-close\" type=\"button\">✕</button>\r\n    </div>\r\n    <div class=\"hint\">\r\n      You can provide a species name to skip accession lookups (faster for large files).\r\n    </div>\r\n    <label for=\"amrwatch-species-input\">Species name (optional)</label>\r\n    <input\r\n      id=\"amrwatch-species-input\"\r\n      class=\"amrwatch-input\"\r\n      type=\"text\"\r\n      placeholder=\"Escherichia coli\"\r\n    />\r\n    <div class=\"amrwatch-actions\">\r\n      <button class=\"button\" id=\"amrwatch-use-lookup\" type=\"button\">Use accession lookup</button>\r\n      <button class=\"button\" id=\"amrwatch-use-species\" type=\"button\">Use species name</button>\r\n    </div>\r\n  </div>\r\n</div>\r\n\r\n<template id=\"snitchTemplate\">\r\n  <div id=\"file-snitch\">\r\n    <button class=\"button\" id=\"clearFileBtn\">✕</button>\r\n    <p id=\"filename\">?</p>\r\n  </div>\r\n</template>\r\n";

const createWorkerUrlFromBase64 = (base64Source) => {
  const binary = atob(base64Source);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(
    new Blob([bytes], { type: "application/javascript" }),
  );
};

class CsvUploadButton extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._db = null;
    this._worker = null;
    this._file = null;
    this._loadedFiles = new Map(); // IDB key → filename
    this._jsonlReady = false;
    this._speciesOverride = null;
    this._amrModalPromise = null;
    this._amrModalResolver = null;
    this._amrModalWired = false;
    this.templateHref = new URL("template.csv", document.baseURI).toString();

    // Config-driven column lists (populated by setConfig)
    this._linkedFields = [];
    this._scalarCols = [];
    this._requiredHeaders = ["country", "genus"];
    this._amrWatchConfig = null;

    const btnLabel = this.getAttribute("button-label") ?? "Load Custom Data";
    const accept = this.getAttribute("accept") ?? ".csv,text/csv";

    // IndexedDB schema (results only)
    this.IDB_NAME = "CsvUploadCache";
    this.IDB_VERSION = 4; // bumped to support chunked storage
    this.STORE_RESULTS = "results"; // { meta, blob } (legacy) or { meta } (chunked)
    this.STORE_CHUNKS = "chunks"; // { key, chunkIndex, data } for chunked storage
    this.STORE_METADATA = "metadata"; // { key: meta } for chunked metadata

    this.shadowRoot.innerHTML = `<style>${styles}</style>${template}`;

    // Apply attribute-driven dynamic values
    this.shadowRoot.querySelector("#uploadLabel").textContent = btnLabel;
    this.shadowRoot.querySelector("#fileInput").setAttribute("accept", accept);

    this._els = {
      fileInput: this.shadowRoot.querySelector("#fileInput"),
      openState: this.shadowRoot.querySelector("#state-open"),
      uploadingState: this.shadowRoot.querySelector("#state-uploading"),
      templateDownload: this.shadowRoot.querySelector("#template-download"),
      progressBar: this.shadowRoot.querySelector("#progress-bar"),
      progressPercent: this.shadowRoot.querySelector("#progress-percent"),
      progressStatus: this.shadowRoot.querySelector("#progress-status"),
      progressDetails: this.shadowRoot.querySelector("#progress-details"),
      amrModal: this.shadowRoot.querySelector("#amrwatch-modal"),
      amrModalClose: this.shadowRoot.querySelector("#amrwatch-close"),
      amrModalInput: this.shadowRoot.querySelector("#amrwatch-species-input"),
      amrModalUseLookup: this.shadowRoot.querySelector("#amrwatch-use-lookup"),
      amrModalUseSpecies: this.shadowRoot.querySelector(
        "#amrwatch-use-species",
      ),
      loadedFiles: this.shadowRoot.querySelector("#loaded-files"),
    };
  }

  /**
   * Accept the application config and derive column lists from it.
   * Called by AMRGeoMapper after fetching config.json.
   */
  setConfig(config) {
    if (!config) return;

    // Observation (linked) columns from config.linkedFields.fields
    this._linkedFields = config.linkedFields?.fields ?? [];

    // Scalar filter columns: filters where arrayType === false,
    // excluding date-derived columns (collection_year is derived from collection_date)
    this._scalarCols = (config.filters ?? [])
      .filter((f) => f.arrayType === false && f.specialType !== "date")
      .map((f) => f.column);

    // Required headers: scalar filter columns + always require country & genus
    const required = new Set(["country", "genus"]);
    for (const col of this._scalarCols) required.add(col);
    this._requiredHeaders = [...required];

    // AMR.watch column mapping from config
    this._amrWatchConfig = config.amrWatch ?? null;
  }

  connectedCallback() {
    this._setupWorker();
    this._setupIndexedDB();
    this._wireUI();
  }

  // ---------- UI ----------
  _wireUI() {
    this._wireAmrWatchModal();
    this._els.templateDownload.addEventListener("click", (e) => {
      const a = e.currentTarget;

      // Ask first. If the user cancels, stop the default.
      if (!confirm("Download data template?")) {
        e.preventDefault();
        return;
      }

      a.download = "CAMRA_template_main.csv";
      a.href = this.templateHref;
    });
    // Select file -> convert -> store
    this._els.fileInput.addEventListener("change", async () => {
      const file = this._els.fileInput.files?.[0] || null;
      this._file = file;
      if (!file) return;

      let speciesOverride = null;
      try {
        const headerSample = await file.slice(0, 8192).text();
        const headerInfo = parseHeaderSample(headerSample);
        if (isAmrWatchHeaders(headerInfo.headers)) {
          speciesOverride = await this._promptAmrWatchSpecies();
        }
      } catch (err) {
        console.warn("Failed to sniff AMR.watch headers:", err);
      }
      this._speciesOverride = speciesOverride;

      // Show progress bar and hide upload button
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
      this._showUploadProgress(
        0,
        `Processing ${file.name} (${fileSizeMB} MB)...`,
      );
      this._updateProgressDetails("Reading file...");

      // Generate result key before processing
      const tempMeta = {
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      };
      const resultKey = this._makeResultKey(tempMeta);

      // Convert FULL file now (keepHeaders=[] => all columns)
      // Use streaming for files larger than 50MB
      this._worker.postMessage({
        type: "loadSelected",
        file,
        headers: [],
        dbName: this.IDB_NAME,
        dbVersion: this.IDB_VERSION,
        resultKey: resultKey,
        speciesOverride: this._speciesOverride,
        amrWatchConfig: this._amrWatchConfig,
        options: {
          delimiter: null, // sniff
          sniffBytes: 8192,
          inferTypes: true,
          useStreaming: file.size > 50 * 1024 * 1024,
          chunkSizeBytes: 10 * 1024 * 1024,
          flatObservations: true,
          idColumn: "id",
          linkedFields: this._linkedFields,
          pretty: false,
          schema: {
            requireHeaders: this._requiredHeaders,
            types: Object.fromEntries(
              this._requiredHeaders.map((h) => [h, "string"]),
            ),
          },
        },
      });
    });

    // Worker messages (progress + result + errors)
    this._worker.addEventListener("message", async (e) => {
      const { type } = e.data || {};
      if (type === "progress") {
        // Update progress bar (non-blocking)
        const progress = e.data.progress || 0;
        const percent = Math.round(progress * 100);
        let status = "Processing CSV...";
        if (progress < 0.1) {
          status = "Reading file...";
        } else if (progress < 0.5) {
          status = "Parsing data...";
        } else if (progress < 0.9) {
          status = "Validating data...";
        } else {
          status = "Finalizing...";
        }
        this._updateProgress(percent, status);
        return;
      } else if (type === "chunk-stored") {
        // Chunk stored successfully (for progress tracking)
        const chunkIndex = e.data.chunkIndex || 0;
        const chunkSize = e.data.chunkSize || 0;
        this._updateProgressDetails(
          `Stored chunk ${chunkIndex + 1} (${this._formatBytes(chunkSize)})`,
        );
        return;
      } else if (type === "error") {
        this._hideUploadProgress();
        this._resetUI();
      } else if (type === "result") {
        const { meta, result, validation } = e.data;
        if (validation?.fatal || validation?.header?.missing?.length > 0) {
          alert(
            "Upload blocked. Missing required columns: " +
              validation.header.missing.join(", "),
          );
          await this._resetUI?.();
          return;
        }
        if (validation && validation.counts?.errors > 0) {
          alert(
            `Found ${validation.counts.errors} errors and ${validation.counts.warnings} warnings.\n` +
              `Consult the provided data template and check your file for errors.`,
          );
        }
        // Show completion
        this._updateProgress(100, "Complete!");
        this._updateProgressDetails(`Processed ${meta.rows || 0} rows`);

        const key = this._makeResultKey(meta);

        // Store based on format: chunked or legacy blob
        if (result.chunked) {
          await this._idbPutResult(key, { meta, chunked: true });
        } else {
          await this._idbPutResult(key, {
            meta,
            blob: result.blob,
            chunked: false,
          });
        }

        // Accumulate into multi-file map
        this._loadedFiles.set(key, meta.name);

        localStorage.setItem("AMRTrackerUserDataLoaded", true);
        localStorage.setItem(
          "latestJsonlKey",
          JSON.stringify([...this._loadedFiles.keys()]),
        );
        this._jsonlReady = true;

        // Clear input so the same file can be re-selected
        if (this._els.fileInput) this._els.fileInput.value = "";

        // Brief delay to show completion, then hide progress
        setTimeout(() => {
          this._fileSnitch(key);
          this._hideUploadProgress();
          this._els.openState.classList.remove("hidden");
        }, 500);

        // Dispatch custom event to notify AMRTracker that user data was loaded
        document.dispatchEvent(new CustomEvent("userDataLoaded"));
      }
    });
  }

  // Progress bar methods
  _showUploadProgress(percent = 0, status = "Processing...") {
    this._els.openState.classList.add("hidden");
    this._els.uploadingState.classList.remove("hidden");
    this._updateProgress(percent, status);
  }

  _hideUploadProgress() {
    this._els.uploadingState.classList.add("hidden");
  }

  _updateProgress(percent, status = null) {
    // Use requestAnimationFrame for non-blocking UI updates
    requestAnimationFrame(() => {
      if (this._els.progressBar) {
        this._els.progressBar.style.width = `${Math.min(
          100,
          Math.max(0, percent),
        )}%`;
      }
      if (this._els.progressPercent) {
        this._els.progressPercent.textContent = `${Math.min(
          100,
          Math.max(0, percent),
        )}%`;
      }
      if (status && this._els.progressStatus) {
        this._els.progressStatus.textContent = status;
      }
    });
  }

  _updateProgressDetails(details) {
    if (this._els.progressDetails) {
      requestAnimationFrame(() => {
        this._els.progressDetails.textContent = details;
      });
    }
  }

  _formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
  }

  _fileSnitch(key) {
    const emptySnitch =
      this.shadowRoot.querySelector("#snitchTemplate").content;
    const snitch = document.importNode(emptySnitch, true);
    const wrapper = snitch.querySelector("div");

    const p = snitch.querySelector("p");
    const filename = this._loadedFiles.get(key) || "";
    if (wrapper) wrapper.classList.remove("fade");
    if (filename) {
      p.textContent = filename;
      if (filename.length > 26 && wrapper) {
        wrapper.classList.add("fade");
      }
    } else {
      p.textContent = "";
    }

    const clearBtn = snitch.querySelector("#clearFileBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        await this._removeFile(key);
        // Remove only this snitch's DOM node
        const node = clearBtn.closest("div");
        if (node) node.remove();
      });
    }

    this._els.loadedFiles.appendChild(snitch);
  }

  async _removeFile(key) {
    this._loadedFiles.delete(key);

    // Delete from IDB: results, metadata, and chunks for this key
    await this._setupIndexedDB();
    const storeNames = [this.STORE_RESULTS, this.STORE_METADATA];
    if (this._db.objectStoreNames.contains(this.STORE_CHUNKS)) {
      storeNames.push(this.STORE_CHUNKS);
    }
    const tx = this._db.transaction(storeNames, "readwrite");

    tx.objectStore(this.STORE_RESULTS).delete(key);
    if (this._db.objectStoreNames.contains(this.STORE_METADATA)) {
      tx.objectStore(this.STORE_METADATA).delete(key);
    }
    if (this._db.objectStoreNames.contains(this.STORE_CHUNKS)) {
      const chunkIndex = tx.objectStore(this.STORE_CHUNKS).index("by-key");
      const cursorReq = chunkIndex.openCursor(IDBKeyRange.only(key));
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Update localStorage
    if (this._loadedFiles.size === 0) {
      localStorage.removeItem("latestJsonlKey");
      localStorage.setItem("AMRTrackerUserDataLoaded", false);
    } else {
      localStorage.setItem(
        "latestJsonlKey",
        JSON.stringify([...this._loadedFiles.keys()]),
      );
    }

    document.dispatchEvent(new CustomEvent("userDataLoaded"));
  }

  async _resetUI() {
    if (this._els.fileInput) this._els.fileInput.value = "";
    this._loadedFiles.clear();
    this._jsonlReady = false;
    this._file = null;
    this._speciesOverride = null;
    this._hideUploadProgress();
    this._els.openState.classList.remove("hidden");
    this._els.loadedFiles.innerHTML = "";
    await this._idbClearResults();
    localStorage.removeItem("latestJsonlKey");
    localStorage.setItem("AMRTrackerUserDataLoaded", false);
  }

  _wireAmrWatchModal() {
    if (this._amrModalWired) return;
    const modal = this._els.amrModal;
    const dialog = modal?.querySelector(".amrwatch-dialog");
    if (!modal || !dialog) return;

    const useLookup = () => this._resolveAmrWatchPrompt(null);
    const useSpecies = () => {
      const raw = this._els.amrModalInput?.value ?? "";
      const trimmed = String(raw).trim();
      this._resolveAmrWatchPrompt(trimmed.length > 0 ? trimmed : null);
    };

    this._els.amrModalClose?.addEventListener("click", useLookup);
    this._els.amrModalUseLookup?.addEventListener("click", useLookup);
    this._els.amrModalUseSpecies?.addEventListener("click", useSpecies);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) useLookup();
    });
    this._els.amrModalInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        useSpecies();
      }
    });

    this._amrModalWired = true;
  }

  _promptAmrWatchSpecies() {
    if (!this._els.amrModal) return Promise.resolve(null);
    if (this._amrModalPromise) return this._amrModalPromise;
    this._els.amrModal.classList.remove("amrwatch-hidden");
    if (this._els.amrModalInput) {
      this._els.amrModalInput.value = "";
      this._els.amrModalInput.focus();
    }
    this._amrModalPromise = new Promise((resolve) => {
      this._amrModalResolver = resolve;
    });
    return this._amrModalPromise;
  }

  _resolveAmrWatchPrompt(value) {
    if (this._els.amrModal) {
      this._els.amrModal.classList.add("amrwatch-hidden");
    }
    if (this._amrModalResolver) {
      this._amrModalResolver(value ?? null);
    }
    this._amrModalResolver = null;
    this._amrModalPromise = null;
  }

  // ---------- Worker ----------
  _setupWorker() {
    if (this._worker) return;
    const workerUrl = createWorkerUrlFromBase64(base64);
    this._worker = new Worker(workerUrl, { type: "module" });
  }

  // ---------- IndexedDB (results only) ----------
  async _setupIndexedDB() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.IDB_NAME, this.IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const oldVersion = e.oldVersion || 0;

        // Create results store (legacy format)
        if (!db.objectStoreNames.contains(this.STORE_RESULTS)) {
          const s = db.createObjectStore(this.STORE_RESULTS);
          s.createIndex("by-name", "meta.name", { unique: false });
          s.createIndex("by-lastModified", "meta.lastModified", {
            unique: false,
          });
        }

        // Create chunks store for incremental storage (version 4+)
        if (
          oldVersion < 4 &&
          !db.objectStoreNames.contains(this.STORE_CHUNKS)
        ) {
          const chunksStore = db.createObjectStore(this.STORE_CHUNKS, {
            keyPath: ["key", "chunkIndex"],
          });
          chunksStore.createIndex("by-key", "key", { unique: false });
        }

        // Create metadata store for chunked data (version 4+)
        if (
          oldVersion < 4 &&
          !db.objectStoreNames.contains(this.STORE_METADATA)
        ) {
          db.createObjectStore(this.STORE_METADATA);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        console.warn("IndexedDB upgrade blocked; close other tabs.");
    });
    return this._db;
  }

  _tx(store, mode = "readonly") {
    return this._db.transaction(store, mode).objectStore(store);
  }

  async _idbPutResult(key, value /* { meta, blob } */) {
    await this._setupIndexedDB();
    return new Promise((resolve, reject) => {
      const req = this._tx(this.STORE_RESULTS, "readwrite").put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async _idbClearResults() {
    await this._setupIndexedDB();
    return new Promise((resolve, reject) => {
      // Clear all stores: results, chunks, and metadata
      const tx = this._db.transaction(
        [this.STORE_RESULTS, this.STORE_CHUNKS, this.STORE_METADATA],
        "readwrite",
      );

      let completed = 0;
      const checkComplete = () => {
        completed++;
        if (completed === 3) resolve(true);
      };

      tx.objectStore(this.STORE_RESULTS).clear().onsuccess = checkComplete;
      if (this._db.objectStoreNames.contains(this.STORE_CHUNKS)) {
        tx.objectStore(this.STORE_CHUNKS).clear().onsuccess = checkComplete;
      } else {
        checkComplete();
      }
      if (this._db.objectStoreNames.contains(this.STORE_METADATA)) {
        tx.objectStore(this.STORE_METADATA).clear().onsuccess = checkComplete;
      } else {
        checkComplete();
      }

      tx.onerror = () => reject(tx.error);
    });
  }

  _makeResultKey(meta) {
    return `${meta.name}:${meta.size}:${meta.lastModified}`;
  }
}

customElements.define("csv-upload-button", CsvUploadButton);
