(function () {
  "use strict";

  const STORAGE_KEY = "tecnica-state-v1";
  const APP_VERSION = "001v7";
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
      approaches: approachList("pasos", [3, 5, 7, 9]),
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  let state = loadState();
  let draft = { attempts: [], distances: {} };
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
    migrateLucioAthlete();
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
    saveState(false);
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
      draft = { attempts: [], distances: {} };
      renderAttemptEditor();
    });

    $("#sessionForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveSessionFromDraft();
    });

    $("#clearDraftButton").addEventListener("click", () => {
      draft = { attempts: [], distances: {} };
      renderAttemptEditor();
      toast("Borrador limpio");
    });

    $("#recordsBody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-session], [data-delete-attempt], [data-delete-distance]");
      if (!button) return;
      if (button.dataset.deleteSession) deleteSession(button.dataset.deleteSession);
      if (button.dataset.deleteAttempt) deleteAttempt(button.dataset.deleteAttempt);
      if (button.dataset.deleteDistance) deleteDistance(button.dataset.deleteDistance, button.dataset.approach);
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
      const button = event.target.closest("[data-toggle-athlete]");
      if (!button) return;
      const athlete = state.athletes.find((item) => item.id === button.dataset.toggleAthlete);
      if (!athlete) return;
      athlete.active = !athlete.active;
      saveState();
      renderAll();
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
      drawChart();
    });
    $("#chartDiscipline").addEventListener("change", () => {
      state.preferences.chartDiscipline = $("#chartDiscipline").value;
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
      ["Jornadas", String(state.sessions.length), "Sesiones guardadas"],
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
        <div class="attempt-list" data-list="${metric.id}"></div>
      </article>
    `;
  }

  function renderApproachCard(discipline, approach) {
    const latest = latestDistance(discipline.id, approach.id);
    const draftDistance = draft.distances[approach.id] || latest || {};
    return `
      <article class="attempt-card" data-approach="${approach.id}">
        <h3 title="${esc(approach.label)}">${esc(approach.short)}</h3>
        <div class="mini-grid">
          <input type="number" inputmode="decimal" step="0.1" min="0" placeholder="Pies" data-distance-feet value="${draftDistance.feet ?? ""}">
          <input type="number" inputmode="decimal" step="1" min="0" placeholder="Cent." data-distance-cm value="${draftDistance.cm ?? ""}">
        </div>
        <input type="number" inputmode="decimal" step="0.01" min="0" placeholder="Marca" data-mark>
        <button class="small-button" type="button" data-add-approach>Añadir</button>
        <div class="attempt-list" data-list="${approach.id}"></div>
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
    const feet = parseOptional($("[data-distance-feet]", card).value);
    const cm = parseOptional($("[data-distance-cm]", card).value);
    const mark = parseMark($("[data-mark]", card).value);
    draft.distances[approachId] = { feet, cm };
    if (mark == null) {
      renderDraftChips();
      return toast("Distancia guardada para la jornada");
    }
    draft.attempts.push({
      draftId: cryptoId(),
      eventId: `${discipline.id}_approach`,
      eventName: discipline.eventName,
      approachId,
      approachLabel: approach.label,
      distanceFeet: feet,
      distanceCm: cm,
      mark,
      unit: discipline.unit,
    });
    $("[data-mark]", card).value = "";
    renderDraftChips();
  }

  function renderDraftChips() {
    $$(".attempt-list").forEach((list) => {
      const key = list.dataset.list;
      const attempts = draft.attempts.filter((attempt) => attempt.eventId === key || attempt.approachId === key);
      const distance = draft.distances[key];
      const distanceChip = distance && (distance.feet || distance.cm)
        ? `<span class="chip">${distance.feet ? fmt(distance.feet) + " p" : ""}${distance.feet && distance.cm ? " / " : ""}${distance.cm ? fmt(distance.cm) + " cm" : ""}</span>`
        : "";
      list.innerHTML = distanceChip + attempts
        .map((attempt, index) => `
          <span class="chip">${index + 1}: ${fmt(attempt.mark)} ${attempt.unit}<button type="button" data-remove-draft="${attempt.draftId}" aria-label="Quitar">x</button></span>
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

  function saveSessionFromDraft() {
    const discipline = DISCIPLINES[$("#disciplineSelect").value];
    const date = $("#dateInput").value;
    const athleteId = $("#athleteSelect").value;
    const notes = $("#notesInput").value.trim();
    collectVisibleDistances(discipline);
    const hasDistance = Object.values(draft.distances).some((item) => item && (item.feet != null || item.cm != null));
    if (!draft.attempts.length && !hasDistance) return toast("No hay datos para guardar");

    const counts = {};
    const attempts = draft.attempts.map((attempt) => {
      const key = attempt.approachId || attempt.eventId;
      counts[key] = (counts[key] || 0) + 1;
      const distance = attempt.approachId ? draft.distances[attempt.approachId] || {} : {};
      return {
        id: cryptoId(),
        eventId: attempt.eventId,
        eventName: attempt.eventName,
        approachId: attempt.approachId,
        approachLabel: attempt.approachLabel,
        distanceFeet: distance.feet ?? attempt.distanceFeet ?? null,
        distanceCm: distance.cm ?? attempt.distanceCm ?? null,
        mark: attempt.mark,
        unit: attempt.unit,
        attempt: counts[key],
      };
    });

    state.sessions.push({
      id: cryptoId(),
      date,
      athleteId,
      discipline: discipline.id,
      notes,
      attempts,
      approachDistances: clone(draft.distances),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    draft = { attempts: [], distances: {} };
    $("#notesInput").value = "";
    saveState();
    renderAll();
    toast("Jornada guardada");
  }

  function collectVisibleDistances(discipline) {
    if (!discipline || discipline.mode !== "approach") return;
    $$(".attempt-card[data-approach]").forEach((card) => {
      const approachId = card.dataset.approach;
      const feet = parseOptional($("[data-distance-feet]", card).value);
      const cm = parseOptional($("[data-distance-cm]", card).value);
      if (feet != null || cm != null) draft.distances[approachId] = { feet, cm };
    });
  }

  function latestDistance(disciplineId, approachId) {
    const sessions = state.sessions
      .filter((session) => session.discipline === disciplineId)
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const session of sessions) {
      const distance = session.approachDistances && session.approachDistances[approachId];
      if (distance && (distance.feet != null || distance.cm != null)) return distance;
    }
    return null;
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
        const deleteAttr = row.kind === "distance"
          ? `data-delete-distance="${row.sessionId}" data-approach="${row.approachId}"`
          : `data-delete-attempt="${row.attemptId}"`;
        return `
          <tr>
            <td>${formatDate(row.date)}</td>
            <td>${esc(row.athleteName)}</td>
            <td>${esc(row.disciplineLabel)}</td>
            <td>${esc(row.metricLabel)}</td>
            <td>${row.mark == null ? '<span class="muted">-</span>' : `${fmt(row.mark)} ${row.unit}${isBest ? '<span class="best-badge">Mejor</span>' : ''}`}</td>
            <td>${row.distanceFeet == null ? "" : fmt(row.distanceFeet)}</td>
            <td>${row.distanceCm == null ? "" : fmt(row.distanceCm)}</td>
            <td><button class="small-button delete-button" type="button" ${deleteAttr}>-</button></td>
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
          ${columns.map((column) => `<td>${formatRecordCell(row.values[column.key])}</td>`).join("")}
          <td><button class="small-button delete-button" type="button" data-delete-session="${row.sessionId}" aria-label="Eliminar jornada">-</button></td>
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
    return state.sessions
      .filter((session) => session.discipline === disciplineId)
      .map((session) => {
        const athlete = state.athletes.find((item) => item.id === session.athleteId);
        const values = {};
        session.attempts.forEach((attempt) => {
          const key = attempt.approachId ? `${session.discipline}:${attempt.approachId}` : attempt.eventId;
          values[key] = values[key] || { mark: null, unit: attempt.unit || "m", attempts: 0 };
          values[key].attempts += 1;
          if (values[key].mark == null || attempt.mark > values[key].mark) values[key].mark = attempt.mark;
        });
        return {
          sessionId: session.id,
          date: session.date,
          athleteId: session.athleteId,
          athleteName: athlete ? athlete.name : session.athleteId,
          values,
          search: {
            date: session.date,
            athlete: athlete ? athlete.name : session.athleteId,
            notes: session.notes || "",
            values: Object.values(values).map((value) => value.mark).join(" "),
          },
        };
      });
  }

  function formatRecordCell(value) {
    if (!value || value.mark == null) return "";
    return fmt(value.mark);
  }

  function flattenAttempts() {
    return state.sessions.flatMap((session) => {
      const athlete = state.athletes.find((item) => item.id === session.athleteId);
      const discipline = DISCIPLINES[session.discipline] || DISCIPLINES.tests;
      return session.attempts.map((attempt) => {
        const metricLabel = attempt.approachId ? `${attempt.eventName} ${attempt.approachLabel}` : attempt.eventName;
        const distance = attempt.approachId ? session.approachDistances?.[attempt.approachId] || {} : {};
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
          distanceFeet: distance.feet ?? attempt.distanceFeet ?? null,
          distanceCm: distance.cm ?? attempt.distanceCm ?? null,
          notes: session.notes || "",
        };
      });
    });
  }

  function flattenRows() {
    const rows = flattenAttempts();
    state.sessions.forEach((session) => {
      const discipline = DISCIPLINES[session.discipline];
      if (!discipline || discipline.mode !== "approach") return;
      const athlete = state.athletes.find((item) => item.id === session.athleteId);
      Object.entries(session.approachDistances || {}).forEach(([approachId, distance]) => {
        const hasAttempt = session.attempts.some((attempt) => attempt.approachId === approachId);
        if (hasAttempt || (!distance.feet && !distance.cm)) return;
        const approach = discipline.approaches.find((item) => item.id === approachId);
        rows.push({
          kind: "distance",
          sessionId: session.id,
          date: session.date,
          athleteId: session.athleteId,
          athleteName: athlete ? athlete.name : session.athleteId,
          discipline: session.discipline,
          disciplineLabel: discipline.label,
          metricKey: `${session.discipline}:${approachId}`,
          metricLabel: approach ? approach.label : approachId,
          approachId,
          mark: null,
          unit: "m",
          distanceFeet: distance.feet ?? null,
          distanceCm: distance.cm ?? null,
          notes: session.notes || "",
        });
      });
    });
    return rows;
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
    state.sessions = state.sessions.filter((session) => session.attempts.length || Object.keys(session.approachDistances || {}).length);
    saveState();
    renderAll();
  }

  function deleteSession(sessionId) {
    if (!confirm("Eliminar jornada completa?")) return;
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    saveState();
    renderAll();
  }

  function deleteDistance(sessionId, approachId) {
    if (!confirm("Eliminar distancia?")) return;
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session || !session.approachDistances) return;
    delete session.approachDistances[approachId];
    state.sessions = state.sessions.filter((item) => item.attempts.length || Object.keys(item.approachDistances || {}).length);
    saveState();
    renderAll();
  }

  function renderAthletes() {
    $("#athleteList").innerHTML = state.athletes
      .map((athlete) => `
        <div class="athlete-row">
          <strong>${esc(athlete.name)}</strong>
          <button class="small-button" type="button" data-toggle-athlete="${esc(athlete.id)}">${athlete.active === false ? "Activar" : "Ocultar"}</button>
        </div>
      `)
      .join("");
  }

  function renderMetricPicker() {
    const discipline = DISCIPLINES[$("#chartDiscipline").value] || DISCIPLINES.tests;
    const metrics = metricOptions(discipline);
    const selected = new Set(state.preferences.chartMetrics?.[discipline.id] || metrics.slice(0, 3).map((item) => item.key));
    $("#metricPicker").innerHTML = metrics
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
    return discipline.approaches.map((approach) => ({ key: `${discipline.id}:${approach.id}`, label: approach.label }));
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
    const checked = $$("input:checked", $("#metricPicker")).map((input) => input.value);
    state.preferences.chartMetrics = state.preferences.chartMetrics || {};
    state.preferences.chartMetrics[discipline.id] = checked;
    saveState(false);

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
    const bottom = 54;
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

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    dates.forEach((date, index) => {
      if (dates.length > 8 && index % Math.ceil(dates.length / 8) !== 0) return;
      ctx.fillText(shortDate(date), xAt(index), height - bottom + 18);
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
    return next;
  }

  function exportBackup() {
    download(`tecnica-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), "application/json");
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
      row.distanceCm ?? "",
      row.notes ?? "",
    ])].map((row) => row.map(csvCell).join(",")).join("\n");
    download(`tecnica-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv;charset=utf-8");
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

  function fmt(value) {
    if (value == null || value === "") return "";
    return Number(value).toLocaleString("es-ES", { maximumFractionDigits: 2 });
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
