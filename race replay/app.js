"use strict";

const API_ROOT = "https://api.openf1.org/v1";
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 400;
const MAX_RATE_LIMIT_RETRIES = 2;
const COLORS = ["#66d9c7", "#f3bd45", "#ef5967", "#7d8bff", "#dc83c6", "#59b9ff", "#ff8b4d", "#c3d85a"];
const SVG_NS = "http://www.w3.org/2000/svg";
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

const elements = {
  season: document.querySelector("#season-select"),
  race: document.querySelector("#race-select"),
  status: document.querySelector("#data-status"),
  statusLabel: document.querySelector("#status-label"),
  chartTitle: document.querySelector("#chart-title"),
  raceHeading: document.querySelector("#race-heading"),
  chart: document.querySelector("#position-chart"),
  empty: document.querySelector("#empty-state"),
  play: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  pauseIcon: document.querySelector("#pause-icon"),
  slider: document.querySelector("#lap-slider"),
  speed: document.querySelector("#speed-select"),
  currentLap: document.querySelector("#current-lap"),
  totalLaps: document.querySelector("#total-laps"),
};

const state = {
  races: [],
  drivers: [],
  series: [],
  totalLaps: 0,
  currentLap: 1,
  playing: false,
  animationFrame: 0,
  previousFrame: 0,
  loadId: 0,
};

function setStatus(message, status = "ready") {
  elements.statusLabel.textContent = message;
  elements.status.dataset.state = status;
}

function buildUrl(endpoint, parameters) {
  return `${API_ROOT}/${endpoint}?${new URLSearchParams(parameters)}`;
}

function scheduleRequest(request) {
  const scheduled = requestQueue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    return request();
  });
  requestQueue = scheduled.catch(() => {});
  return scheduled;
}

async function fetchRecords(endpoint, parameters) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      const response = await scheduleRequest(async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          return await fetch(buildUrl(endpoint, parameters), {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timeout);
        }
      });
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        await new Promise((resolve) => window.setTimeout(
          resolve,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1000,
        ));
        continue;
      }
      if (!response.ok) {
        throw new Error(`OpenF1 respondió ${response.status} al consultar ${endpoint}.`);
      }
      const records = await response.json();
      if (!Array.isArray(records)) {
        throw new Error(`OpenF1 devolvió una respuesta no válida para ${endpoint}.`);
      }
      return records;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`La consulta a OpenF1 (${endpoint}) superó el tiempo de espera.`);
      }
      throw error;
    }
  }
  throw new Error(`OpenF1 rechazó varias consultas a ${endpoint}.`);
}

function showError(error) {
  console.error("No se pudo cargar Race Replay:", error);
  stopPlayback();
  elements.empty.hidden = false;
  elements.chart.hidden = true;
  elements.empty.querySelector("p").textContent = error.message || "No se pudieron cargar los datos de esta carrera.";
  setStatus("ERROR AL CARGAR", "error");
}

function setOptions(select, records, placeholder, valueOf, labelOf) {
  select.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  select.append(first);
  for (const record of records) {
    const option = document.createElement("option");
    option.value = String(valueOf(record));
    option.textContent = labelOf(record);
    select.append(option);
  }
  select.disabled = records.length === 0;
}

function formatRace(session) {
  const date = new Date(session.date_start);
  const dateLabel = Number.isNaN(date.getTime())
    ? ""
    : ` · ${new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", timeZone: "UTC" }).format(date).replace(".", "").toUpperCase()}`;
  const location = session.location || session.meeting_name || "Gran Premio";
  return `${location} · ${session.meeting_name || "Race"}${dateLabel}`;
}

async function loadRaces(year) {
  const loadId = ++state.loadId;
  stopPlayback();
  resetChart("CARGANDO CARRERAS");
  elements.race.disabled = true;
  setStatus(`CARGANDO ${year}`, "loading");
  try {
    const sessions = await fetchRecords("sessions", { year, session_name: "Race" });
    if (loadId !== state.loadId) return;
    state.races = sessions
      .filter((session) => session.session_key
        && session.meeting_key
        && session.session_name === "Race"
        && Date.parse(session.date_end || session.date_start) <= Date.now())
      .sort((first, second) => Date.parse(first.date_start) - Date.parse(second.date_start));
    setOptions(
      elements.race,
      state.races,
      state.races.length ? "Elegí una carrera" : `No hay carreras para ${year}`,
      (session) => session.session_key,
      formatRace,
    );
    elements.empty.querySelector("p").textContent = state.races.length
      ? "Elegí una carrera para cargar la clasificación."
      : `OpenF1 no devolvió carreras de Fórmula 1 para ${year}. Probá otra temporada.`;
    elements.raceHeading.textContent = "SELECCIONÁ UNA CARRERA";
    setStatus(state.races.length ? "ELEGÍ UNA CARRERA" : "SIN CARRERAS");
  } catch (error) {
    if (loadId === state.loadId) showError(error);
  }
}

