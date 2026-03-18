import { getPopulation } from "../utils/populationData.js";

export class CountryShadingManager {
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
