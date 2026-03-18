import { HTMLhelper, escapeHtml, escapeAttr } from "../utils/HTMLHelper.js";
import { hexToRgba } from "../utils/domUtils.js";

export class FilterMenuManager {
  constructor(host) {
    this.host = host;
  }

  generateMenu() {
    this.host._menuAbort?.abort();
    this.host._menuAbort = new AbortController();
    const { signal } = this.host._menuAbort;

    const activeFilterSummary = this._summarizeActiveFilters();
    this._renderMenuUI(activeFilterSummary);
    this.updateTaxonomyHint();

    this._hydrateSectionCounters(activeFilterSummary);

    this._bindFilterCheckboxes(signal);
    this._bindDateWidget(signal);
    this._bindSidebarToggles(signal);
    this.host._chartPanel.bindChartMenu(signal);
    this._bindDataDownload(signal);

    this.updateFilterValueCounters();
  }

  _renderMenuUI(summary) {
    const menuContainer = this.host.shadow.getElementById("menu");
    const filterSections = this._buildFilterSectionsConfig();

    menuContainer.innerHTML = HTMLhelper.menuStructure(
      filterSections,
      summary.total
    );
  }

  _buildFilterSectionsConfig() {
    const isChecked = (section, value) => {
      if (
        this.host.dataLoader.getActiveFilters()[section] &&
        this.host.dataLoader.getActiveFilters()[section].has(value)
      ) {
        return true;
      }
      return false;
    };
    let filterSections = [];

    for (let section in this.host.availableFilters) {
      const sectionConfig = this.host.config.filters.find(
        (filter) => filter.column === section
      );

      let htmlString = "";
      if (sectionConfig.hasDropdown) {
        this.host.availableFilters[section].sort((a, b) => {
          a = a.toString();
          b = b.toString();
          const aIsUnknown = a.toLowerCase() === "unknown";
          const bIsUnknown = b.toLowerCase() === "unknown";

          if (aIsUnknown && !bIsUnknown) return -1;
          if (!aIsUnknown && bIsUnknown) return 1;
          return a.localeCompare(b, "en", { sensitivity: "base" });
        });
        if (sectionConfig.specialType === null) {
          for (let i in this.host.availableFilters[section]) {
            let value = this.host.availableFilters[section][i];
            const checked = isChecked(section, value);
            const filterRow = HTMLhelper.filterRow(section, value, i, checked);
            htmlString += filterRow;
          }
        } else if (sectionConfig.specialType === "date") {
          const filters = this.host.dataLoader.getActiveFilters();

          const fmtDate = (d) => {
            if (!(d instanceof Date)) return "";
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, "0");
            const dd = String(d.getDate()).padStart(2, "0");
            return `${yyyy}/${mm}/${dd}`;
          };

          const startDateStr = fmtDate(filters?.["date-start"]);
          const endDateStr = fmtDate(filters?.["date-end"]);

          htmlString = HTMLhelper.dateSelectionWidget(startDateStr, endDateStr);
        }
        filterSections.push({
          name: sectionConfig.alias,
          column: section,
          string: htmlString,
          icon: sectionConfig.svgIcon,
          searchable: sectionConfig.searchable ?? false,
          scrollable: sectionConfig.specialType === "date" ? false : true,
        });
      }
    }
    return filterSections;
  }

  updateTaxonomyHint() {
    const speciesMeta = this.host.dataLoader.meta.groups?.species;
    const uniqueSpecies = speciesMeta?.unique ?? new Set();
    const firstSpecies = uniqueSpecies.values().next().value ?? "";
    const hintEl = this.host.shadow.getElementById("taxonomy-hint");
    if (hintEl) {
      const rest = uniqueSpecies.size - 1;
      hintEl.innerHTML =
        rest > 0
          ? `Showing <span class="italic">${escapeHtml(firstSpecies)}</span> +${rest} others...`
          : `Showing <span class="italic">${escapeHtml(firstSpecies)}</span>`;
    }
  }

  _bindFilterCheckboxes(signal) {
    const menuContainer = this.host.shadow.getElementById("menu");
    const checkboxes = menuContainer.querySelectorAll(".form-check-input");
    const totalFilterCounter = menuContainer.querySelector("#total-filter-count");

    checkboxes.forEach((checkbox) => {
      checkbox.addEventListener(
        "change",
        (e) => {
          let checkbox = e.currentTarget;
          let type = checkbox.getAttribute("filter-type");
          const menuHeader =
            checkbox.parentElement.parentElement.parentElement.querySelector(
              ".menu-section-header"
            );
          let sectionFilterCounter = menuHeader.querySelector(
            ".section-filter-count"
          );
          sectionFilterCounter.style.backgroundColor = hexToRgba(
            this.host.config.filters.find((obj) => obj.column === type).chartColors
              .general[0],
            0.7
          );
          if (checkbox.checked) {
            this.host.dataLoader.addFilter(type, checkbox.value);
            totalFilterCounter.textContent =
              Number(totalFilterCounter.textContent) + 1;
            sectionFilterCounter.textContent =
              Number(sectionFilterCounter.textContent) + 1;
            sectionFilterCounter.classList.remove("hide");
          } else {
            this.host.dataLoader.removeFilter(type, checkbox.value);
            totalFilterCounter.textContent =
              Number(totalFilterCounter.textContent) - 1;
            sectionFilterCounter.textContent =
              Number(sectionFilterCounter.textContent) - 1;
            if (Number(sectionFilterCounter.textContent) === 0) {
              sectionFilterCounter.classList.add("hide");
            }
          }

          this.host.reload({
            reloadMenu: false,
            focusID: this.host.activeChartID,
            focusLocation: this.host.activeLocation,
          });
        },
        { signal }
      );
    });
  }

  _bindDateWidget(signal) {
    const menuContainer = this.host.shadow.getElementById("menu");

    const startInput = menuContainer.querySelector(
      'input.date-text-input[filter-type="date-start"]'
    );
    const endInput = menuContainer.querySelector(
      'input.date-text-input[filter-type="date-end"]'
    );

    const errorEl = menuContainer.querySelector("#dw-error");

    const applyDateRange = () => {
      if (!startInput || !endInput) return;

      const filters = this.host.dataLoader.getActiveFilters();

      const rawStart = startInput.value.trim();
      const rawEnd = endInput.value.trim();

      const hasStart = rawStart.length > 0;
      const hasEnd = rawEnd.length > 0;

      const startDate = hasStart ? this._validateDate(rawStart, "start") : null;
      const endDate = hasEnd ? this._validateDate(rawEnd, "end") : null;

      [startInput, endInput].forEach((el) =>
        el.classList.remove("invalid-date")
      );
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hide");
      }

      let hasError = false;
      if (hasStart && !startDate) {
        startInput.classList.add("invalid-date");
        hasError = true;
      }
      if (hasEnd && !endDate) {
        endInput.classList.add("invalid-date");
        hasError = true;
      }
      if (hasError) {
        if (errorEl) {
          errorEl.textContent = "Enter dates as YYYY/MM/DD or YYYY.";
          errorEl.classList.remove("hide");
        }
        return;
      }

      if (startDate && endDate && startDate > endDate) {
        startInput.classList.add("invalid-date");
        endInput.classList.add("invalid-date");
        if (errorEl) {
          errorEl.textContent =
            "Start date must be before or equal to the end date.";
          errorEl.classList.remove("hide");
        }
        return;
      }

      if (filters["date-start"]) {
        this.host.dataLoader.removeFilter("date-start");
      }
      if (filters["date-end"]) {
        this.host.dataLoader.removeFilter("date-end");
      }

      if (startDate) {
        this.host.dataLoader.addFilter("date-start", startDate, "date");
      }
      if (endDate) {
        this.host.dataLoader.addFilter("date-end", endDate, "date");
      }

      if (!startDate && !endDate && errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hide");
      }

      this.host.reload({
        reloadMenu: false,
        focusID: this.host.activeChartID,
        focusLocation: this.host.activeLocation ?? "global",
      });
    };

    [startInput, endInput].forEach((input) => {
      if (!input) return;
      input.addEventListener("change", applyDateRange, { signal });
    });
  }

  _validateDate(raw, role = "start") {
    const dateString = String(raw || "").trim();
    if (dateString.length < 4) return false;

    const yearOnlyPattern = /^(\d{4})$/;
    const yearMonthDayPattern = /^(\d{4})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/;

    let match;
    if ((match = dateString.match(yearOnlyPattern))) {
      const year = +match[1];
      if (role === "end") {
        return new Date(year, 11, 31);
      }
      return new Date(year, 0, 1);
    }

    if ((match = dateString.match(yearMonthDayPattern))) {
      const year = +match[1];
      const month = +match[2];
      const day = +match[3];

      const daysInMonth = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
      ];

      if (day >= 1 && day <= daysInMonth[month - 1]) {
        return new Date(year, month - 1, day);
      }
    }

    return false;
  };

  _bindSidebarToggles(signal) {
    const menuSearchFunction = function () {
      const filterContainer = this.parentNode;
      const searchTerm = this.value.toLowerCase();

      const checkboxes = filterContainer.querySelectorAll(".form-check");
      checkboxes.forEach((box) => {
        let labelElement = box.querySelector(".form-check-label");
        let labelText = labelElement.textContent.toLowerCase();
        let checkboxElement = box.querySelector(".form-check-input");
        if (!labelText.includes(searchTerm)) {
          labelElement.style.display = "none";
          checkboxElement.style.display = "none";
          box.style.height = "0px";
          box.style.minHeight = "0px";
          box.setAttribute("style", "display: none !important");
        } else {
          labelElement.style.display = "";
          checkboxElement.style.display = "";
          box.style.height = "";
          box.style.display = "";
        }
      });
    };
    const menuContainer = this.host.shadow.getElementById("menu");
    const chartContainer = this.host.shadow.getElementById("charts");

    const sidebarContainer = menuContainer.querySelector("div#sidebar-menu-group");

    const clearAllFilters = () => {
      const totalFilterCounter = menuContainer.querySelector("#total-filter-count");
      for (let filter of Object.keys(this.host.dataLoader.activeFilters)) {
        delete this.host.dataLoader.activeFilters[filter];
        sidebarContainer.querySelectorAll(".date-text-input").forEach(input => {
          input.value = "";
        });
      }
      totalFilterCounter.textContent = 0;
      sidebarContainer
        .querySelectorAll(".section-filter-count")
        .forEach((counter) => {
          counter.textContent = 0;
          counter.classList.add("hide");
        });
      sidebarContainer
        .querySelectorAll("input.form-check-input")
        .forEach((checkbox) => {
          checkbox.checked = false;
        });
      this.host.reload({
        reloadMenu: false,
        focusID: this.host.activeChartID,
        focusLocation: this.host.activeLocation,
      });
    };

    sidebarContainer
      .querySelector(".clear-btn")
      .addEventListener("click", clearAllFilters, { signal });

    menuContainer
      .querySelectorAll(".menu-section input.menu-section-search")
      .forEach(function (section) {
        section.addEventListener("input", menuSearchFunction, { signal });
      });

    const showFiltersBtn = menuContainer.querySelector("#show-filters-button");

    showFiltersBtn.addEventListener(
      "click",
      () => {
        const toggleSidebar = () => {
          sidebarContainer.classList.toggle("open");

          sidebarContainer
            .querySelector(".menu-content")
            ?.classList.toggle("invisible");
          sidebarContainer
            .querySelector(".clear-btn")
            ?.classList.toggle("invisible");
          const totalFilterCounter = menuContainer.querySelector(
            "#total-filter-count"
          );
          if (totalFilterCounter) {
            const count = Number(totalFilterCounter.textContent || "0");
            if (sidebarContainer.classList.contains("open")) {
              totalFilterCounter.classList.add("hide");
            } else if (count !== 0) {
              totalFilterCounter.classList.remove("hide");
            }
          }

          const topLine = showFiltersBtn.querySelector("line.top");
          const bottomLine = showFiltersBtn.querySelector("line.bottom");
          showFiltersBtn.classList.toggle("filter-active");
          if (topLine && bottomLine) {
            const y1Top = parseFloat(topLine.getAttribute("y1") || "0");
            const y1Bottom = parseFloat(bottomLine.getAttribute("y1") || "0");
            const translation = (y1Bottom - y1Top) / 2;
            if (showFiltersBtn.classList.contains("filter-active")) {
              requestAnimationFrame(() => {
                topLine.setAttribute(
                  "transform",
                  `rotate(45) translate(0, ${translation})`
                );
                bottomLine.setAttribute(
                  "transform",
                  `rotate(-45) translate(0, -${translation})`
                );
                bottomLine.setAttribute("x1", "0");
                bottomLine.setAttribute("x2", "40");
              });
            } else {
              requestAnimationFrame(() => {
                topLine.setAttribute("transform", "rotate(0) translate(0, 0)");
                bottomLine.setAttribute(
                  "transform",
                  "rotate(0) translate(0, 0)"
                );
                bottomLine.setAttribute("x1", "15");
                bottomLine.setAttribute("x2", "25");
              });
            }
          }
        };

        if (
          chartContainer.classList.contains("maximized") &&
          this.host._reflowMaxCharts
        ) {
          let running = true;
          const tick = () => {
            if (!running) return;
            this.host._reflowMaxCharts();
            requestAnimationFrame(tick);
          };
          const stop = () => {
            running = false;
            this.host._reflowMaxCharts();
          };

          requestAnimationFrame(tick);
          const stopOnce = () => {
            stop();
            sidebarContainer.removeEventListener("transitionend", stopOnce);
            sidebarContainer.removeEventListener("transitioncancel", stopOnce);
          };
          sidebarContainer.addEventListener("transitionend", stopOnce, {
            signal,
            once: true,
          });
          sidebarContainer.addEventListener("transitioncancel", stopOnce, {
            signal,
            once: true,
          });
        }

        toggleSidebar();
      },
      { signal }
    );

    const sectionHeader = menuContainer.querySelectorAll("div.menu-section-header");

    sectionHeader.forEach((section) =>
      section.querySelector(".chevron").addEventListener(
        "click",
        () => {
          sectionHeader.forEach((otherSection) => {
            if (
              section !== otherSection &&
              otherSection.parentElement.classList.contains("menu-opened")
            ) {
              otherSection.parentElement.classList.toggle("menu-opened");
              otherSection.classList.toggle("flip");
            }
          });
          section.parentElement.classList.toggle("menu-opened");
          section.classList.toggle("flip");
        },
        { signal }
      )
    );
  }

  _bindDataDownload(signal) {
    const headerSection = this.host.shadow.getElementById("header-area");
    const downloadATag = headerSection.querySelector("#download-data-btn");

    downloadATag.addEventListener(
      "click",
      (event) => {
        if (!downloadATag.confirmed) {
          const csvBlob = this.host.dataLoader.getAllDataBlob();
          const sizeInBytes = csvBlob.size;

          const formatSize = (bytes) => {
            if (bytes < 1024) return `${bytes} bytes`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
          };

          const readableSize = formatSize(sizeInBytes);
          const userConfirmed = confirm(
            `This download will be approximately ${readableSize}. Do you want to continue?`
          );

          if (userConfirmed) {
            const url = URL.createObjectURL(csvBlob);
            downloadATag.href = url;
            downloadATag.download = "data.csv";
          } else {
            event.preventDefault();
            return;
          }
        }
      },
      { signal }
    );
  }

  _summarizeActiveFilters() {
    const dateFilterColumnName = this.host.config.filters.find(
      (filter) => filter.specialType === "date"
    )?.column;
    const summary = { total: 0, perSection: {} };
    const activeFilters = this.host.dataLoader.getActiveFilters() ?? {};

    const pushCount = (sectionKey, count) => {
      if (!sectionKey || count === 0) return;
      summary.perSection[sectionKey] =
        (summary.perSection[sectionKey] ?? 0) + count;
      summary.total += count;
    };

    for (const [type, values] of Object.entries(activeFilters)) {
      let count = 0;
      if (values instanceof Set) {
        count = values.size;
      } else if (values instanceof Date) {
        count = 1;
      } else if (Array.isArray(values)) {
        count = values.length;
      } else if (values != null) {
        count = 1;
      }

      if (count === 0) continue;

      const sectionKey =
        type === "date-start" || type === "date-end"
          ? dateFilterColumnName
          : type;
      pushCount(sectionKey, count);
    }

    return summary;
  }

  _hydrateSectionCounters(activeFilterSummary) {
    const menuContainer = this.host.shadow?.getElementById("menu");
    const sidebarContainer = menuContainer.querySelector("div#sidebar-menu-group");

    const totalFilterCounter = menuContainer.querySelector("#total-filter-count");
    if (totalFilterCounter) {
      totalFilterCounter.textContent = activeFilterSummary.total;
      totalFilterCounter.classList.toggle(
        "hide",
        activeFilterSummary.total === 0
      );
    }

    if (!sidebarContainer) return;

    sidebarContainer.querySelectorAll(".menu-section").forEach((section) => {
      const columnKey = section.dataset.filterColumn;
      if (!columnKey) return;

      const sectionCounter = section.querySelector(".section-filter-count");
      if (!sectionCounter) return;

      const count = activeFilterSummary.perSection[columnKey] ?? 0;
      sectionCounter.textContent = count;
      if (count > 0) {
        sectionCounter.classList.remove("hide");
        const sectionConfig = this.host.config.filters.find(
          (filter) => filter.column === columnKey
        );
        const baseColor = sectionConfig?.chartColors?.general?.[0] ?? "#000000";
        sectionCounter.style.backgroundColor = hexToRgba(baseColor, 0.7);
      } else {
        sectionCounter.classList.add("hide");
      }
    });
  }

  updateFilterValueCounters() {
    const menuContainer = this.host.shadow?.getElementById("menu");
    if (!menuContainer || !this.host.dataLoader?.getFilterValueCounts) return;

    const countsByType = this.host.dataLoader.getFilterValueCounts() ?? {};

    const formatCount = (value) => {
      const numeric = typeof value === "number" ? value : 0;
      try {
        return this.host._countFormatter?.format(numeric) ?? String(numeric);
      } catch (err) {
        console.warn("Number formatter failed, using fallback:", err);
        return String(numeric);
      }
    };

    menuContainer.querySelectorAll(".form-check-input").forEach((checkbox) => {
      const counterEl = checkbox
        .closest(".form-check")
        ?.querySelector(".filter-option-count");
      if (!counterEl) return;
      const type = checkbox.getAttribute("filter-type");
      const valueKey = checkbox.value ?? "";
      const count = countsByType?.[type]?.[valueKey] ?? 0;
      counterEl.textContent = formatCount(count);
      counterEl.dataset.count = String(count);
      counterEl.setAttribute(
        "aria-label",
        `${count} matching genome${count === 1 ? "" : "s"}`
      );
    });
  }

  destroy() {
    this.host._menuAbort?.abort();
  }
}
