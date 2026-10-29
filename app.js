(() => {
  "use strict";

  const config = window.GOAL_TRACKER_CONFIG || {};
  const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
  const GOAL_HEADERS = ["id", "name", "owner_email", "description", "start_date", "end_date", "start_value", "end_value", "unit", "status", "competition_id", "updated_at", "favorite", "cumulative"];
  const HISTORY_HEADERS = ["goal_id", "date", "value", "note", "updated_by"];
  const COMPETITION_HEADERS = ["id", "name", "description", "start_date", "end_date", "created_by", "created_at"];
  const $ = (id) => document.getElementById(id);

  let tokenClient = null;
  let accessToken = null;
  let signedInUser = null;
  let goals = [];
  let historyRows = [];
  let competitions = [];
  let currentPage = "goals";
  let selectedGoalId = "";
  let busy = false;
  let toastTimer = null;
  let silentAuthorization = false;
  const PREFERENCE_KEYS = {
    selectedGoal: "littlewins.selectedGoalId",
    search: "littlewins.goalSearch",
    statusFilter: "littlewins.goalStatusFilter",
    page: "littlewins.currentPage"
  };

  const connectPanel = $("connectPanel");
  const welcomeHero = $("welcomeHero");
  const dashboard = $("dashboard");
  const competitionsPage = $("competitionsPage");
  const dialog = $("goalDialog");
  const competitionDialog = $("competitionDialog");
  const progressDialog = $("progressDialog");

  function readPreference(key, fallback = "") {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writePreference(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      showNotice("Your browser blocked local preferences, so this selection will not persist.");
    }
  }

  function removePreference(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      // Preferences are optional; sign-out should still complete.
    }
  }

  function loadPreferences() {
    selectedGoalId = readPreference(PREFERENCE_KEYS.selectedGoal);
    $("searchInput").value = readPreference(PREFERENCE_KEYS.search);
    const savedFilter = readPreference(PREFERENCE_KEYS.statusFilter, "active");
    if ([...$("statusFilter").options].some(option => option.value === savedFilter)) {
      $("statusFilter").value = savedFilter;
    }
    currentPage = readPreference(PREFERENCE_KEYS.page, "goals") === "competitions" ? "competitions" : "goals";
  }

  function configReady() {
    return config.googleClientId && !config.googleClientId.startsWith("YOUR_") &&
      config.spreadsheetId && !config.spreadsheetId.startsWith("YOUR_");
  }

  function setConnection(connected, label) {
    $("connectionDot").classList.toggle("connected", connected);
    $("connectionLabel").textContent = label;
    $("signOutButton").classList.toggle("hidden", !connected);
    connectPanel.classList.toggle("hidden", connected);
    welcomeHero.classList.toggle("hidden", connected);
    dashboard.classList.toggle("hidden", !connected);
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 3600);
  }

  function showNotice(message, success = false) {
    const notice = $("notice");
    notice.textContent = message;
    notice.classList.toggle("hidden", !message);
    notice.classList.toggle("success", success);
  }

  function apiErrorMessage(error) {
    const msg = error && error.message ? error.message : String(error);
    if (/403|permission|insufficient authentication scopes/i.test(msg)) {
      return "Google denied this action. Confirm that this account has access to the shared sheet and that the app has been authorized for Sheets access.";
    }
    if (/404|not found/i.test(msg)) {
      return "The spreadsheet or a required tab was not found. Check the spreadsheet ID and the tab names in config.js.";
    }
    if (/401|invalid credentials|expired/i.test(msg)) {
      return "Your Google access has expired. Select Connect Google to authorize again.";
    }
    return msg;
  }

  function initGoogle() {
    if (!configReady()) {
      showNotice("Setup needed: copy config.example.js to config.js and enter your OAuth client ID and spreadsheet ID.");
      $("connectButton").disabled = true;
      $("connectButton").textContent = "Finish setup first";
      return;
    }
    const waitForGoogle = () => {
      if (window.google && google.accounts && google.accounts.oauth2) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: config.googleClientId,
          scope: SCOPES,
          callback: async (response) => {
            if (response.error) {
              if (!silentAuthorization) {
                showNotice("Google authorization did not complete: " + response.error);
              }
              silentAuthorization = false;
              return;
            }
            silentAuthorization = false;
            accessToken = response.access_token;
            try {
              const userResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (!userResponse.ok) throw new Error("Could not retrieve Google profile (" + userResponse.status + ").");
              signedInUser = await userResponse.json();
              setConnection(true, signedInUser.email || "Connected");
              $("connectionLabel").textContent = signedInUser.email || "Connected";
              await loadData();
            } catch (error) {
              showNotice(apiErrorMessage(error));
              accessToken = null;
              setConnection(false, "Not connected");
            }
          }
        });
        $("connectButton").disabled = false;
        try {
          silentAuthorization = true;
          tokenClient.requestAccessToken({ prompt: "" });
        } catch (error) {
          silentAuthorization = false;
          showNotice(apiErrorMessage(error));
        }
      } else {
        setTimeout(waitForGoogle, 100);
      }
    };
    waitForGoogle();
  }

  function authorize(prompt = "consent") {
    if (!tokenClient) {
      showNotice("Google sign-in is still loading. Try again in a moment.");
      return;
    }
    silentAuthorization = false;
    tokenClient.requestAccessToken({ prompt });
  }

  async function googleFetch(url, options = {}) {
    if (!accessToken) throw new Error("Not connected to Google.");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...options, headers });
    const bodyText = await response.text();
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { body = { raw: bodyText }; }
    if (!response.ok) {
      const apiMessage = body?.error?.message || response.statusText || "Google API request failed";
      throw new Error(`${response.status}: ${apiMessage}`);
    }
    return body;
  }

  function sheetsUrl(range, suffix = "") {
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(range)}${suffix}`;
  }

  async function getRange(range) {
    const data = await googleFetch(sheetsUrl(range));
    return data.values || [];
  }

  async function updateRange(range, values) {
    return googleFetch(sheetsUrl(range, "?valueInputOption=USER_ENTERED"), {
      method: "PUT",
      body: JSON.stringify({ range, majorDimension: "ROWS", values })
    });
  }

  async function appendRange(range, values) {
    return googleFetch(sheetsUrl(range, ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"), {
      method: "POST",
      body: JSON.stringify({ majorDimension: "ROWS", values })
    });
  }

  async function ensureHeaders(sheetName, expectedHeaders) {
    const existing = await getRange(`${sheetName}!A1:${columnLetter(expectedHeaders.length)}1`);
    if (!existing.length || !existing[0].some(value => String(value || "").trim())) {
      await updateRange(`${sheetName}!A1:${columnLetter(expectedHeaders.length)}1`, [expectedHeaders]);
      return;
    }
    const normalized = existing[0].map(value => String(value || "").trim().toLowerCase());
    const mismatch = expectedHeaders.some((header, index) => normalized[index] !== header);
    if (mismatch) {
      throw new Error(`The "${sheetName}" tab has unexpected column headers. Expected: ${expectedHeaders.join(", ")}. Please fix row 1, then refresh.`);
    }
  }

  function columnLetter(number) {
    let result = "";
    while (number > 0) {
      const remainder = (number - 1) % 26;
      result = String.fromCharCode(65 + remainder) + result;
      number = Math.floor((number - 1) / 26);
    }
    return result;
  }

  async function loadData() {
    if (busy) return;
    busy = true;
    $("refreshButton").textContent = "Loading…";
    showNotice("");
    try {
      await ensureHeaders(config.goalsSheet || "Goals", GOAL_HEADERS);
      await ensureHeaders(config.historySheet || "Progress History", HISTORY_HEADERS);
      await ensureHeaders(config.competitionsSheet || "Competitions", COMPETITION_HEADERS);
      const [goalValues, historyValues, competitionValues] = await Promise.all([
        getRange(`${config.goalsSheet || "Goals"}!A2:N`),
        getRange(`${config.historySheet || "Progress History"}!A2:E`)
        ,getRange(`${config.competitionsSheet || "Competitions"}!A2:G`)
      ]);
      goals = goalValues.filter(row => row.some(value => String(value || "").trim()))
        .map(row => ({
          id: String(row[0] || ""),
          name: String(row[1] || ""),
          owner_email: String(row[2] || ""),
          description: String(row[3] || ""),
          start_date: String(row[4] || ""),
          end_date: String(row[5] || ""),
          start_value: numberOrZero(row[6]),
          end_value: numberOrZero(row[7]),
          unit: String(row[8] || "$"),
          status: String(row[9] || "Active"),
          competition_id: String(row[10] || ""),
          updated_at: String(row[11] || ""),
          favorite: String(row[12] || "").toLowerCase() === "true",
          cumulative: String(row[13] || "").toLowerCase() === "true"
        })).filter(goal => goal.status.toLowerCase() !== "deleted");
      if (!goals.some(goal => goal.id === selectedGoalId)) {
        selectedGoalId = goals[0]?.id || "";
      }
      historyRows = historyValues;
      competitions = competitionValues.filter(row => row.some(value => String(value || "").trim())).map(row => ({
        id: String(row[0] || ""), name: String(row[1] || ""), description: String(row[2] || ""),
        start_date: String(row[3] || ""), end_date: String(row[4] || ""),
        created_by: String(row[5] || ""), created_at: String(row[6] || "")
      }));
      render();
      renderCompetitions();
      switchPage(currentPage);
      showNotice("");
    } catch (error) {
      showNotice(apiErrorMessage(error));
    } finally {
      busy = false;
      $("refreshButton").textContent = "Refresh data ↻";
    }
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function safeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function fmtNumber(value, unit) {
    const number = Number(value) || 0;
    if (unit === "$" || unit.toLowerCase() === "usd" || unit.toLowerCase() === "dollars") {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(number);
    }
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number)} ${unit}`.trim();
  }

  function percent(goal) {
    const latest = latestProgress(goal);
    const range = goal.end_value - goal.start_value;
    if (range <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((latest - goal.start_value) / range * 100)));
  }

  function latestProgress(goal) {
    const entries = historyRows.filter(row => String(row[0] || "") === goal.id)
      .sort((a, b) => String(a[1] || "").localeCompare(String(b[1] || "")));
    if (!entries.length) return goal.start_value;
    return goal.cumulative
      ? goal.start_value + entries.reduce((sum, row) => sum + numberOrZero(row[2]), 0)
      : numberOrZero(entries[entries.length - 1][2]);
  }

  function dateLabel(dateString, prefix = "Due ") {
    if (!dateString) return "No deadline";
    const date = new Date(`${dateString.slice(0, 10)}T12:00:00`);
    if (Number.isNaN(date.getTime())) return "No deadline";
    return prefix + date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function isCompleted(goal) {
    return goal.status.toLowerCase() === "completed" || percent(goal) >= 100;
  }

  function render() {
    const active = goals.filter(goal => goal.status.toLowerCase() === "active" && !isCompleted(goal));
    const completed = goals.filter(isCompleted);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const soon = new Date(today); soon.setDate(soon.getDate() + 14);
    const dueSoon = active.filter(goal => {
      if (!goal.end_date) return false;
      const date = new Date(`${goal.end_date.slice(0, 10)}T12:00:00`);
      return date >= today && date <= soon;
    });
    $("activeCount").textContent = active.length;
    $("completedCount").textContent = completed.length;
    $("dueSoonCount").textContent = dueSoon.length;

    const filter = $("statusFilter").value;
    const query = $("searchInput").value.trim().toLowerCase();
    let visible = goals.filter(goal => {
      if (filter === "active" && (goal.status.toLowerCase() !== "active" || isCompleted(goal))) return false;
      if (filter === "completed" && !isCompleted(goal)) return false;
      return `${goal.name} ${goal.description} ${goal.owner_email}`.toLowerCase().includes(query);
    });
    visible.sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    $("goalsGrid").innerHTML = visible.map((goal, index) => renderGoalCard(goal, index)).join("");
    $("goalListCount").textContent = `${visible.length} goal${visible.length === 1 ? "" : "s"}`;
    if (!visible.some(goal => goal.id === selectedGoalId)) selectedGoalId = visible[0]?.id || "";
    writePreference(PREFERENCE_KEYS.selectedGoal, selectedGoalId);
    renderGoalDetail(goals.find(goal => goal.id === selectedGoalId));
    $("emptyState").classList.toggle("hidden", visible.length > 0);
    $("goalsGrid").classList.toggle("hidden", visible.length === 0);
    $("emptyState").querySelector("h3").textContent = goals.length ? "No goals found." : "Your next chapter starts here.";
    $("emptyState").querySelector("p").textContent = goals.length ? "Try another search or filter to find what you're looking for." : "Add a goal, pick a first step, and give it somewhere to grow.";
    $("emptyNewGoalButton").classList.toggle("hidden", goals.length > 0);
  }

  function renderGoalCard(goal, index) {
    const pct = percent(goal);
    const completed = isCompleted(goal);
    const status = completed ? "Completed" : goal.status;
    const statusClass = status.toLowerCase();
    const symbol = ["↗", "✦", "⌂", "◎", "✳", "◇"][index % 6];
    const colorClass = `color-${index % 4}`;
    const amountLabel = fmtNumber(latestProgress(goal), goal.unit);
    const targetLabel = fmtNumber(goal.end_value, goal.unit);
    const description = goal.description || "A goal worth making time for.";
    return `<article class="goal-card ${selectedGoalId === goal.id ? "selected" : ""}" data-goal-id="${safeText(goal.id)}" tabindex="0" role="button" aria-pressed="${selectedGoalId === goal.id}">
      <div class="goal-card-top">
        <div class="flex-row">
          <div class="goal-symbol ${colorClass}">${symbol}</div>
          <h3 class="goal-title">${safeText(goal.name)}</h3>
        </div>
        ${goal.favorite ? `<span class="favorite-mark" aria-label="Favorite goal">★</span>` : ""}
      </div>
      <p class="goal-description">${safeText(description)}</p>
      <div class="goal-metrics"><span class="goal-amount">${safeText(amountLabel)}</span><span class="goal-target">of ${safeText(targetLabel)}</span></div>
      <div class="progress-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${safeText(goal.name)} progress"><div class="progress-fill ${completed ? "complete" : ""}" style="width:${pct}%"></div></div>
      <div class="goal-bottom"><span class="status-pill ${statusClass}">${safeText(status)}</span><span class="due-date">${safeText(dateLabel(goal.end_date))}</span></div>
    </article>`;
  }

  function renderGoalDetail(goal) {
    const detail = $("goalDetail");
    if (!goal) {
      detail.innerHTML = `<div class="goal-detail-empty"><span class="empty-illustration">✳</span><h3>Select a goal</h3><p>Choose a goal from the list to see its progress and entries.</p></div>`;
      return;
    }
    const entries = progressEntriesFor(goal.id).sort((a, b) => String(b.row[1] || "").localeCompare(String(a.row[1] || "")));
    const pct = percent(goal);
    detail.innerHTML = `<div class="goal-detail-header">
      <div><p class="eyebrow">Goal detail</p><h2>${safeText(goal.name)}</h2><p class="goal-detail-description">${safeText(goal.description || "A goal worth making time for.")}</p></div>
      <div class="goal-detail-actions"><button class="button button-quiet favorite-button ${goal.favorite ? "is-favorite" : ""}" type="button" data-action="favorite" data-id="${safeText(goal.id)}">${goal.favorite ? "★ Favorited" : "☆ Favorite"}</button><button class="button button-quiet" type="button" data-action="edit" data-id="${safeText(goal.id)}">Edit goal</button><button class="button button-primary" type="button" data-action="progress" data-id="${safeText(goal.id)}">＋ Add Entry</button><button class="button button-quiet danger-button" type="button" data-action="delete" data-id="${safeText(goal.id)}">Delete</button></div>
    </div>
    <div class="detail-stat-grid">
      <div><span>Current</span><strong>${safeText(fmtNumber(latestProgress(goal), goal.unit))}</strong></div>
      <div><span>Target</span><strong>${safeText(fmtNumber(goal.end_value, goal.unit))}</strong></div>
      <div><span>Progress</span><strong>${pct}%</strong></div>
      <div><span>Time frame</span><strong>${safeText(dateLabel(goal.end_date, ""))}</strong></div>
    </div>
    <div class="detail-progress-track"><div style="width:${pct}%"></div></div>
    <div class="detail-section-heading"><div><p class="eyebrow">Trend</p><h3>Progress Over Time</h3></div><span class="detail-target-label">Target pace → 100%</span></div>
    ${renderGoalChart(goal, entries)}
    <div class="detail-section-heading"><div><p class="eyebrow">History</p><h3>Progress Entries</h3></div><span>${entries.length} update${entries.length === 1 ? "" : "s"}</span></div>
    <div class="goal-history detail-history">${entries.length ? `<div class="progress-table-wrap"><table class="progress-table"><thead><tr><th class="date-header">Date</th><th>Progress</th><th>Note</th><th class="actions-header">Actions</th></tr></thead><tbody>${entries.map(item => renderGoalEntry(goal, item)).join("")}</tbody></table></div>` : `<div class="goal-history-empty">No entries yet. Add the first update to start the trend.</div>`}</div>`;
  }

  function renderGoalEntry(goal, item) {
    const row = item.row;
    return `<tr class="goal-history-entry">
      <td class="history-date">${safeText(dateLabel(row[1], ""))}</td>
      <td class="history-value">${safeText(fmtNumber(row[2], goal.unit))}</td>
      <td class="history-note">${row[3] ? safeText(row[3]) : `<span class="history-empty-note">No note</span>`}</td>
      <td><span class="history-actions"><button class="history-action" type="button" data-progress-action="edit" data-id="${safeText(goal.id)}" data-row-index="${item.index}">Edit</button><button class="history-action danger" type="button" data-progress-action="delete" data-id="${safeText(goal.id)}" data-row-index="${item.index}">Delete</button></span></td>
    </tr>`;
  }

  function renderGoalChart(goal, entries) {
    const width = 760;
    const height = 280;
    const chartLeft = 12;
    const chartRight = width - 12;
    const chartTop = 18;
    const chartBottom = 244;
    const chartHeight = chartBottom - chartTop;
    let runningValue = goal.start_value;
    const points = entries.slice().reverse().map(item => {
      const date = new Date(`${String(item.row[1] || "").slice(0, 10)}T12:00:00`).getTime();
      const start = new Date(`${goal.start_date.slice(0, 10)}T12:00:00`).getTime();
      const end = new Date(`${goal.end_date.slice(0, 10)}T12:00:00`).getTime();
      runningValue = goal.cumulative ? runningValue + numberOrZero(item.row[2]) : numberOrZero(item.row[2]);
      const progress = goal.end_value > goal.start_value ? (runningValue - goal.start_value) / (goal.end_value - goal.start_value) * 100 : 0;
      return {
        x: chartLeft + Math.max(0, Math.min(1, (date - start) / Math.max(1, end - start))) * (chartRight - chartLeft),
        y: chartBottom - Math.max(0, Math.min(100, progress)) / 100 * chartHeight
      };
    });
    const line = points.length ? points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ") : `${chartLeft},${chartBottom} ${chartRight},${chartBottom}`;
    const latest = points.length ? points[points.length - 1] : { x: chartLeft, y: chartBottom };
    return `<div class="goal-chart" aria-label="${safeText(goal.name)} progress trend">
      <svg viewBox="0 0 ${width} ${height}" role="img">
        <line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartTop}" class="chart-target-line"></line>
        <line x1="${chartLeft}" y1="${chartBottom}" x2="${chartRight}" y2="${chartBottom}" class="chart-axis-line"></line>
        <line x1="${chartLeft}" y1="${chartTop + chartHeight / 2}" x2="${chartRight}" y2="${chartTop + chartHeight / 2}" class="chart-grid-line"></line>
        <polyline points="${line}" class="goal-chart-line"></polyline>
        <circle cx="${latest.x.toFixed(1)}" cy="${latest.y.toFixed(1)}" r="3.5" class="goal-chart-dot"></circle>
      </svg><span>0%</span><span class="goal-chart-midpoint">50%</span><span class="goal-chart-target">Target 100%</span>
    </div>`;
  }

  function fillCompetitionSelect(selected = "") {
    $("goalCompetition").innerHTML = `<option value="">No competition</option>` +
      competitions.map(item => `<option value="${safeText(item.id)}">${safeText(item.name)}</option>`).join("");
    $("goalCompetition").value = selected;
    updateCompetitionDates();
  }

  function updateCompetitionDates() {
    const competition = competitions.find(item => item.id === $("goalCompetition").value);
    const startInput = $("goalStartDate");
    const endInput = $("goalEndDate");
    const startDisplay = $("goalStartDateDisplay");
    const endDisplay = $("goalEndDateDisplay");
    if (competition) {
      startInput.value = competition.start_date.slice(0, 10);
      endInput.value = competition.end_date.slice(0, 10);
      startInput.classList.add("hidden");
      endInput.classList.add("hidden");
      startDisplay.textContent = dateLabel(competition.start_date, "");
      endDisplay.textContent = dateLabel(competition.end_date, "");
      startDisplay.classList.remove("hidden");
      endDisplay.classList.remove("hidden");
    } else {
      startInput.classList.remove("hidden");
      endInput.classList.remove("hidden");
      startDisplay.classList.add("hidden");
      endDisplay.classList.add("hidden");
    }
  }

  function openGoalDialog(goal = null) {
    $("goalForm").reset();
    $("dialogError").classList.add("hidden");
    $("goalId").value = goal ? goal.id : "";
    $("dialogTitle").textContent = goal ? "Edit goal" : "Create a goal";
    $("dialogEyebrow").textContent = goal ? "Keep it moving" : "Make it happen";
    $("goalName").value = goal?.name || "";
    $("goalDescription").value = goal?.description || "";
    $("startValue").value = goal ? goal.start_value : 0;
    $("endValue").value = goal ? goal.end_value : "";
    $("goalCumulative").checked = Boolean(goal?.cumulative);
    $("goalUnit").value = goal?.unit || "$";
    $("goalStartDate").value = goal?.start_date ? goal.start_date.slice(0, 10) : "";
    $("goalEndDate").value = goal?.end_date ? goal.end_date.slice(0, 10) : "";
    $("goalStatus").value = goal?.status || "Active";
    fillCompetitionSelect(goal?.competition_id || "");
    $("saveGoalButton").textContent = "Save goal";
    dialog.showModal();
    $("goalName").focus();
  }

  function closeDialog() {
    dialog.close();
    $("goalName").disabled = false;
    $("goalDescription").disabled = false;
    $("startValue").disabled = false;
    $("endValue").disabled = false;
    $("goalUnit").disabled = false;
    $("goalStartDate").disabled = false;
    $("goalEndDate").disabled = false;
    $("goalStatus").disabled = false;
    $("goalCompetition").disabled = false;
  }

  async function saveGoal(event) {
    event.preventDefault();
    if (!accessToken || busy) return;
    const id = $("goalId").value;
    const existing = id ? goals.find(goal => goal.id === id) : null;
    const name = $("goalName").value.trim();
    const startValue = Number($("startValue").value);
    const endValue = Number($("endValue").value);
    const startDate = $("goalStartDate").value;
    const endDate = $("goalEndDate").value;
    if (!name) return showDialogError("Please enter a goal name.");
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue) || endValue <= startValue) return showDialogError("Ending value must be greater than the starting value.");
    if (!startDate || !endDate || endDate < startDate) return showDialogError("Choose a valid start and end date.");
    const now = new Date().toISOString();
    const goal = {
      id: existing?.id || makeId(),
      name,
      owner_email: existing?.owner_email || signedInUser?.email || "",
      description: $("goalDescription").value.trim(),
      start_date: startDate,
      end_date: endDate,
      start_value: startValue,
      end_value: endValue,
      unit: $("goalUnit").value.trim() || "$",
      status: $("goalStatus").value,
      competition_id: $("goalCompetition").value,
      updated_at: now,
      favorite: existing?.favorite || false,
      cumulative: $("goalCumulative").checked
    };
    const row = [goal.id, goal.name, goal.owner_email, goal.description, goal.start_date, goal.end_date, goal.start_value, goal.end_value, goal.unit, goal.status, goal.competition_id, goal.updated_at, goal.favorite, goal.cumulative];
    const originalButtonText = $("saveGoalButton").textContent;
    $("saveGoalButton").disabled = true;
    $("saveGoalButton").textContent = "Saving…";
    try {
      if (existing) {
        const rowNumber = await findGoalRow(existing.id);
        await updateRange(`${config.goalsSheet || "Goals"}!A${rowNumber}:N${rowNumber}`, [row]);
      } else {
        await appendRange(`${config.goalsSheet || "Goals"}!A:N`, [row]);
      }
      if (!existing && !goal.cumulative) {
        await appendRange(`${config.historySheet || "Progress History"}!A:E`, [[goal.id, startDate, startValue, "Goal starting value", signedInUser?.email || ""]]);
      }
      closeDialog();
      showToast(existing ? "Goal updated. Keep that momentum going!" : "Goal added to the shared sheet.");
      await loadData();
    } catch (error) {
      showDialogError(apiErrorMessage(error));
    } finally {
      $("saveGoalButton").disabled = false;
      $("saveGoalButton").textContent = originalButtonText;
    }
  }

  function showDialogError(message) {
    $("dialogError").textContent = message;
    $("dialogError").classList.remove("hidden");
  }

  async function findGoalRow(id) {
    const rows = await getRange(`${config.goalsSheet || "Goals"}!A2:N`);
    const index = rows.findIndex(row => String(row[0] || "") === id);
    if (index < 0) throw new Error("This goal could not be found in the sheet. Refresh and try again.");
    return index + 2;
  }

  function makeId() {
    return (crypto.randomUUID ? crypto.randomUUID() : `goal-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  async function deleteGoal(id) {
    const goal = goals.find(item => item.id === id);
    if (!goal || !confirm(`Remove "${goal.name}" from the active goal list? This marks it as Deleted in the sheet rather than permanently erasing its row.`)) return;
    try {
      const rowNumber = await findGoalRow(id);
      const updated = [goal.id, goal.name, goal.owner_email, goal.description, goal.start_date, goal.end_date, goal.start_value, goal.end_value, goal.unit, "Deleted", goal.competition_id, new Date().toISOString(), goal.favorite, goal.cumulative];
      await updateRange(`${config.goalsSheet || "Goals"}!A${rowNumber}:N${rowNumber}`, [updated]);
      showToast("Goal removed from the dashboard.");
      await loadData();
    } catch (error) {
      showNotice(apiErrorMessage(error));
    }
  }

  function handleGoalAction(event) {
    const card = event.target.closest("[data-goal-id]");
    if (card && !event.target.closest("button")) {
      selectedGoalId = card.dataset.goalId;
      writePreference(PREFERENCE_KEYS.selectedGoal, selectedGoalId);
      render();
      return;
    }
    const button = event.target.closest("button[data-action]");
    const progressButton = event.target.closest("button[data-progress-action]");
    if (progressButton) {
      const rowIndex = Number(progressButton.dataset.rowIndex);
      if (progressButton.dataset.progressAction === "edit") editProgressEntry(rowIndex);
      if (progressButton.dataset.progressAction === "delete") deleteProgressEntry(rowIndex);
      return;
    }
    if (!button) return;
    const goal = goals.find(item => item.id === button.dataset.id);
    if (!goal) return;
    if (button.dataset.action === "edit") openGoalDialog(goal);
    if (button.dataset.action === "progress") openProgressDialog(goal);
    if (button.dataset.action === "delete") deleteGoal(goal.id);
    if (button.dataset.action === "favorite") toggleFavorite(goal);
  }

  async function toggleFavorite(goal) {
    try {
    const rowNumber = await findGoalRow(goal.id);
    const updated = [goal.id, goal.name, goal.owner_email, goal.description, goal.start_date, goal.end_date, goal.start_value, goal.end_value, goal.unit, goal.status, goal.competition_id, goal.updated_at, !goal.favorite, goal.cumulative];
    await updateRange(`${config.goalsSheet || "Goals"}!A${rowNumber}:N${rowNumber}`, [updated]);
    goal.favorite = !goal.favorite;
    showToast(goal.favorite ? "Goal favorited." : "Goal removed from favorites.");
    render();
    } catch (error) {
    showNotice(apiErrorMessage(error));
    }
  }

  function openProgressDialog(goal) {
    $("progressForm").reset();
    $("progressError").classList.add("hidden");
    $("progressGoalId").value = goal.id;
    $("progressForm").dataset.rowIndex = "";
    $("progressTitle").textContent = `Add progress · ${goal.name}`;
    $("progressValue").value = goal.cumulative ? 0 : latestProgress(goal);
    $("progressDate").value = new Date().toISOString().slice(0, 10);
    $("progressDate").min = goal.start_date.slice(0, 10);
    $("progressDate").max = goal.end_date.slice(0, 10);
    $("saveProgressButton").textContent = "Add Entry";
    progressDialog.showModal();
    $("progressValue").focus();
  }

  function progressEntriesFor(goalId) {
    return historyRows.map((row, index) => ({ row, index }))
      .filter(item => String(item.row[0] || "") === goalId && item.row.some(value => String(value || "").trim()));
  }

  function editProgressEntry(rowIndex) {
    const row = historyRows[rowIndex];
    if (!row) return;
    const goal = goals.find(item => item.id === String(row[0] || ""));
    if (!goal) return;
    if (!progressDialog.open) openProgressDialog(goal);
    $("progressForm").dataset.rowIndex = String(rowIndex);
    $("progressValue").value = numberOrZero(row[2]);
    $("progressDate").value = String(row[1] || "").slice(0, 10);
    $("progressNote").value = String(row[3] || "");
    $("saveProgressButton").textContent = "Update entry";
    $("progressValue").focus();
  }

  async function deleteProgressEntry(rowIndex) {
    const row = historyRows[rowIndex];
    if (!row || !confirm("Delete this progress entry?")) return;
    try {
      await updateRange(`${config.historySheet || "Progress History"}!A${rowIndex + 2}:E${rowIndex + 2}`, [["", "", "", "", ""]]);
      showToast("Progress entry deleted.");
      await loadData();
    } catch (error) {
      showProgressError(apiErrorMessage(error));
    }
  }

  async function saveProgress(event) {
    event.preventDefault();
    if (!accessToken || busy) return;
    const goal = goals.find(item => item.id === $("progressGoalId").value);
    const value = Number($("progressValue").value);
    const date = $("progressDate").value;
    if (!goal) return showProgressError("That goal is no longer available. Refresh and try again.");
    if (!Number.isFinite(value) || !date) return showProgressError("Enter a value and date for this entry.");
    if (date < goal.start_date || date > goal.end_date) return showProgressError("Progress date must be within the goal date range.");
    const rowIndex = $("progressForm").dataset.rowIndex;
    const row = [goal.id, date, value, $("progressNote").value.trim(), signedInUser?.email || ""];
    try {
      if (rowIndex === "") {
        await appendRange(`${config.historySheet || "Progress History"}!A:E`, [row]);
      } else {
        await updateRange(`${config.historySheet || "Progress History"}!A${Number(rowIndex) + 2}:E${Number(rowIndex) + 2}`, [row]);
      }
      progressDialog.close();
      showToast(rowIndex === "" ? "Progress entry saved." : "Progress entry updated.");
      await loadData();
      const updatedGoal = goals.find(item => item.id === goal.id);
      $("progressForm").dataset.rowIndex = "";
      $("saveProgressButton").textContent = "Add Entry";
      if (updatedGoal) {
        $("progressValue").value = latestProgress(updatedGoal);
      }
    } catch (error) {
      showProgressError(apiErrorMessage(error));
    }
  }

  function showProgressError(message) {
    $("progressError").textContent = message;
    $("progressError").classList.remove("hidden");
  }

  function renderCompetitions() {
    const grid = $("competitionsGrid");
    grid.innerHTML = competitions.map(competition => {
      const linked = goals.filter(goal => goal.competition_id === competition.id);
      const avg = linked.length ? Math.round(linked.reduce((sum, goal) => sum + percent(goal), 0) / linked.length) : 0;
      return `<button class="competition-card" type="button" data-competition-id="${safeText(competition.id)}">
        <span class="competition-icon">◎</span><span class="competition-card-copy"><strong>${safeText(competition.name)}</strong>
        <small>${safeText(dateLabel(competition.start_date, ""))} – ${safeText(dateLabel(competition.end_date, ""))}</small>
        <span class="competition-progress"><i style="width:${avg}%"></i></span><small>${linked.length} goal${linked.length === 1 ? "" : "s"} · ${avg}% average progress</small></span>
      </button>`;
    }).join("");
    grid.classList.toggle("hidden", competitions.length === 0);
    $("competitionEmptyState").classList.toggle("hidden", competitions.length > 0);
  }

  function showCompetition(id) {
    const competition = competitions.find(item => item.id === id);
    if (!competition) return;
    const linked = goals.filter(goal => goal.competition_id === id);
    const participants = [...new Set(linked.map(goal => goal.owner_email).filter(Boolean))];
    const average = linked.length ? Math.round(linked.reduce((sum, goal) => sum + percent(goal), 0) / linked.length) : 0;
    const completed = linked.filter(goal => percent(goal) >= 100).length;
    const daysRemaining = Math.max(0, Math.ceil((new Date(`${competition.end_date}T12:00:00`) - new Date()) / 86400000));
    $("competitionDetail").innerHTML = `<button class="competition-back-button" id="closeCompetitionDetail" type="button">← All competitions</button>
      <div class="competition-detail-header"><div><p class="eyebrow">Competition view</p><h2>${safeText(competition.name)}</h2><p>${safeText(competition.description || "Progress toward 100% together.")}</p></div><span class="competition-date-badge">${safeText(dateLabel(competition.start_date, ""))} – ${safeText(dateLabel(competition.end_date, ""))}</span></div>
      <div class="competition-feature-grid"><div class="competition-feature feature-primary"><span>Team progress</span><strong>${average}%</strong><small>Average across ${linked.length} goal${linked.length === 1 ? "" : "s"}</small></div><div class="competition-feature"><span>Goals complete</span><strong>${completed}/${linked.length}</strong><small>At 100% target</small></div><div class="competition-feature"><span>Time remaining</span><strong>${daysRemaining}</strong><small>Days in competition</small></div><div class="competition-feature"><span>Participants</span><strong>${participants.length}</strong><small>People contributing</small></div></div>
      <div class="chart-meta"><span>Progress toward 100% target</span><span>${participants.length} participant${participants.length === 1 ? "" : "s"}</span></div>
      ${renderCompetitionChart(competition, linked)}
      ${renderCompetitionLegend(linked)}
      <div class="competition-sliders"><div class="detail-section-heading"><div><p class="eyebrow">At a glance</p><h3>Goal progress</h3></div><span>Current progress toward each goal</span></div>${linked.length ? linked.map(renderCompetitionSlider).join("") : `<p class="competition-no-goals">No goals are linked to this competition yet.</p>`}</div>`;
    $("competitionDetail").classList.remove("hidden");
    $("competitionsGrid").classList.add("hidden");
    $("competitionEmptyState").classList.add("hidden");
    $("closeCompetitionDetail").addEventListener("click", () => {
      $("competitionDetail").classList.add("hidden");
      renderCompetitions();
    });
  }

  function renderCompetitionLegend(linked) {
    return `<div class="competition-legend"><div class="legend-heading">Chart legend</div>${linked.map((goal, index) => `<div class="legend-item"><i style="background:${["#7c5cff", "#27d3a2", "#ff8c69", "#5aa9ff", "#f5c451"][index % 5]}"></i><span><strong>${safeText(goal.owner_email || "Unknown user")}</strong><small>${safeText(goal.name)}</small></span></div>`).join("")}</div>`;
  }

  function renderCompetitionSlider(goal) {
    const progress = percent(goal);
    return `<div class="competition-slider-row"><div class="competition-slider-label"><span><strong>${safeText(goal.owner_email || "Unknown user")}</strong><small>${safeText(goal.name)}</small></span><b>${progress}%</b></div><div class="competition-slider-track"><div style="width:${progress}%"></div><span class="slider-marker" style="left:${progress}%"></span></div><div class="competition-slider-meta"><span>${safeText(fmtNumber(latestProgress(goal), goal.unit))}</span><span>Target ${safeText(fmtNumber(goal.end_value, goal.unit))}</span></div></div>`;
  }

  function renderCompetitionChart(competition, linked) {
    const width = 760, height = 330, left = 44, top = 20, right = 18, bottom = 38;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const start = new Date(`${competition.start_date}T12:00:00`).getTime();
    const end = new Date(`${competition.end_date}T12:00:00`).getTime();
    const x = date => left + Math.max(0, Math.min(1, (new Date(`${String(date).slice(0, 10)}T12:00:00`).getTime() - start) / Math.max(1, end - start))) * plotWidth;
    const y = value => top + (100 - value) / 100 * plotHeight;
    const lines = linked.map((goal, index) => {
      const entries = historyRows.filter(row => String(row[0] || "") === goal.id).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      let runningValue = goal.start_value;
      const points = [[goal.start_date, 0], ...entries.map(row => {
        runningValue = goal.cumulative ? runningValue + numberOrZero(row[2]) : numberOrZero(row[2]);
        return [row[1], Math.max(0, Math.min(100, (runningValue - goal.start_value) / (goal.end_value - goal.start_value) * 100))];
      })];
      const coords = points.map(point => `${x(point[0]).toFixed(1)},${y(point[1]).toFixed(1)}`).join(" ");
      const color = ["#7c5cff", "#27d3a2", "#ff8c69", "#5aa9ff", "#f5c451"][index % 5];
      return `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join("");
    return `<div class="chart-shell"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Progress chart for ${safeText(competition.name)}">
      <line x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}" class="chart-axis"/><line x1="${left}" y1="${y(50)}" x2="${width - right}" y2="${y(50)}" class="chart-grid"/><line x1="${left}" y1="${y(100)}" x2="${width - right}" y2="${y(100)}" class="chart-grid"/>
      <line x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(100)}" class="target-line"/><text x="8" y="${y(100) + 4}" class="chart-label">100%</text><text x="18" y="${y(50) + 4}" class="chart-label">50%</text><text x="25" y="${y(0) + 4}" class="chart-label">0%</text>
      ${lines}<text x="${left}" y="${height - 10}" class="chart-label">${safeText(competition.start_date)}</text><text x="${width - right - 70}" y="${height - 10}" class="chart-label">${safeText(competition.end_date)}</text>
    </svg><p class="chart-caption">Target pace · 0% at the start, 100% at the competition end</p></div>`;
  }

  async function saveCompetition(event) {
    event.preventDefault();
    if (!accessToken || busy) return;
    const name = $("competitionName").value.trim();
    const start = $("competitionStartDate").value;
    const end = $("competitionEndDate").value;
    if (!name || !start || !end || end < start) {
      $("competitionError").textContent = "Enter a name and a valid date range.";
      $("competitionError").classList.remove("hidden");
      return;
    }
    try {
      await appendRange(`${config.competitionsSheet || "Competitions"}!A:G`, [[makeId(), name, $("competitionDescription").value.trim(), start, end, signedInUser?.email || "", new Date().toISOString()]]);
      competitionDialog.close();
      showToast("Competition created.");
      await loadData();
      switchPage("competitions");
    } catch (error) {
      $("competitionError").textContent = apiErrorMessage(error);
      $("competitionError").classList.remove("hidden");
    }
  }

  function switchPage(page) {
    currentPage = page;
    writePreference(PREFERENCE_KEYS.page, page);
    const isCompetition = page === "competitions";
    dashboard.classList.toggle("hidden", isCompetition);
    competitionsPage.classList.toggle("hidden", !isCompetition);
    $("goalsNavButton").classList.toggle("active", !isCompetition);
    $("competitionsNavButton").classList.toggle("active", isCompetition);
    $("competitionDetail").classList.add("hidden");
    $("competitionsGrid").classList.remove("hidden");
    if (isCompetition) renderCompetitions();
  }

  function signOut() {
    if (accessToken && window.google?.accounts?.oauth2?.revoke) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    signedInUser = null;
    goals = [];
    historyRows = [];
    competitions = [];
    selectedGoalId = "";
    removePreference(PREFERENCE_KEYS.selectedGoal);
    removePreference(PREFERENCE_KEYS.search);
    removePreference(PREFERENCE_KEYS.statusFilter);
    removePreference(PREFERENCE_KEYS.page);
    switchPage("goals");
    setConnection(false, "Not connected");
    $("connectionLabel").textContent = "Not connected";
    showNotice("");
    $("goalsGrid").innerHTML = "";
    $("activeCount").textContent = "0";
    $("completedCount").textContent = "0";
    $("dueSoonCount").textContent = "0";
    showToast("Signed out of this session.");
  }

  $("connectButton").addEventListener("click", () => authorize("consent"));
  $("signOutButton").addEventListener("click", signOut);
  $("newGoalButton").addEventListener("click", () => openGoalDialog());
  $("emptyNewGoalButton").addEventListener("click", () => openGoalDialog());
  $("closeDialogButton").addEventListener("click", closeDialog);
  $("cancelDialogButton").addEventListener("click", closeDialog);
  $("goalForm").addEventListener("submit", saveGoal);
  $("progressForm").addEventListener("submit", saveProgress);
  $("competitionForm").addEventListener("submit", saveCompetition);
  $("newCompetitionButton").addEventListener("click", () => {
    $("competitionForm").reset();
    $("competitionError").classList.add("hidden");
    competitionDialog.showModal();
    $("competitionName").focus();
  });
  $("closeCompetitionButton").addEventListener("click", () => competitionDialog.close());
  $("cancelCompetitionButton").addEventListener("click", () => competitionDialog.close());
  $("closeProgressButton").addEventListener("click", () => progressDialog.close());
  $("cancelProgressButton").addEventListener("click", () => progressDialog.close());
  $("progressDate").addEventListener("click", () => {
    if (typeof $("progressDate").showPicker === "function") $("progressDate").showPicker();
  });
  $("goalsNavButton").addEventListener("click", () => switchPage("goals"));
  $("competitionsNavButton").addEventListener("click", () => switchPage("competitions"));
  $("competitionsGrid").addEventListener("click", event => {
    const card = event.target.closest("[data-competition-id]");
    if (card) showCompetition(card.dataset.competitionId);
  });
  $("goalsGrid").addEventListener("click", handleGoalAction);
  $("goalDetail").addEventListener("click", handleGoalAction);
  $("goalsGrid").addEventListener("keydown", event => {
    if ((event.key !== "Enter" && event.key !== " ") || event.target.closest("button")) return;
    const card = event.target.closest("[data-goal-id]");
    if (!card) return;
    event.preventDefault();
    selectedGoalId = card.dataset.goalId;
    render();
  });
  $("searchInput").addEventListener("input", () => {
    writePreference(PREFERENCE_KEYS.search, $("searchInput").value);
    render();
  });
  $("statusFilter").addEventListener("change", () => {
    writePreference(PREFERENCE_KEYS.statusFilter, $("statusFilter").value);
    render();
  });
  $("refreshButton").addEventListener("click", loadData);
  $("goalCompetition").addEventListener("change", updateCompetitionDates);
  let dialogPointerDownTarget = null;
  dialog.addEventListener("pointerdown", event => {
    dialogPointerDownTarget = event.target;
  });
  dialog.addEventListener("pointercancel", () => {
    dialogPointerDownTarget = null;
  });
  dialog.addEventListener("click", event => {
    if (event.target === dialog && dialogPointerDownTarget === dialog) closeDialog();
    dialogPointerDownTarget = null;
  });
  [competitionDialog, progressDialog].forEach(popup => {
    let pointerDownTarget = null;
    popup.addEventListener("pointerdown", event => {
      pointerDownTarget = event.target;
    });
    popup.addEventListener("pointercancel", () => {
      pointerDownTarget = null;
    });
    popup.addEventListener("click", event => {
      if (event.target === popup && pointerDownTarget === popup) popup.close();
      pointerDownTarget = null;
    });
  });

  loadPreferences();
  setConnection(false, "Not connected");
  initGoogle();
})();
