"use strict";

const API_ROOT = "https://api.openf1.org/v1";
const SESSION_KEY = 11357;
const DRIVER_NUMBER = 10;
const COMPARISON_DRIVER_NUMBER = 18;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RATE_LIMIT_RETRIES = 2;

const elements = {
  carMarker: document.querySelector("#car-marker"),
  comparisonError: document.querySelector("#comparison-error"),
  comparisonGap: document.querySelector("#comparison-gap"),
  comparisonLeader: document.querySelector("#comparison-leader"),
  comparisonGaslyLap: document.querySelector("#comparison-gasly-lap"),
  comparisonGaslyTime: document.querySelector("#comparison-gasly-time"),
  comparisonStrollLap: document.querySelector("#comparison-stroll-lap"),
  comparisonStrollTime: document.querySelector("#comparison-stroll-time"),
  comparisonSectorRows: [...document.querySelectorAll("[data-comparison-sector]")],
  circuitName: document.querySelector("#circuit-name"),
  dataStatus: document.querySelector("#data-status"),
  brakeFill: document.querySelector("#brake-fill"),
  brakeTrack: document.querySelector("#brake-fill").parentElement,
  brakeValue: document.querySelector("#brake-value"),
  driverFirstName: document.querySelector("#driver-first-name"),
  driverLastName: document.querySelector("#driver-last-name"),
  elapsedTime: document.querySelector("#elapsed-time"),
  gearValue: document.querySelector("#gear-value"),
  lapBadge: document.querySelector("#lap-badge"),
  lapNumber: document.querySelector("#lap-number"),
  lapSeek: document.querySelector("#lap-seek"),
  lapTime: document.querySelector("#lap-time"),
  lapTimeDisplay: document.querySelector("#lap-time-display"),
  lapTimeFraction: document.querySelector("#lap-time-fraction"),
  overlay: document.querySelector("#track-overlay"),
  overlayMessage: document.querySelector("#overlay-message"),
  pauseIcon: document.querySelector("#pause-icon"),
  playbackSpeed: document.querySelector("#playback-speed"),
  playButton: document.querySelector("#play-button"),
  playIcon: document.querySelector("#play-icon"),
  resultTag: document.querySelector("#result-tag"),
  retryButton: document.querySelector("#retry-button"),
  rpmValue: document.querySelector("#rpm-value"),
  strollBrakeFill: document.querySelector("#stroll-brake-fill"),
  strollBrakeTrack: document.querySelector("#stroll-brake-fill").parentElement,
  strollBrakeValue: document.querySelector("#stroll-brake-value"),
  strollGearValue: document.querySelector("#stroll-gear-value"),
  strollRpmValue: document.querySelector("#stroll-rpm-value"),
  strollSpeedValue: document.querySelector("#stroll-speed-value"),
  strollThrottleFill: document.querySelector("#stroll-throttle-fill"),
  strollThrottleTrack: document.querySelector("#stroll-throttle-fill").parentElement,
  strollThrottleValue: document.querySelector("#stroll-throttle-value"),
  sectorRows: [...document.querySelectorAll(".sector-row")],
  sectorValues: [
    document.querySelector("#sector-1"),
    document.querySelector("#sector-2"),
    document.querySelector("#sector-3"),
  ],
  strollMarker: document.querySelector("#stroll-marker"),
  strollProgress: document.querySelector("#stroll-progress"),
  strollTrack: document.querySelector("#stroll-track"),
  gaslyTrack: document.querySelector("#gasly-track"),
  sessionDate: document.querySelector("#session-date"),
  speedValue: document.querySelector("#speed-value"),
  statusLabel: document.querySelector("#status-label"),
  teamName: document.querySelector("#team-name"),
  teamSwatch: document.querySelector("#team-swatch"),
  throttleValue: document.querySelector("#throttle-value"),
  throttleFill: document.querySelector("#throttle-fill"),
  throttleTrack: document.querySelector("#throttle-fill").parentElement,
  trackBase: document.querySelector("#track-base"),
  trackLayers: document.querySelector("#track-layers"),
  trackProgress: document.querySelector("#track-progress"),
  trackShadow: document.querySelector("#track-shadow"),
};

const state = {
  carData: [],
  comparisonCarData: [],
  comparisonLap: null,
  comparisonLocation: [],
  comparisonPoints: [],
  comparisonStartTime: 0,
  duration: 0,
  lap: null,
  lapStartTime: 0,
  location: [],
  playing: false,
  position: 0,
  sectors: [],
  speed: 4,
  trackPoints: [],
};

