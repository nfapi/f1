"use strict";

(function () {
  const API_ROOT = "https://api.openf1.org/v1";
  const REQUEST_TIMEOUT_MS = 15000;
  const REQUEST_INTERVAL_MS = 400;
  const MAX_RATE_LIMIT_RETRIES = 2;
  let requestQueue = Promise.resolve();
  let nextRequestAt = 0;

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
      const response = await scheduleRequest(async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          return await fetch(buildUrl(endpoint, parameters), {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
        } catch (error) {
          if (error.name === "AbortError") {
            throw new Error(`OpenF1 demoró demasiado al consultar ${endpoint}.`);
          }
          throw error;
        } finally {
          window.clearTimeout(timeout);
        }
      });

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1000;
        await new Promise((resolve) => window.setTimeout(resolve, delay));
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
    }
    throw new Error(`OpenF1 rechazó varias consultas a ${endpoint}.`);
  }

  function fillSelect(select, records, placeholder, valueOf, labelOf) {
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

  function raceLabel(session) {
    const location = session.location || session.meeting_name || "Gran Premio";
    const date = new Date(session.date_start);
    const dateLabel = Number.isNaN(date.getTime())
      ? ""
      : ` · ${new Intl.DateTimeFormat("es", { day: "2-digit", month: "short", timeZone: "UTC" }).format(date).replace(".", "").toUpperCase()}`;
    return `${location}${dateLabel}`;
  }

  function setStatus(element, message, state = "ready") {
    element.textContent = message;
    element.dataset.state = state;
    const container = element.closest(".data-status");
    if (container) container.dataset.state = state;
  }

  async function initializeRacePicker({ seasonSelect, raceSelect, status, onSelect, onError }) {
    let sessions = [];
    let loadId = 0;

    async function loadSeason() {
      const currentLoad = ++loadId;
      const year = Number(seasonSelect.value);
      onSelect(null);
      raceSelect.disabled = true;
      fillSelect(raceSelect, [], "Cargando carreras…", () => "", () => "");
      raceSelect.disabled = true;
      setStatus(status, `CARGANDO ${year}`, "loading");
      try {
        const records = await fetchRecords("sessions", { year, session_name: "Race" });
        if (currentLoad !== loadId) return;
        sessions = records
          .filter((session) => session.session_key
            && session.meeting_key
            && session.session_name === "Race"
            && Number.isFinite(Date.parse(session.date_end || session.date_start))
            && Date.parse(session.date_end || session.date_start) <= Date.now())
          .sort((first, second) => Date.parse(first.date_start) - Date.parse(second.date_start));
        fillSelect(raceSelect, sessions, sessions.length ? "Elegí una carrera" : `Sin carreras para ${year}`,
          (session) => session.session_key, raceLabel);
        setStatus(status, sessions.length ? "ELEGÍ UNA CARRERA" : "SIN CARRERAS");
      } catch (error) {
        if (currentLoad === loadId) {
          raceSelect.disabled = true;
          fillSelect(raceSelect, [], "No se pudieron cargar las carreras", () => "", () => "");
          raceSelect.disabled = true;
          setStatus(status, "ERROR AL CARGAR", "error");
          onError(error);
        }
      }
    }

    seasonSelect.addEventListener("change", loadSeason);
    raceSelect.addEventListener("change", () => {
      if (!raceSelect.value) {
        onSelect(null);
        return;
      }
      const session = sessions.find((candidate) => String(candidate.session_key) === raceSelect.value);
      onSelect(session || null);
    });
    await loadSeason();
  }

  window.F1Tools = { fetchRecords, fillSelect, initializeRacePicker, setStatus };
})();
