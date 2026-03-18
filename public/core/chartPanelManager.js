import { StackedBarChart } from "./stackedBarChart.js";
import { LineChart } from "./lineChart.js";
import { StackedAreaChart } from "./stackedAreaChart.js";
import { HTMLhelper, escapeHtml } from "../utils/HTMLHelper.js";

export class ChartPanelManager {
  constructor(host) {
    this.host = host;
  }

  _getDefaultOptions() {
    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";
    return {
      yAxis: "absolute",
      dataMode: userDataLoaded ? "compare" : "merge",
      sort: "alphanumeric",
      timeSeriesMode: "perYear",
      lineSelection: "totalCount",
      secondaryDim: null,
    };
  }

  maximizeMenu(menuContainer) {
    const minimizeIconHeight = this.host.constructor.ICON_HEIGHT;
    const mapEl = this.host.shadow.getElementById("map-area");
    if (!mapEl) return;

    const charts = menuContainer;
    const btn = charts.querySelector("#chart-fullscreen-btn");

    charts.classList.add("maximized");
    charts.classList.remove("collapsed");

    const reflow = () => {
      const mapRect = mapEl.getBoundingClientRect();

      const side = this.host.shadow.querySelector("#sidebar-menu-group");
      const sideRect = side?.getBoundingClientRect?.();
      const leftInsetPx = Math.max(
        10,
        sideRect ? Math.round(sideRect.right - mapRect.left) + 10 : 10
      );

      const targetWidth = Math.floor(mapRect.width - leftInsetPx - 10);
      const targetHeight = Math.floor(mapRect.height - 20);

      Object.assign(charts.style, {
        position: "absolute",
        top: "10px",
        right: "10px",
        left: "auto",
        bottom: "auto",
        width: `${targetWidth}px`,
        height: `${targetHeight}px`,
        margin: "0",
        maxWidth: "none",
        maxHeight: "none",
        overflow: "hidden",
      });
    };

    this.host._reflowMaxCharts = reflow;
    requestAnimationFrame(() => {
      this.host._reflowMaxCharts?.();
      this.host.createCharts(
        this.host.locationObjs[this.host.activeLocation],
        this.host.activeLocation,
        this.host.activeChartIDPreference || this.host.activeChartID
      );
    });

    this.host._maxChartsRO?.disconnect?.();
    try {
      this.host._maxChartsRO = new ResizeObserver(() => this.host._reflowMaxCharts?.());
      this.host._maxChartsRO.observe(mapEl);
      const side = this.host.shadow.querySelector("#sidebar-menu-group");
      if (side) this.host._maxChartsRO.observe(side);
    } catch (err) {
      console.error("ResizeObserver not supported, falling back to window resize listener:", err);
      this.host._onMaxChartsWinResize = () => this.host._reflowMaxCharts?.();
      window.addEventListener("resize", this.host._onMaxChartsWinResize);
    }

    if (btn) btn.innerHTML = HTMLhelper.icons("minimize", minimizeIconHeight);
  }

  minimizeMenu(menuContainer) {
    const maximizeIconHeight = this.host.constructor.ICON_HEIGHT;
    const chartContainer = menuContainer;
    const chartMaxMinBtn = chartContainer.querySelector("#chart-fullscreen-btn");

    chartContainer.classList.remove("maximized");

    this.host._maxChartsRO?.disconnect?.();
    this.host._maxChartsRO = null;
    if (this.host._onMaxChartsWinResize) {
      window.removeEventListener("resize", this.host._onMaxChartsWinResize);
      this.host._onMaxChartsWinResize = null;
    }
    this.host._reflowMaxCharts = null;

    [
      "top", "right", "bottom", "left", "width", "height",
      "margin", "maxWidth", "maxHeight", "overflow",
    ].forEach((k) => (chartContainer.style[k] = ""));

    if (chartMaxMinBtn)
      chartMaxMinBtn.innerHTML = HTMLhelper.icons("maximize", maximizeIconHeight);
    this.host.createCharts(
      this.host.locationObjs[this.host.activeLocation],
      this.host.activeLocation,
      this.host.activeChartID
    );
  }

