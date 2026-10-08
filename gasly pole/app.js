"use strict";

const API_ROOT = "https://api.openf1.org/v1";
const SESSION_KEY = 11357;
const DRIVER_NUMBER = 10;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RATE_LIMIT_RETRIES = 2;

const elements = {
  carMarker: document.querySelector("#car-marker"),
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
  sectorRows: [...document.querySelectorAll(".sector-row")],
  sectorValues: [
    document.querySelector("#sector-1"),
    document.querySelector("#sector-2"),
    document.querySelector("#sector-3"),
  ],
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

function validateDriver(driver) {
  if (!driver) {
    throw new Error(`OpenF1 no devolvió el perfil del auto ${DRIVER_NUMBER} para esta sesión.`);
  }
}

function validateLap(lap) {
  if (!lap || !lap.date_start || !Number.isFinite(lap.lap_duration)) {
    throw new Error(`No se encontró una vuelta rápida válida para el auto ${DRIVER_NUMBER}.`);
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

function toIsoOffset(timestamp) {
  return new Date(timestamp).toISOString();
}

async function loadTelemetry(dateStart, duration) {
  const dateStartMs = Date.parse(dateStart);
  const dateEnd = toIsoOffset(dateStartMs + duration * 1000);
  const dateStartIso = toIsoOffset(dateStartMs);
  const dateParameters = {
    session_key: SESSION_KEY,
    driver_number: DRIVER_NUMBER,
    "date>": dateStartIso,
    "date<": dateEnd,
  };
  const locations = await fetchRecords("location", dateParameters);
  const carData = await fetchRecords("car_data", dateParameters);

  state.location = locations
    .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y) && sample.date)
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));
  state.carData = carData
    .filter((sample) => sample.date && Number.isFinite(sample.speed))
    .sort((first, second) => Date.parse(first.date) - Date.parse(second.date));

  if (state.location.length < 2) {
    throw new Error("OpenF1 no devolvió suficientes posiciones GPS para reconstruir esta vuelta.");
  }

  state.trackPoints = projectTrackPoints(state.location);
  drawTrack(state.trackPoints);
  renderProgress(0);
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
  }));
}

function pointsToPath(points) {
  return points.map((point, index) =>
    `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
  ).join(" ");
}

function drawTrack(points) {
  const path = pointsToPath(points);
  elements.trackShadow.setAttribute("d", path);
  elements.trackBase.setAttribute("d", path);
  elements.trackProgress.setAttribute("d", pointsToPath(points.slice(0, 1)));
  elements.trackLayers.hidden = false;
}

function closestCarSample(timestamp) {
  let low = 0;
  let high = state.carData.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(state.carData[middle].date) < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const after = state.carData[low];
  const before = state.carData[Math.max(0, low - 1)];
  return Math.abs(Date.parse(before.date) - timestamp) <= Math.abs(Date.parse(after.date) - timestamp)
    ? before
    : after;
}

function renderTelemetry(progress) {
  if (state.carData.length === 0) {
    return;
  }

  const sample = closestCarSample(state.lapStartTime + progress * 1000);
  elements.speedValue.textContent = String(Math.round(sample.speed));
  renderPedal(sample.throttle, elements.throttleValue, elements.throttleFill, elements.throttleTrack);
  renderPedal(sample.brake, elements.brakeValue, elements.brakeFill, elements.brakeTrack);
  elements.gearValue.textContent = Number.isFinite(sample.n_gear) ? String(sample.n_gear) : "-";
  elements.rpmValue.textContent = Number.isFinite(sample.rpm) ? sample.rpm.toLocaleString("es-AR") : "----";
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
  if (state.trackPoints.length < 2 || !state.duration) {
    return;
  }

  state.position = Math.max(0, Math.min(state.duration, progress));
  const fraction = state.position / state.duration;
  const trackIndex = Math.min(
    state.trackPoints.length - 1,
    Math.floor(fraction * (state.trackPoints.length - 1)),
  );
  const currentPoint = state.trackPoints[trackIndex];
  const nextPoint = state.trackPoints[Math.min(trackIndex + 1, state.trackPoints.length - 1)];
  const heading = Math.atan2(nextPoint.y - currentPoint.y, nextPoint.x - currentPoint.x) * 180 / Math.PI;
  const path = pointsToPath(state.trackPoints.slice(0, trackIndex + 1));

  elements.trackProgress.setAttribute("d", path);
  elements.carMarker.setAttribute(
    "transform",
    `translate(${currentPoint.x.toFixed(2)} ${currentPoint.y.toFixed(2)}) rotate(${heading.toFixed(1)})`,
  );
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
    const drivers = await fetchRecords("drivers", { session_key: SESSION_KEY, driver_number: DRIVER_NUMBER });
    const laps = await fetchRecords("laps", { session_key: SESSION_KEY });
    const driver = drivers.find((record) => record.driver_number === DRIVER_NUMBER);
    const driverLaps = laps.filter((lap) => lap.driver_number === DRIVER_NUMBER);
    const bestLap = fastestValidLap(driverLaps);

    validateDriver(driver);
    validateLap(bestLap);

    renderDriver(driver);
    renderLap(bestLap, laps);
    await loadTelemetry(bestLap.date_start, bestLap.lap_duration);

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
