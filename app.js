"use strict";

const API_ROOT = "https://api.openf1.org/v1";
const SEASON = 2026;
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 400;
const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_MEETING_NAME = "Austrian Grand Prix";
const DEFAULT_DRIVERS = ["ANT", "HAM"];
const MAP_CACHE = new Map();
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

const elements = {
  meeting: document.querySelector("#meeting-select"),
  session: document.querySelector("#session-select"),
  driverA: document.querySelector("#driver-a-select"),
  driverB: document.querySelector("#driver-b-select"),
  dataStatus: document.querySelector("#data-status"),
  statusLabel: document.querySelector("#status-label"),
  circuitName: document.querySelector("#circuit-name"),
  trackWatermark: document.querySelector("#track-watermark"),
  map: document.querySelector("#osm-map"),
  mapToggle: document.querySelector("#map-toggle"),
  mapError: document.querySelector("#map-error"),
  trackStage: document.querySelector("#track-stage"),
  trackMap: document.querySelector("#track-map"),
  trackLayers: document.querySelector("#track-layers"),
  trackShadow: document.querySelector("#track-shadow"),
  trackBase: document.querySelector("#track-base"),
  trackOverlay: document.querySelector("#track-overlay"),
  overlayMessage: document.querySelector("#overlay-message"),
  retryButton: document.querySelector("#retry-button"),
  driverAMarker: document.querySelector("#driver-a-marker"),
  driverBMarker: document.querySelector("#driver-b-marker"),
  driverAProgress: document.querySelector("#driver-a-progress"),
  driverBProgress: document.querySelector("#driver-b-progress"),
  playButton: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  pauseIcon: document.querySelector("#pause-icon"),
  seek: document.querySelector("#lap-seek"),
  elapsed: document.querySelector("#elapsed-time"),
  duration: document.querySelector("#duration-label"),
  speed: document.querySelector("#playback-speed"),
  gap: document.querySelector("#comparison-gap"),
  gapPanel: document.querySelector("#comparison-gap-panel"),
  leader: document.querySelector("#comparison-leader"),
};

const state = {
  meetings: [],
  sessions: [],
  drivers: [],
  meeting: null,
  session: null,
  driverA: null,
  driverB: null,
  lapA: null,
  lapB: null,
  locationsA: [],
  locationsB: [],
  pointsA: [],
  pointsB: [],
  carDataA: [],
  carDataB: [],
  lapStartA: 0,
  lapStartB: 0,
  duration: 0,
  position: 0,
  speed: 4,
  playing: false,
  loadId: 0,
  map: null,
  mapBounds: null,
};

function buildUrl(endpoint, parameters) {
  return `${API_ROOT}/${endpoint}?${new URLSearchParams(parameters)}`;
}

function scheduleRequest(request) {
  const scheduled = requestQueue.then(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, wait));
    }
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

function setStatus(message, status = "ready") {
  elements.statusLabel.textContent = message;
  elements.dataStatus.dataset.state = status;
}

function setBusy(isBusy, message = "CARGANDO DATOS") {
  setStatus(message, isBusy ? "loading" : "ready");
  elements.playButton.disabled = isBusy || state.pointsA.length < 2;
  elements.seek.disabled = isBusy || state.pointsA.length < 2;
  elements.speed.disabled = isBusy || state.pointsA.length < 2;
}

function showError(error) {
  console.error("No se pudo cargar la comparación de vueltas:", error);
  state.playing = false;
  elements.overlayMessage.textContent = error.message || "Ocurrió un error al cargar estos datos.";
  elements.trackOverlay.hidden = false;
  setBusy(false);
  setStatus("ERROR AL CARGAR", "error");
}

function clearError() {
  elements.trackOverlay.hidden = true;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--.---";
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}

function formatSector(seconds) {
  return Number.isFinite(seconds) ? seconds.toFixed(3) : "--.---";
}

