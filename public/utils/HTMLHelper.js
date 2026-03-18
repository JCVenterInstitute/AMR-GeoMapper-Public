import mainStyles from "../styles/main.css";
import bootstrapStyles from "../styles/bootstrap-minimal.css";

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for HTML insertion
 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes a string for use in HTML attributes.
 * Same as escapeHtml but exported separately for clarity.
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for attribute values
 */
function escapeAttr(str) {
  return escapeHtml(str);
}

class HTMLhelper {
  constructor() {}

  static color = {
    textDefault: "#000",
    menuBG: "#f8f9fa",
    chartSettingsBG: "#fff",
    chartSettingsText: "#000",
    modalBG: "#fff",
    filterMenuSectionBG: "#fff",
    whiteBtnHover: "#f3f4f6",
    scrollThumbFill: "#adb5bd",
    headerBorder: "#929292",
  };

  static styleSheets() {
    return /*html*/ `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&icon_names=vaccines" />
    `;
  }

  static styleTag() {
    return /*html*/ `
      <style>${bootstrapStyles}${mainStyles}</style>
    `;
  }

  static menuHeader(title, id, filterCount = 0) {
    let button;
    let filterCounter;
    const filterIconHeight = 20;
    const safeId = escapeAttr(id);
    if (id === "filter") {
      button = /*html*/ `
      <div id="sidebar-menu-control-group">
        <button id="show-filters-button" class="sidebar-btn" data-placement="right" data-tooltip="Filter menu">
          <div class="icon" id="filterToggle">
          ${HTMLhelper.icons("filter", filterIconHeight)}

          </div>
        </button>
      </div>

      `;
      filterCounter = /*html*/ `
          <div id="total-filter-count" class="filter-counter ${
            filterCount === 0 ? "hide" : ""
          }">
            ${filterCount}
          </div>
        `;
    } else {
      button = /*html*/ `
        <button id="chart-fullscreen-btn" class="chart-toolbar-btn" data-placement="bottom" data-tooltip="Maximize chart to view all data"></button>

        <button id="${safeId}-menu-chevron" class="p-0 chevron-button justify-content-center align-items-center">
          <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f">
            <g transform="rotate(90, 480, -480)">
              <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z"/>
            </g>
          </svg>
        </button>
      `;
    }

    return /*html*/ `
          <div
            id="menu-header"
            class="d-flex flex-row justify-content-between align-items-center"
          >
            <div class="menu-title mb-0"><h2>${escapeHtml(title)}</h2></div>
            <div class="d-flex justify-content-center align-items-center">
              ${filterCounter ? filterCounter : ""}

              
              <div id="charts-header-btns" class="">  
                ${button}
              </div>
            </div>
          </div>
        `;
  }