function resetChart(message) {
  state.drivers = [];
  state.series = [];
  state.totalLaps = 0;
  state.currentLap = 1;
  elements.chart.replaceChildren();
  elements.chart.hidden = true;
  elements.empty.hidden = false;
  elements.empty.querySelector("p").textContent = message;
  elements.chartTitle.textContent = "Posiciones por vuelta";
  elements.currentLap.textContent = "--";
  elements.totalLaps.textContent = "/ --";
  elements.slider.disabled = true;
  elements.slider.min = "1";
  elements.slider.max = "1";
  elements.slider.value = "1";
  elements.play.disabled = true;
}

function svgElement(name, attributes = {}, text = "") {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text) node.textContent = text;
  return node;
}

function driverColor(driver, index) {
  return /^[\da-f]{6}$/i.test(driver.team_colour || "")
    ? `#${driver.team_colour}`
    : COLORS[index % COLORS.length];
}

function driverCode(driver) {
  const code = driver.name_acronym || driver.broadcast_name?.replace(/\s+/g, "").slice(0, 3);
  return (code || String(driver.driver_number)).toUpperCase();
}

function makeSeries(drivers, laps, positions, pitStops) {
  const positionByDriver = new Map();
  for (const position of positions) {
    const date = Date.parse(position.date);
    const rank = Number(position.position);
    if (!Number.isFinite(date) || !Number.isInteger(rank)) continue;
    const key = Number(position.driver_number);
    if (!positionByDriver.has(key)) positionByDriver.set(key, []);
    positionByDriver.get(key).push({ date, position: rank });
  }
  for (const records of positionByDriver.values()) records.sort((first, second) => first.date - second.date);

  const lapsByDriver = new Map();
  for (const lap of laps) {
    const driverNumber = Number(lap.driver_number);
    const lapNumber = Number(lap.lap_number);
    const start = Date.parse(lap.date_start);
    if (!Number.isFinite(lapNumber) || !Number.isFinite(start)) continue;
    if (!lapsByDriver.has(driverNumber)) lapsByDriver.set(driverNumber, []);
    lapsByDriver.get(driverNumber).push({
      lap: lapNumber,
      start,
      duration: Number(lap.lap_duration),
    });
  }

  const driverRecords = drivers.slice().sort((first, second) => Number(first.driver_number) - Number(second.driver_number));
  const series = driverRecords.map((driver, index) => {
    const positionRecords = positionByDriver.get(Number(driver.driver_number)) || [];
    const lapRecords = (lapsByDriver.get(Number(driver.driver_number)) || []).sort((first, second) => first.lap - second.lap);
    const driverPitStops = pitStops
      .filter((stop) => Number(stop.driver_number) === Number(driver.driver_number))
      .map((stop) => ({
        lap: Number(stop.lap_number),
        duration: Number(stop.pit_duration),
      }))
      .filter((stop) => Number.isInteger(stop.lap) && stop.lap > 0)
      .sort((first, second) => first.lap - second.lap);
    let positionIndex = -1;
    let lastPosition = null;
    const points = [];
    for (let lapIndex = 0; lapIndex < lapRecords.length; lapIndex += 1) {
      const lap = lapRecords[lapIndex];
      const finish = Number.isFinite(lap.duration) && lap.duration > 0
        ? lap.start + lap.duration * 1000
        : lapRecords[lapIndex + 1]?.start ?? lap.start;
      while (positionIndex + 1 < positionRecords.length && positionRecords[positionIndex + 1].date <= finish) {
        positionIndex += 1;
        lastPosition = positionRecords[positionIndex].position;
      }
      if (lastPosition !== null) points.push({ lap: lap.lap, position: lastPosition });
    }
    if (points.length && positionRecords.length) {
      points[points.length - 1].position = positionRecords[positionRecords.length - 1].position;
    }
    return {
      driver,
      code: driverCode(driver),
      color: driverColor(driver, index),
      points,
      pitStops: driverPitStops,
    };
  }).filter((entry) => entry.points.length > 0);

  return { series, maxLap: Math.max(0, ...laps.map((lap) => Number(lap.lap_number) || 0)) };
}