function formatGap(seconds, withUnit = false) {
  const sign = seconds >= 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(3)}${withUnit ? " s" : ""}`;
}

function fastestLap(laps) {
  return laps
    .filter((lap) => Number.isFinite(lap.lap_duration)
      && lap.lap_duration > 0
      && lap.lap_duration < 180
      && lap.is_pit_out_lap !== true)
    .sort((first, second) => first.lap_duration - second.lap_duration)[0];
}

function teamBright(color) {
  const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16));
  if (!channels || channels.length !== 3) {
    return "#dedfe3";
  }
  return `#${channels.map((channel) => Math.round(channel + (255 - channel) * 0.36)
    .toString(16).padStart(2, "0")).join("")}`;
}

function setDriverColor(side, driver) {
  const root = document.documentElement;
  const base = /^[\da-f]{6}$/i.test(driver.team_colour ?? "")
    ? `#${driver.team_colour}`
    : side === "a" ? "#51b6e8" : "#bf8cff";
  root.style.setProperty(`--driver-${side}`, base);
  root.style.setProperty(`--driver-${side}-bright`, teamBright(base.slice(1)));
  root.style.setProperty(`--driver-${side}-wash`, `${base}22`);
}

function populateSelect(select, records, label, getValue, getLabel) {
  select.replaceChildren();
  records.forEach((record, index) => {
    const option = document.createElement("option");
    option.value = getValue(record);
    option.textContent = getLabel(record, index);
    select.append(option);
  });
  select.disabled = records.length === 0;
  if (records.length === 0) {
    const option = document.createElement("option");
    option.textContent = label;
    select.append(option);
  }
}

function meetingLabel(meeting, index) {
  const location = meeting.location || meeting.country_name || meeting.meeting_name;
  return `${String(index + 1).padStart(2, "0")}  ${location} · ${meeting.meeting_name.replace(/ Grand Prix$/, " GP")}`;
}

function sessionLabel(session) {
  const date = new Date(session.date_start);
  const formattedDate = new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(date).replace(".", "").toUpperCase();
  return `${session.session_name} · ${formattedDate}`;
}

function driverLabel(driver) {
  return `#${String(driver.driver_number).padStart(2, "0")}  ${driver.full_name} · ${driver.team_name}`;
}

function circuitDisplayName(meeting) {
  if (meeting.circuit_short_name === "Spielberg") {
    return "Red Bull Ring";
  }
  return meeting.circuit_short_name;
}

async function loadMeetings() {
  setStatus("CARGANDO TEMPORADA", "loading");
  const meetings = await fetchRecords("meetings", { year: SEASON });
  state.meetings = meetings
    .filter((meeting) => meeting.meeting_key && meeting.meeting_name)
    .sort((first, second) => Date.parse(first.date_start) - Date.parse(second.date_start));
  if (state.meetings.length === 0) {
    throw new Error(`OpenF1 no devolvió meetings para la temporada ${SEASON}.`);
  }

  populateSelect(
    elements.meeting,
    state.meetings,
    "No hay meetings para 2026",
    (meeting) => String(meeting.meeting_key),
    meetingLabel,
  );
  const defaultMeeting = state.meetings.find((meeting) => meeting.meeting_name === DEFAULT_MEETING_NAME)
    || state.meetings[0];
  elements.meeting.value = String(defaultMeeting.meeting_key);
  await loadSessions(defaultMeeting.meeting_key, true);
}

async function loadSessions(meetingKey, useExampleDefaults = false) {
  setBusy(true, "CARGANDO SESIONES");
  elements.session.disabled = true;
  elements.driverA.disabled = true;
  elements.driverB.disabled = true;
  state.meeting = state.meetings.find((meeting) => meeting.meeting_key === Number(meetingKey));
  const sessions = await fetchRecords("sessions", { meeting_key: meetingKey });
  if (String(meetingKey) !== elements.meeting.value) return;
  state.sessions = sessions.sort((first, second) => Date.parse(first.date_start) - Date.parse(second.date_start));
  if (state.sessions.length === 0) {
    throw new Error("No hay sesiones de OpenF1 para este meeting.");
  }

  populateSelect(
    elements.session,
    state.sessions,
    "No hay sesiones",
    (session) => String(session.session_key),
    sessionLabel,
  );
  const preferred = useExampleDefaults
    ? state.sessions.find((session) => session.session_name === "Practice 1")
    : null;
  const session = preferred || state.sessions[0];
  elements.session.value = String(session.session_key);
  await loadSession(session.session_key, useExampleDefaults);
}