  static template() {
    const toolbarHintIconSize = 20;
    return /*html*/ `
      ${HTMLhelper.styleSheets()} ${HTMLhelper.styleTag()}
      <div class="h-100 border map-wrap">

        <div class="backdrop" aria-hidden="true"></div>

        <div id="load-animation">
          <div class="loader"></div>
        </div>

        <form id="dataForm" class="" method="POST">
          <div class="modal" aria-hidden="true">
            <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
              <div class="header">
                <div class="title-block">
                  <h1 class="title" id="dlg-title">Genome Selection</h1>
                  <button class="close" type="button" aria-label="Close">✕</button>
                </div>          
                <div id="msgBanner" class="me-2">
                  <p></p>
                </div>
              </div>
              <div id="taxonomyModalBody"></div>
              <div class="footer">
                <div id="" class="taxon-modal-footer-group d-flex align-items-center">
     
                </div>
                <div id="footer-buttons" class="taxon-modal-footer-group">
                  <button type="button" id="clearBtn" data-placement="bottom" data-tooltip="Clear current selection.">Clear All</button>
                  <button type="submit" id="loadBtn">Display Selection</button>
                </div>
              </div>
            </div>
          </div>
        </form>

       
        <div id="app-surface" class="d-flex flex-column w-100 h-100 position-relative">
          <section id="header-area">
            
          </section>
          <section id="map-area" class="position-relative">
            <div id="menu" class="menu-container center z-3"></div>
            <div
              id="charts"
              class="charts-container menu-container collapsed collapsible"
            >
              <div class="menu-box shadow">
                ${HTMLhelper.menuHeader("Charts", "charts")}
                <div id="chartContent" class="">
                  <div id="chart_and_toolbar">
                    <div id="charts-body">${HTMLhelper.chartOptions()}</div>
                    <div id="charts-toolbar">
                      <div id="toolbar-buttons" class="toolbar-group">
                        <div class="toolbar-sub-group">
                          <button
                            id="chart-settings-btn"
                            class="chart-toolbar-btn"
                            data-placement="bottom"
                            data-tooltip="Chart settings"
                          >
                            ${HTMLhelper.icons("settingsCog")}
                          </button>
                          <div id="chart-settings-dropdown" class="shadow-normal"></div>
                          <button
                            id="chart-download-btn"
                            class="chart-toolbar-btn"
                            data-placement="bottom"
                            data-tooltip="Download chart as image"
                          >
                            ${HTMLhelper.icons("download")}
                          </button>
                        </div>
                        <div class="toolbar-sub-group">
                          <div id="chart-type-selector"></div>
                        </div>
                        <div id="dimension-selectors" class="toolbar-sub-group">
                          <div id="primary-dim-selector"></div>
                          <div id="secondary-dim-selector"></div>
                        </div>
                      </div>

                      <div id="toolbar-hint" class="toolbar-group">
                        Click
                        <span style="margin: 0 3px"
                          >${HTMLhelper.icons("maximize", toolbarHintIconSize)}</span
                        >
                        above to view all data.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div id="map" class="w-100"></div>
          </section>

        </div>
      </div>
      ${HTMLhelper.scriptTag()}
      `;
  }
  static scriptTag() {
    return /*html*/ `
        <script
            async
            src="https://cdn.jsdelivr.net/npm/es-module-shims@1/dist/es-module-shims.min.js"
            crossorigin="anonymous"
        ></script>

      `;
  }

  static filterRow(section, value, index, isChecked) {
    const safeSection = escapeAttr(section);
    const safeValue = escapeAttr(value);
    return /*html*/ `
      <div class="form-check d-flex flex-row justify-content-start w-100 text-break">
        <input class="form-check-input" filter-type="${safeSection}" value="${safeValue}"
        type="checkbox" id="${safeSection}-option-${index}" ${
          isChecked ? "checked" : ""
        } />
        <label class="form-check-label ${
          section === "species" ? "italic" : ""
        }" for="${safeSection}-option-${index}">${escapeHtml(value)}</label>
        <span class="filter-option-count" data-count="0">0</span>
      </div>
          `;
  }

