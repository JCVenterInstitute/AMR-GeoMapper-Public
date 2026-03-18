// BaseChart.js

// --- Shared Constants ---
export const CHART_DEFAULTS = {
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

export class BaseChart {
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