async function loadRace(sessionKey) {
  const loadId = ++state.loadId;
  stopPlayback();
  resetChart("CARGANDO CLASIFICACIÓN…");
  elements.raceHeading.textContent = "CARGANDO CARRERA";
  setStatus("CARGANDO CLASIFICACIÓN", "loading");
  try {
    const [drivers, laps, positions, pitStops] = await Promise.all([
      fetchRecords("drivers", { session_key: sessionKey }),
      fetchRecords("laps", { session_key: sessionKey }),
      fetchRecords("position", { session_key: sessionKey }),
      fetchRecords("pit", { session_key: sessionKey }),
    ]);
    if (loadId !== state.loadId) return;
    if (!laps.length || !positions.length) {
      throw new Error("OpenF1 no devolvió vueltas o cambios de posición para esta carrera.");
    }

    const race = state.races.find((session) => String(session.session_key) === String(sessionKey));
    const result = makeSeries(drivers, laps, positions, pitStops);
    if (!result.series.length || result.maxLap < 2) {
      throw new Error("No hay suficientes datos de posiciones por vuelta para mostrar esta carrera.");
    }
    state.drivers = result.series;
    state.totalLaps = result.maxLap;
    state.currentLap = 1;
    elements.chartTitle.textContent = `${race?.location || "Carrera"} · ${elements.season.value}`;
    elements.raceHeading.textContent = race ? formatRace(race).toUpperCase() : "CARRERA";
    elements.empty.hidden = true;
    elements.chart.hidden = false;
    elements.slider.disabled = false;
    elements.slider.max = String(state.totalLaps);
    elements.slider.value = "1";
    elements.currentLap.textContent = "1";
    elements.totalLaps.textContent = `/ ${state.totalLaps}`;
    elements.play.disabled = false;
    drawChart();
    renderLap();
    const totalPitStops = state.drivers.reduce((count, driver) => count + driver.pitStops.length, 0);
    setStatus(`${state.drivers.length} PILOTOS · ${state.totalLaps} VUELTAS · ${totalPitStops} PARADAS`);
  } catch (error) {
    if (loadId === state.loadId) showError(error);
  }
}