  static icons(key, height = 24) {
    switch (key) {
      case "download":
        return /*html*/ `
        <svg
          xmlns="http://www.w3.org/2000/svg"
          height="${height}px"
          viewBox="0 -960 960 960"
          width="${height}px"
          fill="#1f1f1f"
        >
          <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z" />
        </svg>`;

      case "settingsCog":
        return /*html*/ `
          <svg id="chart-settings-svg" style="max-height: 20px;" xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z"/></svg>
        `;

      case "filter":
        return /*html*/ `
          <svg width="${height}px" height="${height}px" viewBox="0 0 40 40">
            <line class="top" x1="0" y1="7" x2="40" y2="7" />
            <line class="middle" x1="8" y1="20" x2="32" y2="20" />
            <line class="bottom" x1="15" y1="33" x2="25  " y2="33" />
          </svg>  
        `;
      case "nofilter":
        return /*html*/ `
<svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M791-55 55-791l57-57 736 736-57 57ZM633-440l-80-80h167v80h-87ZM433-640l-80-80h487v80H433Zm-33 400v-80h160v80H400ZM240-440v-80h166v80H240ZM120-640v-80h86v80h-86Z"/></svg>
        `;
      case "edit":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/></svg>
        `;
      case "share":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M680-80q-50 0-85-35t-35-85q0-6 3-28L282-392q-16 15-37 23.5t-45 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q24 0 45 8.5t37 23.5l281-164q-2-7-2.5-13.5T560-760q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-24 0-45-8.5T598-672L317-508q2 7 2.5 13.5t.5 14.5q0 8-.5 14.5T317-452l281 164q16-15 37-23.5t45-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Zm0-80q17 0 28.5-11.5T720-200q0-17-11.5-28.5T680-240q-17 0-28.5 11.5T640-200q0 17 11.5 28.5T680-160ZM200-440q17 0 28.5-11.5T240-480q0-17-11.5-28.5T200-520q-17 0-28.5 11.5T160-480q0 17 11.5 28.5T200-440Zm480-280q17 0 28.5-11.5T720-760q0-17-11.5-28.5T680-800q-17 0-28.5 11.5T640-760q0 17 11.5 28.5T680-720Zm0 520ZM200-480Zm480-280Z"/></svg>
        `;
      case "info":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M440-280h80v-240h-80v240Zm40-320q17 0 28.5-11.5T520-640q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640q0 17 11.5 28.5T480-600Zm0 520q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>
        `;
      case "maximize":
        return /*html*/ `
          <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z"/></svg>
          `;
      case "minimize":
        return /*html*/ `
          <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="#1f1f1f"><path d="M240-120v-120H120v-80h200v200h-80Zm400 0v-200h200v80H720v120h-80ZM120-640v-80h120v-120h80v200H120Zm520 0v-200h80v120h120v80H640Z"/></svg>
        `;
      case "stackedBar":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M160-160v-440h160v440H160Zm0-480v-160h160v160H160Zm240 480v-320h160v320H400Zm0-360v-160h160v160H400Zm240 360v-200h160v200H640Zm0-240v-160h160v160H640Z"/></svg>
        `;
      case "lineGraph":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="m140-100-60-60 300-300 160 160 284-320 56 56-340 384-160-160-240 240Zm0-240-60-60 300-300 160 160 284-320 56 56-340 384-160-160-240 240Z"/></svg>
        `;
      case "stackedArea":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M120-160v-520l160 120 200-280 200 160h160v520H120Zm200-120 160-220 280 218v-318H652L496-725 298-447l-98-73v144l120 96Z"/></svg>
        `;
      case "plus":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="currentColor"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>
        `;
      case "close":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 -960 960 960" width="${height}px" fill="currentColor"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>
        `;

      case "github":
        return /*html*/ `
        <svg xmlns="http://www.w3.org/2000/svg" height="${height}px" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M237.9 461.4C237.9 463.4 235.6 465 232.7 465C229.4 465.3 227.1 463.7 227.1 461.4C227.1 459.4 229.4 457.8 232.3 457.8C235.3 457.5 237.9 459.1 237.9 461.4zM206.8 456.9C206.1 458.9 208.1 461.2 211.1 461.8C213.7 462.8 216.7 461.8 217.3 459.8C217.9 457.8 216 455.5 213 454.6C210.4 453.9 207.5 454.9 206.8 456.9zM251 455.2C248.1 455.9 246.1 457.8 246.4 460.1C246.7 462.1 249.3 463.4 252.3 462.7C255.2 462 257.2 460.1 256.9 458.1C256.6 456.2 253.9 454.9 251 455.2zM316.8 72C178.1 72 72 177.3 72 316C72 426.9 141.8 521.8 241.5 555.2C254.3 557.5 258.8 549.6 258.8 543.1C258.8 536.9 258.5 502.7 258.5 481.7C258.5 481.7 188.5 496.7 173.8 451.9C173.8 451.9 162.4 422.8 146 415.3C146 415.3 123.1 399.6 147.6 399.9C147.6 399.9 172.5 401.9 186.2 425.7C208.1 464.3 244.8 453.2 259.1 446.6C261.4 430.6 267.9 419.5 275.1 412.9C219.2 406.7 162.8 398.6 162.8 302.4C162.8 274.9 170.4 261.1 186.4 243.5C183.8 237 175.3 210.2 189 175.6C209.9 169.1 258 202.6 258 202.6C278 197 299.5 194.1 320.8 194.1C342.1 194.1 363.6 197 383.6 202.6C383.6 202.6 431.7 169 452.6 175.6C466.3 210.3 457.8 237 455.2 243.5C471.2 261.2 481 275 481 302.4C481 398.9 422.1 406.6 366.2 412.9C375.4 420.8 383.2 435.8 383.2 459.3C383.2 493 382.9 534.7 382.9 542.9C382.9 549.4 387.5 557.3 400.2 555C500.2 521.8 568 426.9 568 316C568 177.3 455.5 72 316.8 72zM169.2 416.9C167.9 417.9 168.2 420.2 169.9 422.1C171.5 423.7 173.8 424.4 175.1 423.1C176.4 422.1 176.1 419.8 174.4 417.9C172.8 416.3 170.5 415.6 169.2 416.9zM158.4 408.8C157.7 410.1 158.7 411.7 160.7 412.7C162.3 413.7 164.3 413.4 165 412C165.7 410.7 164.7 409.1 162.7 408.1C160.7 407.5 159.1 407.8 158.4 408.8zM190.8 444.4C189.2 445.7 189.8 448.7 192.1 450.6C194.4 452.9 197.3 453.2 198.6 451.6C199.9 450.3 199.3 447.3 197.3 445.4C195.1 443.1 192.1 442.8 190.8 444.4zM179.4 429.7C177.8 430.7 177.8 433.3 179.4 435.6C181 437.9 183.7 438.9 185 437.9C186.6 436.6 186.6 434 185 431.7C183.6 429.4 181 428.4 179.4 429.7z"/></svg>
        `;
      default:
        return "";
    }
  }