function buildApiUrl(endpoint, parameters) {
  const query = new URLSearchParams(parameters);
  return `${API_ROOT}/${endpoint}?${query.toString()}`;
}

async function fetchRecords(endpoint, parameters) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(buildApiUrl(endpoint, parameters), {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * (attempt + 1);
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(`OpenF1 respondió con el estado ${response.status} (${response.statusText}).`);
      }

      const records = await response.json();
      if (!Array.isArray(records)) {
        throw new Error(`La respuesta de OpenF1 para «${endpoint}» no tiene el formato esperado.`);
      }

      return records;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`La consulta a «${endpoint}» superó el límite de ${REQUEST_TIMEOUT_MS / 1000} segundos.`);
      }

      if (error instanceof TypeError) {
        throw new Error("No se pudo conectar con OpenF1. Revisá la conexión y el acceso del navegador a la API.");
      }

      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  throw new Error(`OpenF1 rechazó varias consultas a «${endpoint}». Esperá un momento y reintentá.`);
}

function setStatus(label, status) {
  elements.statusLabel.textContent = label;
  elements.dataStatus.dataset.state = status;
}

function setLoading(isLoading) {
  elements.trackLayers.hidden = isLoading || state.trackPoints.length < 2;
  elements.overlay.hidden = true;
  elements.playButton.disabled = isLoading || state.trackPoints.length < 2;
  elements.lapSeek.disabled = isLoading || state.trackPoints.length < 2;
  elements.playbackSpeed.disabled = isLoading || state.trackPoints.length < 2;
}

function showError(error) {
  console.error("No se pudo cargar la vuelta de Monza:", error);
  state.playing = false;
  setLoading(false);
  setStatus("ERROR DE DATOS", "error");
  elements.overlayMessage.textContent = error.message;
  elements.overlay.hidden = false;
  elements.playButton.disabled = true;
  elements.lapSeek.disabled = true;
  elements.playbackSpeed.disabled = true;
  setPlayButton(false);
}

function setPlayButton(isPlaying) {
  state.playing = isPlaying;
  elements.playIcon.hidden = isPlaying;
  elements.pauseIcon.hidden = !isPlaying;
  elements.playButton.setAttribute("aria-label", isPlaying ? "Pausar vuelta" : "Reproducir vuelta");
}

function formatLapTime(seconds, includeHours = false) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--.---";
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(3).padStart(6, "0");
  return includeHours || minutes > 0 ? `${minutes}:${remainder}` : `0:${remainder}`;
}

function formatSectorTime(seconds) {
  return Number.isFinite(seconds) ? seconds.toFixed(3) : "--.---";
}

function formatGap(seconds, includeUnit = false) {
  const sign = seconds >= 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(3)}${includeUnit ? " s" : ""}`;
}

function fastestValidLap(laps) {
  return laps
    .filter((lap) =>
      Number.isFinite(lap.lap_duration)
      && lap.lap_duration > 0
      && lap.lap_duration < 180
      && lap.is_pit_out_lap !== true,
    )
    .sort((first, second) => first.lap_duration - second.lap_duration)[0];
}

function getLocalSessionDate(dateString) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/Rome",
  }).format(new Date(dateString)).replace(".", "").toUpperCase();
}

function validateDriver(driver, driverNumber = DRIVER_NUMBER) {
  if (!driver) {
    throw new Error(`OpenF1 no devolvió el perfil del auto ${driverNumber} para esta sesión.`);
  }
}

function validateLap(lap, driverNumber = DRIVER_NUMBER) {
  if (!lap || !lap.date_start || !Number.isFinite(lap.lap_duration)) {
    throw new Error(`No se encontró una vuelta rápida válida para el auto ${driverNumber}.`);
  }
}

function renderDriver(driver) {
  elements.driverFirstName.textContent = driver.first_name.toUpperCase();
  elements.driverLastName.textContent = driver.last_name.toUpperCase();
  elements.teamName.textContent = driver.team_name.toUpperCase();
  if (/^[\da-f]{6}$/i.test(driver.team_colour ?? "")) {
    document.documentElement.style.setProperty("--team", `#${driver.team_colour}`);
  }
  elements.teamSwatch.style.backgroundColor = `var(--team)`;
}