async function loadSession(sessionKey, useExampleDefaults = false) {
  setBusy(true, "CARGANDO PILOTOS");
  elements.driverA.disabled = true;
  elements.driverB.disabled = true;
  state.session = state.sessions.find((session) => session.session_key === Number(sessionKey));
  const drivers = await fetchRecords("drivers", { session_key: sessionKey });
  if (String(sessionKey) !== elements.session.value) return;
  state.drivers = drivers.filter((driver) => Number.isFinite(driver.driver_number))
    .sort((first, second) => first.driver_number - second.driver_number);
  if (state.drivers.length < 2) {
    throw new Error("No hay dos pilotos disponibles en esta sesión.");
  }

  populateSelect(elements.driverA, state.drivers, "No hay pilotos", (driver) => String(driver.driver_number), driverLabel);
  populateSelect(elements.driverB, state.drivers, "No hay pilotos", (driver) => String(driver.driver_number), driverLabel);

  const defaults = useExampleDefaults
    ? DEFAULT_DRIVERS.map((acronym) => state.drivers.find((driver) => driver.name_acronym === acronym))
    : [];
  const driverA = defaults[0] || state.drivers[0];
  const driverB = defaults[1] || state.drivers.find((driver) => driver.driver_number !== driverA.driver_number);
  elements.driverA.value = String(driverA.driver_number);
  elements.driverB.value = String(driverB.driver_number);
  await loadComparison();
}

function selectedDrivers() {
  return [
    state.drivers.find((driver) => driver.driver_number === Number(elements.driverA.value)),
    state.drivers.find((driver) => driver.driver_number === Number(elements.driverB.value)),
  ];
}

async function loadComparison() {
  const loadId = ++state.loadId;
  const [driverA, driverB] = selectedDrivers();
  if (!state.session || !driverA || !driverB) {
    return;
  }
  if (driverA.driver_number === driverB.driver_number) {
    showError(new Error("Elegí dos pilotos distintos para comparar."));
    return;
  }

  clearError();
  setBusy(true, "CARGANDO VUELTAS");
  state.playing = false;
  elements.playIcon.hidden = false;
  elements.pauseIcon.hidden = true;
  elements.trackLayers.hidden = true;
  state.driverA = driverA;
  state.driverB = driverB;

  try {
    const [lapsA, lapsB] = await Promise.all([
      fetchRecords("laps", { session_key: state.session.session_key, driver_number: driverA.driver_number }),
      fetchRecords("laps", { session_key: state.session.session_key, driver_number: driverB.driver_number }),
    ]);
    const lapA = fastestLap(lapsA);
    const lapB = fastestLap(lapsB);
    if (!lapA || !lapB) {
      throw new Error("No se encontraron vueltas rápidas válidas para ambos pilotos en esta sesión.");
    }

    const [locationA, carA, locationB, carB] = await Promise.all([
      fetchLapData("location", driverA.driver_number, lapA),
      fetchLapData("car_data", driverA.driver_number, lapA),
      fetchLapData("location", driverB.driver_number, lapB),
      fetchLapData("car_data", driverB.driver_number, lapB),
    ]);
    if (loadId !== state.loadId) {
      return;
    }

    const cleanLocationA = validLocations(locationA);
    const cleanLocationB = validLocations(locationB);
    if (cleanLocationA.length < 2 || cleanLocationB.length < 2) {
      throw new Error("OpenF1 no devolvió suficientes posiciones GPS para reconstruir las dos vueltas.");
    }

    state.lapA = lapA;
    state.lapB = lapB;
    state.locationsA = cleanLocationA;
    state.locationsB = cleanLocationB;
    state.carDataA = validCarData(carA);
    state.carDataB = validCarData(carB);
    if (state.carDataA.length === 0 || state.carDataB.length === 0) {
      throw new Error("OpenF1 no devolvió telemetría suficiente para ambos pilotos.");
    }
    state.lapStartA = Date.parse(lapA.date_start);
    state.lapStartB = Date.parse(lapB.date_start);
    state.duration = Math.max(lapA.lap_duration, lapB.lap_duration);
    state.position = 0;

    const projected = projectTrackPoints([...cleanLocationA, ...cleanLocationB]);
    state.pointsA = addCumulativeDistance(projected.slice(0, cleanLocationA.length));
    state.pointsB = addCumulativeDistance(projected.slice(cleanLocationA.length));
    drawTrack();
    renderDriver("a", driverA, lapA);
    renderDriver("b", driverB, lapB);
    renderComparison();
    updateMap(loadId).catch((error) => {
      if (loadId === state.loadId) {
        console.error("No se pudo ubicar el mapa base del circuito:", error);
        elements.mapError.textContent = error.message;
        elements.mapError.hidden = false;
      }
    });
    renderProgress(0);
    elements.trackLayers.hidden = false;
    elements.duration.textContent = formatTime(state.duration);
    setBusy(false, "DATOS VERIFICADOS");
  } catch (error) {
    if (loadId === state.loadId) {
      showError(error);
    }
  }
}