  static headerArea(firstSpecies, additionalSpeciesCount = 0) {
    let selectedHint = `Showing <span class="italic">${escapeHtml(firstSpecies)}</span>`;
    if (additionalSpeciesCount > 0) {
      selectedHint += ` +${additionalSpeciesCount} others...`;
    }

    return /*html*/ `
      <div id="taxonomy-selector-header-group">
        <h1>AMR GeoMapper <span style="color: red;">BETA</span></h1>
        <div id="taxonomy-hint-group">
          <p id="taxonomy-hint" class="">
            ${selectedHint}
          </p>
          <button id="openTaxonModal" class="header-btn" data-placement="bottom" data-tooltip="Load new data">${HTMLhelper.icons(
            "edit",
          )}</button>
        </div>
      </div>
      <div id="header-additional-btns">
        <a id="download-data-btn" class="header-btn" data-placement="bottom" data-tooltip="Download raw map data as .csv">${HTMLhelper.icons(
          "download",
        )}</a>

        <a id="github-button" class="header-btn" href="https://github.com/JCVenterInstitute/AMR-GeoMapper" data-tooltip="Project GitHub">
          ${HTMLhelper.icons("github")}
        </a>
        <button id="information-button" class="header-btn" data-placement="left" data-tooltip="Software information">${HTMLhelper.icons(
          "info",
        )}</button>
      </div>
    `;
  }

  static menuStructure(filterSections, totalFilterCount = 0) {
    let sections = "";
    filterSections.forEach((section) => {
      const safeName = escapeHtml(section.name);
      const safeNameAttr = escapeAttr(section.name);
      const safeColumn = escapeAttr(section.column ?? "");
      const safeIcon = section.icon ? escapeAttr(section.icon) : "";
      sections += /*html*/ `
        <div
            class="menu-section" id="${safeNameAttr.toLowerCase()}-section"
            data-filter-column="${safeColumn}"
        >
            <div class="menu-section-header d-flex justify-content-between mt-2 mb-3">
              <div class="menu-section-header-left">

                ${
                  section.icon
                    ? `<img width="24px" height="24px" src="${safeIcon}" />`
                    : ""
                }
                <h3>
                ${safeName}
                </h3>
              </div>
              <div class="d-flex flex-row justify-end align-center">
                <div class="section-filter-count filter-counter hide">0</div>
                <svg class="chevron chevron-button subsection-chevron" xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#1f1f1f"><path d="M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z"/></svg>
              </div>

            </div>
            ${
              section.searchable
                ? `
              <input
              type="text"
              id="${safeNameAttr}SearchBox"
              placeholder="Search ${safeName}..."
              class="form-control mb-2 menu-section-search"
              />
              `
                : ""
            }

            <div class="w-100 ${
              section.scrollable ? "scroll-container" : ""
            } menu-sub-section">
                ${section.string}
            </div>
        </div>
    `;
    });
    return /*html*/ `
    <div id="sidebar-menu-group" class="d-flex flex-row h-100">
      <div id="filter-menu-container" class="menu-box shadow-normal h-100 z-2">
        ${HTMLhelper.menuHeader("Filters", "filter", totalFilterCount)}

        <div class="menu-content scroll-container invisible">
          ${sections}
        </div>
        <button class="invisible clear-btn filter-menu-btn justify-center align-center">
          <span>${HTMLhelper.icons("nofilter")}</span>Clear Filters
        </button>
      </div>
    </div>

    `;
  }

