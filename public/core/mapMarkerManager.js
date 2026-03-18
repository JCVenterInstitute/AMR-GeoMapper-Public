import { PieChart } from "./pieChart.js";

export class MapMarkerManager {
  constructor(host) {
    this.host = host;
  }

  clearMapMarkers() {
    this.host.markersArray.forEach((marker) => {
      const content = marker?._pieChartContent;
      if (content?._destroyPieCharts) {
        content._destroyPieCharts();
      } else if (Array.isArray(content?._pieCharts)) {
        content._pieCharts.forEach((chart) => chart?.destroy?.());
      }
      marker.remove();
    });
    this.host.markersArray.length = 0;

    this._removeZoomListener();
  }

  _getMarkerPieChartSizeConfig() {
    const sizeConfig = this.host.config?.mapOptions?.markerPieChartSize ?? {};
    const minSize = Number.isFinite(sizeConfig.min) ? sizeConfig.min : 40;
    const maxSize = Number.isFinite(sizeConfig.max) ? sizeConfig.max : 120;
    return {
      min: Math.min(minSize, maxSize),
      max: Math.max(minSize, maxSize),
    };
  }

  computeMarkerSizeScale() {
    const { min, max } = this._getMarkerPieChartSizeConfig();
    let minCount = Infinity;
    let maxCount = -Infinity;

    if (this.host.locationObjs) {
      for (const key of Object.keys(this.host.locationObjs)) {
        const locationObj = this.host.locationObjs[key];
        if (!locationObj?.country) continue;
        const count = Number(locationObj.genomeCount ?? 0);
        if (!Number.isFinite(count)) continue;
        minCount = Math.min(minCount, count);
        maxCount = Math.max(maxCount, count);
      }
    }

    if (!Number.isFinite(minCount)) minCount = 0;
    if (!Number.isFinite(maxCount)) maxCount = 0;

    this.host._markerSizeScale = {
      minCount,
      maxCount,
      minSize: min,
      maxSize: max,
    };
    return this.host._markerSizeScale;
  }

  _getMarkerPieChartSize(locationObj) {
    const scale = this.host._markerSizeScale || this.computeMarkerSizeScale();
    const count = Number(locationObj?.genomeCount ?? 0);
    if (!Number.isFinite(count) || count <= 0) {
      return Math.round(scale.minSize);
    }

    const minCount = Math.max(scale.minCount, 1);
    const maxCount = Math.max(scale.maxCount, minCount);
    if (maxCount === minCount) {
      return Math.round(scale.minSize);
    }

    const logMin = Math.log10(minCount);
    const logMax = Math.log10(maxCount);
    const logVal = Math.log10(Math.max(count, minCount));
    const t = (logVal - logMin) / (logMax - logMin);
    const clamped = Math.min(1, Math.max(0, t));
    return Math.round(
      scale.minSize + (scale.maxSize - scale.minSize) * clamped,
    );
  }

  createPin(locationObj, key) {
    const position = locationObj.getCoordinates();
    const chartsEnabled = this.host.config.mapOptions.showMarkerPieCharts;
    const markerContent = chartsEnabled
      ? this.createPieChart(locationObj)
      : null;

    if (!Number.isNaN(position.lat) && !Number.isNaN(position.lng)) {
      let marker;

      if (markerContent) {
        const size = this._getMarkerPieChartSize(locationObj);
        const icon = L.divIcon({
          className: "pie-chart-marker",
          html: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });

        marker = L.marker([position.lat, position.lng], { icon }).addTo(
          this.host.map,
        );

        requestAnimationFrame(() => {
          const iconElement = marker.getElement();
          if (iconElement) {
            iconElement.innerHTML = "";
            iconElement.appendChild(markerContent);
          }
        });

        marker._pieChartContent = markerContent;
      } else {
        marker = L.marker([position.lat, position.lng]).addTo(this.host.map);
      }

      marker.on("click", () => {
        const active =
          this.host.activeChartIDPreference || this.host.activeChartID || null;

        this.host.activeLocation = key;
        this.host.createCharts(locationObj, key, active);
        this.host.expandMenu(this.host.shadow.getElementById("charts"));

        if (this.host.config.mapOptions.centerOnMarkerClick) {
          this.host.map.panTo(marker.getLatLng());
        }
      });
      marker.isStateLevel = locationObj.isStateLevel;
      marker.isUSACountry =
        locationObj.country === "United States" && !locationObj.isStateLevel;

      if (locationObj.isStateLevel || marker.isUSACountry) {
        this._checkMarkerZoom(marker);
      }

      this._setupZoomListener();

      return marker;
    }
    return false;
  }

  createPieChart(locationObj) {
    const size = this._getMarkerPieChartSize(locationObj);
    const pieChart = new PieChart({
      size,
      topN: this.host.constructor.PIE_CHART_TOP_N,
      includeOther: false,
      config: this.host.config,
      speciesColorMap: this.host.speciesColorMap,
      shadowRoot: this.host.shadow,
    });
    return pieChart.create(locationObj);
  }

  _checkMarkerZoom(marker) {
    if (!this.host.map || !marker) return;

    const zoom = this.host.map.getZoom();
    const isZoomedIn = zoom >= this.host.constructor.STATE_LEVEL_ZOOM_THRESHOLD;

    if (marker.isStateLevel) {
      if (isZoomedIn) {
        if (!this.host.map.hasLayer(marker)) {
          marker.addTo(this.host.map);
          this._reattachPieChartContent(marker);
        }
      } else {
        if (this.host.map.hasLayer(marker)) {
          marker.remove();
        }
      }
    }
    // else if (marker.isUSACountry) {
    //   if (isZoomedIn) {
    //     if (this.host.map.hasLayer(marker)) {
    //       marker.remove();
    //     }
    //   } else {
    //     if (!this.host.map.hasLayer(marker)) {
    //       marker.addTo(this.host.map);
    //       this._reattachPieChartContent(marker);
    //     }
    //   }
    // }
  }

  _reattachPieChartContent(marker) {
    const content = marker._pieChartContent;
    if (!content) return;

    requestAnimationFrame(() => {
      const iconElement = marker.getElement();
      if (iconElement) {
        iconElement.innerHTML = "";
        iconElement.appendChild(content);
      }
    });
  }

  _setupZoomListener() {
    if (this.host._zoomChangeListener) return;

    this.host._zoomChangeListener = () => {
      this.host.markersArray.forEach((marker) => {
        if (marker.isStateLevel || marker.isUSACountry) {
          this._checkMarkerZoom(marker);
        }
      });
    };
    this.host.map.on("zoomend", this.host._zoomChangeListener);
  }

  _removeZoomListener() {
    if (this.host._zoomChangeListener && this.host.map) {
      this.host.map.off("zoomend", this.host._zoomChangeListener);
      this.host._zoomChangeListener = null;
    }
  }

  destroy() {
    if (this.host.markersArray) {
      for (const marker of this.host.markersArray) {
        if (marker._pieChartContent?._destroyPieCharts) {
          marker._pieChartContent._destroyPieCharts();
        }
        marker.remove();
      }
      this.host.markersArray = [];
    }

    if (this.host._zoomChangeListener && this.host.map) {
      this.host.map.off("zoomend", this.host._zoomChangeListener);
      this.host._zoomChangeListener = null;
    }
  }
}
