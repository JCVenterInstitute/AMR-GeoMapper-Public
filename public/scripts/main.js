async function loadLeaflet() {
  // Load Leaflet CSS
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(link);

  // Load Leaflet JS
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initMap() {
  const config = await fetch("../config.json").then((res) => res.json());
  const mapConf = config.mapSettings;

  let center = mapConf?.center || { lat: 0, lng: 0 };
  let size = () => {
    switch (mapConf?.size) {
      case "world":
        return 2;
      case "country":
        return 5;
      case "state":
      case "province":
        return 7;
      default:
        return 2;
    }
  };

  const map = L.map(document.getElementById("map"), {
    center: [center.lat || 0, center.lng || 0],
    zoom: size(),
  });

  const tileConfig = config.mapOptions?.tileProvider || {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 19,
  };

  L.tileLayer(tileConfig.url, {
    attribution: tileConfig.attribution,
    maxZoom: tileConfig.maxZoom,
  }).addTo(map);
}

loadLeaflet().then(() => initMap());