  static dateSelectionWidget(startDate = null, endDate = null) {
    const braceColor = "#4682B4";
    const svgCircle = (id) => {
      return /*html*/ `
      <svg id="${id}" height="14px" viewbox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
        <circle r="5" cx="5" cy="5" fill="${braceColor}"/>
      </svg>
    `;
    };
    const widget =
      /*html*/
      `
    <div id="date-widget">
      <div id="dw-bar" style="background-color: ${braceColor}"></div>
      <label id="dw-start-label" for="dw-start-date-input">Start Date</label>
      ${svgCircle("dw-start-circle")}
      <input ${
        !!startDate ? `value=${escapeAttr(startDate)}` : ""
      } type="text" id="dw-start-date-input" name="dw-start-date-input" class="date-text-input" filter-type="date-start" />
      <p id="dw-start-hint" class="form-hint">YYYY/MM/DD or YYYY</p>
    
      <label id="dw-end-label" for="dw-end-date-input">End Date</label>
      ${svgCircle("dw-end-circle")}
      <input ${
        !!endDate ? `value=${escapeAttr(endDate)}` : ""
      } type="text" id="dw-end-date-input" name="dw-end-date-input" class="date-text-input" filter-type="date-end"/>
      <p id="dw-end-hint" class="form-hint">YYYY/MM/DD or YYYY</p>

      <p
        id="dw-error"
        class="form-hint hide"
        style="color: #b00020; margin-top: 0.25rem;"
      ></p>
    </div>
    `;

    return widget;
  }

  static chartSelector(
    chartSection,
    backgroundColor,
    svg = null,
    svgOnly = false,
  ) {
    const percentWhite = 40;
    const safeColor = escapeAttr(backgroundColor);
    const border = `border: solid color-mix(in srgb, ${safeColor}, white ${percentWhite}%);`;

    const safeAlias = escapeHtml(chartSection.alias);
    const content = svg ? (svgOnly ? svg : svg + " " + safeAlias) : safeAlias;

    return /*html*/ `
      <button id="${escapeAttr(chartSection.column)}" style="background-color: ${safeColor}; ${border}" class="btn chart-selector-btn">
        <h3>
          ${content}
        </h3>
      </button>
    `;
  }
  static chartTypeSelector(chartTypes, activeType) {
    const typeLabels = {
      stackedBar: "Bar Chart",
      lineGraph: "Line Graph",
      stackedArea: "Stacked Area Chart",
    };
    const typeIcons = {
      stackedBar: HTMLhelper.icons("stackedBar"),
      lineGraph: HTMLhelper.icons("lineGraph"),
      stackedArea: HTMLhelper.icons("stackedArea"),
    };

    const isSingleOption = chartTypes.length === 1;

    const buttons = chartTypes
      .map((type) => {
        const svgIcon = typeIcons[type] || "";
        const isActive = type === activeType;
        const disabledAttr = isSingleOption ? "disabled" : "";
        const disabledClass = isSingleOption ? "single-option" : "";
        return /*html*/ `
          <button
            class="chart-toolbar-btn chart-type-svg-btn ${
              isActive ? "active-chart-type" : ""
            } ${disabledClass}"
            data-chart-type="${type}"
            data-placement="bottom"
            data-tooltip="${
              typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1)
            }"
            aria-label="${
              typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1)
            }"
            type="button"
            ${disabledAttr}
            tabindex="0"
          >
            ${svgIcon}
          </button>
        `;
      })
      .join("");

    return /*html*/ `
      <div id="chart-type-selector-buttons" class="chart-type-selector-group">
        ${buttons}
      </div>
    `;
  }

