"use strict";

const seasonSelect = document.querySelector("#season-select");
const raceSelect = document.querySelector("#race-select");
const statusLabel = document.querySelector("#status-label");
const emptyState = document.querySelector("#empty-state");
const dataView = document.querySelector("#data-view");
const driverASelect = document.querySelector("#driver-a");
const driverBSelect = document.querySelector("#driver-b");
const svg = document.querySelector("#pace-chart");
const svgNs = "http://www.w3.org/2000/svg";
const COLORS = ["#66d9c7", "#f3bd45", "#ef5967", "#7d8bff", "#dc83c6", "#59b9ff", "#ff8b4d", "#c3d85a"];
let drivers = [];
let lapData = [];
let selectedSession = null;
let activeLoadId = 0;

function showError(error) {
  console.error("No se pudo cargar el ritmo de carrera:", error);
  dataView.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = error.message || "No se pudieron cargar los tiempos de vuelta.";
  F1Tools.setStatus(statusLabel, "ERROR AL CARGAR", "error");
}

function formatTime(seconds) {
  return Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}` : "—";
}

function makeSvg(tag, attributes, text = "") {
  const element = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  return element;
}

function statsFor(driver) {
  const laps = lapData.filter((lap) => Number(lap.driver_number) === Number(driver.driver_number)
    && Number.isFinite(Number(lap.lap_duration))
    && Number(lap.lap_duration) > 0
    && Number(lap.lap_duration) < 180
    && lap.is_pit_out_lap !== true)
    .sort((first, second) => Number(first.lap_number) - Number(second.lap_number));
  const times = laps.map((lap) => Number(lap.lap_duration));
  const average = times.length ? times.reduce((sum, time) => sum + time, 0) / times.length : NaN;
  const variance = times.length ? times.reduce((sum, time) => sum + (time - average) ** 2, 0) / times.length : NaN;
  return { driver, laps, best: times.length ? Math.min(...times) : NaN, average, deviation: Math.sqrt(variance) };
}

function selectedStats(select) {
  return drivers.find((driver) => String(driver.driver_number) === select.value);
}

function renderPaceChart(first, second) {
  const width = 1000;
  const height = 350;
  const margin = { top: 27, right: 25, bottom: 48, left: 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const comparisons = [statsFor(first), statsFor(second)].filter((stats) => stats.laps.length);
  const maxLap = Math.max(2, ...comparisons.flatMap((stats) => stats.laps.map((lap) => Number(lap.lap_number))));
  const deltas = comparisons.flatMap((stats) => stats.laps.map((lap) => Number(lap.lap_duration) - stats.best));
  let maxDelta = Math.max(1, ...deltas);
  let minDelta = Math.min(0, ...deltas);
  if (maxDelta - minDelta < 1) maxDelta = minDelta + 1;
  const x = (lap) => margin.left + ((lap - 1) / Math.max(1, maxLap - 1)) * plotWidth;
  const y = (delta) => margin.top + ((maxDelta - delta) / (maxDelta - minDelta)) * plotHeight;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", `Ritmo por vuelta de ${first.name_acronym} y ${second.name_acronym}, segundos por encima de su vuelta más rápida`);
  svg.replaceChildren();

  for (let index = 0; index <= 4; index += 1) {
    const value = minDelta + ((maxDelta - minDelta) * index) / 4;
    const lineY = y(value);
    svg.append(makeSvg("line", { x1: margin.left, y1: lineY, x2: width - margin.right, y2: lineY, class: "grid-line" }));
    svg.append(makeSvg("text", { x: margin.left - 9, y: lineY + 3, "text-anchor": "end", class: "axis-label" }, `+${value.toFixed(1)}s`));
  }
  const step = maxLap > 45 ? 10 : maxLap > 20 ? 5 : Math.max(1, Math.ceil(maxLap / 8));
  for (let lap = 1; lap <= maxLap; lap += step) {
    const lineX = x(lap);
    svg.append(makeSvg("line", { x1: lineX, y1: margin.top, x2: lineX, y2: height - margin.bottom, class: "grid-line" }));
    svg.append(makeSvg("text", { x: lineX, y: height - 17, "text-anchor": "middle", class: "axis-label" }, lap));
  }
  svg.append(makeSvg("text", { x: margin.left + plotWidth / 2, y: height - 3, "text-anchor": "middle", class: "axis-title" }, "VUELTA"));
  svg.append(makeSvg("text", { x: margin.left, y: 14, class: "axis-title" }, "SEGUNDOS SOBRE LA MEJOR VUELTA"));

  comparisons.forEach((stats, index) => {
    const color = index === 0 ? "#66d9c7" : "#f3bd45";
    const points = stats.laps.map((lap) => ({ lap: Number(lap.lap_number), delta: Number(lap.lap_duration) - stats.best }));
    const path = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.lap).toFixed(1)},${y(point.delta).toFixed(1)}`).join(" ");
    svg.append(makeSvg("path", { d: path, class: "pace-line", stroke: color }));
    points.forEach((point) => {
      const circle = makeSvg("circle", { cx: x(point.lap), cy: y(point.delta), r: 2.5, class: "pace-point", fill: color });
      circle.append(makeSvg("title", {}, `Vuelta ${point.lap} · ${formatTime(stats.laps.find((lap) => Number(lap.lap_number) === point.lap)?.lap_duration)}`));
      svg.append(circle);
    });
    const legendX = margin.left + index * 190;
    svg.append(makeSvg("line", { x1: legendX, y1: height - 31, x2: legendX + 16, y2: height - 31, stroke: color, "stroke-width": 3 }));
    svg.append(makeSvg("text", { x: legendX + 22, y: height - 28, fill: color, class: "chart-legend" }, `${stats.driver.name_acronym} · ${stats.driver.last_name}`));
  });
}

