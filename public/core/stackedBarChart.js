// StackedBarChart.js
import { BaseChart } from "./baseChart.js";

// --- Layout Constants ---
const LAYOUT = {
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
export class StackedBarChart extends BaseChart {
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
      barPercentage: LAYOUT.BAR_PCT_SINGLE,
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
            this._clampBarThickness(ctx, stackCount, LAYOUT.BAR_PCT_SINGLE),
          barPercentage: LAYOUT.BAR_PCT_SINGLE,
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

    const { MIN_BAR_PX, MIN_SIDE_PAD_PX, GAP_PX } = LAYOUT;
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

    const { MIN_BAR_PX, MAX_BAR_PX, MIN_SIDE_PAD_PX } = LAYOUT;

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
      this.layoutState.calculatedGroupWidth + sidePad * 2 + LAYOUT.GAP_PX;

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
        ctx.font = opts?.font || `500 16px ${fontFamily}`;
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