  expandMenu(menuContainer) {
    menuContainer.querySelector("span.genome-counter").style.display = "inline";
    menuContainer.querySelector("button#chart-fullscreen-btn").style.visibility = "visible";
    menuContainer.classList.remove("collapsed");
    menuContainer.querySelector(".chartSection canvas").style.display = "block";
  }

  collapseMenu(menuContainer) {
    menuContainer.style.height = getComputedStyle(menuContainer).height;
    menuContainer.style.width = getComputedStyle(menuContainer).width;

    menuContainer.querySelector(".chartSection canvas").style.display = "none";
    menuContainer.classList.add("collapsed");

    menuContainer.querySelector("span.genome-counter").style.display = "none";
    menuContainer.querySelector("button#chart-fullscreen-btn").style.visibility = "hidden";
  }

  downloadChartImage(
    chart,
    {
      format = "png",
      scale = 2,
      fileName = "chart",
      background = "#ffffff",
    } = {}
  ) {
    const legendPlugin = chart.options.plugins.legend;
    const originalDisplay = legendPlugin?.display ?? false;

    if (legendPlugin) {
      legendPlugin.display = true;
      chart.update("none");
    }

    const src = chart.canvas;
    const cssW = src.clientWidth;
    const cssH = src.clientHeight;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cssW * scale));
    out.height = Math.max(1, Math.round(cssH * scale));

    const ctx = out.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0, out.width, out.height);

    if (legendPlugin) {
      legendPlugin.display = originalDisplay;
      chart.update("none");
    }

    const mime =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
        ? "image/webp"
        : "image/png";

    out.toBlob(
      (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${fileName}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      },
      mime,
      0.92
    );
  }

  renderChartInPanel(locationObj, filterConfig, container) {
    const chartType =
      container.dataset.activeChartType ||
      (Array.isArray(filterConfig.chartType)
        ? filterConfig.chartType[0]
        : filterConfig.chartType) ||
      "stackedBar";

    const ChartClass =
      chartType === "lineGraph"
        ? LineChart
        : chartType === "stackedArea"
        ? StackedAreaChart
        : StackedBarChart;

    container.dataset.activeChartType = chartType;

    if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
      this.host.userChartOptions = this._getDefaultOptions();
    }
    const options = this.host.userChartOptions;

    if (container._chartRenderer) {
      container._chartRenderer.destroy();
      container._chartRenderer = null;
    }
    if (container._chartInstance) {
      container._chartInstance.destroy();
      container._chartInstance = null;
    }

    const chartRenderer = new ChartClass(container);

    chartRenderer.render(locationObj, {
      filterConfig,
      filterConfigs: this.host.config.filters,
      userOptions: options,
      isFullscreen: this.host.shadow
        .querySelector("#charts")
        .classList.contains("maximized"),
      colorMaps: {
        species: this.host.speciesColorMap,
        genus: this.host.genusColorMap,
      },
      unfilteredYearTotals: this.host.dataLoader.getUnfilteredYearTotals(),
    });

    container._chartRenderer = chartRenderer;
  }

  createCharts(locationObj, key, active = null) {
    const name = locationObj?.name ?? "No data";
    const chartContainer = this.host.shadow.getElementById("charts");
    chartContainer.setAttribute("locationKey", key);

    this.host.mapHeight = getComputedStyle(this.host.shadow.querySelector("#map")).height;

    chartContainer.querySelector(
      ".menu-title"
    ).innerHTML = `<span style="font-weight: 600;">${escapeHtml(name)}</span> <span class="genome-counter">- ${
      locationObj?.genomeCount ?? 0
    } Genomes</span>`;

    const chartBody = chartContainer.querySelector("#charts-body");

    chartBody.querySelectorAll(".chartSection").forEach((section) => {
      if (section._chartRenderer) {
        section._chartRenderer.destroy();
        section._chartRenderer = null;
      }
    });
    while (chartBody.firstChild) {
      chartBody.removeChild(chartBody.firstChild);
    }

    const primaryDimOptions = this.host.config.filters
      .filter(f => f.hasBarChart)
      .map(f => ({
        value: f.column,
        label: f.alias || f.column.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      }));

    const activeChartID =
      active || this.host.activeChartIDPreference || this.host.activeChartID || primaryDimOptions[0]?.value || null;

    const validActiveID = primaryDimOptions.find(opt => opt.value === activeChartID)
      ? activeChartID
      : primaryDimOptions[0]?.value || null;

    this.host.activeChartID = validActiveID;
    this.host.activeChartIDPreference = validActiveID;

    const activeFilter = this.host.config.filters.find(f => f.column === validActiveID);
    if (!activeFilter) return;

    const sectionContainer = document.createElement("div");
    sectionContainer.classList.add("chartSection", "active-chart");
    sectionContainer.id = "main-chart";
    sectionContainer.style.height = "100%";
    sectionContainer.dataset.primaryDim = validActiveID;
    chartBody.appendChild(sectionContainer);

    const chartTypes = Array.isArray(activeFilter.chartType)
      ? activeFilter.chartType
      : [activeFilter.chartType || "stackedBar"];

    const activeType = (this.host.activeChartType && chartTypes.includes(this.host.activeChartType))
      ? this.host.activeChartType
      : chartTypes[0];
    sectionContainer.dataset.activeChartType = activeType;

    this.host.activeChartType = activeType;

    this.renderChartInPanel(locationObj, activeFilter, sectionContainer);

    const primaryContainer = chartContainer.querySelector("#primary-dim-selector");
    if (primaryContainer) {
      primaryContainer.innerHTML = HTMLhelper.primaryDimensionSelector(
        primaryDimOptions,
        validActiveID
      );
    }

    if (chartContainer._bindPrimaryDimDropdown) {
      chartContainer._bindPrimaryDimDropdown();
    }

    if (chartContainer._updateChartTypeSelector) {
      chartContainer._updateChartTypeSelector();
    }
  }

  // --- Chart menu bindings ---

  bindChartMenu(signal) {
    const chartContainer = this.host.shadow.getElementById("charts");

    this._bindChartExpandCollapse(signal, chartContainer);
    this._bindChartMaximize(signal, chartContainer);
    this._bindChartDownload(signal, chartContainer);
    this._bindDimensionSelectors(signal, chartContainer);
    this._bindChartOptionsPanel(signal, chartContainer);
  }

  _bindChartExpandCollapse(signal, chartContainer) {
    const chartMaxMinBtn = chartContainer.querySelector("#chart-fullscreen-btn");

    chartContainer.querySelector("#charts-menu-chevron").addEventListener(
      "click",
      () => {
        if (chartContainer.classList.contains("collapsed")) {
          this.expandMenu(chartContainer);
        } else {
          if (chartContainer.classList.contains("maximized")) {
            const onTransitionEnd = (e) => {
              if (
                e.target === chartContainer &&
                (e.propertyName === "height" || e.propertyName === "width")
              ) {
                this.collapseMenu(chartContainer);
              }
            };
            chartContainer.addEventListener("transitionend", onTransitionEnd, {
              once: true,
            });

            const activeID = this.host.activeChartID ?? null;
            const location = chartContainer.getAttribute("locationKey") ?? null;
            this.minimizeMenu(chartContainer, activeID, location);
            chartMaxMinBtn.innerHTML = HTMLhelper.icons("maximize");

            const transitionDuration = getComputedStyle(chartContainer).transitionDuration;
            if (!transitionDuration || transitionDuration === "0s") {
              requestAnimationFrame(() => this.collapseMenu(chartContainer));
            }
          } else {
            this.collapseMenu(chartContainer);
          }
        }
      },
      { signal }
    );
  }

  _bindChartMaximize(signal, chartContainer) {
    const chartMaxMinBtn = chartContainer.querySelector("#chart-fullscreen-btn");

    chartMaxMinBtn.innerHTML = chartContainer.classList.contains("maximized")
      ? HTMLhelper.icons("minimize")
      : HTMLhelper.icons("maximize");

    chartMaxMinBtn.addEventListener(
      "click",
      () => {
        this.host.activeLocation = chartContainer.getAttribute("locationKey") ?? null;
        if (chartContainer.classList.contains("maximized")) {
          this.minimizeMenu(chartContainer);
          chartMaxMinBtn.innerHTML = HTMLhelper.icons("maximize");
        } else {
          this.maximizeMenu(chartContainer);
          chartMaxMinBtn.innerHTML = HTMLhelper.icons("minimize");
        }
      },
      { signal }
    );
  }

  _bindChartDownload(signal, chartContainer) {
    const chartDownloadBtn = chartContainer.querySelector("#chart-download-btn");

    chartDownloadBtn.addEventListener(
      "click",
      () => {
        const activeSection = this.host.shadowRoot.querySelector(".chartSection.active-chart");
        const chart = activeSection?._chartRenderer?.chartInstance;

        if (!chart) return;

        chart.update("none");
        if (confirm("Download this chart as .png?")) {
          this.downloadChartImage(chart, {
            format: "png",
            scale: 2,
            fileName: "my-chart",
            background: "#ffffff",
          });
        }
      },
      { signal }
    );
  }

  _getActivePrimaryDim(chartContainer) {
    const mainChart = chartContainer.querySelector("#main-chart");
    return mainChart?.dataset.primaryDim || this.host.activeChartID;
  }

  _getActiveFilterConfig(chartContainer) {
    const primaryDim = this._getActivePrimaryDim(chartContainer);
    return this.host.config.filters.find(f => f.column === primaryDim);
  }

  _getActiveChartType(chartContainer) {
    const mainChart = chartContainer.querySelector("#main-chart");
    if (mainChart?.dataset.activeChartType) {
      return mainChart.dataset.activeChartType;
    }

    const filterConfig = this._getActiveFilterConfig(chartContainer);
    if (filterConfig) {
      if (Array.isArray(filterConfig.chartType)) {
        return filterConfig.chartType[0];
      }
      return filterConfig.chartType || "stackedBar";
    }
    return "stackedBar";
  }

  _getActiveChartSection(chartContainer) {
    return chartContainer.querySelector("#main-chart");
  }

  _handlePrimaryDimChange(newPrimaryDim, chartContainer, updateChartTypeSelector) {
    const locationKey = chartContainer.getAttribute("locationKey");
    const locationObj = this.host.locationObjs[locationKey];
    if (!locationObj) return;

    this.host.activeChartID = newPrimaryDim;
    this.host.activeChartIDPreference = newPrimaryDim;

    const filterConfig = this.host.config.filters.find(f => f.column === newPrimaryDim);
    if (!filterConfig) return;

    const chartBody = chartContainer.querySelector("#charts-body");
    chartBody.querySelectorAll(".chartSection").forEach(section => {
      if (section._chartRenderer) {
        section._chartRenderer.destroy();
        section._chartRenderer = null;
      }
    });
    while (chartBody.firstChild) {
      chartBody.removeChild(chartBody.firstChild);
    }

    const sectionContainer = document.createElement("div");
    sectionContainer.classList.add("chartSection", "active-chart");
    sectionContainer.id = "main-chart";
    sectionContainer.style.height = "100%";
    sectionContainer.dataset.primaryDim = newPrimaryDim;
    chartBody.appendChild(sectionContainer);

    const chartTypes = Array.isArray(filterConfig.chartType)
      ? filterConfig.chartType
      : [filterConfig.chartType || "stackedBar"];

    const activeType = (this.host.activeChartType && chartTypes.includes(this.host.activeChartType))
      ? this.host.activeChartType
      : chartTypes[0];
    sectionContainer.dataset.activeChartType = activeType;

    this.host.activeChartType = activeType;

    this.renderChartInPanel(locationObj, filterConfig, sectionContainer);

    updateChartTypeSelector();
  }

  _bindDimensionSelectors(signal, chartContainer) {
    const updateSecondaryDimSelector = (chartType, filterConfig) => {
      const secondaryContainer = chartContainer.querySelector("#secondary-dim-selector");
      if (!secondaryContainer) return;

      const isTimeSeries = chartType === "lineGraph" || chartType === "stackedArea";

      if (isTimeSeries) {
        secondaryContainer.innerHTML = HTMLhelper.secondaryDimensionSelector(
          [{ value: "time", label: "Time" }],
          "time",
          true
        );
        secondaryContainer.style.display = "flex";
        return;
      }

      if (chartType === "stackedBar" && filterConfig?.hierarchicalOptions?.secondaryDimensions) {
        const secondaryDims = filterConfig.hierarchicalOptions.secondaryDimensions;

        const options = secondaryDims.map(dimName => {
          const dimConfig = this.host.config.filters?.find(f => f.column === dimName);
          return {
            value: dimName,
            label: dimConfig?.alias || dimName.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
          };
        });

        const activeSecondaryDim = this.host.userChartOptions?.secondaryDim || secondaryDims[0];

        secondaryContainer.innerHTML = HTMLhelper.secondaryDimensionSelector(
          options,
          activeSecondaryDim,
          false
        );
        secondaryContainer.style.display = "flex";

        const dropdown = secondaryContainer.querySelector("#secondary-dim-dropdown");
        if (dropdown) {
          dropdown.addEventListener("change", (e) => {
            const selectedDim = e.target.value;

            if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
              this.host.userChartOptions = this._getDefaultOptions();
            }
            this.host.userChartOptions.secondaryDim = selectedDim;

            const chartSection = this._getActiveChartSection(chartContainer);
            const locationKey = chartContainer.getAttribute("locationKey");
            const locationObj = this.host.locationObjs[locationKey];

            if (locationObj && chartSection) {
              this.renderChartInPanel(locationObj, filterConfig, chartSection);
            }
          }, { signal });
        }
        return;
      }

      secondaryContainer.style.display = "none";
      secondaryContainer.innerHTML = "";
    };

    const updateChartTypeSelector = () => {
      const selectorContainer = chartContainer.querySelector("#chart-type-selector");
      if (!selectorContainer) return;

      const filterConfig = this._getActiveFilterConfig(chartContainer);
      if (!filterConfig || !filterConfig.chartType) {
        selectorContainer.innerHTML = "";
        selectorContainer.style.display = "none";
        return;
      }

      const chartTypes = Array.isArray(filterConfig.chartType)
        ? filterConfig.chartType
        : [filterConfig.chartType];

      const mainChart = this._getActiveChartSection(chartContainer);
      const activeType = mainChart?.dataset.activeChartType || chartTypes[0];

      selectorContainer.innerHTML = HTMLhelper.chartTypeSelector(chartTypes, activeType);
      selectorContainer.style.display = "flex";

      selectorContainer.querySelectorAll("button[data-chart-type]").forEach((btn) => {
        btn.addEventListener(
          "click",
          () => {
            if (chartTypes.length === 1) return;

            const selectedType = btn.getAttribute("data-chart-type");
            const chartSection = this._getActiveChartSection(chartContainer);
            if (!chartSection) return;

            const locationKey = chartContainer.getAttribute("locationKey");

            chartSection.dataset.activeChartType = selectedType;
            this.host.activeChartType = selectedType;

            selectorContainer.querySelectorAll("button[data-chart-type]").forEach((b) => {
              b.classList.remove("active-chart-type");
            });
            btn.classList.add("active-chart-type");

            const locationObj = this.host.locationObjs[locationKey];
            if (locationObj) {
              this.renderChartInPanel(locationObj, filterConfig, chartSection);
              if (chartContainer._regenerateOptionsDropdown) {
                chartContainer._regenerateOptionsDropdown();
              }
              updateSecondaryDimSelector(selectedType, filterConfig);
            }
          },
          { signal }
        );
      });

      updateSecondaryDimSelector(activeType, filterConfig);
    };

    const bindPrimaryDimDropdown = () => {
      const primaryContainer = chartContainer.querySelector("#primary-dim-selector");
      const dropdown = primaryContainer?.querySelector("#primary-dim-dropdown");
      if (dropdown) {
        dropdown.addEventListener("change", (e) => {
          this._handlePrimaryDimChange(e.target.value, chartContainer, updateChartTypeSelector);
        }, { signal });
      }
    };

    bindPrimaryDimDropdown();
    updateChartTypeSelector();

    chartContainer._updateChartTypeSelector = updateChartTypeSelector;
    chartContainer._bindPrimaryDimDropdown = bindPrimaryDimDropdown;
  }

  _bindChartOptionsPanel(signal, chartContainer) {
    const optionsBtn = chartContainer.querySelector("button#chart-settings-btn");

    const showOptionsDropdown = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;
      optionsDropdown.style.display = "block";
      optionsDropdown.classList.add("open");
    };

    const hideOptionsDropdown = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;
      optionsDropdown.addEventListener(
        "transitionend",
        (e) => {
          if (e.target !== optionsDropdown || e.propertyName !== "opacity") return;
          optionsDropdown.style.display = "none";
        },
        { once: true }
      );
      optionsDropdown.classList.remove("open");
    };

    const toggleOptionsDropdown = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;
      const isOpen = optionsDropdown.classList.contains("open");
      if (isOpen) {
        hideOptionsDropdown();
      } else {
        showOptionsDropdown();
      }
      optionsBtn.classList.toggle("rotate");
    };

    const bindCloseButton = () => {
      const closeOptionsBtn = chartContainer.querySelector("button#close-chart-settings-btn");
      if (closeOptionsBtn) {
        const newBtn = closeOptionsBtn.cloneNode(true);
        closeOptionsBtn.parentNode.replaceChild(newBtn, closeOptionsBtn);
        newBtn.addEventListener("click", toggleOptionsDropdown, { signal });
      }
    };

    const bindOptionsInputs = () => {
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (!optionsDropdown) return;

      optionsDropdown.querySelectorAll("input").forEach((input) => {
        const newInput = input.cloneNode(true);
        input.parentNode.replaceChild(newInput, input);

        newInput.addEventListener(
          "change",
          () => {
            this._updateChartOptionsFromForm(chartContainer);
            const locationKey = chartContainer.getAttribute("locationKey");
            try {
              this.host.activeLocation = locationKey;
              this.host.createCharts(this.host.locationObjs[locationKey], locationKey, this.host.activeChartID);
            } catch (err) {
              console.error("Failed to update charts after options change:", err);
            }
          },
          { signal }
        );
      });

      bindCloseButton();
    };

    const regenerateOptionsDropdown = () => {
      if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
        this.host.userChartOptions = this._getDefaultOptions();
      }

      const optionsBodyInnerHtml = HTMLhelper.chartOptions(this.host.userChartOptions);
      const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
      if (optionsDropdown) {
        const wasOpen = optionsDropdown.classList.contains("open");
        optionsDropdown.innerHTML = optionsBodyInnerHtml;
        bindOptionsInputs();
        if (wasOpen) {
          optionsDropdown.classList.add("open");
        }
      }
    };

    chartContainer._regenerateOptionsDropdown = regenerateOptionsDropdown;

    regenerateOptionsDropdown();
    optionsBtn.addEventListener("click", toggleOptionsDropdown, { signal });
    bindCloseButton();
    this._updateChartOptionsFromForm(chartContainer);
  }

  _updateChartOptionsFromForm(chartContainer) {
    const optionsDropdown = chartContainer.querySelector("#chart-settings-dropdown");
    if (!optionsDropdown) return;

    if (!this.host.userChartOptions || Object.keys(this.host.userChartOptions).length === 0) {
      this.host.userChartOptions = this._getDefaultOptions();
    }

    const updatedOptions = { ...this.host.userChartOptions };

    optionsDropdown.querySelectorAll("input").forEach((input) => {
      if (input.checked) {
        const categoryID = input.parentElement.parentElement.parentElement.id;
        switch (categoryID) {
          case "yAxis-mode":
            updatedOptions.yAxis = input.value;
            break;
          case "sort-mode":
            updatedOptions.sort = input.value;
            break;
          case "data-set-mode":
            updatedOptions.dataMode = input.value;
            break;
          case "timeSeries-mode":
            updatedOptions.timeSeriesMode = input.value;
            break;
          case "lineSelection-mode":
            updatedOptions.lineSelection = input.value;
            break;
        }
      }
    });

    this.host.userChartOptions = updatedOptions;
  }

  destroy() {
    this.host._maxChartsRO?.disconnect?.();
    this.host._maxChartsRO = null;
    if (this.host._onMaxChartsWinResize) {
      window.removeEventListener("resize", this.host._onMaxChartsWinResize);
      this.host._onMaxChartsWinResize = null;
    }
    this.host._reflowMaxCharts = null;

    if (this.host._activeCharts) {
      for (const chart of Object.values(this.host._activeCharts)) {
        chart?.destroy?.();
      }
      this.host._activeCharts = {};
    }
  }
}
