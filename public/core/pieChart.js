// PieChart.js
import { escapeHtml, escapeAttr } from "../utils/HTMLHelper.js";
/**
 * Creates multi-ring pie charts for map markers using Chart.js
 * This type of chart is separate from the baseChart.js class.
 * @class PieChart
 */
export class PieChart {
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