async function fetchLapData(endpoint, driverNumber, lap) {
  const start = Date.parse(lap.date_start);
  return fetchRecords(endpoint, {
    session_key: state.session.session_key,
    driver_number: driverNumber,
    "date>": new Date(start).toISOString(),
    "date<": new Date(start + lap.lap_duration * 1000).toISOString(),
  });
}

function validLocations(locations) {
  return locations
    .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y) && sample.date)
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
}

function validCarData(samples) {
  return samples
    .filter((sample) => sample.date && Number.isFinite(sample.speed))
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
}

function projectTrackPoints(locations) {
  const xs = locations.map((point) => point.x);
  const ys = locations.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width === 0 || height === 0) {
    throw new Error("Las posiciones recibidas no alcanzan para dibujar el circuito.");
  }

  const scale = Math.min(850 / width, 550 / height);
  const offsetX = (1000 - width * scale) / 2;
  const offsetY = (700 - height * scale) / 2;
  return locations.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: 700 - (offsetY + (point.y - minY) * scale),
    date: point.date,
  }));
}

function addCumulativeDistance(points) {
  let distance = 0;
  return points.map((point, index) => {
    if (index > 0) {
      distance += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    }
    return { ...point, distance };
  });
}

function pointsToPath(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function drawTrack() {
  const pathA = pointsToPath(state.pointsA);
  const pathB = pointsToPath(state.pointsB);
  elements.trackBase.setAttribute("d", pathA);
  elements.trackShadow.setAttribute("d", pathA);
  document.querySelector("#driver-a-track").setAttribute("d", pathA);
  document.querySelector("#driver-b-track").setAttribute("d", pathB);
  document.querySelector("#driver-a-progress").setAttribute("d", pointsToPath(state.pointsA.slice(0, 1)));
  document.querySelector("#driver-b-progress").setAttribute("d", pointsToPath(state.pointsB.slice(0, 1)));
  elements.trackLayers.hidden = false;
}

function positionAtElapsed(points, lap, elapsed) {
  const last = points.length - 1;
  const totalDistance = points[last].distance;
  if (elapsed >= lap.lap_duration) {
    return { index: last, point: points[last], next: points[last], distanceFraction: 1 };
  }

  const timestamp = Date.parse(lap.date_start) + elapsed * 1000;
  let low = 0;
  let high = last;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(points[middle].date) < timestamp) low = middle + 1;
    else high = middle;
  }

  const nextIndex = low;
  const previousIndex = Math.max(0, nextIndex - 1);
  const previous = points[previousIndex];
  const next = points[nextIndex];
  const timeSpan = Date.parse(next.date) - Date.parse(previous.date);
  const fraction = timeSpan === 0 ? 0 : Math.max(0, Math.min(1, (timestamp - Date.parse(previous.date)) / timeSpan));
  const distance = previous.distance + (next.distance - previous.distance) * fraction;
  return {
    index: previousIndex,
    point: {
      x: previous.x + (next.x - previous.x) * fraction,
      y: previous.y + (next.y - previous.y) * fraction,
    },
    next,
    distanceFraction: totalDistance > 0 ? distance / totalDistance : 0,
  };
}