function renderLap(lap, laps) {
  state.lap = lap;
  state.duration = lap.lap_duration;
  state.lapStartTime = Date.parse(lap.date_start);
  state.sectors = [
    lap.duration_sector_1,
    lap.duration_sector_2,
    lap.duration_sector_3,
  ];

  const quickestInSession = fastestValidLap(laps);
  const isPoleLap = quickestInSession?.driver_number === DRIVER_NUMBER
    && quickestInSession?.lap_number === lap.lap_number;

  elements.lapTime.textContent = formatLapTime(lap.lap_duration);
  const formattedLapTime = formatLapTime(lap.lap_duration);
  elements.lapTimeDisplay.firstChild.textContent = formattedLapTime.slice(0, -4);
  elements.lapTimeFraction.textContent = formattedLapTime.slice(-4);
  elements.lapNumber.textContent = String(lap.lap_number).padStart(2, "0");
  elements.sessionDate.textContent = `MONZA · ${getLocalSessionDate(lap.date_start)} 2026`;
  elements.lapBadge.textContent = isPoleLap ? "P1" : "P";
  elements.resultTag.textContent = isPoleLap ? "VUELTA DE POLE" : "MEJOR VUELTA";

  state.sectors.forEach((sectorTime, index) => {
    elements.sectorValues[index].textContent = formatSectorTime(sectorTime);
  });

  elements.sectorRows[0].classList.add("is-active");
  renderProgress(0);
}

function renderComparison(lap) {
  state.comparisonLap = lap;
  state.comparisonStartTime = Date.parse(lap.date_start);
  state.duration = Math.max(state.lap.lap_duration, lap.lap_duration);

  const lapGap = lap.lap_duration - state.lap.lap_duration;
  elements.comparisonGaslyTime.textContent = formatLapTime(state.lap.lap_duration);
  elements.comparisonStrollTime.textContent = formatLapTime(lap.lap_duration);
  elements.comparisonGaslyLap.textContent = String(state.lap.lap_number).padStart(2, "0");
  elements.comparisonStrollLap.textContent = String(lap.lap_number).padStart(2, "0");
  elements.comparisonGap.textContent = formatGap(lapGap, true);
  elements.comparisonLeader.textContent = lapGap >= 0 ? "VENTAJA GASLY" : "VENTAJA STROLL";
  elements.lapTime.textContent = formatLapTime(state.duration);

  const gaslySectors = [
    state.lap.duration_sector_1,
    state.lap.duration_sector_2,
    state.lap.duration_sector_3,
  ];
  const strollSectors = [
    lap.duration_sector_1,
    lap.duration_sector_2,
    lap.duration_sector_3,
  ];

  gaslySectors.forEach((gaslyTime, index) => {
    const strollTime = strollSectors[index];
    const delta = strollTime - gaslyTime;
    const row = elements.comparisonSectorRows[index];

    row.children[1].textContent = formatSectorTime(gaslyTime);
    row.children[2].textContent = formatSectorTime(strollTime);
    row.children[3].textContent = formatGap(delta);
    row.classList.toggle("gasly-faster", delta > 0);
    row.classList.toggle("stroll-faster", delta < 0);
  });
}

function toIsoOffset(timestamp) {
  return new Date(timestamp).toISOString();
}

function buildLapDateParameters(driverNumber, lap) {
  const dateStartMs = Date.parse(lap.date_start);
  const dateEnd = toIsoOffset(dateStartMs + lap.lap_duration * 1000);
  const dateStartIso = toIsoOffset(dateStartMs);

  return {
    session_key: SESSION_KEY,
    driver_number: driverNumber,
    "date>": dateStartIso,
    "date<": dateEnd,
  };
}

