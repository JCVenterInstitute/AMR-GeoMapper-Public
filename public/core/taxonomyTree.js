export class TaxonomyTree {
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
