import { TaxonomyTree } from "./taxonomyTree.js";
import { HTMLhelper } from "../utils/HTMLHelper.js";
import { debounce } from "../utils/domUtils.js";

export class TaxonomyModalManager {
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
