import { DataLoader } from "../core/dataLoader.js";
import {
  LocationData,
  normalizeCountry,
  SharedRegistries,
} from "../core/locationData.js";
import { ColorGenerator } from "../utils/colorGen.js";
import { HTMLhelper } from "../utils/HTMLHelper.js";

import { CountryShadingManager } from "../core/countryShadingManager.js";
import { TooltipManager } from "../core/tooltipManager.js";
import { TaxonomyModalManager } from "../core/taxonomyModalManager.js";
import { MapMarkerManager } from "../core/mapMarkerManager.js";
import { ChartPanelManager } from "../core/chartPanelManager.js";
import { FilterMenuManager } from "../core/filterMenuManager.js";

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

      // Pass config to the CSV upload button so it can derive column lists
      const uploadBtn = this.shadow.querySelector("csv-upload-button");
      if (uploadBtn) uploadBtn.setConfig(configData);

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