  /**
   * Generate primary dimension selector dropdown.
   * @param {Array} options - Array of {value, label} for available primary dimensions
   * @param {string} activeValue - Currently selected primary dimension
   * @returns {string} HTML string
   */
  static primaryDimensionSelector(options = [], activeValue = null) {
    if (!options || options.length === 0) {
      return "";
    }

    const optionsHtml = options
      .map((opt) => {
        const selected = opt.value === activeValue ? "selected" : "";
        return `<option value="${escapeAttr(opt.value)}" ${selected}>${escapeHtml(opt.label)}</option>`;
      })
      .join("");

    return /*html*/ `
      <select id="primary-dim-dropdown" class="dimension-select" title="Select primary dimension">
        ${optionsHtml}
      </select>
    `;
  }

  /**
   * Generate secondary dimension selector for hierarchical charts.
   * @param {Array} options - Array of {value, label} for available secondary dimensions
   * @param {string} activeValue - Currently selected secondary dimension
   * @param {boolean} disabled - Whether the dropdown should be disabled (for time series)
   * @returns {string} HTML string
   */
  static secondaryDimensionSelector(
    options = [],
    activeValue = null,
    disabled = false,
  ) {
    if (!options || options.length === 0) {
      return "";
    }

    const optionsHtml = options
      .map((opt) => {
        const selected = opt.value === activeValue ? "selected" : "";
        return `<option value="${escapeAttr(opt.value)}" ${selected}>${escapeHtml(opt.label)}</option>`;
      })
      .join("");

    const disabledAttr = disabled ? "disabled" : "";

    return /*html*/ `
      <span class="secondary-dim-label">by</span>
      <select id="secondary-dim-dropdown" class="dimension-select" title="Select dimension to break down by" ${disabledAttr}>
        ${optionsHtml}
      </select>
    `;
  }