function elapsedAtDistance(points, lap, fraction) {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return lap.lap_duration;
  const target = fraction * points[points.length - 1].distance;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].distance < target) low = middle + 1;
    else high = middle;
  }
  const next = points[low];
  const previous = points[Math.max(0, low - 1)];
  const fractionOnSegment = next.distance === previous.distance
    ? 0
    : (target - previous.distance) / (next.distance - previous.distance);
  const timestamp = Date.parse(previous.date)
    + (Date.parse(next.date) - Date.parse(previous.date)) * fractionOnSegment;
  return Math.max(0, Math.min(lap.lap_duration, (timestamp - Date.parse(lap.date_start)) / 1000));
}

function positionMarker(element, position) {
  const heading = Math.atan2(position.next.y - position.point.y, position.next.x - position.point.x) * 180 / Math.PI;
  element.setAttribute("transform", `translate(${position.point.x.toFixed(2)} ${position.point.y.toFixed(2)}) rotate(${heading.toFixed(1)})`);
}

function closestSample(samples, timestamp) {
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(samples[middle].date) < timestamp) low = middle + 1;
    else high = middle;
  }
  const after = samples[low];
  const before = samples[Math.max(0, low - 1)];
  return Math.abs(Date.parse(before.date) - timestamp) <= Math.abs(Date.parse(after.date) - timestamp)
    ? before
    : after;
}

function renderPedal(side, name, value) {
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  document.querySelector(`#driver-${side}-${name}`).textContent = percent === null ? "--" : String(Math.round(percent));
  document.querySelector(`#driver-${side}-${name}-bar`).style.width = `${percent ?? 0}%`;
}

function renderTelemetry(side, samples, start, elapsed) {
  const sample = closestSample(samples, start + elapsed * 1000);
  document.querySelector(`#driver-${side}-speed`).textContent = String(Math.round(sample.speed));
  document.querySelector(`#driver-${side}-gear`).textContent = Number.isFinite(sample.n_gear) ? String(sample.n_gear) : "-";
  document.querySelector(`#driver-${side}-rpm`).textContent = Number.isFinite(sample.rpm)
    ? sample.rpm.toLocaleString("es-AR")
    : "----";
  renderPedal(side, "throttle", sample.throttle);
  renderPedal(side, "brake", sample.brake);
}

function renderProgress(progress) {
  if (state.pointsA.length < 2 || state.pointsB.length < 2) return;
  state.position = Math.max(0, Math.min(state.duration, progress));
  const elapsedA = Math.min(state.position, state.lapA.lap_duration);
  const elapsedB = Math.min(state.position, state.lapB.lap_duration);
  const positionA = positionAtElapsed(state.pointsA, state.lapA, elapsedA);
  const positionB = positionAtElapsed(state.pointsB, state.lapB, elapsedB);
  const prefixA = state.pointsA.slice(0, positionA.index + 1);
  const prefixB = state.pointsB.slice(0, positionB.index + 1);
  prefixA.push(positionA.point);
  prefixB.push(positionB.point);
  document.querySelector("#driver-a-progress").setAttribute("d", pointsToPath(prefixA));
  document.querySelector("#driver-b-progress").setAttribute("d", pointsToPath(prefixB));
  positionMarker(elements.driverAMarker, positionA);
  positionMarker(elements.driverBMarker, positionB);

  const equivalentB = elapsedAtDistance(state.pointsB, state.lapB, positionA.distanceFraction);
  const gap = equivalentB - elapsedA;
  elements.gap.textContent = formatGap(gap, true);
  elements.leader.textContent = Math.abs(gap) < 0.005
    ? "EMPATE EN PISTA"
    : `VENTAJA ${gap > 0 ? state.driverA.last_name : state.driverB.last_name}`.toUpperCase();
  elements.gapPanel.classList.toggle("driver-a-leading", gap > 0.005);
  elements.gapPanel.classList.toggle("driver-b-leading", gap < -0.005);
  elements.elapsed.textContent = formatTime(state.position);
  const fraction = (state.position / state.duration) * 100;
  elements.seek.value = String(fraction);
  elements.seek.style.setProperty("--seek-progress", `${fraction}%`);
  renderTelemetry("a", state.carDataA, state.lapStartA, elapsedA);
  renderTelemetry("b", state.carDataB, state.lapStartB, elapsedB);
}

