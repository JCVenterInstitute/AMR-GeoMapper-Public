// StackedAreaChart.js
import { BaseChart, CHART_DEFAULTS } from "./baseChart.js";

const LAYOUT = {
  MAX_LINES: 5,
};

export class StackedAreaChart extends BaseChart {

  constructor(container, config) {
    super(container, config);
  }

  _getType() {
    return "line";
  }

  _prepareConfig(locationObj, context) {
    const { filterConfig, userOptions, isFullscreen, colorMaps } = context;

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
    const isRelative = (userOptions?.yAxis ?? "absolute") === "relative";

    //  1. Fetch Time-Series Data
    const rawData = safeLocation.getTimeSeriesData(
      filterConfig.column,
      cumulative,
      dataMode,
      LAYOUT.MAX_LINES,
      lineSelection
    );

    // 2. Normalize data to percentages (100% stacked) only if relative mode
    let processedData;
    if (isRelative) {
      processedData = this._normalizeToPercentages(
        rawData.datasets,
        rawData.labels
      );
    } else {
      // In absolute mode, preserve original data but store it for tooltips
      processedData = {
        datasets: rawData.datasets.map((ds) => ({
          ...ds,
          originalData: [...ds.data], // Store original for tooltips
        })),
        labels: rawData.labels,
      };
    }

    // 3. Process Data & Apply Styling
    let datasets;
    if (dataMode === "compare") {
      datasets = this._applyCompareModeStyling(processedData.datasets, {
        fill: true,
        stack: "single",
        fillOpacity: 0.6,
        pointRadius: 0,
      });
    } else {
      const colors = this._generateColors(processedData.datasets.length);
      datasets = processedData.datasets.map((ds, index) => {
        const color = colors[index % colors.length];
        return {
          ...ds,
          borderColor: color,
          backgroundColor: color + "80",
          fill: true,
          stack: "single",
          tension: 0.1,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointBackgroundColor: color,
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        };
      });
    }

    //  4. Generate Titles
    const title = `${safeLocation.name || "No Name"} ${filterConfig.alias} ${
      isRelative ? "Proportion" : "Frequency"
    } Over Time`;
    const subtitle = isRelative
      ? cumulative
        ? `Top ${LAYOUT.MAX_LINES} cumulative`
        : `Top ${LAYOUT.MAX_LINES} per year`
      : cumulative
      ? `Top ${LAYOUT.MAX_LINES} cumulative frequency`
      : `Top ${LAYOUT.MAX_LINES} frequency per year`;

    const layoutLogic = {
      title,
      subtitle,
      isCumulative: cumulative,
      isRelative,
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
      scales: this._getScales(rawData.labels, isRelative),
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
        tooltip: this._getTooltipConfig(cumulative, isRelative),
      },
    };

    return {
      data: { labels: rawData.labels, datasets },
      options,
      layoutLogic,
    };
  }

  /**
   * Normalize time-series data to percentages (100% stacked)
   * @param {Array} datasets - Raw datasets from getTimeSeriesData
   * @param {Array} labels - Time point labels (years)
   * @returns {{datasets: Array, labels: Array}} Normalized datasets with original data preserved
   */
  _normalizeToPercentages(datasets, labels) {
    if (!datasets || datasets.length === 0 || !labels || labels.length === 0) {
      return { datasets: [], labels };
    }

    // Clone datasets and preserve original data
    const normalizedDatasets = datasets.map((ds) => ({
      ...ds,
      data: [...ds.data],
      originalData: [...ds.data], // Store original absolute values
    }));

    // For each time point, calculate total and normalize
    for (let timeIndex = 0; timeIndex < labels.length; timeIndex++) {
      // Calculate total across all datasets for this time point
      let total = 0;
      for (const ds of normalizedDatasets) {
        const value = ds.data[timeIndex];
        if (value != null && !isNaN(value) && value > 0) {
          total += value;
        }
      }

      // Normalize each dataset value to percentage
      if (total > 0) {
        for (const ds of normalizedDatasets) {
          const originalValue = ds.data[timeIndex];
          if (
            originalValue != null &&
            !isNaN(originalValue) &&
            originalValue > 0
          ) {
            ds.data[timeIndex] = (originalValue / total) * 100;
          } else {
            ds.data[timeIndex] = 0; // Set to 0 for null/undefined/NaN values
          }
        }
      } else {
        // If total is 0, set all values to 0
        for (const ds of normalizedDatasets) {
          ds.data[timeIndex] = 0;
        }
      }
    }

    return { datasets: normalizedDatasets, labels };
  }

  _getScales(yearLabels, isRelative) {
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
        stacked: true,
        beginAtZero: true,
        ...(isRelative
          ? {
              min: 0,
              max: 100,
              title: {
                display: true,
                text: "Proportion (%)",
              },
              ticks: {
                callback: (value) => `${value}%`,
                precision: 0,
              },
            }
          : {
              title: {
                display: true,
                text: "Frequency",
              },
              ticks: {
                precision: 0,
              },
              grace: 5,
            }),
        grid: {
          display: false,
        }
      },
    };
  }

  _getTooltipConfig(cumulative, isRelative) {
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
          if (isRelative) {
            // Get percentage from normalized data
            const percentage = context.parsed.y ?? 0;
            // Get absolute value from original data
            const absoluteValue = context.dataset.originalData
              ? context.dataset.originalData[context.dataIndex] ?? 0
              : 0;
            return `${label}: ${percentage.toFixed(
              1
            )}% (${absoluteValue.toLocaleString()})`;
          } else {
            // In absolute mode, show the value directly
            const value = context.parsed.y ?? 0;
            return `${label}: ${value.toLocaleString()}`;
          }
        },
        footer: (items) => {
          if (isRelative) {
            if (cumulative) {
              return "Cumulative proportion";
            }
            return "Per year proportion";
          } else {
            if (cumulative) {
              return "Cumulative sum";
            }
            return "Per year count";
          }
        },
      },
    };
  }

  _getPlugins() {
    return [this._getNoDataPlugin(), this._getTooltipLimitPlugin()];
  }
}