  static chartOptions(savedOptions = null) {
    const userDataLoaded =
      localStorage.getItem("AMRTrackerUserDataLoaded") === "true";

    // Y-Axis modes (common to all charts)
    const yAxisModes = [
      { label: "Absolute", value: "absolute" },
      { label: "Relative / Percentage", value: "relative" },
    ];
    const savedYAxis = savedOptions?.yAxis || "absolute";
    const yAxisSectionString = yAxisModes
      .map((type) => {
        const isChecked = type.value === savedYAxis;
        return /*html*/ `
          <div>
            <input type="radio" id="${type.value}-yAxis-radio" name="yAxis-radio" value="${type.value}" ${isChecked ? "checked" : ""}>
            <label for="${type.value}-yAxis-radio">${type.label}</label>
          </div>
        `;
      })
      .join("");

    // Data mode (when user data loaded)
    const dataModes = ["Compare", "Merge"];
    const savedDataMode =
      savedOptions?.dataMode || (userDataLoaded ? "compare" : "merge");
    const dataModeSectionString = dataModes
      .map((type) => {
        const isChecked = type.toLowerCase() === savedDataMode;
        return /*html*/ `
          <div>
            <input type="radio" id="${type}-data-mode-radio" name="data-mode-radio" value="${type.toLowerCase()}" ${isChecked ? "checked" : ""}>
            <label for="${type}-data-mode-radio">${type}</label>
          </div>
        `;
      })
      .join("");

    // Sort types for bar charts
    const sortTypes = userDataLoaded
      ? ["Alphanumeric", "Count: CAMRA", "Count: User data", "Count: Combined"]
      : ["Alphanumeric", "Count"];
    const savedSort = savedOptions?.sort || "alphanumeric";
    const sortSectionString = sortTypes
      .map((type) => {
        const sortValue =
          type === "Count: CAMRA"
            ? "count:camra"
            : type === "Count: User data"
              ? "count:userdata"
              : type === "Count: Combined"
                ? "count:combined"
                : type === "Count"
                  ? "count"
                  : "alphanumeric";
        const isChecked = sortValue.toLowerCase() === savedSort?.toLowerCase();
        return /*html*/ `
          <div>
            <input type="radio" id="${type.replace(/[:\s]/g, "")}-sort-radio" name="sort-radio" value="${sortValue}" ${isChecked ? "checked" : ""}>
            <label for="${type.replace(/[:\s]/g, "")}-sort-radio">${type}</label>
          </div>
        `;
      })
      .join("");

    // Time series modes
    const timeSeriesModes = [
      { label: "Per Year", value: "perYear" },
      { label: "Cumulative", value: "cumulative" },
    ];
    const savedTimeSeriesMode = savedOptions?.timeSeriesMode || "perYear";
    const timeSeriesSectionString = timeSeriesModes
      .map((type) => {
        const isChecked = type.value === savedTimeSeriesMode;
        return /*html*/ `
          <div>
            <input type="radio" id="${type.label.replace(" ", "")}-timeSeries-radio" name="timeSeries-radio" value="${type.value}" ${isChecked ? "checked" : ""}>
            <label for="${type.label.replace(" ", "")}-timeSeries-radio">${type.label}</label>
          </div>
        `;
      })
      .join("");

    // Line selection modes
    const lineSelectionModes = [
      { label: "Top by Total Count", value: "totalCount" },
      { label: "Top by Recent Year", value: "recentYear" },
      { label: "Alphanumeric", value: "alphanumeric" },
    ];
    const savedLineSelection = savedOptions?.lineSelection || "totalCount";
    const lineSelectionSectionString = lineSelectionModes
      .map((type) => {
        const isChecked = type.value === savedLineSelection;
        return /*html*/ `
          <div>
            <input type="radio" id="${type.value}-lineSelection-radio" name="lineSelection-radio" value="${type.value}" ${isChecked ? "checked" : ""}>
            <label for="${type.value}-lineSelection-radio">${type.label}</label>
          </div>
        `;
      })
      .join("");

    return /*html*/ `
      <div id="chart-options-header">
        <h2>Chart Settings</h2>
        <button id="close-chart-settings-btn">✕</button>
      </div>
      <section id="chart-options">
        <div id="yAxis-mode" class="chart-options-group">
          <h3>Y-Axis:</h3>
          <p>Sets the y-axis scale for all chart types.</p>
          <div class="d-flex flex-wrap flex-row">
            ${yAxisSectionString}
          </div>
        </div>

        <div class="chart-options-subheading">Bar Chart Options</div>
        <div id="sort-mode" class="chart-options-group">
          <h3>Sort:</h3>
          <p>How the x-axis values are ordered.</p>
          <div class="d-flex flex-wrap flex-row">
            ${sortSectionString}
          </div>
        </div>

        <div class="chart-options-subheading">Time Series Options</div>
        <div id="timeSeries-mode" class="chart-options-group">
          <h3>Time Series Mode:</h3>
          <p>Display frequency per year or cumulative sum over time.</p>
          <div class="d-flex flex-wrap flex-row">
            ${timeSeriesSectionString}
          </div>
        </div>
        <div id="lineSelection-mode" class="chart-options-group">
          <h3>Line Selection:</h3>
          <p>How lines are selected and ordered for time series charts.</p>
          <div class="d-flex flex-wrap flex-row">
            ${lineSelectionSectionString}
          </div>
        </div>

        ${
          userDataLoaded
            ? /*html*/ `
        <div class="chart-options-subheading">Data Options</div>
        <div id="data-set-mode" class="chart-options-group">
          <h3>User Data:</h3>
          <p>How user data is integrated into the charts.</p>
          <div class="d-flex flex-wrap flex-row">
            ${dataModeSectionString}
          </div>
        </div>
        `
            : ""
        }
      </section>
    `;
  }