async function loadTelemetry(gaslyLap, strollLap) {
  const dateParameters = {
    ...buildLapDateParameters(DRIVER_NUMBER, gaslyLap),
  };
  const locations = await fetchRecords("location", dateParameters);
  const carData = await fetchRecords("car_data", dateParameters);
  const comparisonLocations = await fetchRecords(
    "location",
    buildLapDateParameters(COMPARISON_DRIVER_NUMBER, strollLap),
  );

  state.location = locations
    .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y) && sample.date)
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
  state.comparisonLocation = comparisonLocations
    .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y) && sample.date)
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
  state.carData = carData
    .filter((sample) => sample.date && Number.isFinite(sample.speed))
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));

  if (state.location.length < 2) {
    throw new Error("OpenF1 no devolvió suficientes posiciones GPS para reconstruir esta vuelta.");
  }
  if (state.comparisonLocation.length < 2) {
    throw new Error("OpenF1 no devolvió suficientes posiciones GPS para reconstruir la vuelta de Lance Stroll.");
  }

  const allLocations = [...state.location, ...state.comparisonLocation];
  const allPoints = projectTrackPoints(allLocations);
  state.trackPoints = addCumulativeDistance(allPoints.slice(0, state.location.length));
  state.comparisonPoints = addCumulativeDistance(allPoints.slice(state.location.length));
  state.comparisonCarData = await fetchRecords(
    "car_data",
    buildLapDateParameters(COMPARISON_DRIVER_NUMBER, strollLap),
  );
  state.comparisonCarData = state.comparisonCarData
    .filter((sample) => sample.date && Number.isFinite(sample.speed))
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
  if (state.carData.length === 0 || state.comparisonCarData.length === 0) {
    throw new Error("OpenF1 no devolvió telemetría suficiente para los dos pilotos.");
  }
  drawTrack();
  renderProgress(0);
}

function addCumulativeDistance(points) {
  let distance = 0;
  return points.map((point, index) => {
    if (index > 0) {
      const previous = points[index - 1];
      distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    }
    return { ...point, distance };
  });
}

function projectTrackPoints(locations) {
  const xValues = locations.map((point) => point.x);
  const yValues = locations.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const width = maxX - minX;
  const height = maxY - minY;

  if (width === 0 || height === 0) {
    throw new Error("Las posiciones recibidas no alcanzan para dibujar el trazado de la vuelta.");
  }

  const margin = 75;
  const scale = Math.min((1000 - margin * 2) / width, (700 - margin * 2) / height);
  const offsetX = (1000 - width * scale) / 2;
  const offsetY = (700 - height * scale) / 2;

  return locations.map((point) => ({
    x: offsetX + (point.x - minX) * scale,
    y: 700 - (offsetY + (point.y - minY) * scale),
    date: point.date,
  }));
}

