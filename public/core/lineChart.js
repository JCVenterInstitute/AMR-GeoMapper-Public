// LineChart.js
import { BaseChart, CHART_DEFAULTS } from "./baseChart.js";

// --- Layout Constants ---
const LAYOUT = {
  MAX_LINES: 5,
  OVERLAP_OFFSET_RATIO: 0.02,
  OVERLAP_THRESHOLD_RATIO: 0.05,
};

export class LineChart extends BaseChart {

  constructor(container, config) {
    super(container, config);
  }

  _getType() {
    return "line";
  }

  _prepareConfig(locationObj, context) {
    const { filterConfig, userOptions, isFullscreen, colorMaps, unfilteredYearTotals } = context;

    const safeLocation = locationObj || {
      genomeCount: 0,
      name: "No Data",
      getTimeSeriesData: () => ({ labels: [], datasets: [] }),
    };

    const timeSeriesMode = userOptions?.timeSeriesMode ?? "perYear";
    const cumulative = timeSeriesMode === "cumulative";

    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";
    let dataMode = userOptions?.dataMode;
    if (dataMode === undefined) {
      dataMode = userDataLoaded ? "compare" : "merge";
    }

    const lineSelection = userOptions?.lineSelection ?? "totalCount";
    const isPercentage = userOptions?.yAxis === "relative";

    //  1. Fetch Time-Series Data
    const rawData = safeLocation.getTimeSeriesData(
      filterConfig.column,
      cumulative,
      dataMode,
      LAYOUT.MAX_LINES,
      lineSelection,
      unfilteredYearTotals
    );

    // 2. Process Data & Apply Styling
    let datasets = rawData.datasets;
    if (isPercentage) {
      datasets = datasets.map((ds) => {
        // Use unfiltered year totals for relative mode (percentage of pre-filter data)
        const totals =
          dataMode === "compare"
            ? rawData.unfilteredYearTotalsByDataset?.get(ds.datasetId) ??
              rawData.yearTotalsByDataset?.get(ds.datasetId)
            : rawData.unfilteredYearTotals ?? rawData.yearTotals;
        const data = ds.data.map((value, index) => {
          if (value == null) return null;
          const total = totals?.[index] ?? 0;
          return total > 0 ? (value / total) * 100 : 0;
        });
        return { ...ds, data };
      });
    }

    if (dataMode === "compare") {
      datasets = this._applyCompareModeStyling(datasets, {
        fill: false,
        fillOpacity: 0.125,
        pointRadius: 3,
      });
    } else {
      const colors = this._generateColors(rawData.datasets.length);
      datasets = datasets.map((ds, index) => {
        const color = colors[index % colors.length];
        return {
          ...ds,
          borderColor: color,
          backgroundColor: color + "20",
          fill: false,
          tension: 0.1,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        };
      });
    }

    //  3. Apply overlap offset
    datasets = this._offsetOverlappingLines(datasets, rawData.labels);

    //  4. Generate Titles
    const title = `${safeLocation.name || "No Name"} ${
      filterConfig.alias
    } per Genome Over Time`;
    const subtitle = cumulative
      ? `Top ${LAYOUT.MAX_LINES} cumulative frequency`
      : `Top ${LAYOUT.MAX_LINES} frequency per year (${rawData.labels.length} years)`;

    const layoutLogic = {
      title,
      subtitle,
      isCumulative: cumulative,
    };

    //  5. Build Chart Options
    const options = {
      responsive: true,
      animation: false,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      scales: this._getScales(rawData.labels, isPercentage),
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: {
            font: { size: 12 },
            usePointStyle: true,
            padding: 15,
          },
        },
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
        tooltip: this._getTooltipConfig(cumulative, isPercentage),
      },
    };

    return {
      data: { labels: rawData.labels, datasets },
      options,
      layoutLogic,
    };
  }

  _getScales(yearLabels, isPercentage) {
    // Use category scale for years (simpler than time scale, no adapter needed)
    return {
      x: {
        type: "category",
        title: {
          display: true,
          text: "Year",
        },
        ticks: {
          maxRotation: 45,
          minRotation: 45,
        },
        grid: {
          display: false,
        }
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: isPercentage ? "Percentage of Total" : "Frequency",
        },
        ticks: {
          precision: isPercentage ? 1 : 0,
          callback: (value) => {
            if (!isPercentage) return value;
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue)) return value;
            const formatted = Number.isInteger(numericValue)
              ? numericValue.toString()
              : numericValue.toFixed(1);
            return `${formatted}%`;
          },
        },
        grid: {
          display: false,
        }
      },
    };
  }

  _getTooltipConfig(cumulative, isPercentage) {
    return {
      // Sort items by original value (descending - highest frequency first)
      itemSort: (a, b) => {
        // Use original data for sorting if available
        const valueA = a.dataset.originalData
          ? a.dataset.originalData[a.dataIndex] ?? 0
          : a.parsed.y ?? 0;
        const valueB = b.dataset.originalData
          ? b.dataset.originalData[b.dataIndex] ?? 0
          : b.parsed.y ?? 0;
        return valueB - valueA; // Descending order (highest first)
      },
      callbacks: {
        title: (items) => {
          if (items.length === 0) return "";
          const year = items[0].label;
          return `Year: ${year}`;
        },
        label: (context) => {
          const label = context.dataset.label || "Value";
          // Use original data if available (for offset lines), otherwise use parsed value
          const value = context.dataset.originalData
            ? context.dataset.originalData[context.dataIndex]
            : context.parsed.y;
          if (isPercentage) {
            const numericValue = Number(value ?? 0);
            const formatted = Number.isInteger(numericValue)
              ? numericValue.toString()
              : numericValue.toFixed(1);
            return `${label}: ${formatted}%`;
          }
          return `${label}: ${value.toLocaleString()}`;
        },
        footer: (items) => {
          if (isPercentage) {
            return cumulative
              ? "Cumulative percent of all samples"
              : "Percent of all samples per year";
          }
          if (cumulative) {
            return "Cumulative sum";
          }
          return "Per year count";
        },
      },
    };
  }

  _getPlugins() {
    return [this._getNoDataPlugin(), this._getTooltipLimitPlugin()];
  }

  /**
   * Detect and offset overlapping lines to make them visible
   * @param {Array} datasets - Chart datasets with styled data
   * @param {Array} labels - X-axis labels (years)
   * @returns {Array} Datasets with y-values adjusted to prevent overlap
   */
  _offsetOverlappingLines(datasets, labels) {
    if (!datasets || datasets.length < 2 || !labels || labels.length < 2) {
      return datasets;
    }

    // Clone datasets and store original values
    const offsetDatasets = datasets.map((ds) => ({
      ...ds,
      data: [...ds.data],
      originalData: [...ds.data], // Store original values for tooltips
    }));

    // Calculate offset in data units (convert from pixels)
    // We'll use a fixed pixel offset of 3-5 pixels
    const allValues = offsetDatasets
      .flatMap((ds) => ds.data)
      .filter((v) => v != null && !isNaN(v) && v > 0);

    if (allValues.length === 0) {
      return offsetDatasets;
    }

    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const dataRange = maxValue - minValue || maxValue || 1;

    const offsetAmount = dataRange * LAYOUT.OVERLAP_OFFSET_RATIO;

    for (let pointIndex = 0; pointIndex < labels.length - 1; pointIndex++) {
      const overlappingGroups = this._findConsecutiveOverlaps(
        offsetDatasets,
        pointIndex,
        offsetAmount * LAYOUT.OVERLAP_THRESHOLD_RATIO
      );

      // Apply centered offsets to each group
      overlappingGroups.forEach((group) => {
        if (group.length > 1) {
          this._applyCenteredOffsets(
            group,
            offsetDatasets,
            pointIndex,
            offsetAmount
          );
        }
      });
    }

    return offsetDatasets;
  }

  /**
   * Find groups of datasets that have overlapping values at consecutive points
   * @param {Array} datasets - All datasets
   * @param {number} startPointIndex - Starting point index to check
   * @param {number} threshold - Overlap threshold
   * @returns {Array} Array of groups, each group is array of dataset indices
   */
  _findConsecutiveOverlaps(datasets, startPointIndex, threshold) {
    const groups = [];
    const processed = new Set();

    for (let i = 0; i < datasets.length; i++) {
      if (processed.has(i)) continue;

      const ds1 = datasets[i];
      const val1_point1 = ds1.data[startPointIndex];
      const val1_point2 = ds1.data[startPointIndex + 1];

      // Skip if either value is null/undefined
      if (val1_point1 == null || val1_point2 == null) {
        processed.add(i);
        continue;
      }

      // Start a new group with this dataset
      const group = [i];
      processed.add(i);

      // Find all other datasets that overlap at both consecutive points
      for (let j = i + 1; j < datasets.length; j++) {
        if (processed.has(j)) continue;

        const ds2 = datasets[j];
        const val2_point1 = ds2.data[startPointIndex];
        const val2_point2 = ds2.data[startPointIndex + 1];

        if (val2_point1 == null || val2_point2 == null) continue;

        // Check if both consecutive points overlap
        const overlap1 = Math.abs(val1_point1 - val2_point1) <= threshold;
        const overlap2 = Math.abs(val1_point2 - val2_point2) <= threshold;

        if (overlap1 && overlap2) {
          group.push(j);
          processed.add(j);
        }
      }

      if (group.length > 1) {
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * Apply centered offsets to a group of overlapping datasets
   * @param {Array} group - Array of dataset indices
   * @param {Array} datasets - All datasets
   * @param {number} pointIndex - Point index where offset starts
   * @param {number} offsetAmount - Base offset amount
   */
  _applyCenteredOffsets(group, datasets, pointIndex, offsetAmount) {
    const groupSize = group.length;

    // Calculate offsets centered around 0
    // For example: 3 lines -> [-1, 0, 1] * offsetAmount
    const offsets = [];
    for (let i = 0; i < groupSize; i++) {
      const position = i - (groupSize - 1) / 2;
      offsets.push(position * offsetAmount);
    }

    // Apply offsets to both consecutive points
    group.forEach((datasetIndex, i) => {
      const ds = datasets[datasetIndex];
      const offset = offsets[i];

      // Apply to both consecutive points
      if (ds.data[pointIndex] != null) {
        ds.data[pointIndex] += offset;
      }
      if (ds.data[pointIndex + 1] != null) {
        ds.data[pointIndex + 1] += offset;
      }
    });
  }
}