function renderDriver(side, driver, lap) {
  const id = (name) => document.querySelector(`#driver-${side}-${name}`);
  id("number").textContent = String(driver.driver_number).padStart(2, "0");
  id("avatar").textContent = driver.name_acronym || driver.first_name.slice(0, 1);
  id("first").textContent = driver.first_name.toUpperCase();
  id("last").textContent = driver.last_name.toUpperCase();
  id("team").textContent = driver.team_name.toUpperCase();
  id("result").textContent = "MEJOR VUELTA";
  id("position").textContent = "FASTEST";
  id("time").textContent = formatTime(lap.lap_duration);
  id("lap").textContent = String(lap.lap_number).padStart(2, "0");
  id("date").textContent = new Intl.DateTimeFormat("es-AR", {
    day: "2-digit", month: "short", timeZone: "UTC",
  }).format(new Date(lap.date_start)).replace(".", "").toUpperCase();
  id("s1").textContent = formatSector(lap.duration_sector_1);
  id("s2").textContent = formatSector(lap.duration_sector_2);
  id("s3").textContent = formatSector(lap.duration_sector_3);
  id("telemetry-tag").textContent = `${driver.name_acronym || side.toUpperCase()} #${driver.driver_number}`;
  setDriverColor(side, driver);
}

function renderComparison() {
  const first = state.driverA;
  const second = state.driverB;
  const a = state.lapA;
  const b = state.lapB;
  const put = (selector, text) => { document.querySelector(selector).textContent = text; };
  put("#comparison-a-name", `${first.full_name.toUpperCase()} · #${first.driver_number}`);
  put("#comparison-b-name", `${second.full_name.toUpperCase()} · #${second.driver_number}`);
  put("#comparison-a-time", formatTime(a.lap_duration));
  put("#comparison-b-time", formatTime(b.lap_duration));
  put("#comparison-a-lap", String(a.lap_number).padStart(2, "0"));
  put("#comparison-b-lap", String(b.lap_number).padStart(2, "0"));
  put("#sector-a-heading", first.name_acronym);
  put("#sector-b-heading", second.name_acronym);
  put("#comparison-session-label", `${state.session.session_name.toUpperCase()} · MEJOR VUELTA`);
  put("#legend-a", `${first.name_acronym} #${first.driver_number}`);
  put("#legend-b", `${second.name_acronym} #${second.driver_number}`);
  const circuitName = circuitDisplayName(state.meeting);
  const location = circuitName.toLowerCase() === state.meeting.location.toLowerCase()
    ? state.meeting.country_name
    : state.meeting.location;
  put("#circuit-name", `${circuitName} · ${location}`);
  put("#track-watermark", state.meeting.circuit_short_name.toUpperCase());
  document.querySelector("#track-map").setAttribute(
    "aria-label",
    `Trazas de ${first.full_name} y ${second.full_name} en ${state.meeting.circuit_short_name}`,
  );
  document.querySelectorAll("[data-sector-index]").forEach((row) => {
    const index = Number(row.dataset.sectorIndex);
    const sectorA = [a.duration_sector_1, a.duration_sector_2, a.duration_sector_3][index];
    const sectorB = [b.duration_sector_1, b.duration_sector_2, b.duration_sector_3][index];
    row.children[1].textContent = formatSector(sectorA);
    row.children[2].textContent = formatSector(sectorB);
    row.children[3].textContent = Number.isFinite(sectorA) && Number.isFinite(sectorB)
      ? formatGap(sectorB - sectorA)
      : "--.---";
    row.classList.toggle("driver-a-faster", Number.isFinite(sectorA) && sectorA < sectorB);
    row.classList.toggle("driver-b-faster", Number.isFinite(sectorB) && sectorB < sectorA);
  });
}

