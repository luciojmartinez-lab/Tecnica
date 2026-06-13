(function () {
  "use strict";

  const STORAGE_KEY = "tecnica-state-v1";
  const APP_VERSION = "001v14";
  const COLORS = ["#176fc6", "#1fbf72", "#c47b19", "#8b5cf6", "#c2413f", "#0891b2", "#475569"];

  const DISCIPLINES = {
    tests: {
      id: "tests",
      label: "Tests",
      mode: "tests",
      metrics: [
        { id: "pies_juntos", label: "Pies juntos", unit: "m" },
        { id: "triple_test", label: "Triple", unit: "m" },
        { id: "quintuple", label: "Quintuples", unit: "m" },
      ],
    },
    triple: {
      id: "triple",
      label: "Triples",
      mode: "approach",
      eventName: "Triple",
      unit: "m",
      approaches: approachList("zancadas", [4, 6, 8, 10, 12, 14, 16]),
    },
    longitud: {
      id: "longitud",
      label: "Longitud",
      mode: "approach",
      eventName: "Longitud",
      unit: "m",
      approaches: approachList("zancadas", [4, 6, 8, 10, 12, 14, 16]),
    },
    altura: {
      id: "altura",
      label: "Altura",
      mode: "approach",
      eventName: "Altura",
      unit: "m",
      approaches: approachList("pasos", [3, 5, 7, 9, 11, 13]),
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let state = loadState();
  let draft = { attempts: [] };
  let expandedRecordCells = new Set();
  let toastTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function approachList(kind, counts) {
    return counts.map((count) => ({
      id: kind === "pasos" ? `p${count}` : `z${count}`,
      label: `${count} ${kind}`,
      short: `${count}${kind === "pasos" ? "p" : "z"}`,
    }));
  }

  function init() {
    migrateState();
    bindNavigation();
    bindForms();
    registerServiceWorker();
    $("#dateInput").value = new Date().toISOString().slice(0, 10);
    renderAll();
    updateSyncStatus();
    window.addEventListener("online", updateSyncStatus);
    window.addEventListener("offline", updateSyncStatus);
    window.addEventListener("resize", debounce(drawChart, 150));
  }

  function loadState() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (error) {
        console.warn(error);
      }
    }
    const seed = clone(window.TECNICA_SEED || { athletes: [], sessions: [], sourceNotes: [] });
    seed.preferences = seed.preferences || {};
    seed.updatedAt = seed.updatedAt || new Date().toISOString();
    seed.appVersion = APP_VERSION;
    return seed;
  }

  function migrateState() {
    state.schemaVersion = 1;
    state.appVersion = APP_VERSION;
    state.athletes = Array.isArray(state.athletes) ? state.athletes : [];
    state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
    state.sourceNotes = Array.isArray(state.sourceNotes) ? state.sourceNotes : [];
    state.preferences = state.preferences || {};
    state.settings = state.settings || {};
    state.settings.approachDistances = state.settings.approachDistances || {};
    migrateLucioAthlete();
    mergeDuplicateAthletes();
    state.sessions.forEach((session) => {
      session.attempts = Array.isArray(session.attempts) ? session.attempts : [];
      session.approachDistances = session.approachDistances || {};
      session.attempts.forEach((attempt) => {
        if (attempt.approachId && (attempt.distanceFeet || attempt.distanceCm)) {
          session.approachDistances[attempt.approachId] = {
            feet: attempt.distanceFeet ?? null,
            cm: attempt.distanceCm ?? null,
          };
        }
      });
    });
    migrateApproachDistanceSettings();
    saveState(false);
  }

  function migrateApproachDistanceSettings(target = state) {
    target.settings = target.settings || {};
    target.settings.approachDistances = target.settings.approachDistances || {};
    const oldGlobalDistances = {};
    Object.keys(target.settings.approachDistances).forEach((key) => {
      if (DISCIPLINES[key]) oldGlobalDistances[key] = target.settings.approachDistances[key];
    });

    (target.athletes || []).forEach((athlete) => {
      target.settings.approachDistances[athlete.id] = target.settings.approachDistances[athlete.id] || {};
      Object.values(DISCIPLINES)
        .filter((discipline) => discipline.mode === "approach")
        .forEach((discipline) => {
          target.settings.approachDistances[athlete.id][discipline.id] = target.settings.approachDistances[athlete.id][discipline.id] || {};
          discipline.approaches.forEach((approach) => {
            const saved = target.settings.approachDistances[athlete.id][discipline.id][approach.id] || {};
            const legacyGlobal = athlete.id === "lucio" ? oldGlobalDistances[discipline.id]?.[approach.id] || {} : {};
            const migrated = findLegacyDistance(target, athlete.id, discipline.id, approach.id);
            const distance = {
              feet: hasOwn(saved, "feet") ? saved.feet : migrated.feet ?? legacyGlobal.feet ?? null,
              cm: hasOwn(saved, "cm") ? saved.cm : migrated.cm ?? legacyGlobal.cm ?? null,
            };
            if (discipline.id === "altura") {
              distance.horizontal = hasOwn(saved, "horizontal") ? saved.horizontal : (saved.feet ?? migrated.feet ?? legacyGlobal.feet ?? null);
              distance.vertical = hasOwn(saved, "vertical") ? saved.vertical : (saved.cm ?? migrated.cm ?? legacyGlobal.cm ?? null);
              distance.feet = null;
              distance.cm = null;
            }
            target.settings.approachDistances[athlete.id][discipline.id][approach.id] = distance;
          });
        });
    });

    Object.keys(oldGlobalDistances).forEach((key) => {
      delete target.settings.approachDistances[key];
    });
  }

  function findLegacyDistance(target, athleteId, disciplineId, approachId) {
    const sessions = [...(target.sessions || [])]
      .filter((session) => session.athleteId === athleteId && session.discipline === disciplineId)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    for (const session of sessions) {
      const sessionDistance = session.approachDistances?.[approachId];
      if (sessionDistance && (sessionDistance.feet != null || sessionDistance.cm != null)) return sessionDistance;
      const attempt = (session.attempts || []).find((item) => item.approachId === approachId && (item.distanceFeet != null || item.distanceCm != null));
      if (attempt) return { feet: attempt.distanceFeet ?? null, cm: attempt.distanceCm ?? null };
    }
    return {};
  }

  function migrateLucioAthlete(target = state) {
    const oldAthlete = target.athletes.find((athlete) => athlete.id === "miquel");
    const lucioAthlete = target.athletes.find((athlete) => athlete.id === "lucio");

    if (oldAthlete && lucioAthlete && oldAthlete !== lucioAthlete) {
      target.sessions.forEach((session) => {
        if (session.athleteId === "miquel") session.athleteId = "lucio";
      });
      target.athletes = target.athletes.filter((athlete) => athlete.id !== "miquel");
      return;
    }

    if (oldAthlete) {
      oldAthlete.id = "lucio";
      oldAthlete.name = "Lucio";
      target.sessions.forEach((session) => {
        if (session.athleteId === "miquel") session.athleteId = "lucio";
      });
      if (target.preferences.chartAthlete === "miquel") target.preferences.chartAthlete = "lucio";
    }

    target.athletes.forEach((athlete) => {
      if (athlete.name === "Miquel") athlete.name = "Lucio";
    });
  }

  function mergeDuplicateAthletes(target = state) {
    target.athletes = Array.isArray(target.athletes) ? target.athletes : [];
    target.sessions = Array.isArray(target.sessions) ? target.sessions : [];
    target.preferences = target.preferences || {};
    target.settings = target.settings || {};
    target.settings.approachDistances = target.settings.approachDistances || {};

    const groups = new Map();
    target.athletes.forEach((athlete) => {
      const key = normalize(athlete.name || athlete.id);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(athlete);
    });

    const idMap = new Map();
    const merged = [];
    groups.forEach((athletes, key) => {
      const canonical = athletes.find((athlete) => athlete.id === key)
        || (key === "lucio" ? athletes.find((athlete) => athlete.id === "lucio") : null)
        || athletes[0];
      canonical.active = athletes.some((athlete) => athlete.active !== false);
      athletes.forEach((athlete) => {
        if (athlete === canonical) return;
        idMap.set(athlete.id, canonical.id);
        mergeAthleteDistances(target, canonical.id, athlete.id);
      });
      merged.push(canonical);
    });

    if (!idMap.size) return;
    target.sessions.forEach((session) => {
      if (idMap.has(session.athleteId)) session.athleteId = idMap.get(session.athleteId);
    });
    ["chartAthlete", "filterAthlete"].forEach((key) => {
      if (idMap.has(target.preferences[key])) target.preferences[key] = idMap.get(target.preferences[key]);
    });
    idMap.forEach((_, oldId) => {
      delete target.settings.approachDistances[oldId];
    });
    target.athletes = merged;
  }

  function mergeAthleteDistances(target, keepId, removeId) {
    const settings = target.settings.approachDistances;
    const keep = settings[keepId] || {};
    const remove = settings[removeId] || {};
    Object.keys(remove).forEach((disciplineId) => {
      keep[disciplineId] = keep[disciplineId] || {};
      Object.keys(remove[disciplineId] || {}).forEach((approachId) => {
        const saved = keep[disciplineId][approachId] || {};
        const incoming = remove[disciplineId][approachId] || {};
        keep[disciplineId][approachId] = {
          feet: hasOwn(saved, "feet") && saved.feet != null ? saved.feet : incoming.feet ?? null,
          cm: hasOwn(saved, "cm") && saved.cm != null ? saved.cm : incoming.cm ?? null,
          horizontal: hasOwn(saved, "horizontal") && saved.horizontal != null ? saved.horizontal : incoming.horizontal ?? null,
          vertical: hasOwn(saved, "vertical") && saved.vertical != null ? saved.vertical : incoming.vertical ?? null,
        };
      });
    });
    settings[keepId] = keep;
  }

  function saveState(touch = true) {
    if (touch) state.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    updateSyncStatus();
  }

  function bindNavigation() {
    $$(".tab-button").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;
        $$(".tab-button").forEach((item) => item.classList.toggle("is-active", item === button));
        $$(".view").forEach((view) => view.classList.toggle("is-active", view.id === `view-${tab}`));
        state.preferences.tab = tab;
        saveState(false);
        if (tab === "graficos") drawChart();
      });
    });
  }

  function bindForms() {
    $("#disciplineSelect").addEventListener("change", () => {
      renderAttemptEditor();
    });

    $("#sessionForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveSessionFromDraft();
    });

    $("#clearDraftButton").addEventListener("click", () => {
      draft = { attempts: [] };
      renderAttemptEditor();
      toast("Borrador limpio");
    });

    $("#recordsBody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-toggle-attempts], [data-delete-session], [data-delete-attempt]");
      if (!button) return;
      if (button.dataset.toggleAttempts) toggleRecordAttempts(button.dataset.toggleAttempts);
      if (button.dataset.deleteSession) deleteSession(button.dataset.deleteSession);
      if (button.dataset.deleteAttempt) deleteAttempt(button.dataset.deleteAttempt);
    });

    $("#athleteForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("#newAthleteName");
      const name = input.value.trim();
      if (!name) return;
      state.athletes.push({
        id: slug(name) + "-" + Date.now().toString(36),
        name,
        active: true,
        createdAt: new Date().toISOString(),
      });
      input.value = "";
      saveState();
      renderAll();
      toast("Atleta añadido");
    });

    $("#athleteList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-toggle-athlete], [data-delete-athlete]");
      if (!button) return;
      if (button.dataset.deleteAthlete) {
        deleteAthlete(button.dataset.deleteAthlete);
        return;
      }
      const athlete = state.athletes.find((item) => item.id === button.dataset.toggleAthlete);
      if (!athlete) return;
      athlete.active = !athlete.active;
      saveState();
      renderAll();
    });

    $("#distanceConfig").addEventListener("click", (event) => {
      const button = event.target.closest("[data-toggle-distance-athlete]");
      if (!button) return;
      toggleDistanceAthlete(button.dataset.toggleDistanceAthlete);
    });
    $("#distanceConfig").addEventListener("input", (event) => {
      const input = event.target.closest("[data-distance-field]");
      if (!input) return;
      updateConfiguredDistance(input);
    });

    $("#attemptModal").addEventListener("click", (event) => {
      if (event.target.closest("[data-close-modal]")) closeAttemptsModal();
    });

    ["sortSelect", "filterDiscipline", "filterAthlete", "filterText"].forEach((id) => {
      $("#" + id).addEventListener("input", () => {
        state.preferences[id] = $("#" + id).value;
        saveState(false);
        renderRecords();
      });
    });

    $("#chartAthlete").addEventListener("change", () => {
      state.preferences.chartAthlete = $("#chartAthlete").value;
      saveState(false);
      renderMetricPicker();
      drawChart();
    });
    $("#chartDiscipline").addEventListener("change", () => {
      state.preferences.chartDiscipline = $("#chartDiscipline").value;
      saveState(false);
      renderMetricPicker();
      drawChart();
    });
    $("#chartMode").addEventListener("change", () => {
      state.preferences.chartMode = $("#chartMode").value;
      saveState(false);
      renderMetricPicker();
      drawChart();
    });
    $("#metricPicker").addEventListener("change", drawChart);

    $("#exportButton").addEventListener("click", exportBackup);
    $("#backupTopButton").addEventListener("click", exportBackup);
    $("#csvButton").addEventListener("click", exportCsv);
    $("#csvTopButton").addEventListener("click", exportCsv);
    $("#importButton").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", importBackup);
    $("#resetButton").addEventListener("click", resetSeed);

    $("#syncKeyInput").addEventListener("input", () => {
      state.preferences.syncKey = $("#syncKeyInput").value;
      saveState(false);
    });
    $("#toggleSyncKey").addEventListener("click", toggleSyncKeyVisibility);
    $("#syncEndpointInput").addEventListener("input", () => {
      state.preferences.syncEndpoint = $("#syncEndpointInput").value.trim() || "/api/sync";
      saveState(false);
    });
    $("#syncButton").addEventListener("click", syncSmart);
    $("#pushButton").addEventListener("click", pushRemote);
    $("#pullButton").addEventListener("click", pullRemote);
  }

  function renderAll() {
    renderSelects();
    renderKpis();
    renderAttemptEditor();
    renderRecords();
    renderAthletes();
    renderDistanceConfig();
    renderMetricPicker();
    renderSourceNotes();
    $("#syncKeyInput").value = state.preferences.syncKey || "";
    $("#syncEndpointInput").value = state.preferences.syncEndpoint || "/api/sync";
    drawChart();
  }

  function renderSelects() {
    const previousFilters = {
      sortSelect: $("#sortSelect")?.value || state.preferences.sortSelect || "desc",
      filterDiscipline: $("#filterDiscipline")?.value || state.preferences.filterDiscipline || "tests",
      filterAthlete: $("#filterAthlete")?.value || state.preferences.filterAthlete || "",
      filterText: $("#filterText")?.value || state.preferences.filterText || "",
    };
    const athleteOptions = state.athletes
      .filter((athlete) => athlete.active !== false)
      .map((athlete) => `<option value="${esc(athlete.id)}">${esc(athlete.name)}</option>`)
      .join("");
    $("#athleteSelect").innerHTML = athleteOptions;
    $("#chartAthlete").innerHTML = athleteOptions;
    $("#filterAthlete").innerHTML = `<option value="">Todos</option>${athleteOptions}`;

    const disciplineOptions = Object.values(DISCIPLINES)
      .map((discipline) => `<option value="${discipline.id}">${discipline.label}</option>`)
      .join("");
    $("#disciplineSelect").innerHTML = disciplineOptions;
    $("#chartDiscipline").innerHTML = disciplineOptions;
    $("#filterDiscipline").innerHTML = `<option value="">Todas</option>${disciplineOptions}`;

    if (state.preferences.chartAthlete) $("#chartAthlete").value = state.preferences.chartAthlete;
    $("#chartDiscipline").value = state.preferences.chartDiscipline || "tests";
    $("#chartMode").value = state.preferences.chartMode || "date";
    $("#sortSelect").value = previousFilters.sortSelect;
    $("#filterDiscipline").value = previousFilters.filterDiscipline;
    $("#filterAthlete").value = previousFilters.filterAthlete;
    $("#filterText").value = previousFilters.filterText;
  }

  function renderKpis() {
    const attempts = flattenAttempts();
    const best = attempts.filter((row) => row.mark != null).sort((a, b) => b.mark - a.mark)[0];
    const lastDate = state.sessions.map((session) => session.date).sort().at(-1);
    const cards = [
      ["Atletas", String(state.athletes.filter((item) => item.active !== false).length), "Activos"],
      ["Jornadas", String(state.sessions.filter((session) => session.attempts.length).length), "Sesiones guardadas"],
      ["Intentos", String(attempts.length), "Saltos registrados"],
      ["Ultima", lastDate ? shortDate(lastDate) : "-", best ? `${best.metricLabel}: ${fmt(best.mark)} m` : "Sin marcas"],
    ];
    $("#kpiGrid").innerHTML = cards
      .map(([label, value, foot]) => `
        <article class="kpi-card">
          <div class="kpi-label">${label}</div>
          <div class="kpi-value">${value}</div>
          <div class="kpi-foot">${foot}</div>
        </article>
      `)
      .join("");
  }

  function renderAttemptEditor() {
    const discipline = DISCIPLINES[$("#disciplineSelect").value] || DISCIPLINES.tests;
    const root = $("#attemptEditor");
    if (discipline.mode === "tests") {
      root.innerHTML = `<div class="attempt-grid tests-grid">${discipline.metrics.map(renderTestCard).join("")}</div>`;
      $$(".attempt-card", root).forEach((card) => {
        card.querySelector("[data-add-test]").addEventListener("click", () => addTestAttempt(card.dataset.metric));
      });
    } else {
      root.innerHTML = `<div class="attempt-grid approach-grid">${discipline.approaches.map((approach) => renderApproachCard(discipline, approach)).join("")}</div>`;
      $$(".attempt-card", root).forEach((card) => {
        card.querySelector("[data-add-approach]").addEventListener("click", () => addApproachAttempt(card.dataset.approach));
      });
    }
    renderDraftChips();
  }

  function renderTestCard(metric) {
    return `
      <article class="attempt-card" data-metric="${metric.id}">
        <h3>${metric.label}</h3>
        <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="Marca">
        <button class="small-button" type="button" data-add-test>Añadir</button>
        <div class="attempt-list" data-list="tests:${metric.id}"></div>
      </article>
    `;
  }

  function renderApproachCard(discipline, approach) {
    return `
      <article class="attempt-card" data-approach="${approach.id}">
        <h3 title="${esc(approach.label)}">${esc(approach.short)}</h3>
        <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="Marca" data-mark>
        <button class="small-button" type="button" data-add-approach>Añadir</button>
        <div class="attempt-list" data-list="${discipline.id}:${approach.id}"></div>
      </article>
    `;
  }

  function addTestAttempt(metricId) {
    const discipline = DISCIPLINES.tests;
    const metric = discipline.metrics.find((item) => item.id === metricId);
    const card = $(`.attempt-card[data-metric="${metricId}"]`);
    const input = $("input", card);
    const mark = parseMark(input.value);
    if (mark == null) return toast("Introduce una marca");
    draft.attempts.push({
      draftId: cryptoId(),
      athleteId: $("#athleteSelect").value,
      disciplineId: discipline.id,
      listKey: `tests:${metric.id}`,
      eventId: metric.id,
      eventName: metric.label,
      approachId: null,
      approachLabel: "",
      distanceFeet: null,
      distanceCm: null,
      mark,
      unit: metric.unit,
    });
    input.value = "";
    renderDraftChips();
  }

  function addApproachAttempt(approachId) {
    const discipline = DISCIPLINES[$("#disciplineSelect").value];
    const approach = discipline.approaches.find((item) => item.id === approachId);
    const card = $(`.attempt-card[data-approach="${approachId}"]`);
    const mark = parseMark($("[data-mark]", card).value);
    if (mark == null) return toast("Introduce una marca");
    draft.attempts.push({
      draftId: cryptoId(),
      athleteId: $("#athleteSelect").value,
      disciplineId: discipline.id,
      listKey: `${discipline.id}:${approachId}`,
      eventId: `${discipline.id}_approach`,
      eventName: discipline.eventName,
      approachId,
      approachLabel: approach.label,
      distanceFeet: null,
      distanceCm: null,
      mark,
      unit: discipline.unit,
    });
    $("[data-mark]", card).value = "";
    renderDraftChips();
  }

  function renderDraftChips() {
    $$(".attempt-list").forEach((list) => {
      const key = list.dataset.list;
      const attempts = draft.attempts.filter((attempt) => attempt.listKey === key);
      list.innerHTML = attempts
        .map((attempt) => `
          <span class="chip">${esc(athleteShort(attempt.athleteId))}: ${fmt(attempt.mark)} ${attempt.unit}<button type="button" data-remove-draft="${attempt.draftId}" aria-label="Quitar">x</button></span>
        `)
        .join("");
    });
    $$("[data-remove-draft]").forEach((button) => {
      button.addEventListener("click", () => {
        draft.attempts = draft.attempts.filter((attempt) => attempt.draftId !== button.dataset.removeDraft);
        renderDraftChips();
      });
    });
  }

  function athleteShort(athleteId) {
    const athlete = state.athletes.find((item) => item.id === athleteId);
    const name = athlete ? athlete.name : athleteId;
    return String(name || "").slice(0, 3);
  }

  function saveSessionFromDraft() {
    const date = $("#dateInput").value;
    const notes = $("#notesInput").value.trim();
    if (!draft.attempts.length) return toast("No hay marcas para guardar");

    const groups = new Map();
    draft.attempts.forEach((attempt) => {
      const groupKey = `${attempt.athleteId}|${attempt.disciplineId}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          athleteId: attempt.athleteId,
          disciplineId: attempt.disciplineId,
          attempts: [],
        });
      }
      groups.get(groupKey).attempts.push(attempt);
    });

    groups.forEach((group) => {
      const counts = {};
      const attempts = group.attempts.map((attempt) => {
        const key = attempt.approachId || attempt.eventId;
        counts[key] = (counts[key] || 0) + 1;
        return {
          id: cryptoId(),
          eventId: attempt.eventId,
          eventName: attempt.eventName,
          approachId: attempt.approachId,
          approachLabel: attempt.approachLabel,
          distanceFeet: attempt.distanceFeet ?? null,
          distanceCm: attempt.distanceCm ?? null,
          mark: attempt.mark,
          unit: attempt.unit,
          attempt: counts[key],
        };
      });
      state.sessions.push({
        id: cryptoId(),
        date,
        athleteId: group.athleteId,
        discipline: group.disciplineId,
        notes,
        attempts,
        approachDistances: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    draft = { attempts: [] };
    $("#notesInput").value = "";
    saveState();
    renderAll();
    toast(groups.size === 1 ? "Jornada guardada" : `${groups.size} jornadas guardadas`);
  }

  function renderRecords() {
    const table = $(".data-table");
    const head = $(".data-table thead");
    const body = $("#recordsBody");
    const disciplineFilter = $("#filterDiscipline").value;
    if (disciplineFilter && DISCIPLINES[disciplineFilter]) {
      renderDisciplineRecords(table, head, body, disciplineFilter);
      return;
    }
    const rows = flattenRows();
    const athleteFilter = $("#filterAthlete").value;
    const text = normalize($("#filterText").value);
    const best = bestByDay();
    const sorted = rows
      .filter((row) => !disciplineFilter || row.discipline === disciplineFilter)
      .filter((row) => !athleteFilter || row.athleteId === athleteFilter)
      .filter((row) => !text || normalize(Object.values(row).join(" ")).includes(text))
      .sort((a, b) => {
        const order = $("#sortSelect").value === "asc" ? 1 : -1;
        return order * (a.date.localeCompare(b.date) || a.metricLabel.localeCompare(b.metricLabel));
      });
    if (!sorted.length) {
      table.className = "data-table generic-table";
      head.innerHTML = `
        <tr>
          <th>Fecha</th>
          <th>Atleta</th>
          <th>Especialidad</th>
          <th>Columna</th>
          <th>Marca</th>
          <th>Pies</th>
          <th>Cent.</th>
          <th></th>
        </tr>
      `;
      body.innerHTML = `<tr><td colspan="8" class="muted">Sin datos</td></tr>`;
      return;
    }
    table.className = "data-table generic-table";
    head.innerHTML = `
      <tr>
        <th>Fecha</th>
        <th>Atleta</th>
        <th>Especialidad</th>
        <th>Columna</th>
        <th>Marca</th>
        <th>Pies</th>
        <th>Cent.</th>
        <th></th>
      </tr>
    `;
    body.innerHTML = sorted
      .map((row) => {
        const bestKey = keyForBest(row);
        const isBest = row.mark != null && best.get(bestKey) === row.mark;
        return `
          <tr>
            <td>${formatDate(row.date)}</td>
            <td>${esc(row.athleteName)}</td>
            <td>${esc(row.disciplineLabel)}</td>
            <td>${esc(row.metricLabel)}</td>
            <td>${row.mark == null ? '<span class="muted">-</span>' : `${fmt(row.mark)} ${row.unit}${isBest ? '<span class="best-badge">Mejor</span>' : ''}`}</td>
            <td>${row.distanceFeet == null ? "" : fmt(row.distanceFeet)}</td>
            <td>${formatCm(row.distanceCm)}</td>
            <td><button class="small-button delete-button" type="button" data-delete-attempt="${row.attemptId}">Eliminar</button></td>
          </tr>
        `;
      })
      .join("");
  }

  function renderDisciplineRecords(table, head, body, disciplineId) {
    const discipline = DISCIPLINES[disciplineId];
    const athleteFilter = $("#filterAthlete").value;
    const text = normalize($("#filterText").value);
    const groups = groupedSessions(disciplineId)
      .filter((row) => !athleteFilter || row.athleteId === athleteFilter)
      .filter((row) => !text || normalize(Object.values(row.search).join(" ")).includes(text))
      .sort((a, b) => {
        const order = $("#sortSelect").value === "asc" ? 1 : -1;
        return order * (a.date.localeCompare(b.date) || a.athleteName.localeCompare(b.athleteName));
      });

    const columns = recordColumns(discipline);
    table.className = `data-table compact-record-table ${discipline.id}-record-table`;
    head.innerHTML = `
      <tr>
        <th>Fecha</th>
        ${columns.map((column) => `<th>${esc(column.short)}</th>`).join("")}
        <th></th>
      </tr>
    `;

    if (!groups.length) {
      body.innerHTML = `<tr><td colspan="${columns.length + 2}" class="muted">Sin datos</td></tr>`;
      return;
    }

    body.innerHTML = groups
      .map((row) => `
        <tr>
          <td>${shortDate(row.date)}</td>
          ${columns.map((column) => `<td>${formatRecordCell(row, column.key)}</td>`).join("")}
          <td><button class="small-button delete-button" type="button" data-delete-session="${row.sessionIds.join(",")}" aria-label="Eliminar jornada">Eliminar</button></td>
        </tr>
      `)
      .join("");
  }

  function recordColumns(discipline) {
    if (discipline.mode === "tests") {
      return discipline.metrics.map((metric) => ({
        key: metric.id,
        short: metric.label === "Pies juntos" ? "Pies juntos" : metric.label,
      }));
    }
    return discipline.approaches.map((approach) => ({
      key: `${discipline.id}:${approach.id}`,
      short: approach.short,
    }));
  }

  function groupedSessions(disciplineId) {
    const grouped = new Map();
    state.sessions
      .filter((session) => session.discipline === disciplineId)
      .forEach((session) => {
        const athlete = state.athletes.find((item) => item.id === session.athleteId);
        const groupId = `${disciplineId}|${session.athleteId}|${session.date}`;
        if (!grouped.has(groupId)) {
          grouped.set(groupId, {
            groupId,
            sessionIds: [],
            date: session.date,
            athleteId: session.athleteId,
            athleteName: athlete ? athlete.name : session.athleteId,
            values: {},
            search: {
              date: session.date,
              athlete: athlete ? athlete.name : session.athleteId,
              notes: "",
              values: "",
            },
          });
        }
        const group = grouped.get(groupId);
        group.sessionIds.push(session.id);
        group.search.notes += ` ${session.notes || ""}`;
        session.attempts.forEach((attempt) => {
          const key = attempt.approachId ? `${session.discipline}:${attempt.approachId}` : attempt.eventId;
          group.values[key] = group.values[key] || { best: null, unit: attempt.unit || "m", attempts: [] };
          group.values[key].attempts.push({
            id: attempt.id,
            sessionId: session.id,
            mark: attempt.mark,
            unit: attempt.unit || "m",
            attempt: attempt.attempt,
          });
          if (group.values[key].best == null || attempt.mark > group.values[key].best) group.values[key].best = attempt.mark;
        });
      });
    return Array.from(grouped.values()).map((group) => {
      group.search.values = Object.values(group.values)
        .flatMap((value) => value.attempts.map((attempt) => attempt.mark))
        .join(" ");
      return group;
    });
  }

  function formatRecordCell(row, columnKey) {
    const value = row.values[columnKey];
    if (!value || value.best == null) return "";
    const cellId = recordCellId(row.groupId, columnKey);
    const expanded = expandedRecordCells.has(cellId);
    const attempts = [...value.attempts].sort((a, b) => b.mark - a.mark);
    const more = attempts.length > 1
      ? `<button class="inline-plus" type="button" data-toggle-attempts="${esc(cellId)}" aria-label="${expanded ? "Cerrar intentos" : "Ver intentos"}">${expanded ? "Cerrar" : "+"}</button>`
      : "";
    const details = expanded
      ? `<div class="record-attempt-list">
          ${attempts.map((attempt) => {
            const isBest = attempt.mark === value.best;
            return `<span class="${isBest ? "record-attempt is-best" : "record-attempt"}">${fmt(attempt.mark)}</span>`;
          }).join("")}
        </div>`
      : "";
    return `<div class="record-cell-content"><strong class="record-best">${fmt(value.best)}</strong>${more}${details}</div>`;
  }

  function recordCellId(groupId, columnKey) {
    return `${groupId}||${columnKey}`;
  }

  function toggleRecordAttempts(cellId) {
    if (expandedRecordCells.has(cellId)) {
      expandedRecordCells.delete(cellId);
    } else {
      expandedRecordCells.add(cellId);
    }
    renderRecords();
  }

  function openAttemptsModal(groupId, columnKey) {
    const [disciplineId] = groupId.split("|");
    const discipline = DISCIPLINES[disciplineId];
    const group = groupedSessions(disciplineId).find((item) => item.groupId === groupId);
    const value = group?.values?.[columnKey];
    if (!discipline || !group || !value) return;
    const column = recordColumns(discipline).find((item) => item.key === columnKey);
    const attempts = [...value.attempts].sort((a, b) => b.mark - a.mark);
    $("#attemptModalTitle").textContent = `${column ? column.short : "Marca"} - ${formatDate(group.date)}`;
    $("#attemptModalBody").innerHTML = `
      <p class="modal-subtitle">${esc(group.athleteName)} · ${esc(discipline.label)}</p>
      <div class="attempt-modal-list">
        ${attempts.map((attempt, index) => {
          const isBest = attempt.mark === value.best && index === 0;
          return `<div class="attempt-modal-row ${isBest ? "is-best" : ""}">
            <span>${index + 1}</span>
            ${isBest ? `<strong>${fmt(attempt.mark)} ${esc(attempt.unit)}</strong>` : `<span>${fmt(attempt.mark)} ${esc(attempt.unit)}</span>`}
          </div>`;
        }).join("")}
      </div>
    `;
    $("#attemptModal").hidden = false;
  }

  function closeAttemptsModal() {
    $("#attemptModal").hidden = true;
    $("#attemptModalBody").innerHTML = "";
  }

  function flattenAttempts() {
    return state.sessions.flatMap((session) => {
      const athlete = state.athletes.find((item) => item.id === session.athleteId);
      const discipline = DISCIPLINES[session.discipline] || DISCIPLINES.tests;
      return session.attempts.map((attempt) => {
        const metricLabel = attempt.approachId ? `${attempt.eventName} ${attempt.approachLabel}` : attempt.eventName;
        const distance = attempt.approachId ? getConfiguredDistance(session.athleteId, session.discipline, attempt.approachId, session) : {};
        return {
          kind: "attempt",
          sessionId: session.id,
          attemptId: attempt.id,
          date: session.date,
          athleteId: session.athleteId,
          athleteName: athlete ? athlete.name : session.athleteId,
          discipline: session.discipline,
          disciplineLabel: discipline.label,
          metricKey: attempt.approachId ? `${session.discipline}:${attempt.approachId}` : attempt.eventId,
          metricLabel,
          approachId: attempt.approachId,
          mark: attempt.mark,
          unit: attempt.unit || "m",
          distanceFeet: distance.feet ?? null,
          distanceCm: distance.cm ?? null,
          notes: session.notes || "",
        };
      });
    });
  }

  function flattenRows() {
    return flattenAttempts();
  }

  function bestByDay() {
    const map = new Map();
    flattenAttempts().forEach((row) => {
      const key = keyForBest(row);
      const current = map.get(key);
      if (current == null || row.mark > current) map.set(key, row.mark);
    });
    return map;
  }

  function keyForBest(row) {
    return `${row.date}|${row.athleteId}|${row.metricKey}`;
  }

  function deleteAttempt(attemptId) {
    if (!confirm("Eliminar intento?")) return;
    state.sessions.forEach((session) => {
      session.attempts = session.attempts.filter((attempt) => attempt.id !== attemptId);
    });
    state.sessions = state.sessions.filter((session) => session.attempts.length);
    saveState();
    renderAll();
  }

  function deleteSession(sessionId) {
    if (!confirm("Eliminar jornada completa?")) return;
    const ids = new Set(String(sessionId).split(","));
    state.sessions = state.sessions.filter((session) => !ids.has(session.id));
    saveState();
    renderAll();
  }

  function renderAthletes() {
    $("#athleteList").innerHTML = state.athletes
      .map((athlete) => `
        <div class="athlete-row">
          <strong>${esc(athlete.name)}</strong>
          <div class="athlete-actions">
            <button class="small-button" type="button" data-toggle-athlete="${esc(athlete.id)}">${athlete.active === false ? "Activar" : "Ocultar"}</button>
            <button class="small-button delete-button" type="button" data-delete-athlete="${esc(athlete.id)}">Eliminar</button>
          </div>
        </div>
      `)
      .join("");
  }

  function deleteAthlete(athleteId) {
    const athlete = state.athletes.find((item) => item.id === athleteId);
    if (!athlete) return;
    const sameName = state.athletes.filter((item) => item.id !== athleteId && normalize(item.name) === normalize(athlete.name));
    const target = sameName.find((item) => item.id === "lucio") || sameName[0];
    const sessionsCount = state.sessions.filter((session) => session.athleteId === athleteId).length;
    const message = target
      ? `Eliminar ${athlete.name} duplicado y pasar sus jornadas a ${target.name}?`
      : sessionsCount
        ? `Eliminar ${athlete.name} y sus ${sessionsCount} jornadas?`
        : `Eliminar ${athlete.name}?`;
    if (!confirm(message)) return;

    if (target) {
      state.sessions.forEach((session) => {
        if (session.athleteId === athleteId) session.athleteId = target.id;
      });
      mergeAthleteDistances(state, target.id, athleteId);
    } else {
      state.sessions = state.sessions.filter((session) => session.athleteId !== athleteId);
    }
    delete state.settings?.approachDistances?.[athleteId];
    state.athletes = state.athletes.filter((item) => item.id !== athleteId);
    const fallbackAthlete = state.athletes[0]?.id || "";
    ["chartAthlete", "filterAthlete"].forEach((key) => {
      if (state.preferences[key] === athleteId) state.preferences[key] = fallbackAthlete;
    });
    saveState();
    renderAll();
    toast("Atleta eliminado");
  }

  function renderDistanceConfig() {
    const disciplines = Object.values(DISCIPLINES).filter((discipline) => discipline.mode === "approach");
    const expanded = new Set(state.preferences.expandedDistanceAthletes || []);
    $("#distanceConfig").innerHTML = state.athletes
      .map((athlete) => {
        const isExpanded = expanded.has(athlete.id);
        return `
          <section class="distance-athlete ${isExpanded ? "is-open" : ""}">
            <div class="distance-athlete-header">
              <h3>${esc(athlete.name)}</h3>
              <button class="inline-plus" type="button" data-toggle-distance-athlete="${esc(athlete.id)}" aria-label="${isExpanded ? "Cerrar distancias" : "Abrir distancias"}">${isExpanded ? "Cerrar" : "+"}</button>
            </div>
            ${isExpanded ? `
              <div class="distance-athlete-body">
                ${disciplines.map((discipline) => `
                  <div class="distance-discipline">
                    <strong>${esc(discipline.label)}</strong>
                    <div class="distance-grid ${discipline.id === "altura" ? "height-distance-grid" : ""}">
                      ${discipline.approaches.map((approach) => renderDistanceRow(athlete, discipline, approach)).join("")}
                    </div>
                  </div>
                `).join("")}
              </div>
            ` : ""}
          </section>
        `;
      })
      .join("");
  }

  function renderDistanceRow(athlete, discipline, approach) {
    const distance = getConfiguredDistance(athlete.id, discipline.id, approach.id);
    if (discipline.id === "altura") {
      return `
        <label class="distance-row height-distance-row">
          <span>${esc(approach.short)}</span>
          <input data-distance-field="horizontal" data-athlete="${esc(athlete.id)}" data-discipline="${discipline.id}" data-approach="${approach.id}" inputmode="decimal" value="${distance.horizontal == null ? "" : fmt(distance.horizontal)}" placeholder="horiz.">
          <span class="distance-cross">x</span>
          <input data-distance-field="vertical" data-athlete="${esc(athlete.id)}" data-discipline="${discipline.id}" data-approach="${approach.id}" inputmode="decimal" value="${distance.vertical == null ? "" : fmt(distance.vertical)}" placeholder="vert.">
        </label>
      `;
    }
    return `
      <label class="distance-row">
        <span>${esc(approach.short)}</span>
        <input data-distance-field="feet" data-athlete="${esc(athlete.id)}" data-discipline="${discipline.id}" data-approach="${approach.id}" inputmode="decimal" value="${distance.feet == null ? "" : fmt(distance.feet)}" placeholder="pies">
        <input data-distance-field="cm" data-athlete="${esc(athlete.id)}" data-discipline="${discipline.id}" data-approach="${approach.id}" inputmode="decimal" value="${formatCm(distance.cm)}" placeholder="cm">
      </label>
    `;
  }

  function toggleDistanceAthlete(athleteId) {
    state.preferences.expandedDistanceAthletes = state.preferences.expandedDistanceAthletes || [];
    const expanded = new Set(state.preferences.expandedDistanceAthletes);
    if (expanded.has(athleteId)) expanded.delete(athleteId);
    else expanded.add(athleteId);
    state.preferences.expandedDistanceAthletes = Array.from(expanded);
    saveState(false);
    renderDistanceConfig();
  }

  function updateConfiguredDistance(input) {
    const athleteId = input.dataset.athlete;
    const disciplineId = input.dataset.discipline;
    const approachId = input.dataset.approach;
    const field = input.dataset.distanceField;
    state.settings.approachDistances[athleteId] = state.settings.approachDistances[athleteId] || {};
    state.settings.approachDistances[athleteId][disciplineId] = state.settings.approachDistances[athleteId][disciplineId] || {};
    const distance = state.settings.approachDistances[athleteId][disciplineId][approachId] || { feet: null, cm: null };
    distance[field] = field === "cm" ? parseCmInput(input.value) : parseOptional(input.value);
    if (disciplineId === "altura") {
      distance.feet = null;
      distance.cm = null;
    }
    state.settings.approachDistances[athleteId][disciplineId][approachId] = distance;
    saveState();
  }

  function getConfiguredDistance(athleteId, disciplineId, approachId, session = null) {
    const configured = state.settings?.approachDistances?.[athleteId]?.[disciplineId]?.[approachId] || {};
    const legacy = session?.approachDistances?.[approachId] || {};
    const attemptLegacy = session?.attempts?.find((attempt) => attempt.approachId === approachId && (attempt.distanceFeet != null || attempt.distanceCm != null));
    const feet = hasOwn(configured, "feet") ? configured.feet : legacy.feet ?? attemptLegacy?.distanceFeet ?? null;
    const cm = hasOwn(configured, "cm") ? configured.cm : legacy.cm ?? attemptLegacy?.distanceCm ?? null;
    if (disciplineId === "altura") {
      return {
        feet: null,
        cm: null,
        horizontal: hasOwn(configured, "horizontal") ? configured.horizontal : (configured.feet ?? legacy.feet ?? attemptLegacy?.distanceFeet ?? null),
        vertical: hasOwn(configured, "vertical") ? configured.vertical : (configured.cm ?? legacy.cm ?? attemptLegacy?.distanceCm ?? null),
      };
    }
    return {
      feet,
      cm,
      horizontal: feet,
      vertical: cm,
    };
  }

  function renderMetricPicker() {
    const discipline = DISCIPLINES[$("#chartDiscipline").value] || DISCIPLINES.tests;
    const mode = $("#chartMode")?.value || "date";
    const options = mode === "approach" && discipline.mode === "approach"
      ? approachDateOptions(discipline)
      : metricOptions(discipline);
    const prefKey = mode === "approach" ? `${discipline.id}:dates` : discipline.id;
    const selected = new Set(state.preferences.chartMetrics?.[prefKey] || options.slice(0, 5).map((item) => item.key));
    $("#metricPicker").innerHTML = options
      .map((metric) => `
        <label>
          <input type="checkbox" value="${esc(metric.key)}" ${selected.has(metric.key) ? "checked" : ""}>
          ${esc(metric.label)}
        </label>
      `)
      .join("");
  }

  function metricOptions(discipline) {
    if (discipline.mode === "tests") {
      return discipline.metrics.map((metric) => ({ key: metric.id, label: metric.label }));
    }
    return discipline.approaches.map((approach) => ({ key: `${discipline.id}:${approach.id}`, label: approach.short }));
  }

  function approachDateOptions(discipline) {
    const athleteId = $("#chartAthlete").value;
    return Array.from(new Set(flattenAttempts()
      .filter((row) => row.athleteId === athleteId && row.discipline === discipline.id)
      .map((row) => row.date)))
      .sort((a, b) => b.localeCompare(a))
      .map((date) => ({ key: date, label: shortDate(date) }));
  }

  function drawChart() {
    const canvas = $("#trendChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(680, Math.floor(rect.width * ratio));
    canvas.height = Math.max(360, Math.floor(rect.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    ctx.clearRect(0, 0, width, height);

    const discipline = DISCIPLINES[$("#chartDiscipline").value] || DISCIPLINES.tests;
    const athleteId = $("#chartAthlete").value;
    const mode = $("#chartMode")?.value || "date";
    const checked = $$("input:checked", $("#metricPicker")).map((input) => input.value);
    state.preferences.chartMetrics = state.preferences.chartMetrics || {};
    const prefKey = mode === "approach" && discipline.mode === "approach" ? `${discipline.id}:dates` : discipline.id;
    state.preferences.chartMetrics[prefKey] = checked;
    saveState(false);

    if (mode === "approach" && discipline.mode === "approach") {
      drawApproachChart(ctx, width, height, discipline, athleteId, checked);
      return;
    }

    const rows = flattenAttempts().filter((row) => row.athleteId === athleteId && checked.includes(row.metricKey));
    const grouped = new Map();
    rows.forEach((row) => {
      const key = `${row.metricKey}|${row.date}`;
      const current = grouped.get(key);
      if (!current || row.mark > current.mark) grouped.set(key, row);
    });
    const dates = Array.from(new Set(Array.from(grouped.values()).map((row) => row.date))).sort();
    const metrics = metricOptions(discipline).filter((metric) => checked.includes(metric.key));
    const values = Array.from(grouped.values()).map((row) => row.mark);

    if (!dates.length || !metrics.length) {
      drawEmptyChart(ctx, width, height, "Sin marcas para esta seleccion");
      $("#chartLegend").innerHTML = "";
      return;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max(0.1, (max - min) * 0.18);
    const yMin = Math.max(0, min - pad);
    const yMax = max + pad;
    const left = 58;
    const right = 24;
    const top = 28;
    const bottom = 86;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const xAt = (index) => left + (dates.length === 1 ? plotW / 2 : (plotW * index) / (dates.length - 1));
    const yAt = (value) => top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#d7dee8";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#637084";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i += 1) {
      const value = yMin + ((yMax - yMin) * i) / 5;
      const y = yAt(value);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.fillText(fmt(value), left - 8, y);
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    dates.forEach((date, index) => {
      if (dates.length > 12 && index % Math.ceil(dates.length / 12) !== 0) return;
      ctx.save();
      ctx.translate(xAt(index), height - bottom + 12);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(shortDate(date), 0, 0);
      ctx.restore();
    });

    metrics.forEach((metric, metricIndex) => {
      const color = COLORS[metricIndex % COLORS.length];
      const points = dates
        .map((date, index) => {
          const row = grouped.get(`${metric.key}|${date}`);
          return row ? { x: xAt(index), y: yAt(row.mark), value: row.mark } : null;
        })
        .filter(Boolean);
      if (!points.length) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      points.forEach((point) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    $("#chartLegend").innerHTML = metrics
      .map((metric, index) => `<span class="legend-item"><span class="legend-swatch" style="background:${COLORS[index % COLORS.length]}"></span>${esc(metric.label)}</span>`)
      .join("");
  }

  function drawApproachChart(ctx, width, height, discipline, athleteId, checkedDates) {
    const approaches = discipline.approaches;
    const rows = flattenAttempts().filter((row) => row.athleteId === athleteId && row.discipline === discipline.id);
    const selectedDates = checkedDates.length ? checkedDates : approachDateOptions(discipline).slice(0, 5).map((item) => item.key);
    const grouped = new Map();
    rows.forEach((row) => {
      if (!selectedDates.includes(row.date)) return;
      const key = `${row.date}|${row.approachId}`;
      const current = grouped.get(key);
      if (!current || row.mark > current.mark) grouped.set(key, row);
    });
    const values = Array.from(grouped.values()).map((row) => row.mark);

    if (!values.length) {
      drawEmptyChart(ctx, width, height, "Sin marcas para estas zancadas");
      $("#chartLegend").innerHTML = "";
      return;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max(0.1, (max - min) * 0.18);
    const yMin = Math.max(0, min - pad);
    const yMax = max + pad;
    const left = 58;
    const right = 24;
    const top = 28;
    const bottom = 48;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const xAt = (index) => left + (approaches.length === 1 ? plotW / 2 : (plotW * index) / (approaches.length - 1));
    const yAt = (value) => top + plotH - ((value - yMin) / (yMax - yMin || 1)) * plotH;

    drawChartFrame(ctx, width, height, left, right, top, bottom, yMin, yMax, yAt);

    ctx.fillStyle = "#637084";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    approaches.forEach((approach, index) => {
      ctx.fillText(approach.short, xAt(index), height - bottom + 16);
    });

    selectedDates.forEach((date, dateIndex) => {
      const color = COLORS[dateIndex % COLORS.length];
      const points = approaches
        .map((approach, index) => {
          const row = grouped.get(`${date}|${approach.id}`);
          return row ? { x: xAt(index), y: yAt(row.mark), value: row.mark } : null;
        })
        .filter(Boolean);
      if (!points.length) return;
      drawChartLine(ctx, points, color);
    });

    $("#chartLegend").innerHTML = selectedDates
      .map((date, index) => `<span class="legend-item"><span class="legend-swatch" style="background:${COLORS[index % COLORS.length]}"></span>${shortDate(date)}</span>`)
      .join("");
  }

  function drawChartFrame(ctx, width, height, left, right, top, bottom, yMin, yMax, yAt) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#d7dee8";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#637084";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i += 1) {
      const value = yMin + ((yMax - yMin) * i) / 5;
      const y = yAt(value);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.fillText(fmt(value), left - 8, y);
    }
  }

  function drawChartLine(ctx, points, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    points.forEach((point) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawEmptyChart(ctx, width, height, message) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#637084";
    ctx.font = "18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, width / 2, height / 2);
  }

  async function syncSmart() {
    const remote = await fetchRemote();
    if (!remote) return;
    const localTime = Date.parse(state.updatedAt || 0);
    const remoteTime = Date.parse(remote.updatedAt || remote.savedAt || 0);
    if (remote.data && remoteTime > localTime) {
      state = normalizeIncoming(remote.data);
      saveState(false);
      renderAll();
      toast("Datos descargados");
      return;
    }
    await pushRemote();
  }

  async function pullRemote() {
    const remote = await fetchRemote();
    if (!remote || !remote.data) return;
    state = normalizeIncoming(remote.data);
    saveState(false);
    renderAll();
    toast("Datos descargados");
  }

  async function pushRemote() {
    const key = getSyncKey();
    if (!key) return;
    const endpoint = getSyncEndpoint();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sync-key": key },
        body: JSON.stringify({ data: state, updatedAt: state.updatedAt }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      state.preferences.lastSyncAt = payload.savedAt || new Date().toISOString();
      saveState(false);
      updateSyncStatus();
      toast("Datos subidos");
    } catch (error) {
      console.error(error);
      toast("No se pudo subir");
    }
  }

  async function fetchRemote() {
    const key = getSyncKey();
    if (!key) return null;
    const endpoint = getSyncEndpoint();
    try {
      const response = await fetch(endpoint, { headers: { "x-sync-key": key } });
      if (response.status === 404) return { data: null };
      if (!response.ok) throw new Error(await response.text());
      return await response.json();
    } catch (error) {
      console.error(error);
      toast("No se pudo sincronizar");
      return null;
    }
  }

  function getSyncKey() {
    const key = $("#syncKeyInput").value.trim();
    if (!key) toast("Falta la clave");
    return key;
  }

  function toggleSyncKeyVisibility() {
    const input = $("#syncKeyInput");
    const button = $("#toggleSyncKey");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.setAttribute("aria-label", visible ? "Mostrar clave" : "Ocultar clave");
    button.title = visible ? "Mostrar clave" : "Ocultar clave";
  }

  function getSyncEndpoint() {
    return ($("#syncEndpointInput").value || "/api/sync").trim();
  }

  function normalizeIncoming(incoming) {
    const next = clone(incoming);
    next.preferences = { ...(state.preferences || {}), ...(next.preferences || {}) };
    next.updatedAt = next.updatedAt || new Date().toISOString();
    next.athletes = Array.isArray(next.athletes) ? next.athletes : [];
    next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
    next.preferences = next.preferences || {};
    migrateLucioAthlete(next);
    mergeDuplicateAthletes(next);
    migrateApproachDistanceSettings(next);
    return next;
  }

  function exportBackup() {
    download(`tecnica-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), "application/json");
    toast("Backup descargado");
  }

  function exportCsv() {
    const rows = flattenRows();
    const header = ["fecha", "atleta", "especialidad", "columna", "marca", "unidad", "pies", "centimetros", "notas"];
    const csv = [header, ...rows.map((row) => [
      row.date,
      row.athleteName,
      row.disciplineLabel,
      row.metricLabel,
      row.mark ?? "",
      row.unit ?? "",
      row.distanceFeet ?? "",
      formatCm(row.distanceCm),
      row.notes ?? "",
    ])].map((row) => row.map(csvCell).join(",")).join("\n");
    download(`tecnica-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv;charset=utf-8");
    toast("CSV descargado");
  }

  function importBackup(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        state = normalizeIncoming(incoming);
        saveState();
        renderAll();
        toast("Backup cargado");
      } catch (error) {
        console.error(error);
        toast("JSON no valido");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  function resetSeed() {
    if (!confirm("Restaurar los datos iniciales?")) return;
    state = clone(window.TECNICA_SEED);
    state.preferences = {};
    state.updatedAt = new Date().toISOString();
    migrateState();
    renderAll();
    toast("Seed restaurado");
  }

  function renderSourceNotes() {
    $("#sourceNotes").innerHTML = (state.sourceNotes || [])
      .map((note) => `
        <div class="source-note-block">
          <strong>${esc(note.sheet)}</strong>
          ${(note.rows || []).map((row) => `<div>${esc(row)}</div>`).join("")}
        </div>
      `)
      .join("");
  }

  function updateSyncStatus() {
    const status = $("#syncStatus");
    if (!status) return;
    if (!navigator.onLine) {
      status.textContent = "Offline";
      return;
    }
    const last = state.preferences?.lastSyncAt;
    status.textContent = last ? `Sync ${shortDate(last.slice(0, 10))}` : "Local";
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((error) => console.warn(error));
    });
  }

  function parseMark(value) {
    const parsed = parseOptional(value);
    return parsed != null && parsed >= 0 ? parsed : null;
  }

  function parseOptional(value) {
    if (value == null || value === "") return null;
    const parsed = Number(String(value).replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseCmInput(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const normalized = text.replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return /[,.]/.test(text) ? Math.round(parsed * 100) : Math.round(parsed);
  }

  function fmt(value) {
    if (value == null || value === "") return "";
    return Number(value).toLocaleString("es-ES", { maximumFractionDigits: 2 });
  }

  function formatCm(value) {
    if (value == null || value === "") return "";
    return (Number(value) / 100).toLocaleString("es-ES", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatDate(date) {
    if (!date) return "";
    const [y, m, d] = date.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }

  function shortDate(date) {
    if (!date) return "";
    const [y, m, d] = date.slice(0, 10).split("-");
    return `${d}/${m}/${String(y).slice(2)}`;
  }

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function slug(value) {
    return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "atleta";
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function cryptoId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2400);
  }
})();
