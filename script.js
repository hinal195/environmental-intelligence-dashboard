const CITY_COORDS = {
  Goa: { lat: 15.2993, lon: 74.124 },
  Mumbai: { lat: 19.076, lon: 72.8777 },
  Jaipur: { lat: 26.9124, lon: 75.7873 },
  Ahmedabad: { lat: 23.0225, lon: 72.5714 },
  Thiruvananthapuram: { lat: 8.5241, lon: 76.9366 },
};

const AQI_MAP = { 1: 50, 2: 100, 3: 150, 4: 220, 5: 320 };
const DEFAULT_THEME = {
  primary: "#ff6a00",
  accent: "#ff3c00",
  background: "#020617",
  card: "rgba(15, 23, 42, 0.55)",
  text: "#ecfeff",
  muted: "#9ca3af",
};
const state = {
  mode: "general",
  selectedCity: "Goa",
  dataSource: "live",
  cityData: [],
  charts: {},
};

const el = {
  cityList: document.getElementById("cityList"),
  kpiGrid: document.getElementById("kpiGrid"),
  forecastCard: document.getElementById("forecastCard"),
  insightsList: document.getElementById("insightsList"),
  dataSourceBadge: document.getElementById("dataSourceBadge"),
  alertsPanel: document.getElementById("alertsPanel"),
  toastContainer: document.getElementById("toastContainer"),
  chatHistory: document.getElementById("chatHistory"),
  chatInput: document.getElementById("chatInput"),
  sendChatBtn: document.getElementById("sendChatBtn"),
  chatSuggestions: document.getElementById("chatSuggestions"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveApiKeyBtn: document.getElementById("saveApiKeyBtn"),
  paletteImageInput: document.getElementById("paletteImageInput"),
  palettePreview: document.getElementById("palettePreview"),
  resetThemeBtn: document.getElementById("resetThemeBtn"),
  defaultThemeToggle: document.getElementById("defaultThemeToggle"),
};

function getApiKey() {
  return localStorage.getItem("ow_api_key") || "";
}

function saveApiKey() {
  const value = el.apiKeyInput.value.trim();
  if (!value) return;
  localStorage.setItem("ow_api_key", value);
  toast("API key saved.");
  init(true);
}

function fetchWithTimeout(url, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

function mapConfidence(score) {
  if (score > 0.7) return "High";
  if (score > 0.45) return "Medium";
  return "Low";
}

function approxUv(temp, cloudPct) {
  return Math.max(1, Math.min(11, (temp / 5) * (1 - cloudPct / 130)));
}

function normalizeCityData(city, weatherRes, airRes, forecastRes) {
  const temp = Number(weatherRes.main.temp.toFixed(1));
  const pop = forecastRes.list?.[0]?.pop ?? weatherRes.clouds.all / 100;
  const pop6 = forecastRes.list?.[1]?.pop ?? pop;
  const temp3 = forecastRes.list?.[0]?.main?.temp ?? temp;
  const temp6 = forecastRes.list?.[1]?.main?.temp ?? temp3;
  const tempChange3h = Number((temp3 - temp).toFixed(1));
  const tempChange6h = Number((temp6 - temp).toFixed(1));
  const rainTrend = pop6 > pop ? "increasing" : pop6 < pop ? "decreasing" : "steady";
  const confidenceRaw = 1 - Math.min(1, Math.abs(tempChange3h - tempChange6h) / 5);

  return {
    city,
    weather: {
      temperatureC: temp,
      humidityPct: weatherRes.main.humidity,
      windSpeedMs: weatherRes.wind.speed,
      pressureHpa: weatherRes.main.pressure,
      visibilityKm: Number(((weatherRes.visibility || 10000) / 1000).toFixed(1)),
      rainProbabilityPct: Math.round(pop * 100),
      uvIndex: Number(approxUv(temp, weatherRes.clouds.all).toFixed(1)),
    },
    air: {
      aqi: airRes.list[0].main.aqi,
      pm2_5: Number(airRes.list[0].components.pm2_5.toFixed(1)),
      pm10: Number(airRes.list[0].components.pm10.toFixed(1)),
      co: Number(airRes.list[0].components.co.toFixed(1)),
      no2: Number(airRes.list[0].components.no2.toFixed(1)),
      so2: Number(airRes.list[0].components.so2.toFixed(1)),
      o3: Number(airRes.list[0].components.o3.toFixed(1)),
    },
    forecast: {
      tempChange3h,
      tempChange6h,
      rainTrend,
      confidence: mapConfidence(confidenceRaw),
    },
  };
}

function riskAssessment(cityObj) {
  const aqiScore = AQI_MAP[cityObj.air.aqi] || 120;
  const temp = cityObj.weather.temperatureC;
  const rain = cityObj.weather.rainProbabilityPct;
  const visibility = cityObj.weather.visibilityKm;

  const weights =
    state.mode === "travel"
      ? { aqi: 0.2, temp: 0.15, rain: 0.4, visibility: 0.25 }
      : state.mode === "health"
      ? { aqi: 0.45, temp: 0.35, rain: 0.1, visibility: 0.1 }
      : { aqi: 0.35, temp: 0.25, rain: 0.2, visibility: 0.2 };

  const normalized = {
    aqi: Math.min(1, aqiScore / 300),
    temp: Math.min(1, temp / 45),
    rain: rain / 100,
    visibility: Math.min(1, (10 - Math.min(10, visibility)) / 10),
  };

  const score =
    normalized.aqi * weights.aqi +
    normalized.temp * weights.temp +
    normalized.rain * weights.rain +
    normalized.visibility * weights.visibility;

  let label = "Safe";
  if (aqiScore > 200 || rain > 70 || score > 0.65) label = "Avoid";
  else if (aqiScore > 100 || temp > 35 || score > 0.45) label = "Caution";

  return { score, label, aqiScore };
}

async function loadFallback() {
  const fallback = await fetch("data.json").then((r) => r.json());
  state.cityData = fallback.cities;
  state.dataSource = "fallback";
}

async function loadLiveData() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Missing API key.");

  const cityPromises = Object.keys(CITY_COORDS).map(async (city) => {
    const { lat, lon } = CITY_COORDS[city];
    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
    const airUrl = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${apiKey}`;
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;

    const [weatherRes, airRes, forecastRes] = await Promise.all([
      fetchWithTimeout(weatherUrl).then((r) => r.json()),
      fetchWithTimeout(airUrl).then((r) => r.json()),
      fetchWithTimeout(forecastUrl).then((r) => r.json()),
    ]);

    if (weatherRes.cod && Number(weatherRes.cod) !== 200) throw new Error(`Weather failed for ${city}`);
    if (!airRes.list || !forecastRes.list) throw new Error(`Air/Forecast failed for ${city}`);
    return normalizeCityData(city, weatherRes, airRes, forecastRes);
  });

  state.cityData = await Promise.all(cityPromises);
  state.dataSource = "live";
}

function updateDataSourceBadge() {
  el.dataSourceBadge.textContent = state.dataSource === "live" ? "Live Data" : "Fallback Data";
  el.dataSourceBadge.className = `badge ${state.dataSource}`;
}

function renderCityList() {
  el.cityList.innerHTML = "";
  state.cityData.forEach((c) => {
    const risk = riskAssessment(c);
    const div = document.createElement("div");
    div.className = `city-item ${c.city === state.selectedCity ? "active" : ""}`;
    div.innerHTML = `<span>${c.city}</span><span class="risk-pill risk-${risk.label.toLowerCase()}">${risk.label}</span>`;
    div.onclick = () => {
      state.selectedCity = c.city;
      renderAll();
    };
    el.cityList.appendChild(div);
  });
}

function renderKpis(cityObj) {
  const kpis = [
    ["Temperature", `${cityObj.weather.temperatureC} °C`],
    ["Humidity", `${cityObj.weather.humidityPct} %`],
    ["Wind", `${cityObj.weather.windSpeedMs} m/s`],
    ["Pressure", `${cityObj.weather.pressureHpa} hPa`],
    ["Visibility", `${cityObj.weather.visibilityKm} km`],
    ["UV", cityObj.weather.uvIndex],
  ];
  el.kpiGrid.innerHTML = kpis
    .map(
      (k) => `<div class="kpi-card"><div class="kpi-label">${k[0]}</div><div class="kpi-value">${k[1]}</div></div>`
    )
    .join("");
}

function renderForecast(cityObj) {
  const f = cityObj.forecast;
  const arrowTemp = f.tempChange6h >= 0 ? "↑" : "↓";
  const rainArrow = f.rainTrend === "increasing" ? "↑" : f.rainTrend === "decreasing" ? "↓" : "→";
  el.forecastCard.innerHTML = `
    <div class="forecast-row"><span>Temperature trend</span><strong>${arrowTemp} ${f.tempChange6h} °C (6h)</strong></div>
    <div class="forecast-row"><span>Rain trend</span><strong>${rainArrow} ${f.rainTrend}</strong></div>
    <div class="forecast-row"><span>Confidence</span><strong>${f.confidence}</strong></div>
  `;
}

function updateCharts(selected) {
  const labels = state.cityData.map((c) => c.city);
  const tempData = state.cityData.map((c) => c.weather.temperatureC);
  const pollutants = [selected.air.pm2_5, selected.air.pm10, selected.air.co / 10, selected.air.no2, selected.air.so2, selected.air.o3];
  const theme = getThemeColorsFromCss();
  const tickColor = withAlpha(theme.text, 0.82);
  const gridColor = withAlpha(theme.text, 0.2);

  if (!state.charts.temp) {
    state.charts.temp = new Chart(document.getElementById("tempChart"), {
      type: "bar",
      data: { labels, datasets: [{ label: "Temperature °C", data: tempData, backgroundColor: theme.primary }] },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: theme.text } } },
        scales: { x: { ticks: { color: tickColor }, grid: { color: gridColor } }, y: { ticks: { color: tickColor }, grid: { color: gridColor } } },
      },
    });
  } else {
    state.charts.temp.data.labels = labels;
    state.charts.temp.data.datasets[0].data = tempData;
    state.charts.temp.update();
  }

  const aqiNum = riskAssessment(selected).aqiScore;
  if (!state.charts.aqi) {
    state.charts.aqi = new Chart(document.getElementById("aqiGauge"), {
      type: "doughnut",
      data: {
        labels: ["AQI", "Remaining"],
        datasets: [{ data: [aqiNum, Math.max(1, 350 - aqiNum)], backgroundColor: [theme.primary, withAlpha(theme.muted, 0.25)], borderWidth: 0 }],
      },
      options: { circumference: 180, rotation: 270, cutout: "72%", plugins: { legend: { labels: { color: theme.text } } } },
    });
  } else {
    state.charts.aqi.data.datasets[0].data = [aqiNum, Math.max(1, 350 - aqiNum)];
    state.charts.aqi.update();
  }

  if (!state.charts.radar) {
    state.charts.radar = new Chart(document.getElementById("pollutantRadar"), {
      type: "radar",
      data: {
        labels: ["PM2.5", "PM10", "CO/10", "NO2", "SO2", "O3"],
        datasets: [{ label: `${selected.city} Pollutants`, data: pollutants, borderColor: theme.primary, backgroundColor: withAlpha(theme.primary, 0.28) }],
      },
      options: {
        plugins: { legend: { labels: { color: theme.text } } },
        scales: { r: { pointLabels: { color: tickColor }, grid: { color: gridColor }, angleLines: { color: gridColor } } },
      },
    });
  } else {
    state.charts.radar.data.datasets[0].label = `${selected.city} Pollutants`;
    state.charts.radar.data.datasets[0].data = pollutants;
    state.charts.radar.update();
  }
  refreshChartsTheme();
}

function renderInsights() {
  const hottest = [...state.cityData].sort((a, b) => b.weather.temperatureC - a.weather.temperatureC)[0];
  const worstAir = [...state.cityData].sort((a, b) => (AQI_MAP[b.air.aqi] || 0) - (AQI_MAP[a.air.aqi] || 0))[0];
  const rainiest = [...state.cityData].sort((a, b) => b.weather.rainProbabilityPct - a.weather.rainProbabilityPct)[0];

  el.insightsList.innerHTML = `
    <li>Hottest city: <strong>${hottest.city}</strong> (${hottest.weather.temperatureC} °C)</li>
    <li>Worst AQI: <strong>${worstAir.city}</strong> (${AQI_MAP[worstAir.air.aqi]})</li>
    <li>Rainiest city: <strong>${rainiest.city}</strong> (${rainiest.weather.rainProbabilityPct}%)</li>
  `;
}

function collectAlerts() {
  const alerts = [];
  state.cityData.forEach((c) => {
    const aqi = AQI_MAP[c.air.aqi] || 100;
    if (aqi > 200) alerts.push({ type: "high", text: `🚨 High pollution alert in ${c.city}` });
    if (c.weather.temperatureC > 35) alerts.push({ type: "medium", text: `🌡️ Heatwave warning in ${c.city}` });
    if (c.weather.rainProbabilityPct > 70) alerts.push({ type: "medium", text: `🌧️ Rain alert for ${c.city}` });
  });
  return alerts;
}

function renderAlerts() {
  const alerts = collectAlerts();
  el.alertsPanel.innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert-item ${a.type}">${a.text}</div>`).join("")
    : `<div class="alert-item">No high-priority alerts right now.</div>`;
}

function toast(message) {
  const div = document.createElement("div");
  div.className = "toast";
  div.textContent = message;
  el.toastContainer.appendChild(div);
  setTimeout(() => div.remove(), 3400);
}

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  el.chatHistory.appendChild(div);
  el.chatHistory.scrollTop = el.chatHistory.scrollHeight;
}

function recommendationFor(cityObj) {
  const risk = riskAssessment(cityObj);
  if (risk.label === "Avoid") return "Avoid non-essential outdoor plans.";
  if (risk.label === "Caution") return "Proceed with caution and monitor conditions.";
  return "Conditions are mostly favorable.";
}

function chatAnswer(queryRaw) {
  const query = queryRaw.toLowerCase();
  const selected = state.cityData.find((c) => c.city === state.selectedCity) || state.cityData[0];
  const worstAqi = [...state.cityData].sort((a, b) => (AQI_MAP[b.air.aqi] || 0) - (AQI_MAP[a.air.aqi] || 0))[0];
  const bestTravel = [...state.cityData].sort((a, b) => riskAssessment(a).score - riskAssessment(b).score)[0];

  if (query.includes("best city") || query.includes("travel")) {
    return `${bestTravel.city} is best for travel now. Rain ${bestTravel.weather.rainProbabilityPct}%, visibility ${bestTravel.weather.visibilityKm} km, AQI ${AQI_MAP[bestTravel.air.aqi]}. Recommendation: ${recommendationFor(bestTravel)}`;
  }
  if (query.includes("worst air") || query.includes("air quality")) {
    return `${worstAqi.city} currently has the worst air quality with AQI ${AQI_MAP[worstAqi.air.aqi]} and PM2.5 at ${worstAqi.air.pm2_5}. Recommendation: reduce outdoor exposure.`;
  }
  if (query.includes("rain later") || query.includes("will it rain")) {
    return `${selected.city}: rain probability is ${selected.weather.rainProbabilityPct}% and trend is ${selected.forecast.rainTrend}. Reasoning: short-term forecast pattern indicates ${selected.forecast.rainTrend} rain chance.`;
  }
  if (query.includes("safe") || query.includes(selected.city.toLowerCase())) {
    const risk = riskAssessment(selected);
    return `${selected.city} is ${risk.label} now. AQI ${risk.aqiScore}, temp ${selected.weather.temperatureC}°C, rain ${selected.weather.rainProbabilityPct}%, visibility ${selected.weather.visibilityKm} km. Recommendation: ${recommendationFor(selected)}`;
  }
  return `For ${selected.city}: AQI ${AQI_MAP[selected.air.aqi]}, temp ${selected.weather.temperatureC}°C, rain ${selected.weather.rainProbabilityPct}% (${selected.forecast.rainTrend}). Recommendation: ${recommendationFor(selected)}`;
}

function renderSuggestions() {
  const suggestions = [
    "Best city to travel today?",
    `Is ${state.selectedCity} safe now?`,
    "Will it rain later?",
    "Which city has worst air quality?",
  ];
  el.chatSuggestions.innerHTML = "";
  suggestions.forEach((s) => {
    const chip = document.createElement("button");
    chip.className = "suggestion-chip";
    chip.textContent = s;
    chip.onclick = () => {
      el.chatInput.value = s;
      sendChat();
    };
    el.chatSuggestions.appendChild(chip);
  });
}

function sendChat() {
  const q = el.chatInput.value.trim();
  if (!q) return;
  appendMessage("user", q);
  const ans = chatAnswer(q);
  appendMessage("bot", ans);
  el.chatInput.value = "";
  renderSuggestions();
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (h < 60) [rn, gn, bn] = [c, x, 0];
  else if (h < 120) [rn, gn, bn] = [x, c, 0];
  else if (h < 180) [rn, gn, bn] = [0, c, x];
  else if (h < 240) [rn, gn, bn] = [0, x, c];
  else if (h < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return [
    Math.round((rn + m) * 255),
    Math.round((gn + m) * 255),
    Math.round((bn + m) * 255),
  ];
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function withAlpha(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function brighten(hex, amount = 0.12) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const rgb = hslToRgb(h, s, clamp01(l + amount));
  return rgbToHex(...rgb);
}

function saturateIfDull(hex, minSat = 0.45) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const boosted = Math.max(s, minSat);
  const rgb = hslToRgb(h, boosted, l);
  return rgbToHex(...rgb);
}

function darken(hex, amount = 0.55) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const rgb = hslToRgb(h, Math.min(0.65, s), clamp01(l - amount));
  return rgbToHex(...rgb);
}

function makeCardColor(backgroundHex) {
  const [h, s, l] = rgbToHsl(...hexToRgb(backgroundHex));
  const rgb = hslToRgb(h, Math.min(0.55, s + 0.08), clamp01(l + 0.12));
  return withAlpha(rgbToHex(...rgb), 0.72);
}

function getThemeColorsFromCss() {
  const styles = getComputedStyle(document.documentElement);
  return {
    primary: styles.getPropertyValue("--primary").trim(),
    accent: styles.getPropertyValue("--accent").trim(),
    background: styles.getPropertyValue("--bg").trim(),
    card: styles.getPropertyValue("--card").trim(),
    text: styles.getPropertyValue("--text").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
  };
}

function refreshChartsTheme() {
  if (!state.charts.temp && !state.charts.aqi && !state.charts.radar) return;
  const t = getThemeColorsFromCss();
  const chartText = t.text || "#ecfeff";
  const chartTicks = withAlpha(chartText, 0.82);
  const grid = withAlpha(chartText, 0.2);
  const primarySoft = withAlpha(t.primary, 0.28);
  const rest = withAlpha(t.muted || "#9ca3af", 0.25);

  if (state.charts.temp) {
    state.charts.temp.data.datasets[0].backgroundColor = t.primary;
    state.charts.temp.options.plugins.legend.labels.color = chartText;
    state.charts.temp.options.scales.x.ticks.color = chartTicks;
    state.charts.temp.options.scales.y.ticks.color = chartTicks;
    state.charts.temp.options.scales.x.grid = { color: grid };
    state.charts.temp.options.scales.y.grid = { color: grid };
    state.charts.temp.update();
  }

  if (state.charts.aqi) {
    state.charts.aqi.data.datasets[0].backgroundColor = [t.primary, rest];
    state.charts.aqi.options.plugins.legend.labels.color = chartText;
    state.charts.aqi.update();
  }

  if (state.charts.radar) {
    state.charts.radar.data.datasets[0].borderColor = t.primary;
    state.charts.radar.data.datasets[0].backgroundColor = primarySoft;
    state.charts.radar.options.plugins.legend.labels.color = chartText;
    state.charts.radar.options.scales.r.pointLabels.color = chartTicks;
    state.charts.radar.options.scales.r.grid.color = grid;
    state.charts.radar.options.scales.r.angleLines.color = grid;
    state.charts.radar.update();
  }
}

function applyTheme(colors) {
  const root = document.documentElement;
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--bg", colors.background);
  root.style.setProperty("--card", colors.card);
  root.style.setProperty("--text", colors.text);
  root.style.setProperty("--muted", colors.muted || DEFAULT_THEME.muted);
  localStorage.setItem("dashboard_theme", JSON.stringify(colors));
  refreshChartsTheme();
}

function renderPalettePreview(colors) {
  el.palettePreview.innerHTML = [colors.primary, colors.accent, colors.background]
    .map((c) => `<span class="swatch" style="background:${c}"></span>`)
    .join("");
}

function applyDefaultTheme() {
  applyTheme(DEFAULT_THEME);
  renderPalettePreview(DEFAULT_THEME);
  if (el.defaultThemeToggle) el.defaultThemeToggle.checked = true;
}

function restoreTheme() {
  const saved = localStorage.getItem("dashboard_theme");
  if (!saved) {
    applyDefaultTheme();
    return;
  }
  try {
    const theme = JSON.parse(saved);
    applyTheme(theme);
    renderPalettePreview(theme);
    const isDefault =
      theme.primary === DEFAULT_THEME.primary &&
      theme.accent === DEFAULT_THEME.accent &&
      theme.background === DEFAULT_THEME.background;
    if (el.defaultThemeToggle) el.defaultThemeToggle.checked = isDefault;
  } catch {
    applyDefaultTheme();
  }
}

function dominantPaletteFromPixels(pixels) {
  const buckets = new Map();
  let darkest = { lum: Number.POSITIVE_INFINITY, color: [8, 12, 20] };
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a < 200) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const q = [Math.round(r / 24) * 24, Math.round(g / 24) * 24, Math.round(b / 24) * 24];
    const key = q.join(",");
    buckets.set(key, (buckets.get(key) || 0) + 1);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < darkest.lum) darkest = { lum, color: [r, g, b] };
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const vibrantSorted = sorted
    .map(([key, count]) => {
      const rgb = key.split(",").map((n) => Number.parseInt(n, 10));
      const [, s, l] = rgbToHsl(...rgb);
      return { rgb, count, score: s * 1.2 + (1 - Math.abs(0.5 - l)) * 0.5 };
    })
    .sort((a, b) => b.score - a.score);

  const primaryRgb = vibrantSorted[0]?.rgb || [255, 106, 0];
  const accentRgb =
    vibrantSorted[1]?.rgb ||
    sorted[1]?.[0]?.split(",").map((n) => Number.parseInt(n, 10)) ||
    [255, 60, 0];
  const bgRgb = darkest.color;

  let primary = saturateIfDull(rgbToHex(...primaryRgb), 0.5);
  let accent = saturateIfDull(rgbToHex(...accentRgb), 0.45);
  const background = darken(rgbToHex(...bgRgb), 0.22);
  const card = makeCardColor(background);
  const text = relativeLuminance(background) > 0.38 ? "#f8fafc" : "#ecfeff";

  if (primary.toLowerCase() === accent.toLowerCase()) accent = brighten(primary, 0.12);
  return { primary, accent, background, card, text, muted: DEFAULT_THEME.muted };
}

