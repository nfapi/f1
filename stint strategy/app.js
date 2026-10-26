"use strict";

const seasonSelect = document.querySelector("#season-select");
const raceSelect = document.querySelector("#race-select");
const statusLabel = document.querySelector("#status-label");
const emptyState = document.querySelector("#empty-state");
const dataView = document.querySelector("#data-view");
const chart = document.querySelector("#strategy-chart");
const title = document.querySelector("#race-title");
const COMPOUNDS = {
  SOFT: { color: "#ef5967", label: "SOFT" },
  MEDIUM: { color: "#f3bd45", label: "MEDIUM" },
  HARD: { color: "#e5e7e5", label: "HARD" },
  INTERMEDIATE: { color: "#66d9c7", label: "INTER" },
  WET: { color: "#5997ff", label: "WET" },
};
let activeLoadId = 0;

function showError(error) {
  console.error("No se pudo cargar la estrategia:", error);
  dataView.hidden = true;
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = error.message || "No se pudo cargar la estrategia.";
  F1Tools.setStatus(statusLabel, "ERROR AL CARGAR", "error");
}

function addMetric(id, value) {
  document.querySelector(`#${id}`).textContent = value;
}

function renderStrategy(session, drivers, stints, stops) {
  const driverByNumber = new Map(drivers.map((driver) => [Number(driver.driver_number), driver]));
  const groups = new Map();
  for (const stint of stints) {
    const driverNumber = Number(stint.driver_number);
    const lapStart = Number(stint.lap_start);
    const lapEnd = Number(stint.lap_end);
    if (!driverByNumber.has(driverNumber) || !Number.isFinite(lapStart) || lapStart < 1
      || !Number.isFinite(lapEnd) || lapEnd < lapStart) continue;
    if (!groups.has(driverNumber)) groups.set(driverNumber, []);
    groups.get(driverNumber).push({ ...stint, lap_start: lapStart, lap_end: lapEnd });
  }
  const maxLap = Math.max(1, ...Array.from(groups.values()).flatMap((items) => items.map((stint) => stint.lap_end)));
  const compoundNames = [...new Set(stints.map((stint) => String(stint.compound || "UNKNOWN").toUpperCase()))].sort();
  const legend = document.querySelector("#strategy-legend");
  legend.replaceChildren();
  for (const compound of compoundNames) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("i");
    swatch.className = "legend-swatch";
    swatch.style.background = COMPOUNDS[compound]?.color || "#858b8c";
    const label = document.createElement("span");
    label.textContent = compound;
    item.append(swatch, label);
    legend.append(item);
  }

  chart.replaceChildren();
  const chartGrid = document.createElement("div");
  chartGrid.className = "strategy-chart";
  const axis = document.createElement("div");
  axis.className = "strategy-axis";
  const axisName = document.createElement("span");
  axisName.className = "axis-driver-label";
  axisName.textContent = "PILOTO";
  const axisLaps = document.createElement("div");
  axisLaps.className = "axis-laps";
  const step = maxLap > 45 ? 10 : maxLap > 20 ? 5 : Math.max(1, Math.ceil(maxLap / 8));
  for (let lap = 1; lap <= maxLap; lap += step) {
    const tick = document.createElement("span");
    tick.className = "axis-tick";
    tick.style.left = `${((lap - 1) / maxLap) * 100}%`;
    tick.textContent = lap;
    axisLaps.append(tick);
  }
  const finalTick = document.createElement("span");
  finalTick.className = "axis-tick";
  finalTick.style.left = "100%";
  finalTick.textContent = maxLap;
  axisLaps.append(finalTick);
  axis.append(axisName, axisLaps);
  chartGrid.append(axis);

  const orderedDrivers = [...groups.keys()]
    .sort((first, second) => (driverByNumber.get(first).name_acronym || "").localeCompare(driverByNumber.get(second).name_acronym || ""));
  for (const number of orderedDrivers) {
    const driver = driverByNumber.get(number);
    const driverStints = groups.get(number).sort((first, second) => first.stint_number - second.stint_number || first.lap_start - second.lap_start);
    const row = document.createElement("div");
    row.className = "strategy-row";
    const name = document.createElement("span");
    name.className = "driver-name";
    const code = document.createElement("b");
    code.textContent = driver.name_acronym || `#${number}`;
    const fullName = document.createElement("span");
    fullName.textContent = driver.last_name || driver.full_name;
    name.append(code, fullName);
    const track = document.createElement("div");
    track.className = "stint-track";
    driverStints.forEach((stint) => {
      const compound = String(stint.compound || "UNKNOWN").toUpperCase();
      const bar = document.createElement("span");
      bar.className = "stint-bar";
      bar.style.left = `${((stint.lap_start - 1) / maxLap) * 100}%`;
      bar.style.width = `${Math.max(0.45, ((stint.lap_end - stint.lap_start + 1) / maxLap) * 100)}%`;
      bar.style.background = COMPOUNDS[compound]?.color || "#858b8c";
      bar.textContent = stint.lap_end - stint.lap_start > 1 ? compound[0] : "";
      const hasTyreAge = stint.tyre_age_at_start !== null
        && stint.tyre_age_at_start !== undefined
        && Number.isFinite(Number(stint.tyre_age_at_start));
      const age = hasTyreAge ? ` · neumático con ${stint.tyre_age_at_start} vueltas` : "";
      bar.title = `${driver.full_name} · ${compound} · vueltas ${stint.lap_start}-${stint.lap_end}${age}`;
      track.append(bar);
    });
    row.append(name, track);
    chartGrid.append(row);
  }
  chart.append(chartGrid);

  const totalStops = stops.length || Math.max(0, [...groups.values()].reduce((sum, items) => sum + Math.max(0, items.length - 1), 0));
  const raceYear = new Date(session.date_start).getUTCFullYear();
  title.textContent = `${session.location || session.meeting_name} · ${raceYear}`;
  addMetric("metric-drivers", String(groups.size));
  addMetric("metric-stops", String(totalStops));
  addMetric("metric-compounds", String(compoundNames.length));
  document.querySelector("#metric-compound-detail").textContent = compoundNames.join(" · ");
  emptyState.hidden = true;
  dataView.hidden = false;
  F1Tools.setStatus(statusLabel, `${groups.size} PILOTOS · ${maxLap} VUELTAS · ${totalStops} PARADAS`);
}

async function loadRace(session) {
  const loadId = ++activeLoadId;
  if (!session) {
    dataView.hidden = true;
    emptyState.hidden = false;
    emptyState.querySelector("p").textContent = "Elegí una carrera para explorar sus estrategias de neumáticos.";
    title.textContent = "Stints por piloto";
    return;
  }
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = "CARGANDO STINTS Y PARADAS…";
  dataView.hidden = true;
  F1Tools.setStatus(statusLabel, "CARGANDO ESTRATEGIA", "loading");
  try {
    const [drivers, stints, stops] = await Promise.all([
      F1Tools.fetchRecords("drivers", { session_key: session.session_key }),
      F1Tools.fetchRecords("stints", { session_key: session.session_key }),
      F1Tools.fetchRecords("pit", { session_key: session.session_key }),
    ]);
    if (loadId !== activeLoadId) return;
    if (!stints.length) throw new Error("OpenF1 no devolvió stints para esta carrera.");
    renderStrategy(session, drivers, stints, stops);
  } catch (error) {
    if (loadId === activeLoadId) showError(error);
  }
}

F1Tools.initializeRacePicker({
  seasonSelect,
  raceSelect,
  status: statusLabel,
  onSelect: loadRace,
  onError: showError,
});