function pointsToPath(points) {
  return points.map((point, index) =>
    `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
  ).join(" ");
}

function drawTrack() {
  const path = pointsToPath(state.trackPoints);
  elements.trackShadow.setAttribute("d", path);
  elements.trackBase.setAttribute("d", path);
  elements.gaslyTrack.setAttribute("d", path);
  elements.strollTrack.setAttribute("d", pointsToPath(state.comparisonPoints));
  elements.trackProgress.setAttribute("d", pointsToPath(state.trackPoints.slice(0, 1)));
  elements.strollProgress.setAttribute("d", pointsToPath(state.comparisonPoints.slice(0, 1)));
  elements.trackLayers.hidden = false;
}

function getPositionAtElapsed(points, lap, elapsed) {
  const totalDistance = points[points.length - 1].distance;
  const finalIndex = points.length - 1;
  if (elapsed >= lap.lap_duration) {
    return {
      index: finalIndex,
      point: points[finalIndex],
      nextPoint: points[finalIndex],
      distanceFraction: 1,
    };
  }

  const targetTime = Date.parse(lap.date_start) + elapsed * 1000;
  let low = 0;
  let high = finalIndex;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(points[middle].date) < targetTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const nextIndex = low;
  const previousIndex = Math.max(0, nextIndex - 1);
  const previous = points[previousIndex];
  const next = points[nextIndex];
  const previousTime = Date.parse(previous.date);
  const nextTime = Date.parse(next.date);
  const fraction = nextTime === previousTime
    ? 0
    : Math.max(0, Math.min(1, (targetTime - previousTime) / (nextTime - previousTime)));

  return {
    index: previousIndex,
    point: {
      x: previous.x + (next.x - previous.x) * fraction,
      y: previous.y + (next.y - previous.y) * fraction,
    },
    nextPoint: next,
    distanceFraction: totalDistance > 0
      ? (previous.distance + (next.distance - previous.distance) * fraction) / totalDistance
      : 0,
  };
}

function getElapsedAtDistanceFraction(points, lap, fraction) {
  const normalizedFraction = Math.max(0, Math.min(1, fraction));
  if (normalizedFraction === 0) {
    return 0;
  }
  if (normalizedFraction === 1) {
    return lap.lap_duration;
  }

  const targetDistance = normalizedFraction * points[points.length - 1].distance;
  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].distance < targetDistance) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const next = points[low];
  const previous = points[Math.max(0, low - 1)];
  const segmentDistance = next.distance - previous.distance;
  const position = segmentDistance > 0
    ? (targetDistance - previous.distance) / segmentDistance
    : 0;
  const timestamp = Date.parse(previous.date)
    + (Date.parse(next.date) - Date.parse(previous.date)) * position;

  return Math.max(0, Math.min(lap.lap_duration, (timestamp - Date.parse(lap.date_start)) / 1000));
}

function closestCarSample(carData, timestamp) {
  let low = 0;
  let high = carData.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(carData[middle].date) < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const after = carData[low];
  const before = carData[Math.max(0, low - 1)];
  return Math.abs(Date.parse(before.date) - timestamp) <= Math.abs(Date.parse(after.date) - timestamp)
    ? before
    : after;
}

function renderTelemetry(progress) {
  if (state.carData.length > 0) {
    const sample = closestCarSample(state.carData, state.lapStartTime + progress * 1000);
    elements.speedValue.textContent = String(Math.round(sample.speed));
    renderPedal(sample.throttle, elements.throttleValue, elements.throttleFill, elements.throttleTrack);
    renderPedal(sample.brake, elements.brakeValue, elements.brakeFill, elements.brakeTrack);
    elements.gearValue.textContent = Number.isFinite(sample.n_gear) ? String(sample.n_gear) : "-";
    elements.rpmValue.textContent = Number.isFinite(sample.rpm) ? sample.rpm.toLocaleString("es-AR") : "----";
  }

  if (state.comparisonCarData.length > 0) {
    const strollElapsed = Math.min(progress, state.comparisonLap.lap_duration);
    const sample = closestCarSample(
      state.comparisonCarData,
      state.comparisonStartTime + strollElapsed * 1000,
    );
    elements.strollSpeedValue.textContent = String(Math.round(sample.speed));
    renderPedal(sample.throttle, elements.strollThrottleValue, elements.strollThrottleFill, elements.strollThrottleTrack);
    renderPedal(sample.brake, elements.strollBrakeValue, elements.strollBrakeFill, elements.strollBrakeTrack);
    elements.strollGearValue.textContent = Number.isFinite(sample.n_gear) ? String(sample.n_gear) : "-";
    elements.strollRpmValue.textContent = Number.isFinite(sample.rpm) ? sample.rpm.toLocaleString("es-AR") : "----";
  }
}

function renderPedal(value, valueElement, fillElement, trackElement) {
  if (!Number.isFinite(value)) {
    valueElement.textContent = "--";
    fillElement.style.width = "0%";
    trackElement.setAttribute("aria-valuenow", "0");
    return;
  }

  const percentage = Math.max(0, Math.min(100, value));
  valueElement.textContent = String(Math.round(percentage));
  fillElement.style.width = `${percentage}%`;
  trackElement.setAttribute("aria-valuenow", String(Math.round(percentage)));
}

function renderProgress(progress) {
  if (state.trackPoints.length < 2 || state.comparisonPoints.length < 2 || !state.duration) {
    return;
  }

  state.position = Math.max(0, Math.min(state.duration, progress));
  const fraction = state.position / state.duration;
  const gaslyPosition = getPositionAtElapsed(
    state.trackPoints,
    state.lap,
    Math.min(state.position, state.lap.lap_duration),
  );
  const strollPosition = getPositionAtElapsed(
    state.comparisonPoints,
    state.comparisonLap,
    Math.min(state.position, state.comparisonLap.lap_duration),
  );
  const gaslyPath = state.trackPoints.slice(0, gaslyPosition.index + 1);
  const strollPath = state.comparisonPoints.slice(0, strollPosition.index + 1);

  gaslyPath.push(gaslyPosition.point);
  strollPath.push(strollPosition.point);
  elements.trackProgress.setAttribute("d", pointsToPath(gaslyPath));
  elements.strollProgress.setAttribute("d", pointsToPath(strollPath));
  positionMarker(elements.carMarker, gaslyPosition);
  positionMarker(elements.strollMarker, strollPosition);
  const comparisonElapsed = getElapsedAtDistanceFraction(
    state.comparisonPoints,
    state.comparisonLap,
    gaslyPosition.distanceFraction,
  );
  const dynamicGap = comparisonElapsed - Math.min(state.position, state.lap.lap_duration);
  elements.comparisonGap.textContent = formatGap(dynamicGap, true);
  elements.comparisonLeader.textContent = dynamicGap > 0.005
    ? "VENTAJA GASLY EN PISTA"
    : dynamicGap < -0.005 ? "VENTAJA STROLL EN PISTA" : "EMPATE EN PISTA";
  elements.comparisonGap.classList.toggle("gasly-leading", dynamicGap > 0.005);
  elements.comparisonGap.classList.toggle("stroll-leading", dynamicGap < -0.005);
  elements.elapsedTime.textContent = formatLapTime(state.position);
  elements.lapSeek.value = String(fraction * 100);
  elements.lapSeek.style.setProperty("--seek-progress", `${fraction * 100}%`);

  const sectorEndTimes = [
    state.sectors[0],
    state.sectors[0] + state.sectors[1],
  ];
  const activeSector = state.position < sectorEndTimes[0]
    ? 0
    : state.position < sectorEndTimes[1] ? 1 : 2;
  elements.sectorRows.forEach((row, index) => {
    row.classList.toggle("is-active", index === activeSector);
  });

  renderTelemetry(state.position);
}

function positionMarker(marker, position) {
  const heading = Math.atan2(
    position.nextPoint.y - position.point.y,
    position.nextPoint.x - position.point.x,
  ) * 180 / Math.PI;

  marker.setAttribute(
    "transform",
    `translate(${position.point.x.toFixed(2)} ${position.point.y.toFixed(2)}) rotate(${heading.toFixed(1)})`,
  );
}

function animationFrame(timestamp) {
  if (!state.playing) {
    return;
  }

  if (!animationFrame.previousTimestamp) {
    animationFrame.previousTimestamp = timestamp;
  }

  const elapsedMilliseconds = timestamp - animationFrame.previousTimestamp;
  animationFrame.previousTimestamp = timestamp;
  const nextPosition = state.position + (elapsedMilliseconds / 1000) * state.speed;

  if (nextPosition >= state.duration) {
    renderProgress(state.duration);
    setPlayButton(false);
    animationFrame.previousTimestamp = 0;
    return;
  }

  renderProgress(nextPosition);
  window.requestAnimationFrame(animationFrame);
}

async function loadPage() {
  setLoading(true);
  setStatus("CONECTANDO", "loading");
  animationFrame.previousTimestamp = 0;

  try {
    const drivers = await fetchRecords("drivers", { session_key: SESSION_KEY });
    const laps = await fetchRecords("laps", { session_key: SESSION_KEY });
    const driver = drivers.find((record) => record.driver_number === DRIVER_NUMBER);
    const comparisonDriver = drivers.find((record) => record.driver_number === COMPARISON_DRIVER_NUMBER);
    const driverLaps = laps.filter((lap) => lap.driver_number === DRIVER_NUMBER);
    const comparisonDriverLaps = laps.filter((lap) => lap.driver_number === COMPARISON_DRIVER_NUMBER);
    const bestLap = fastestValidLap(driverLaps);
    const comparisonBestLap = fastestValidLap(comparisonDriverLaps);

    validateDriver(driver);
    validateLap(bestLap);
    validateDriver(comparisonDriver, COMPARISON_DRIVER_NUMBER);
    validateLap(comparisonBestLap, COMPARISON_DRIVER_NUMBER);

    renderDriver(driver);
    renderLap(bestLap, laps);
    renderComparison(comparisonBestLap);
    await loadTelemetry(bestLap, comparisonBestLap);

    elements.trackLayers.hidden = false;
    elements.playButton.disabled = false;
    elements.lapSeek.disabled = false;
    elements.playbackSpeed.disabled = false;
    setStatus("DATOS VERIFICADOS", "ready");
  } catch (error) {
    showError(error);
  }
}

elements.playButton.addEventListener("click", () => {
  if (state.playing) {
    setPlayButton(false);
    animationFrame.previousTimestamp = 0;
    return;
  }

  if (state.position >= state.duration) {
    renderProgress(0);
  }

  state.speed = Number(elements.playbackSpeed.value);
  setPlayButton(true);
  window.requestAnimationFrame(animationFrame);
});

elements.lapSeek.addEventListener("input", () => {
  const wasPlaying = state.playing;
  setPlayButton(false);
  animationFrame.previousTimestamp = 0;
  renderProgress((Number(elements.lapSeek.value) / 100) * state.duration);

  if (wasPlaying) {
    state.speed = Number(elements.playbackSpeed.value);
    setPlayButton(true);
    window.requestAnimationFrame(animationFrame);
  }
});

elements.playbackSpeed.addEventListener("change", () => {
  state.speed = Number(elements.playbackSpeed.value);
});

elements.retryButton.addEventListener("click", loadPage);

loadPage();
