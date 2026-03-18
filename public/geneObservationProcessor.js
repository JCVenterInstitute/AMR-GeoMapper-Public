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

export { GeneObservationProcessor };
