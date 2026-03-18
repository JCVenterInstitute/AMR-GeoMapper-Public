import { geoLookup } from "../utils/geoLookup.js";
import { ColorGenerator } from "../utils/colorGen.js";

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

export { LocationData, normalizeCountry, SharedRegistries, IdRegistry, RelationalCrosstab };