  static taxonomyModal(taxonJSON, levelNames = ["family", "genus", "species"]) {
    const taxonomyTree = HTMLhelper.taxon(taxonJSON, levelNames);
    let htmlString = /*html*/ `
      <div id="taxonomySelection">
        <div id="available-selected">
          <section id="available-taxonomies">
            <h2 id="available-header">Available Genomes</h2>
            <div id="modal-search-box" class="mt-2 mb-2">
              <input id="taxonomy-search" type="search" placeholder="Search family, genus, species" autocomplete="off" />
            </div>
            <div id="available-taxonomy-tree" class="scroll-container">
              ${taxonomyTree}
            </div>
          </section>
              <section id="user-files-section">
                <h2 id="available-header">Load User Data
                  <a class="" href="https://github.com/JCVenterInstitute/AMR-GeoMapper/blob/b835203e1b5a8e3ab5f8eb55492f2f4f651f60b5/docs/user-data-guide.md">
                    <svg id="help-icon" xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="#1f1f1f"><path d="M478-240q21 0 35.5-14.5T528-290q0-21-14.5-35.5T478-340q-21 0-35.5 14.5T428-290q0 21 14.5 35.5T478-240Zm-36-154h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg>
                  </a>
                </h2>
                <div id="user-files" class="scroll-container">
                  <csv-upload-button></csv-upload-button>
                </div>
                <div id="data-guarantee">Your data is always private and only loaded locally.</div>
              </section>
        </div>
        </div>
      </div>
    `;

    return htmlString;
  }

  static taxon(taxonData, levelNames = ["family", "genus", "species"]) {
    const taxonHTMLContainer = document.createElement("section");
    const taxonUlEl = document.createElement("ul");
    taxonUlEl.classList.add("list-tree");
    taxonHTMLContainer.appendChild(taxonUlEl);

    const slug = (s) =>
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");

    // Build ID from path array
    const mkId = (side, level, path) =>
      `${side}-${level}-${path.filter(Boolean).map(slug).join("__")}`;

    // Build checkbox with data attributes from path
    const mkCheckbox = (side, level, path, text) => {
      const id = mkId(side, level, path);

      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "taxon-checkbox";
      input.id = id;
      input.dataset.level = level;

      // Set data attributes for each level in path
      levelNames.forEach((levelName, index) => {
        if (path[index]) {
          input.dataset[levelName] = path[index];
        }
      });

      input.dataset.label = text;

      const label = document.createElement("label");
      label.setAttribute("for", id);
      // First level (e.g., "order" or "family") is not italicized
      if (level === levelNames[0]) {
        label.textContent = text;
      } else {
        const span = document.createElement("span");
        span.className = "italic";
        span.textContent = text;
        label.appendChild(span);
      }

      return { input, label };
    };

    // Recursive function to build tree
    const buildTree = (data, parentUl, currentPath = [], currentLevel = 0) => {
      if (currentLevel >= levelNames.length) return;

      const levelName = levelNames[currentLevel];
      const isLeafLevel = currentLevel === levelNames.length - 1;

      if (isLeafLevel && Array.isArray(data)) {
        // Leaf level: data is an array of species
        data.forEach((species) => {
          const spLi = document.createElement("li");
          spLi.classList.add("leaf");
          const spWrap = document.createElement("div");
          const spCb = mkCheckbox(
            "avail",
            levelName,
            [...currentPath, species],
            species,
          );
          spWrap.append(spCb.input, spCb.label);
          spLi.appendChild(spWrap);
          parentUl.appendChild(spLi);
        });
      } else if (
        typeof data === "object" &&
        data !== null &&
        !Array.isArray(data)
      ) {
        // Non-leaf level: data is an object
        Object.keys(data).forEach((key) => {
          const newPath = [...currentPath, key];
          const li = document.createElement("li");
          const details = document.createElement("details");
          details.open = false;
          const summary = document.createElement("summary");

          const chevron = document.createElement("span");
          chevron.classList.add("tree-chevron");
          chevron.setAttribute("aria-hidden", "true");
          summary.appendChild(chevron);

          const cb = mkCheckbox("avail", levelName, newPath, key);
          summary.append(cb.input, cb.label);
          details.appendChild(summary);

          const ul = document.createElement("ul");
          details.appendChild(ul);
          li.appendChild(details);
          parentUl.appendChild(li);

          // Recursively build children
          buildTree(data[key], ul, newPath, currentLevel + 1);
        });
      }
    };

    buildTree(taxonData, taxonUlEl);

    // return HTML string for your template usage
    return taxonHTMLContainer.innerHTML;
  }
}

export { HTMLhelper, escapeHtml, escapeAttr };
