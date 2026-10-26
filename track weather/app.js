"use strict";

const seasonSelect = document.querySelector("#season-select");
const raceSelect = document.querySelector("#race-select");
const statusLabel = document.querySelector("#status-label");
const emptyState = document.querySelector("#empty-state");
const dataView = document.querySelector("#data-view");
const title = document.querySelector("#race-title");
const metricSelect = document.querySelector("#weather-metric");
const svg = document.querySelector("#weather-chart");
const svgNs = "http://www.w3.org/2000/svg";
let currentReadings = [];
let currentSession = null;
let activeLoadId = 0;

function showError(error) {
  console.error("No se pudo cargar el clima:", error);
  dataView.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = error.message || "No se pudieron cargar las condiciones meteorológicas.";
  F1Tools.setStatus(statusLabel, "ERROR AL CARGAR", "error");
}

function average(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function display(value, unit = "", digits = 1) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : "—";
}

function makeSvg(tag, attributes, text = "") {
  const element = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  return element;
}

function renderChart() {
  if (!currentReadings.length || !currentSession) return;
  const field = metricSelect.value;
  const labels = {
    track_temperature: { title: "TEMPERATURA DE PISTA", unit: "°C", color: "#66d9c7" },
    air_temperature: { title: "TEMPERATURA AMBIENTE", unit: "°C", color: "#ff8b4d" },
    rainfall: { title: "LLUVIA", unit: "", color: "#5997ff" },
    wind_speed: { title: "VELOCIDAD DEL VIENTO", unit: " m/s", color: "#f3bd45" },
    humidity: { title: "HUMEDAD", unit: "%", color: "#dc83c6" },
  };
  const definition = labels[field];
  const values = currentReadings.map((reading) => ({ time: Date.parse(reading.date), value: Number(reading[field]) }))
    .filter((reading) => Number.isFinite(reading.time) && Number.isFinite(reading.value))
    .sort((first, second) => first.time - second.time);
  const width = 1000;
  const height = 350;
  const margin = { top: 25, right: 28, bottom: 48, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minTime = values[0]?.time ?? 0;
  const maxTime = values[values.length - 1]?.time ?? minTime + 1;
  let minValue = Math.min(...values.map((reading) => reading.value));
  let maxValue = Math.max(...values.map((reading) => reading.value));
  if (field === "rainfall") {
    minValue = 0;
    maxValue = Math.max(1, maxValue);
  } else if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  if (field !== "rainfall") {
    const pad = (maxValue - minValue) * 0.12;
    minValue -= pad;
    maxValue += pad;
  }
  const x = (time) => margin.left + ((time - minTime) / Math.max(1, maxTime - minTime)) * plotWidth;
  const y = (value) => margin.top + ((maxValue - value) / Math.max(1, maxValue - minValue)) * plotHeight;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", `${definition.title} durante ${currentSession.location || currentSession.meeting_name}`);
  svg.replaceChildren();
  for (let index = 0; index <= 4; index += 1) {
    const value = minValue + ((maxValue - minValue) * index) / 4;
    const lineY = y(value);
    svg.append(makeSvg("line", { x1: margin.left, y1: lineY, x2: width - margin.right, y2: lineY, class: "grid-line" }));
    svg.append(makeSvg("text", { x: margin.left - 10, y: lineY + 3, "text-anchor": "end", class: "axis-label" }, `${value.toFixed(field === "rainfall" ? 0 : 1)}${definition.unit}`));
  }
  const timeCount = 5;
  for (let index = 0; index < timeCount; index += 1) {
    const time = minTime + ((maxTime - minTime) * index) / (timeCount - 1);
    const label = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(time));
    svg.append(makeSvg("text", { x: x(time), y: height - 17, "text-anchor": "middle", class: "axis-label" }, label));
  }
  svg.append(makeSvg("text", { x: margin.left + plotWidth / 2, y: height - 3, "text-anchor": "middle", class: "axis-title" }, "HORA (UTC)"));
  const path = values.map((reading, index) => `${index ? "L" : "M"}${x(reading.time).toFixed(1)},${y(reading.value).toFixed(1)}`).join(" ");
  if (field === "rainfall") {
    values.filter((reading) => reading.value > 0).forEach((reading) => {
      svg.append(makeSvg("line", { x1: x(reading.time), y1: y(reading.value), x2: x(reading.time), y2: y(0), class: "rain-stem" }));
    });
  } else {
    svg.append(makeSvg("path", { d: `${path} L${x(maxTime)},${y(minValue)} L${x(minTime)},${y(minValue)} Z`, class: "weather-area", fill: definition.color }));
  }
  svg.append(makeSvg("path", { d: path, class: "weather-line", stroke: definition.color }));
  values.forEach((reading, index) => {
    if (index % Math.max(1, Math.floor(values.length / 30)) === 0 || index === values.length - 1) {
      const point = makeSvg("circle", { cx: x(reading.time), cy: y(reading.value), r: 3, class: "weather-point", fill: definition.color });
      point.append(makeSvg("title", {}, `${new Date(reading.time).toISOString()} · ${reading.value}${definition.unit}`));
      svg.append(point);
    }
  });
  svg.prepend(makeSvg("text", { x: margin.left, y: 14, class: "axis-title" }, definition.title));
}

async function loadRace(session) {
  const loadId = ++activeLoadId;
  if (!session) {
    currentReadings = [];
    currentSession = null;
    dataView.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector("p").textContent = "Elegí una carrera para ver las condiciones meteorológicas.";
    title.textContent = "Clima durante la carrera";
    return;
  }
  currentReadings = [];
  currentSession = session;
  dataView.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = "CARGANDO MEDICIONES METEOROLÓGICAS…";
  F1Tools.setStatus(statusLabel, "CARGANDO CLIMA", "loading");
  try {
    const readings = await F1Tools.fetchRecords("weather", { session_key: session.session_key });
    if (loadId !== activeLoadId) return;
    if (!readings.length) throw new Error("OpenF1 no devolvió mediciones meteorológicas para esta carrera.");
    currentReadings = readings;
    const air = average(readings, "air_temperature");
    const track = average(readings, "track_temperature");
    const wind = average(readings, "wind_speed");
    const rainCount = readings.filter((reading) => Number(reading.rainfall) > 0).length;
    document.querySelector("#metric-air").textContent = display(air, " °C");
    document.querySelector("#metric-track").textContent = display(track, " °C");
    document.querySelector("#metric-rain").textContent = rainCount ? `${rainCount} lecturas` : "No detectada";
    document.querySelector("#metric-wind").textContent = `viento promedio ${display(wind, " m/s")}`;
    title.textContent = `${session.location || session.meeting_name} · ${seasonSelect.value}`;
    emptyState.hidden = true;
    dataView.hidden = false;
    renderChart();
    F1Tools.setStatus(statusLabel, `${readings.length} MEDICIONES · UTC`);
  } catch (error) {
    if (loadId === activeLoadId) showError(error);
  }
}

metricSelect.addEventListener("change", renderChart);
F1Tools.initializeRacePicker({
  seasonSelect,
  raceSelect,
  status: statusLabel,
  onSelect: loadRace,
  onError: showError,
});