function drawChart() {
  const width = 1160;
  const height = 560;
  const margin = { top: 27, right: 92, bottom: 55, left: 55 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxPosition = Math.max(1, ...state.drivers.flatMap((entry) => entry.points.map((point) => point.position)));
  const maxLap = state.totalLaps;
  const x = (lap) => margin.left + ((lap - 1) / Math.max(1, maxLap - 1)) * plotWidth;
  const y = (position) => margin.top + ((position - 1) / Math.max(1, maxPosition - 1)) * plotHeight;

  elements.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  elements.chart.setAttribute("aria-label", `Posiciones por vuelta, ${state.drivers.length} pilotos, ${maxLap} vueltas`);
  elements.chart.replaceChildren();
  const grid = svgElement("g", { "aria-hidden": "true" });
  const positionStep = maxPosition > 12 ? 2 : 1;
  for (let position = 1; position <= maxPosition; position += positionStep) {
    const lineY = y(position);
    grid.append(svgElement("line", { x1: margin.left, y1: lineY, x2: width - margin.right, y2: lineY, class: "grid-line" }));
    grid.append(svgElement("text", { x: margin.left - 13, y: lineY + 3, "text-anchor": "end", class: "axis-label" }, position));
  }
  const lapStep = maxLap > 45 ? 10 : maxLap > 20 ? 5 : Math.max(1, Math.ceil(maxLap / 8));
  for (let lap = 1; lap <= maxLap; lap += lapStep) {
    const lineX = x(lap);
    grid.append(svgElement("line", { x1: lineX, y1: margin.top, x2: lineX, y2: margin.top + plotHeight, class: "grid-line vertical-grid" }));
    grid.append(svgElement("text", { x: lineX, y: height - margin.bottom + 20, "text-anchor": "middle", class: "axis-label" }, lap));
  }
  if ((maxLap - 1) % lapStep !== 0 && maxLap > 1) {
    grid.append(svgElement("text", { x: x(maxLap), y: height - margin.bottom + 20, "text-anchor": "middle", class: "axis-label" }, maxLap));
  }
  grid.append(svgElement("text", { x: margin.left + plotWidth / 2, y: height - 9, "text-anchor": "middle", class: "axis-title" }, "VUELTA"));
  grid.append(svgElement("text", { x: 15, y: margin.top + plotHeight / 2, "text-anchor": "middle", class: "axis-title", transform: `rotate(-90 15 ${margin.top + plotHeight / 2})` }, "POSICIÓN"));
  elements.chart.append(grid);

  const plot = svgElement("g");
  state.drivers.forEach((entry, index) => {
    const path = svgElement("path", { class: "position-line", stroke: entry.color, "data-driver-index": index });
    const dot = svgElement("circle", { class: "current-dot", r: 4, fill: entry.color, "data-driver-index": index, hidden: true });
    plot.append(path, dot);
  });
  state.drivers.forEach((entry, index) => {
    const label = svgElement("g", { class: "driver-label-group", "data-driver-index": index });
    const labelWidth = entry.code.length * 7 + 10;
    const background = svgElement("rect", {
      class: "driver-label-background",
      x: 0,
      y: -7,
      width: labelWidth,
      height: 14,
      rx: 2,
      fill: "#080a0c",
      stroke: entry.color,
    });
    const text = svgElement("text", { class: "driver-label", x: 5, y: 3.5, fill: entry.color }, entry.code);
    label.append(background, text);
    plot.append(label);
  });
  const pitLayer = svgElement("g", { class: "pit-stop-layer", "aria-label": "Paradas en boxes" });
  state.drivers.forEach((entry, index) => {
    for (const [stopIndex, stop] of entry.pitStops.entries()) {
      const point = entry.points.reduce((nearest, candidate) => (
        Math.abs(candidate.lap - stop.lap) < Math.abs(nearest.lap - stop.lap) ? candidate : nearest
      ), entry.points[0]);
      if (!point) continue;
      const marker = svgElement("path", {
        class: "pit-stop-marker",
        d: "M0 -6 L6 0 L0 6 L-6 0 Z",
        transform: `translate(${x(stop.lap)} ${y(point.position)})`,
        "data-driver-index": index,
        "data-stop-index": stopIndex,
        hidden: true,
      });
      const duration = Number.isFinite(stop.duration) ? ` · ${stop.duration.toFixed(1)} s` : "";
      marker.append(svgElement("title", {}, `${entry.driver.full_name} · Vuelta ${stop.lap}${duration}`));
      pitLayer.append(marker);
    }
  });
  plot.append(pitLayer);
  const cursor = svgElement("line", { class: "lap-cursor", y1: margin.top, y2: margin.top + plotHeight });
  plot.append(cursor);
  elements.chart.append(plot);
  elements.chart.dataset.plotLeft = String(margin.left);
  elements.chart.dataset.plotTop = String(margin.top);
  elements.chart.dataset.plotWidth = String(plotWidth);
  elements.chart.dataset.plotHeight = String(plotHeight);
  elements.chart.dataset.maxPosition = String(maxPosition);
  elements.chart.dataset.maxLap = String(maxLap);
  elements.chart.dataset.width = String(width);
  elements.chart.dataset.height = String(height);
  elements.chart.dataset.marginRight = String(margin.right);
  elements.chart.dataset.marginBottom = String(margin.bottom);
  renderLap();
}

function renderLap() {
  if (!state.drivers.length) return;
  const width = Number(elements.chart.dataset.width);
  const marginLeft = Number(elements.chart.dataset.plotLeft);
  const marginTop = Number(elements.chart.dataset.plotTop);
  const plotWidth = Number(elements.chart.dataset.plotWidth);
  const maxPosition = Number(elements.chart.dataset.maxPosition);
  const maxLap = Number(elements.chart.dataset.maxLap);
  const plotHeight = Number(elements.chart.dataset.plotHeight);
  const x = (lap) => marginLeft + ((lap - 1) / Math.max(1, maxLap - 1)) * plotWidth;
  const y = (position) => marginTop + ((position - 1) / Math.max(1, maxPosition - 1)) * plotHeight;

  state.drivers.forEach((entry, index) => {
    const visiblePoints = entry.points.filter((point) => point.lap <= state.currentLap);
    const path = elements.chart.querySelector(`.position-line[data-driver-index="${index}"]`);
    const dot = elements.chart.querySelector(`.current-dot[data-driver-index="${index}"]`);
    const label = elements.chart.querySelector(`.driver-label-group[data-driver-index="${index}"]`);
    if (!visiblePoints.length) {
      path.setAttribute("d", "");
      dot.setAttribute("hidden", "");
      label.textContent = "";
      return;
    }
    const previous = visiblePoints[visiblePoints.length - 1];
    const next = entry.points.find((point) => point.lap > state.currentLap);
    let latest = previous;
    if (next) {
      const progress = (state.currentLap - previous.lap) / (next.lap - previous.lap);
      latest = {
        lap: state.currentLap,
        position: previous.position + (next.position - previous.position) * progress,
      };
    }
    const pathPoints = [
      ...visiblePoints.slice(0, -1),
      latest,
    ];
    const pathData = pathPoints
      .map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point.lap).toFixed(1)},${y(point.position).toFixed(1)}`)
      .join(" ");
    path.setAttribute("d", pathData);
    dot.removeAttribute("hidden");
    dot.setAttribute("cx", x(latest.lap));
    dot.setAttribute("cy", y(latest.position));
    label.setAttribute("transform", `translate(${Math.min(width - 24, x(latest.lap) + 8)} ${y(latest.position)})`);
  });
  elements.chart.querySelectorAll(".pit-stop-marker").forEach((marker) => {
    const driverIndex = Number(marker.dataset.driverIndex);
    const stopIndex = Number(marker.dataset.stopIndex);
    const stop = state.drivers[driverIndex]?.pitStops[stopIndex];
    if (stop && stop.lap <= state.currentLap) marker.removeAttribute("hidden");
    else marker.setAttribute("hidden", "");
  });
  const cursor = elements.chart.querySelector(".lap-cursor");
  cursor.setAttribute("x1", x(state.currentLap));
  cursor.setAttribute("x2", x(state.currentLap));
  elements.currentLap.textContent = String(Math.floor(state.currentLap));
  elements.slider.value = state.currentLap.toFixed(1);
}

function stopPlayback() {
  state.playing = false;
  window.cancelAnimationFrame(state.animationFrame);
  state.previousFrame = 0;
  elements.playIcon.hidden = false;
  elements.pauseIcon.hidden = true;
  elements.play.setAttribute("aria-label", "Reproducir animación");
}

function advance(timestamp) {
  if (!state.playing) return;
  if (!state.previousFrame) {
    state.previousFrame = timestamp;
  } else {
    const elapsed = Math.min(timestamp - state.previousFrame, 50);
    state.previousFrame = timestamp;
    state.currentLap = Math.min(state.totalLaps, state.currentLap + elapsed / Number(elements.speed.value));
    renderLap();
  }
  if (state.currentLap >= state.totalLaps) {
    stopPlayback();
    return;
  }
  state.animationFrame = window.requestAnimationFrame(advance);
}

function togglePlayback() {
  if (!state.drivers.length) return;
  if (state.playing) {
    stopPlayback();
    return;
  }
  if (state.currentLap >= state.totalLaps) {
    state.currentLap = 1;
    renderLap();
  }
  state.playing = true;
  state.previousFrame = 0;
  elements.playIcon.hidden = true;
  elements.pauseIcon.hidden = false;
  elements.play.setAttribute("aria-label", "Pausar animación");
  state.animationFrame = window.requestAnimationFrame(advance);
}

elements.season.addEventListener("change", () => loadRaces(elements.season.value));
elements.race.addEventListener("change", () => {
  if (elements.race.value) loadRace(elements.race.value);
  else {
    stopPlayback();
    resetChart("Elegí una carrera para cargar la clasificación.");
  }
});
elements.play.addEventListener("click", togglePlayback);
elements.slider.addEventListener("input", () => {
  stopPlayback();
  state.currentLap = Number(elements.slider.value);
  renderLap();
});

loadRaces(elements.season.value);