function extractPalette(file) {
  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => (img.src = reader.result);
  img.onload = () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = 120;
    canvas.height = 120;
    ctx.drawImage(img, 0, 0, 120, 120);
    const pixels = ctx.getImageData(0, 0, 120, 120).data;

    const theme = dominantPaletteFromPixels(pixels);
    applyTheme(theme);
    renderPalettePreview(theme);
    if (el.defaultThemeToggle) el.defaultThemeToggle.checked = false;
    toast("Theme palette extracted from image.");
  };
  reader.readAsDataURL(file);
}

function renderAll() {
  updateDataSourceBadge();
  renderCityList();
  const selected = state.cityData.find((c) => c.city === state.selectedCity) || state.cityData[0];
  renderKpis(selected);
  renderForecast(selected);
  renderInsights();
  renderAlerts();
  updateCharts(selected);
  renderSuggestions();
}

function bindEvents() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      renderAll();
    };
  });
  el.sendChatBtn.onclick = sendChat;
  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  el.saveApiKeyBtn.onclick = saveApiKey;
  el.paletteImageInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) extractPalette(file);
  });
  if (el.resetThemeBtn) {
    el.resetThemeBtn.addEventListener("click", () => {
      localStorage.removeItem("dashboard_theme");
      applyDefaultTheme();
      toast("Theme reset to default.");
    });
  }
  if (el.defaultThemeToggle) {
    el.defaultThemeToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        applyDefaultTheme();
        toast("Default theme enabled.");
      }
    });
  }
}

async function init(force = false) {
  try {
    if (force || getApiKey()) {
      await loadLiveData();
    } else {
      throw new Error("No API key");
    }
  } catch (error) {
    await loadFallback();
    toast("Using fallback dataset because live API is unavailable.");
  }
  renderAll();
}

el.apiKeyInput.value = getApiKey();
bindEvents();
restoreTheme();
appendMessage("bot", "Ask me about travel safety, AQI risk, or rain trends for monitored cities.");
init();