function renderComparison() {
  const first = selectedStats(driverASelect);
  const second = selectedStats(driverBSelect);
  if (!first || !second) return;
  const firstStats = statsFor(first);
  const secondStats = statsFor(second);
  const bestStats = firstStats.best <= secondStats.best ? firstStats : secondStats;
  const averageStats = [firstStats, secondStats].sort((a, b) => a.average - b.average)[0];
  const consistencyStats = [firstStats, secondStats].sort((a, b) => a.deviation - b.deviation)[0];
  document.querySelector("#metric-best").textContent = formatTime(bestStats.best);
  document.querySelector("#metric-best-detail").textContent = `${bestStats.driver.name_acronym} · ${bestStats.driver.full_name}`;
  document.querySelector("#metric-average").textContent = formatTime(averageStats.average);
  document.querySelector("#metric-average-detail").textContent = `${averageStats.driver.name_acronym} · ${averageStats.laps.length} vueltas`;
  document.querySelector("#metric-consistency").textContent = Number.isFinite(consistencyStats.deviation) ? `±${consistencyStats.deviation.toFixed(3)} s` : "—";
  document.querySelector("#metric-consistency-detail").textContent = `${consistencyStats.driver.name_acronym} · menor dispersión`;
  renderPaceChart(first, second);
}

function renderTable() {
  const rows = drivers.map(statsFor).filter((stats) => Number.isFinite(stats.average)).sort((first, second) => first.average - second.average);
  const body = document.querySelector("#pace-table");
  body.replaceChildren();
  rows.forEach((stats, index) => {
    const row = document.createElement("tr");
    const values = [
      String(index + 1),
      `${stats.driver.name_acronym} · ${stats.driver.full_name}`,
      formatTime(stats.best),
      formatTime(stats.average),
      `±${stats.deviation.toFixed(3)} s`,
      String(stats.laps.length),
    ];
    values.forEach((value, cellIndex) => {
      const cell = document.createElement("td");
      if (cellIndex === 1) {
        const identity = document.createElement("span");
        identity.className = "table-driver";
        const swatch = document.createElement("i");
        swatch.className = "table-swatch";
        swatch.style.background = COLORS[index % COLORS.length];
        identity.append(swatch, document.createTextNode(value));
        cell.append(identity);
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    });
    body.append(row);
  });
}

async function loadRace(session) {
  const loadId = ++activeLoadId;
  if (!session) {
    drivers = [];
    lapData = [];
    selectedSession = null;
    dataView.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector("p").textContent = "Elegí una carrera para comparar ritmo y consistencia.";
    document.querySelector("#race-title").textContent = "Comparación de ritmo";
    return;
  }
  selectedSession = session;
  dataView.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = "CARGANDO TIEMPOS DE VUELTA…";
  F1Tools.setStatus(statusLabel, "CARGANDO RITMO", "loading");
  try {
    const [driverRows, laps] = await Promise.all([
      F1Tools.fetchRecords("drivers", { session_key: session.session_key }),
      F1Tools.fetchRecords("laps", { session_key: session.session_key }),
    ]);
    if (loadId !== activeLoadId || selectedSession?.session_key !== session.session_key) return;
    lapData = laps;
    drivers = driverRows.filter((driver) => statsFor(driver).laps.length);
    if (!drivers.length) throw new Error("No hay tiempos de vuelta válidos para comparar en esta carrera.");
    const options = drivers.slice().sort((a, b) => a.name_acronym.localeCompare(b.name_acronym));
    F1Tools.fillSelect(driverASelect, options, "Elegí piloto A", (driver) => driver.driver_number,
      (driver) => `${driver.name_acronym} · ${driver.full_name}`);
    F1Tools.fillSelect(driverBSelect, options, "Elegí piloto B", (driver) => driver.driver_number,
      (driver) => `${driver.name_acronym} · ${driver.full_name}`);
    const selections = options.slice().sort((first, second) => statsFor(first).average - statsFor(second).average);
    driverASelect.value = String(selections[0].driver_number);
    driverBSelect.value = String((selections.find((driver) => driver.driver_number !== selections[0].driver_number) || selections[0]).driver_number);
    document.querySelector("#race-title").textContent = `${session.location || session.meeting_name} · ${seasonSelect.value}`;
    emptyState.hidden = true;
    dataView.hidden = false;
    renderTable();
    renderComparison();
    F1Tools.setStatus(statusLabel, `${drivers.length} PILOTOS · ${laps.length} VUELTAS REGISTRADAS`);
  } catch (error) {
    if (loadId === activeLoadId && selectedSession?.session_key === session.session_key) showError(error);
  }
}

driverASelect.addEventListener("change", renderComparison);
driverBSelect.addEventListener("change", renderComparison);
F1Tools.initializeRacePicker({
  seasonSelect,
  raceSelect,
  status: statusLabel,
  onSelect: loadRace,
  onError: showError,
});
