import CsvWorkerSource from "web-worker:../core/csv-worker.js";
import { parseHeaderSample, isAmrWatchHeaders } from "../utils/csvUtils.js";
import styles from "../styles/userFileHandler.css";
import template from "../templates/userFileHandler.html";

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
    const workerUrl = createWorkerUrlFromBase64(CsvWorkerSource);
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