async function updateMap(loadId) {
  if (!window.L) {
    elements.mapError.textContent = "No se pudo iniciar Leaflet para mostrar el mapa.";
    elements.mapError.hidden = false;
    return;
  }
  if (!state.map) {
    state.map = window.L.map(elements.map, {
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomSnap: 0.01,
    });
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
    }).addTo(state.map)
      .on("tileerror", () => {
        elements.mapError.textContent = "No se pudieron cargar algunos mosaicos de OpenStreetMap.";
        elements.mapError.hidden = false;
      })
      .on("tileload", () => { elements.mapError.hidden = true; });
  }

  const meetingKey = state.meeting.meeting_key;
  if (!MAP_CACHE.has(meetingKey)) MAP_CACHE.set(meetingKey, findMapBounds(state.meeting));
  state.mapBounds = await MAP_CACHE.get(meetingKey);
  if (loadId !== state.loadId) return;
  if (state.mapBounds) {
    state.map.fitBounds(state.mapBounds, { animate: false, padding: [18, 18] });
  } else {
    elements.mapError.textContent = "No se encontró el circuito en OpenStreetMap.";
    elements.mapError.hidden = false;
  }
  window.requestAnimationFrame(() => state.map.invalidateSize());
}

async function findMapBounds(meeting) {
  const circuitQuery = `${circuitDisplayName(meeting)} circuit, ${meeting.location}, ${meeting.country_name}`;
  for (const query of [circuitQuery, `${meeting.location}, ${meeting.country_name}`]) {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
    })}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`OpenStreetMap no pudo ubicar ${meeting.circuit_short_name} (${response.status}).`);
    }
    const results = await response.json();
    const result = results[0];
    if (result?.boundingbox?.length === 4) {
      const [south, north, west, east] = result.boundingbox.map(Number);
      return [[south, west], [north, east]];
    }
  }
  return null;
}

function setMapVisible(visible) {
  elements.trackStage.classList.toggle("map-visible", visible);
  elements.map.setAttribute("aria-hidden", String(!visible));
  if (visible && state.map) {
    window.requestAnimationFrame(() => state.map.invalidateSize());
  }
}

function animate(timestamp) {
  if (!state.playing) return;
  if (!animate.previousTimestamp) animate.previousTimestamp = timestamp;
  const delta = timestamp - animate.previousTimestamp;
  animate.previousTimestamp = timestamp;
  const next = state.position + (delta / 1000) * state.speed;
  if (next >= state.duration) {
    renderProgress(state.duration);
    setPlaying(false);
    animate.previousTimestamp = 0;
    return;
  }
  renderProgress(next);
  window.requestAnimationFrame(animate);
}

function setPlaying(playing) {
  state.playing = playing;
  elements.playIcon.hidden = playing;
  elements.pauseIcon.hidden = !playing;
  elements.playButton.setAttribute("aria-label", playing ? "Pausar vueltas" : "Reproducir vueltas");
}

elements.meeting.addEventListener("change", async () => {
  try {
    await loadSessions(elements.meeting.value);
  } catch (error) {
    showError(error);
  }
});

elements.session.addEventListener("change", async () => {
  try {
    await loadSession(elements.session.value);
  } catch (error) {
    showError(error);
  }
});

elements.driverA.addEventListener("change", loadComparison);
elements.driverB.addEventListener("change", loadComparison);

elements.playButton.addEventListener("click", () => {
  if (state.playing) {
    setPlaying(false);
    animate.previousTimestamp = 0;
    return;
  }
  if (state.position >= state.duration) renderProgress(0);
  state.speed = Number(elements.speed.value);
  setPlaying(true);
  window.requestAnimationFrame(animate);
});

elements.seek.addEventListener("input", () => {
  const wasPlaying = state.playing;
  setPlaying(false);
  animate.previousTimestamp = 0;
  renderProgress((Number(elements.seek.value) / 100) * state.duration);
  if (wasPlaying) {
    setPlaying(true);
    window.requestAnimationFrame(animate);
  }
});

elements.speed.addEventListener("change", () => {
  state.speed = Number(elements.speed.value);
});

elements.mapToggle.addEventListener("change", () => setMapVisible(elements.mapToggle.checked));
elements.retryButton.addEventListener("click", loadComparison);
window.addEventListener("resize", () => {
  if (state.map) window.setTimeout(() => state.map.invalidateSize(), 100);
});

setMapVisible(elements.mapToggle.checked);
loadMeetings().catch(showError);
