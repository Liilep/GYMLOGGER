// Fresh simplified frontend logic with strict program -> pass -> exercises flow
const state = {
  programs: [],
  templates: [],
  exercises: [],
  sessions: [],
  pbs: [],
  activeSession: null,
  currentProgramId: "",
  currentTemplateId: "",
  templatesProgramId: "",
  templatesMode: "pass",
  pbFilterExercise: "",
  pbFilterReps: 0,
  guide: null, // { tplId, exerciseIndex, setNumber, completed }
  currentUser: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  viewUser: null,
  viewUserPrograms: [],
  viewUserPBs: [],
  historyOpen: {},
  sessionLocked: false,
  activeExerciseId: null,
  completedExercises: {},
  restTimer: null, // { total, remaining, deadline }
  sessionStartedAt: null,
  restoredWorkout: false,
};

let currentModal = null;
let authMode = "login";
let restInterval = null;
let sessionPersistTimer = null;
let backNavGuardEnabled = false;
let restoreApplied = false;
let apiPollTimer = null;
let apiPollInFlight = false;
let apiReadyResolve = null;

const storedBase = localStorage.getItem("API_BASE") || "";
let API_BASE = window.API_BASE || storedBase || "";
const API_CANDIDATES = [
  storedBase,
  "http://localhost:8001",
  "http://127.0.0.1:8001",
].filter(Boolean);
const HEALTH_PATHS = ["/health", "/healthz"];
const API_READY_BASE_DELAY = 2000;
let authToken = localStorage.getItem("authToken") || "";
const ACTIVE_SESSION_STORAGE_KEY = "activeWorkoutSession";
const SESSION_PERSIST_DEBOUNCE_MS = 300;
const SESSION_LEAVE_WARNING = "Du har ett pågående pass. Lämnar du sidan kan data gå förlorad.";
let apiReady = false;
let apiReadyPromise = null;

async function api(path, options = {}) {
  await waitForApiReady();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (authToken) headers.Authorization = authToken;
  const fetchWithBase = async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
    try {
      const res = await fetch(`${base}${path}`, { ...options, headers, signal: controller.signal });
      if (res.status === 401) {
        handleUnauthorized();
        const err = new Error("Unauthorized");
        err.status = 401;
        throw err;
      }
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(txt || res.statusText);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await fetchWithBase(API_BASE);
  } catch (err) {
    console.warn("fetch misslyckades mot", API_BASE, "för", path, err);
    if (err && err.status === 401) throw err;
    const shouldShowOverlay = !err || err.status === 0 || err.status === undefined || err.status >= 500;
    if (shouldShowOverlay) {
      apiReady = false;
      showOverlay("Startar servern / Laddar…");
      startApiReadyPolling(true);
    }
    try {
      const next = await detectApiBase(true);
      if (next && next !== API_BASE) {
        API_BASE = next;
        console.info("byter API_BASE till", API_BASE);
        return await fetchWithBase(API_BASE);
      }
    } catch (detectErr) {
      console.error("API-bastest misslyckades", detectErr);
    }
    throw new Error(`Kunde inte nå API (${API_BASE || "okänt"}): ${err?.message || err}`);
  }
}

function logout() {
  authToken = "";
  localStorage.removeItem("authToken");
  clearCompletedExercises(state.activeSession?.id);
  clearPersistedSessionState(true);
  disableNavigationGuards();
  exitSessionLockUI();
  clearRestTimer();
  state.sessionLocked = false;
  state.activeExerciseId = null;
  state.completedExercises = {};
  state.sessionStartedAt = null;
  state.restoredWorkout = false;
  state.currentUser = null;
  state.programs = [];
  state.templates = [];
  state.exercises = [];
  state.sessions = [];
  state.pbs = [];
  state.friends = [];
  state.incomingRequests = [];
  state.outgoingRequests = [];
  state.viewUser = null;
  state.viewUserPrograms = [];
  state.viewUserPBs = [];
  renderAuthStatus(false);
  setMainVisibility(false);
}

function handleUnauthorized() {
  logout();
}

function completedStoreKey(sessionId) {
  return sessionId ? `session_completed_${sessionId}` : "";
}

function loadCompletedExercises(sessionId) {
  if (!sessionId) return {};
  try {
    const raw = localStorage.getItem(completedStoreKey(sessionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn("Kunde inte ladda klara övningar", err);
    return {};
  }
}

function saveCompletedExercises(sessionId, map) {
  if (!sessionId) return;
  try {
    localStorage.setItem(completedStoreKey(sessionId), JSON.stringify(map || {}));
  } catch (err) {
    console.warn("Kunde inte spara klara övningar", err);
  }
}

function clearCompletedExercises(sessionId) {
  if (!sessionId) return;
  try {
    localStorage.removeItem(completedStoreKey(sessionId));
  } catch (err) {
    console.warn("Kunde inte rensa klara övningar", err);
  }
}

function isSessionActive() {
  return Boolean(state.activeSession && state.activeSession.status === "in_progress");
}

function loadPersistedSessionState() {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.warn("Kunde inte läsa sparad session", err);
    return null;
  }
}

function clearPersistedSessionState(finalized = false) {
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = null;
  restoreApplied = false;
  state.restoredWorkout = false;
  try {
    if (finalized) {
      localStorage.setItem(
        ACTIVE_SESSION_STORAGE_KEY,
        JSON.stringify({ finalized: true, lastUpdatedAt: Date.now() })
      );
    } else {
      localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  } catch (err) {
    console.warn("Kunde inte rensa sparad session", err);
  }
}

function buildSessionSnapshot() {
  if (!isSessionActive()) return null;
  // Persist local-only session state so reload/lock/bfcache can restore safely.
  return {
    session: state.activeSession,
    guide: state.guide,
    activeExerciseId: state.activeExerciseId,
    completedExercises: state.completedExercises || {},
    sessionLocked: state.sessionLocked,
    currentProgramId: state.currentProgramId,
    currentTemplateId: state.currentTemplateId,
    restTimer: state.restTimer ? { ...state.restTimer } : null,
    startedAt: state.sessionStartedAt || Date.now(),
    lastUpdatedAt: Date.now(),
    finalized: false,
  };
}

function persistActiveSessionState(immediate = false) {
  if (!isSessionActive()) {
    clearPersistedSessionState();
    return;
  }
  const saver = () => {
    const payload = buildSessionSnapshot();
    if (!payload) return;
    try {
      localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn("Kunde inte spara aktivt pass", err);
    }
  };
  if (immediate) {
    clearTimeout(sessionPersistTimer);
    saver();
    return;
  }
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(saver, SESSION_PERSIST_DEBOUNCE_MS);
}

function showOverlay(message = "Startar servern / Laddar…", sub = "Kollar API och databasstatus...") {
  const overlay = document.getElementById("appOverlay");
  if (!overlay) return;
  const title = overlay.querySelector(".overlay-title");
  const subEl = overlay.querySelector(".overlay-sub");
  if (title && message) title.textContent = message;
  if (subEl && sub) subEl.textContent = sub;
  overlay.classList.remove("hidden");
  overlay.classList.add("visible");
}

function hideOverlay() {
  const overlay = document.getElementById("appOverlay");
  if (!overlay) return;
  overlay.classList.remove("visible");
  overlay.classList.add("hidden");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs = 3000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkApiReadyOnce(baseOverride) {
  const base = baseOverride || API_BASE;
  if (!base) return false;
  for (const path of HEALTH_PATHS) {
    try {
      const res = await fetchWithTimeout(`${base}${path}`, 5000);
      if (res.status === 401 || res.status === 403) return true;
      if (!res.ok) continue;
      try {
        const data = await res.json();
        if (data && data.ok === false) return false;
      } catch (_) {
        // ignore parse errors; treat as ok if HTTP ok
      }
      return true;
    } catch (err) {
      // try next path
    }
  }
  return false;
}

function startApiReadyPolling(force = false) {
  if (force) {
    apiReady = false;
    apiReadyPromise = null;
    apiReadyResolve = null;
    if (apiPollTimer) {
      clearTimeout(apiPollTimer);
      apiPollTimer = null;
    }
  }
  if (apiReady) return Promise.resolve(true);
  if (!apiReadyPromise) {
    apiReadyPromise = new Promise((resolve) => {
      apiReadyResolve = resolve;
    });
  }
  if (apiPollTimer) return apiReadyPromise;
  const poll = async () => {
    if (apiPollInFlight) {
      apiPollTimer = setTimeout(poll, 1500);
      return;
    }
    apiPollInFlight = true;
    let ready = false;
    try {
      if (!API_BASE) {
        await detectApiBase().catch(() => {});
      }
      ready = await checkApiReadyOnce();
    } catch (err) {
      ready = false;
    } finally {
      apiPollInFlight = false;
    }
    if (ready) {
      apiReady = true;
      hideOverlay();
      setStatusIndicator("ok", `API OK (${API_BASE || "okänt"})`);
      if (apiReadyResolve) apiReadyResolve(true);
      apiReadyPromise = null;
      apiReadyResolve = null;
      if (apiPollTimer) {
        clearTimeout(apiPollTimer);
        apiPollTimer = null;
      }
      return;
    }
    apiReady = false;
    showOverlay("Startar servern / Laddar…");
    setStatusIndicator("fail", `API väntar (${API_BASE || "okänt"})`);
    apiPollTimer = setTimeout(poll, 2500);
  };
  apiPollTimer = setTimeout(poll, 0);
  return apiReadyPromise;
}

async function waitForApiReady(force = false) {
  if (apiReady && !force) return true;
  const promise = startApiReadyPolling(force);
  if (apiReady) return true;
  if (promise && typeof promise.then === "function") {
    await promise;
  } else {
    while (!apiReady) {
      await sleep(300);
    }
  }
  return true;
}

function disableZoom() {
  if (disableZoom.hasRun) return;
  disableZoom.hasRun = true;
  ["gesturestart", "gesturechange", "gestureend"].forEach((ev) => {
    window.addEventListener(
      ev,
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
  });
  window.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    },
    { passive: false }
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    },
    { passive: false }
  );
  let lastTouchEnd = 0;
  window.addEventListener(
    "touchend",
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false }
  );
}

function showRestoreNotice(message = "", options = {}) {
  let bar = document.getElementById("sessionRestoreBanner");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "sessionRestoreBanner";
    bar.style.display = "none";
    bar.style.margin = "8px 0";
    bar.style.padding = "10px 12px";
    bar.style.border = "1px solid #4ade80";
    bar.style.background = "#102418";
    bar.style.color = "#c5f4d2";
    bar.style.borderRadius = "8px";
    bar.style.gap = "8px";
    bar.style.alignItems = "center";
    bar.style.justifyContent = "space-between";
    bar.style.flexWrap = "wrap";
    bar.style.fontSize = "14px";
    bar.style.lineHeight = "1.4";
    bar.style.boxShadow = "0 4px 14px rgba(0,0,0,0.25)";
    bar.style.display = "flex";
    bar.style.flexDirection = "row";
    const hero = document.querySelector(".hero");
    if (hero && hero.parentNode) {
      hero.parentNode.insertBefore(bar, hero.nextSibling);
    } else {
      document.body.prepend(bar);
    }
  }
  bar.innerHTML = "";
  if (!message || !state.restoredWorkout) {
    bar.style.display = "none";
    return;
  }
  const text = document.createElement("span");
  text.textContent = message;
  bar.appendChild(text);

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.gap = "8px";
  if (options.showResume) {
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "btn ghost small";
    resumeBtn.textContent = "Fortsätt pass";
    resumeBtn.addEventListener("click", () => {
      state.restoredWorkout = false;
      showRestoreNotice("");
      switchTab("tab-pass");
      const guideEl = document.getElementById("guideStatus");
      if (guideEl) guideEl.scrollIntoView({ behavior: "smooth", block: "center" });
      persistActiveSessionState(true);
    });
    controls.appendChild(resumeBtn);
  }

  if (options.allowDismiss !== false) {
    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "btn ghost small";
    dismissBtn.textContent = "Stäng";
    dismissBtn.addEventListener("click", () => {
      state.restoredWorkout = false;
      showRestoreNotice("");
      persistActiveSessionState(true);
    });
    controls.appendChild(dismissBtn);
  }
  if (controls.children.length) {
    bar.appendChild(controls);
  }
  bar.style.display = "flex";
}

function handleBeforeUnload(e) {
  if (!isSessionActive()) return;
  e.preventDefault();
  e.returnValue = SESSION_LEAVE_WARNING;
  return SESSION_LEAVE_WARNING;
}

function handlePopState(e) {
  if (!isSessionActive()) return;
  const leave = window.confirm(SESSION_LEAVE_WARNING);
  if (!leave) {
    try {
      history.pushState({ sessionGuard: true }, "", window.location.href);
    } catch (err) {
      console.warn("Kunde inte återställa history-state", err);
    }
    return;
  }
  disableNavigationGuards();
}

function enableNavigationGuards() {
  window.removeEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("beforeunload", handleBeforeUnload);
  if (!backNavGuardEnabled && window.history && window.history.pushState) {
    try {
      history.pushState({ sessionGuard: true }, "", window.location.href);
      window.addEventListener("popstate", handlePopState);
      backNavGuardEnabled = true;
    } catch (err) {
      console.warn("Kunde inte aktivera back-skydd", err);
    }
  }
}

function disableNavigationGuards() {
  window.removeEventListener("beforeunload", handleBeforeUnload);
  if (backNavGuardEnabled) {
    window.removeEventListener("popstate", handlePopState);
    backNavGuardEnabled = false;
  }
}

function resumeRestTimerFromSaved(rest) {
  if (!rest) return;
  const remaining = Math.max(
    0,
    Math.ceil(((rest.deadline || Date.now() + (rest.remaining || rest.total || 0) * 1000) - Date.now()) / 1000)
  );
  if (!remaining) {
    clearRestTimer();
    return;
  }
  startRestTimer(remaining);
}

function restoreActiveSessionFromStorage(markRestored = false) {
  if (restoreApplied) return false;
  // Reload session UI state from localStorage if a pass was active.
  const saved = loadPersistedSessionState();
  if (!saved || saved.finalized) return false;
  const savedSession = saved.session;
  if (!savedSession || savedSession.status === "done" || savedSession.status === "cancelled") {
    clearPersistedSessionState(true);
    return false;
  }
  if (state.activeSession && savedSession.id && Number(state.activeSession.id) !== Number(savedSession.id)) {
    return false;
  }
  if (!state.activeSession && savedSession) {
    state.activeSession = savedSession;
    state.sessions = state.sessions || [];
    if (!state.sessions.some((s) => Number(s.id) === Number(savedSession.id))) {
      state.sessions.unshift(savedSession);
    }
  }
  if (!isSessionActive()) return false;
  state.sessionLocked = saved.sessionLocked ?? true;
  state.hasAnyActiveSessions = true;
  state.currentProgramId = saved.currentProgramId || state.currentProgramId || savedSession.program_id || "";
  state.currentTemplateId = saved.currentTemplateId || state.currentTemplateId || savedSession.template_id || "";
  state.activeExerciseId = saved.activeExerciseId || null;
  state.completedExercises = saved.completedExercises || {};
  state.guide = saved.guide || state.guide;
  state.sessionStartedAt = saved.startedAt || state.sessionStartedAt || Date.now();
  if (saved.restTimer) {
    resumeRestTimerFromSaved(saved.restTimer);
  }
  restoreApplied = true;
  if (markRestored) {
    state.restoredWorkout = true;
  }
  enterSessionLockUI();
  showSelectorArea(false);
  enableFinish();
  if (state.restoredWorkout) {
    showRestoreNotice("Återställde pågående pass.", { showResume: true });
  } else {
    showRestoreNotice("");
  }
  enableNavigationGuards();
  persistActiveSessionState(true);
  return true;
}

async function loadData(options = {}) {
  const { markRestored = false } = options || {};
  await waitForApiReady();
  if (!authToken) {
    renderAuthStatus(false);
    setMainVisibility(false);
    return;
  }
  setMainVisibility(true);
  const [
    meRes,
    programsRes,
    templatesRes,
    exercisesRes,
    sessionsRes,
    pbRes,
    friendsRes,
    incomingReqRes,
    outgoingReqRes,
  ] = await Promise.all([
    api("/users/me"),
    api("/programs"),
    api("/templates"),
    api("/exercises"),
    api("/sessions"),
    api("/pbs"),
    api("/friends"),
    api("/friends/requests/incoming"),
    api("/friends/requests/outgoing"),
  ]);
  state.currentUser = meRes || null;
  state.programs = programsRes || [];
  state.exercises = exercisesRes || [];
  state.sessions = sessionsRes || [];
  state.pbs = pbRes || [];
  state.friends = friendsRes || [];
  state.incomingRequests = incomingReqRes || [];
  state.outgoingRequests = outgoingReqRes || [];
  // map templates response
  state.templates = (templatesRes || []).map((item) => {
    const tpl = item.template || item;
    const rows = item.exercises || tpl.exercises || [];
    const program = state.programs.find((p) => p.id === tpl.program_id);
    return {
      ...tpl,
      program_name: program?.name || "",
      exercises: rows.map((r) => {
        const ex = state.exercises.find((e) => e.id === r.exercise_id);
        return { ...r, exercise_name: ex?.name || "" };
      }),
    };
  });
  state.activeSession = state.sessions.find((s) => s.status === "in_progress") || null;
  restoreActiveSessionFromStorage(markRestored);
  if (isSessionActive()) {
    state.sessionStartedAt =
      state.sessionStartedAt ||
      loadPersistedSessionState()?.startedAt ||
      Date.now();
    enableNavigationGuards();
  } else {
    state.sessionStartedAt = null;
    showRestoreNotice("");
    disableNavigationGuards();
  }
  state.hasAnyActiveSessions = state.sessions.some((s) => s.status === "in_progress");
  if (!state.activeSession) {
    if (!state.currentProgramId && state.programs.length) {
      state.currentProgramId = state.programs[0].id;
    }
    if (!state.templatesProgramId && state.programs.length) {
      state.templatesProgramId = state.programs[0].id;
    }
    const defaultTpl = state.currentProgramId
      ? state.templates.find((t) => t.program_id === state.currentProgramId)
      : null;
    if (!state.currentTemplateId && defaultTpl) {
      state.currentTemplateId = defaultTpl.id;
    }
  }
  if (state.activeSession) {
    state.sessionLocked = true;
    enterSessionLockUI();
    const tpl = state.templates.find((t) => t.id === state.activeSession.template_id);
    if (tpl) {
      state.currentProgramId = tpl.program_id;
      state.currentTemplateId = tpl.id;
      setSelectorsToSession(tpl);
      showSelectorArea(false);
      if (state.activeExerciseId || state.guide) {
        showLogForm();
      } else {
        hideLogForm();
      }
      enableFinish();
    }
  } else {
    state.sessionLocked = false;
    state.activeExerciseId = null;
    exitSessionLockUI();
    showSelectorArea(true);
    hideLogForm();
    disableStartFinish();
  }
  initGuideFromSession();
  renderProgramFilter();
  renderTemplates();
  renderExercises();
  renderProgramSelects();
  renderExerciseList();
  renderProgramTemplates();
  renderFriends();
  renderFriendRequests();
  renderPublicView();
  renderAuthStatus(true);
  renderActiveSession();
  renderPBs();
  renderSessionHistory();
  applyGuideToForm();
  toggleStartButton();
  setTemplatesMode(state.templatesMode || "pass");
  setAuthMode(authMode || "login");
  persistActiveSessionState();
}

async function pingApi() {
  const statusEl = document.getElementById("apiStatus");
  if (!statusEl) return;
  setStatusIndicator("unknown", "Testar API...");
  try {
    await waitForApiReady(true);
    setStatusIndicator("ok", `API OK (${API_BASE})`);
  } catch (err) {
    setStatusIndicator("fail", `API FEL (${API_BASE || "okänt"}): ${err.message}`);
    console.error("API ping misslyckades", err);
  }
}

async function detectApiBase(force = false) {
  if (API_BASE && !force) return API_BASE;
  const statusEl = document.getElementById("apiStatus");
  const candidates = [...new Set(API_CANDIDATES)];
  for (const base of candidates) {
    if (!base) continue;
    try {
      const ok = await tryBase(base);
      if (ok) {
        API_BASE = base;
        localStorage.setItem("API_BASE", API_BASE);
        if (statusEl) setStatusIndicator("ok", `API OK (${API_BASE})`);
        return API_BASE;
      }
    } catch (err) {
      console.warn("API base misslyckades", base, err);
    }
  }
  const errMsg = "Ingen API-bas kunde nås (testade: " + candidates.join(", ") + ")";
  if (statusEl) {
    setStatusIndicator("fail", errMsg);
  }
  throw new Error(errMsg);
}

async function tryBase(base) {
  try {
    const ok = await checkApiReadyOnce(base);
    if (ok) return true;
  } catch (err) {
    // fall through to doc check
  }
  try {
    const res2 = await fetchWithTimeout(`${base}/openapi.json`, 2000);
    if (res2.ok) return true;
    const res3 = await fetchWithTimeout(`${base}/docs`, 2000);
    return res3.ok;
  } catch (err) {
    return false;
  }
}


// ---------- Selectors ----------
function renderProgramFilter() {
  const sel = document.getElementById("programSelect");
  if (!sel) return;
  sel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Välj program";
  sel.appendChild(placeholder);
  state.programs.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (!state.currentProgramId && state.programs.length) {
    state.currentProgramId = state.programs[0].id;
  }
  sel.value = state.currentProgramId;
  sel.onchange = (e) => {
    const val = e.target.value;
    state.currentProgramId = val ? Number(val) : "";
    state.currentTemplateId = "";
    renderTemplates();
    initGuideFromTemplate();
    applyGuideToForm();
    toggleStartButton();
    hideLogForm();
  };
}

function renderTemplates() {
  const sel = document.getElementById("templateSelect");
  if (!sel) return;
  sel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Välj passmall";
  sel.appendChild(placeholder);
  const currentProgId = state.currentProgramId ? Number(state.currentProgramId) : null;
  const filtered = currentProgId
    ? state.templates.filter((t) => Number(t.program_id) === currentProgId)
    : [];
  filtered.forEach((tpl) => {
    const opt = document.createElement("option");
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    sel.appendChild(opt);
  });
  const programNameEl = document.getElementById("programName");
  const templateExercisesEl = document.getElementById("templateExercises");
  const startHint = document.getElementById("startHint");
  programNameEl.textContent = "?";
  templateExercisesEl.innerHTML = "";
  if (startHint) startHint.textContent = "V?lj en passmall med minst en ?vning f?r att kunna starta.";
  if (!state.activeSession && filtered.length === 0) {
    disableStartFinish();
    hideLogForm();
  }
  const targetTplId =
    state.currentTemplateId && filtered.some((t) => Number(t.id) === Number(state.currentTemplateId))
      ? state.currentTemplateId
      : "";
  const firstWithExercises = filtered.find((t) => (t.exercises || []).length);
  const fallbackTplId = targetTplId || firstWithExercises?.id || filtered[0]?.id || "";
  sel.value = fallbackTplId || "";
  state.currentTemplateId = sel.value ? Number(sel.value) : "";
  const tpl = filtered.find((t) => Number(t.id) === Number(state.currentTemplateId));
  if (!state.activeSession && tpl) {
    if (tpl.program_id) {
      state.currentProgramId = Number(tpl.program_id);
    }
    programNameEl.textContent = tpl.program_name || "?";
    renderTemplateExercises(tpl);
    initGuideFromTemplate();
    applyGuideToForm();
    toggleStartButton();
    if (tpl.exercises && tpl.exercises.length) {
      const startBtn = document.getElementById("startSessionBtn");
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.style.display = "inline-flex";
      }
    }
  }
  sel.onchange = (e) => {
    const tplId = e.target.value ? Number(e.target.value) : "";
    const tpl = state.templates.find((t) => Number(t.id) === Number(tplId));
    state.currentTemplateId = tpl?.id ? Number(tpl.id) : "";
    if (tpl?.program_id) {
      state.currentProgramId = Number(tpl.program_id);
    }
    document.getElementById("programName").textContent = tpl?.program_name || "?";
    renderTemplateExercises(tpl);
    initGuideFromTemplate();
    applyGuideToForm();
    toggleStartButton();
    const startBtn = document.getElementById("startSessionBtn");
    if (startBtn && tpl?.exercises?.length) {
      startBtn.disabled = false;
      startBtn.style.display = "inline-flex";
    }
    if (!state.activeSession && (!tpl || !(tpl.exercises || []).length)) {
      hideLogForm();
      disableStartFinish();
    }
  };
}

function renderTemplateExercises(tpl) {
  const container = document.getElementById("templateExercises");
  container.innerHTML = "";
  if (!tpl) {
    container.innerHTML = '<div class="empty muted">Välj ett program och en passmall.</div>';
    return;
  }
  if (!tpl.exercises.length) {
    container.innerHTML = '<div class="empty muted">Inga övningar i den här mallen. Lägg till i fliken Passmallar.</div>';
    return;
  }
  const inSession = state.sessionLocked && state.activeSession && Number(tpl.id) === Number(state.activeSession.template_id);
  const counts = inSession ? getExerciseLogCounts(state.activeSession) : {};
  tpl.exercises.forEach((row, idx) => {
    const div = document.createElement("div");
    const doneCount = counts[Number(row.exercise_id)] || 0;
    const planned = getPlannedSets(row);
    const isCompleted = inSession && state.completedExercises[row.exercise_id];
    const isActive = inSession && Number(state.activeExerciseId) === Number(row.exercise_id);
    div.className = "exercise-card";
    if (inSession) {
      div.classList.add("session-exercise");
      if (isCompleted) div.classList.add("done");
      if (isActive) div.classList.add("active");
      if (!isCompleted) {
        div.classList.add("clickable");
        div.addEventListener("click", () => selectExerciseForSession(row.exercise_id));
      }
    }
    const statusLabel = inSession
      ? `<span class="pill ${isCompleted ? "success" : isActive ? "accent" : "subtle"}">${
          isCompleted ? "Klar" : isActive ? "Pågår" : "Redo"
        }</span>`
      : '<span class="pill subtle">Planerat</span>';
    const progress = inSession ? `<div class="meta">Loggade set: ${doneCount} / ${planned}</div>` : "";
    div.innerHTML = `
      <div class="row space">
        <h3>${idx + 1}. ${row.exercise_name || "Övning"}</h3>
        ${statusLabel}
      </div>
      <div class="tags">
        <span class="tag">Set ${row.planned_sets || "-"}</span>
        <span class="tag">Reps ${row.reps || "-"}</span>
        <span class="tag">Vikt ${row.planned_weight || "-"}</span>
        <span class="tag">RPE ${row.rpe || "-"}</span>
        <span class="tag">Vila ${row.rest || "-"}</span>
      </div>
      ${progress}
      <p class="muted small">${row.comment || ""}</p>
    `;
    container.appendChild(div);
  });
}

// ---------- Exercises ----------
// ---------- Exercises ----------
function selectExerciseForSession(exerciseId) {
  if (!state.activeSession) return;
  const tpl = state.templates.find((t) => t.id === state.activeSession.template_id);
  if (!tpl) return;
  if (state.completedExercises[exerciseId]) return;
  const idx = tpl.exercises.findIndex((r) => Number(r.exercise_id) === Number(exerciseId));
  if (idx === -1) return;
  clearRestTimer();
  state.activeExerciseId = Number(exerciseId);
  const counts = getExerciseLogCounts(state.activeSession);
  const done = counts[Number(exerciseId)] || 0;
  state.guide = { tplId: tpl.id, exerciseIndex: idx, setNumber: done + 1, completed: false };
  applyGuideToForm();
  showLogForm();
  renderTemplateExercises(tpl);
  updateGuideUI(state.guide);
  const row = tpl.exercises[idx];
  prefillLogFields(row, state.guide.setNumber);
  persistActiveSessionState();
}

function renderExercises() {
  setLogExerciseOptions();
  renderProgramSelects();
}

function setLogExerciseOptions() {
  const sel = document.getElementById("logExercise");
  if (!sel) return;
  sel.innerHTML = "";
  const tpl = getCurrentTemplateForLogging();
  const list = tpl ? tpl.exercises : [];
  sel.disabled = !list.length;
  if (tpl && list.length) {
    list.forEach((row) => {
      const ex = state.exercises.find((e) => e.id === row.exercise_id);
      const opt = document.createElement("option");
      opt.value = row.exercise_id;
      opt.textContent = ex?.name || row.exercise_id;
      sel.appendChild(opt);
    });
    if (!sel.value && list[0]) {
      sel.value = list[0].exercise_id;
    }
    handleLogExerciseChange();
  }
}

function renderExerciseList() {
  const list = document.getElementById("exerciseList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.exercises.length) {
    list.textContent = "Inga övningar ännu.";
    return;
  }
  state.exercises.forEach((ex) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <div>
        <div class="title">${ex.name}</div>
        <div class="meta">${ex.muscle_group || "-"} • ${ex.type || "-"} • ${ex.equipment || "-"}</div>
        <div class="meta">${ex.notes || ""}</div>
      </div>
      <div class="actions">
        <button type="button" class="action-btn" data-action="edit-exercise" data-id="${ex.id}">Redigera</button>
        <button type="button" class="action-btn danger" data-action="delete-exercise" data-id="${ex.id}">Ta bort</button>
      </div>
    `;
    list.appendChild(item);
  });
}

// ---------- Program & template selects ----------
function renderProgramSelects() {
  const tplProgram = document.getElementById("tplProgram");
  const rowTemplate = document.getElementById("rowTemplate");
  const rowProgram = document.getElementById("rowProgram");
  const overviewSel = document.getElementById("overviewProgramSelect");
  const rowExercise = document.getElementById("rowExercise");
  const rowExerciseSearch = null; // removed separate search field; reuse main select
  if (tplProgram) {
    tplProgram.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Välj program";
    tplProgram.appendChild(placeholder);
    state.programs.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name} (v${p.version || 1})`;
      tplProgram.appendChild(opt);
    });
  }
  if (rowProgram) {
    rowProgram.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Välj program";
    rowProgram.appendChild(placeholder);
    state.programs.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      rowProgram.appendChild(opt);
    });
    rowProgram.value = state.templatesProgramId || state.currentProgramId || "";
    rowProgram.onchange = (e) => {
      const val = e.target.value;
      state.templatesProgramId = val ? Number(val) : "";
      renderProgramSelects();
      renderProgramTemplates();
    };
  }
  if (tplProgram) {
    tplProgram.value = state.templatesProgramId || state.currentProgramId || "";
    tplProgram.onchange = (e) => {
      const val = e.target.value;
      state.templatesProgramId = val ? Number(val) : "";
      renderProgramSelects();
      renderProgramTemplates();
    };
  }
  if (overviewSel) {
    overviewSel.value = state.templatesProgramId || state.currentProgramId || "";
  }
  const selectedRowProgram = rowProgram?.value ? Number(rowProgram.value) : state.currentProgramId;
  if (rowTemplate) {
    rowTemplate.innerHTML = "";
    const tplFiltered = selectedRowProgram
      ? state.templates.filter((t) => Number(t.program_id) === Number(selectedRowProgram))
      : [];
    if (!tplFiltered.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Inga pass för valt program";
      rowTemplate.appendChild(opt);
      rowTemplate.disabled = true;
    } else {
      rowTemplate.disabled = false;
    }
    tplFiltered.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name} (${t.program_name || ""})`;
      rowTemplate.appendChild(opt);
    });
    if (tplFiltered.length === 1) {
      rowTemplate.value = tplFiltered[0].id;
    }
    if (!rowTemplate.value && state.currentTemplateId && tplFiltered.some((t) => t.id === state.currentTemplateId)) {
      rowTemplate.value = state.currentTemplateId;
    }
    // if no selection and we have a filtered list, pick first
    if (!rowTemplate.value && tplFiltered.length) {
      rowTemplate.value = tplFiltered[0].id;
    }
  }

  // fill exercise select with optional search filter
  if (rowExercise) {
    rowExercise.innerHTML = "";
    state.exercises.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.id;
      opt.textContent = ex.name;
      rowExercise.appendChild(opt);
    });
    if (!rowExercise.value && state.exercises.length) {
      rowExercise.value = state.exercises[0].id;
    }
  }
}

function renderProgramTemplates() {
  const programList = document.getElementById("programList");
  if (programList) {
    programList.innerHTML = "";
    if (!state.programs.length) {
      programList.textContent = "Inga program ännu.";
    } else {
      state.programs.forEach((p) => {
        const item = document.createElement("div");
        item.className = "list-item column";
        item.innerHTML = `
          <div>
            <div class="title">${p.name}</div>
            <div class="meta">${p.description || ""}</div>
            <div class="meta">Status: ${p.status || "active"} • v${p.version || 1}</div>
            <div class="meta">Publicerat: ${p.is_public ? "Ja" : "Nej"}</div>
          </div>
          <div class="actions">
            <label class="meta small">
              <input type="checkbox" data-action="toggle-program-public" data-id="${p.id}" ${p.is_public ? "checked" : ""} />
              Public
            </label>
            <button type="button" class="action-btn" data-action="edit-program" data-id="${p.id}">Redigera</button>
            <button type="button" class="action-btn danger" data-action="delete-program" data-id="${p.id}">Ta bort</button>
          </div>
        `;
        programList.appendChild(item);
      });
    }
  }
  const templateList = document.getElementById("templateList");
  if (templateList) {
    templateList.innerHTML = "";
    const overviewSel = document.getElementById("overviewProgramSelect");
    if (overviewSel) {
      overviewSel.innerHTML = "";
      state.programs.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        overviewSel.appendChild(opt);
      });
      if (!state.templatesProgramId && state.programs.length) {
        state.templatesProgramId = state.programs[0].id;
      }
      overviewSel.value = state.templatesProgramId || "";
      overviewSel.onchange = (e) => {
        const val = e.target.value;
        state.templatesProgramId = val ? Number(val) : "";
        renderProgramSelects();
        renderProgramTemplates();
      };
    }
    const filtered = state.templatesProgramId
      ? state.templates.filter((t) => Number(t.program_id) === Number(state.templatesProgramId))
      : state.templates;
    if (!filtered.length) {
      templateList.textContent = state.templatesProgramId
        ? "Inga passmallar för valt program ännu."
        : "Välj ett program för att visa passmallar.";
      return;
    }
    const sortedTemplates = [...filtered].sort((a, b) => {
      if (a.program_name === b.program_name) return a.name.localeCompare(b.name);
      return (a.program_name || "").localeCompare(b.program_name || "");
    });
    sortedTemplates.forEach((t) => {
      const item = document.createElement("div");
      item.className = "list-item column";

      const header = document.createElement("div");
      header.innerHTML = `
        <div class="title">${t.name}</div>
        <div class="meta">Program: ${t.program_name || ""} • ${t.exercises.length} övningar</div>
      `;
      item.appendChild(header);

      const rowsWrap = document.createElement("div");
      rowsWrap.className = "template-rows";
      if (!t.exercises.length) {
        rowsWrap.innerHTML = '<div class="meta">Inga övningar i denna mall ännu.</div>';
      } else {
        t.exercises.forEach((row) => {
          const ex = state.exercises.find((e) => e.id === row.exercise_id);
          const rowDiv = document.createElement("div");
          rowDiv.className = "template-row";
          rowDiv.innerHTML = `
            <div>
              <div class="title">${ex?.name || "Övning"}</div>
              <div class="meta">Set ${row.planned_sets || "-"} • Reps ${row.reps || "-"} • Vikt ${row.planned_weight || "-"}</div>
              <div class="meta">RPE ${row.rpe || "-"} • Vila ${row.rest || "-"} ${row.comment ? "• " + row.comment : ""}</div>
            </div>
            <div class="actions">
              <button type="button" class="action-btn" data-action="edit-template-row" data-tpl-id="${t.id}" data-row-id="${row.id}">Redigera</button>
              <button type="button" class="action-btn danger" data-action="delete-template-row" data-tpl-id="${t.id}" data-row-id="${row.id}">Ta bort</button>
            </div>
          `;
          rowsWrap.appendChild(rowDiv);
        });
      }
      item.appendChild(rowsWrap);

      const actions = document.createElement("div");
      actions.className = "actions";
      actions.innerHTML = `
        <button type="button" class="action-btn" data-action="edit-template" data-id="${t.id}">Byt namn</button>
        <button type="button" class="action-btn danger" data-action="delete-template" data-id="${t.id}">Ta bort passmall</button>
      `;
      item.appendChild(actions);

      templateList.appendChild(item);
    });
  }
}

// ---------- Sessions / Guide ----------
function renderActiveSession() {
  const label = document.getElementById("activeSessionLabel");
  const list = document.getElementById("setLogList");
  const clearRow = document.getElementById("clearActiveRow");
  const clearBtn = document.getElementById("clearActiveBtn");
  const cancelBtn = document.getElementById("cancelSessionBtn");
  if (!label || !list) return;
  list.innerHTML = "";
  if (!state.activeSession) {
    label.textContent = "Ingen aktiv session";
    updateGuideUI(null);
    clearRestTimer();
    disableStartFinish();
    hideLogForm();
    showSelectorArea(true);
    if (cancelBtn) cancelBtn.style.display = "none";
    if (clearRow) clearRow.style.display = state.hasAnyActiveSessions ? "flex" : "none";
    if (clearBtn) clearBtn.disabled = !state.hasAnyActiveSessions;
    return;
  }
  enableFinish();
  if (state.activeExerciseId || state.guide) {
    showLogForm();
  } else {
    hideLogForm();
  }
  if (cancelBtn) cancelBtn.style.display = "inline-flex";
  if (clearRow) clearRow.style.display = state.hasAnyActiveSessions ? "flex" : "none";
  if (clearBtn) clearBtn.disabled = false;
  const elapsed = formatElapsedSince(state.sessionStartedAt);
  const elapsedText = elapsed ? ` • ${elapsed}` : "";
  label.textContent = `${state.activeSession.template_name} (${state.activeSession.date})${elapsedText}`;
  state.activeSession.set_logs?.forEach((s) => {
    const ex = state.exercises.find((e) => e.id === s.exercise_id);
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <div>
        <div class="title">${ex?.name || "Övning"}</div>
        <div class="meta">Set ${s.set_number} • ${s.weight} kg x ${s.reps} • RPE ${s.rpe}</div>
        <div class="meta">${s.comment || ""}</div>
      </div>
      <div class="meta">#${String(s.id || "").slice(0, 4)}</div>
    `;
    list.appendChild(item);
  });
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty muted";
    empty.textContent = "Inga set loggade ännu. Följ guiden och lägg till första setet.";
    list.appendChild(empty);
  }
  updateGuideUI(state.guide);
  updateRestUI();
}

function renderSessionHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.sessions.length) {
    list.textContent = "Ingen historik ännu.";
    return;
  }
  state.sessions
    .slice(0, 15)
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .forEach((s) => {
      const item = document.createElement("div");
      item.className = "list-item column";
      const open = Boolean(state.historyOpen[s.id]);
      const setLogs = s.set_logs || [];
      const detailRows = setLogs
        .map((log) => {
          const ex = state.exercises.find((e) => e.id === log.exercise_id);
          const name = ex?.name || "Övning";
          return `
            <div class="meta">
              ${name} • Set ${log.set_number || "-"} • ${log.weight || 0} kg x ${log.reps || 0} • RPE ${log.rpe || "-"}${log.comment ? " • " + log.comment : ""}
            </div>
          `;
        })
        .join("");
      item.innerHTML = `
        <div>
          <div class="title">${s.template_name || "Pass"} • ${s.date || "okänt datum"}</div>
          <div class="meta">${s.program_name || ""} • ${s.status} • ${s.set_logs?.length || 0} set</div>
        </div>
        <div class="actions">
          <button type="button" class="action-btn" data-action="toggle-session-details" data-id="${s.id}">
            ${open ? "Dölj" : "Visa"} detaljer
          </button>
          <button type="button" class="action-btn danger" data-action="delete-session" data-id="${s.id}">Ta bort</button>
          <div class="meta">#${String(s.id || "").slice(0, 4)}</div>
        </div>
        ${
          open
            ? `<div class="history-details">
                ${detailRows || '<div class="muted">Inga set loggade.</div>'}
              </div>`
            : ""
        }
      `;
      list.appendChild(item);
    });
}

function toggleSessionDetails(id) {
  const key = String(id);
  state.historyOpen[key] = !state.historyOpen[key];
  renderSessionHistory();
}

function renderPBs() {
  const list = document.getElementById("pbList");
  if (!list) return;
  const exSel = document.getElementById("pbExerciseFilter");
  const repsInput = document.getElementById("pbRepsFilter");
  if (exSel) {
    exSel.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Alla övningar";
    exSel.appendChild(optAll);
    state.exercises.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.id;
      opt.textContent = ex.name;
    exSel.appendChild(opt);
    });
    exSel.value = state.pbFilterExercise || "";
  }
  if (repsInput) repsInput.value = state.pbFilterReps || "";
  list.innerHTML = "";
  const exFilter = state.pbFilterExercise || "";
  const repsFilter = state.pbFilterReps || 0;
  const source = (state.pbs || []).filter((pb) => pb.kind === "max_weight_reps");
  let filtered = source.filter((pb) => (!exFilter || Number(pb.exercise_id) === Number(exFilter)));
  if (repsFilter) {
    filtered = filtered.filter((pb) => Number(pb.reps) === Number(repsFilter));
  }
  const grouped = {};
  filtered.forEach((pb) => {
    const key = pb.exercise_id;
    if (!grouped[key] || Number(pb.value) > Number(grouped[key].value)) {
      grouped[key] = pb;
    }
  });
  const items = Object.values(grouped);
  if (!items.length) {
    list.textContent = "Inga PB ännu.";
    return;
  }
  items
    .slice()
    .sort((a, b) => (Number(a.value) > Number(b.value) ? -1 : 1))
    .forEach((pb) => {
      const ex = state.exercises.find((e) => e.id === pb.exercise_id);
      const value =
        typeof pb.value === "number" && Number.isFinite(pb.value)
          ? pb.value % 1 === 0
            ? pb.value
            : pb.value.toFixed(2)
          : pb.value;
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <div>
          <div class="title">${ex?.name || "Övning"} • ${pb.label || pb.kind}</div>
          <div class="meta">Värde: ${value} • Reps: ${pb.reps || "-"} • Datum: ${pb.date || "-"}</div>
          <div class="meta">Publicerat: ${pb.is_public ? "Ja" : "Nej"}</div>
        </div>
        <div class="actions">
          <label class="meta small">
            <input type="checkbox" data-action="toggle-pb-public" data-id="${pb.id}" ${pb.is_public ? "checked" : ""} />
            Public
          </label>
          <div class="meta">#${String(pb.id || "").slice(0, 4)}</div>
        </div>
      `;
      list.appendChild(item);
    });
}

function renderFriendRequests() {
  const incomingList = document.getElementById("incomingRequests");
  const outgoingList = document.getElementById("outgoingRequests");
  if (incomingList) {
    incomingList.innerHTML = "";
    if (!state.incomingRequests.length) {
      incomingList.innerHTML = '<div class="muted">Inga inkommande förfrågningar.</div>';
    } else {
      state.incomingRequests.forEach((req) => {
        const item = document.createElement("div");
        item.className = "list-item";
        item.innerHTML = `
          <div>
            <div class="title">${req.from_username || "Okänd"}</div>
            <div class="meta">${req.from_display_name || ""}</div>
          </div>
          <div class="actions">
            <button type="button" class="action-btn" data-action="accept-request" data-id="${req.id}">Acceptera</button>
            <button type="button" class="action-btn danger" data-action="reject-request" data-id="${req.id}">Avvisa</button>
          </div>
        `;
        incomingList.appendChild(item);
      });
    }
  }
  if (outgoingList) {
    outgoingList.innerHTML = "";
    if (!state.outgoingRequests.length) {
      outgoingList.innerHTML = '<div class="muted">Inga skickade förfrågningar.</div>';
    } else {
      state.outgoingRequests.forEach((req) => {
        const item = document.createElement("div");
        item.className = "list-item";
        item.innerHTML = `
          <div>
            <div class="title">${req.to_username || "Okänd"}</div>
            <div class="meta">Status: ${req.status}</div>
          </div>
        `;
        outgoingList.appendChild(item);
      });
    }
  }
}

function renderFriends() {
  const list = document.getElementById("friendsList");
  if (!list) return;
  list.innerHTML = "";
  if (!state.friends.length) {
    list.innerHTML = '<div class="muted">Inga vänner ännu.</div>';
    return;
  }
  state.friends.forEach((fr) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `
      <div>
        <div class="title">${fr.username}</div>
        <div class="meta">${fr.display_name || ""}</div>
      </div>
      <div class="actions">
        <button type="button" class="action-btn" data-action="view-public" data-username="${fr.username}">Visa publicerat</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function renderPublicView() {
  const label = document.getElementById("publicViewLabel");
  const programList = document.getElementById("publicPrograms");
  const pbList = document.getElementById("publicPBs");
  const username = state.viewUser;
  if (label) {
    label.textContent = username
      ? `Publikt innehåll från ${username}`
      : "Välj en användare för att se publika program och PBs.";
  }
  if (programList) {
    programList.innerHTML = "";
    if (!username) {
      programList.innerHTML = '<div class="muted">Ingen användare vald.</div>';
    } else if (!state.viewUserPrograms.length) {
      programList.innerHTML = '<div class="muted">Inga publicerade program.</div>';
    } else {
      state.viewUserPrograms.forEach((p) => {
        const item = document.createElement("div");
        item.className = "list-item";
        item.innerHTML = `
          <div>
            <div class="title">${p.name}</div>
            <div class="meta">${p.description || ""}</div>
            <div class="meta">Publicerat: ${p.is_public ? "Ja" : "Nej"}</div>
          </div>
          <div class="actions">
            <button type="button" class="action-btn" data-action="view-public-program" data-id="${p.id}" data-username="${username}">Visa innehåll</button>
            <button type="button" class="action-btn" data-action="copy-public-program" data-id="${p.id}" data-username="${username}" ${p.is_public ? "" : "disabled"}>Kopiera</button>
          </div>
        `;
        programList.appendChild(item);
      });
    }
  }
  if (pbList) {
    pbList.innerHTML = "";
    if (!username) {
      pbList.innerHTML = '<div class="muted">Ingen användare vald.</div>';
    } else if (!state.viewUserPBs.length) {
      pbList.innerHTML = '<div class="muted">Inga publicerade PBs.</div>';
    } else {
      state.viewUserPBs.forEach((pb) => {
        const item = document.createElement("div");
        const ex = state.exercises.find((e) => e.id === pb.exercise_id);
        item.className = "list-item";
        item.innerHTML = `
          <div>
            <div class="title">${ex?.name || "Övning"} • ${pb.label || pb.kind}</div>
            <div class="meta">Värde: ${pb.value} • Reps: ${pb.reps || "-"} • Datum: ${pb.date || "-"}</div>
          </div>
        `;
        pbList.appendChild(item);
      });
    }
  }
}

function getSelectedTemplate() {
  const tplId = state.currentTemplateId || document.getElementById("templateSelect")?.value;
  return state.templates.find((t) => String(t.id) === String(tplId));
}

function getCurrentTemplateForLogging() {
  if (state.activeSession) {
    return state.templates.find((t) => t.id === state.activeSession.template_id);
  }
  return getSelectedTemplate();
}

function getPlannedSets(row) {
  const n = parseInt(row.planned_sets, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function getTemplateRowForExercise(exerciseId, tpl = getCurrentTemplateForLogging()) {
  if (!tpl) return null;
  return (tpl.exercises || []).find((r) => Number(r.exercise_id) === Number(exerciseId)) || null;
}

function parseRestSeconds(restValue) {
  if (restValue === undefined || restValue === null) return 0;
  const str = String(restValue).trim();
  if (!str) return 0;
  const lower = str.toLowerCase();
  if (lower.includes(":")) {
    const [min, sec] = lower.split(":").map((v) => Number(v) || 0);
    const total = min * 60 + sec;
    return total > 0 ? Math.round(total) : 0;
  }
  const unit =
    lower.endsWith("min") || lower.endsWith("mins") || lower.endsWith("m")
      ? "m"
      : lower.endsWith("s")
      ? "s"
      : "";
  const match = lower.match(/(\d+(?:\.\d+)?)/);
  const num = match ? Number(match[1]) : Number(lower);
  if (!Number.isFinite(num) || num <= 0) return 0;
  let secs;
  if (unit === "s") {
    secs = Math.round(num);
  } else if (unit === "m") {
    secs = Math.round(num * 60);
  } else {
    // Default to minutes for typical rest values
    secs = Math.round(num * 60);
    // If that would be an hour or more and no hours were specified, fall back to seconds
    if (secs >= 3600) {
      secs = Math.round(num);
    }
  }
  return secs;
}

function formatRestTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatElapsedSince(startTs) {
  if (!startTs) return "";
  const diff = Math.max(0, Date.now() - startTs);
  const totalMins = Math.floor(diff / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const secs = Math.floor((diff % 60000) / 1000);
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, "0")}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function updateRestUI() {
  const box = document.getElementById("restTimerBox");
  const countdown = document.getElementById("restTimerCountdown");
  const submitBtn = document.querySelector("#logForm button[type='submit']");
  const shouldDisableBase = !state.guide || (state.guide && state.guide.completed);
  if (!box) return;
  if (!state.restTimer) {
    box.style.display = "none";
    if (submitBtn) submitBtn.disabled = shouldDisableBase;
    return;
  }
  box.style.display = "flex";
  if (countdown) countdown.textContent = formatRestTime(state.restTimer.remaining);
  if (submitBtn) submitBtn.disabled = true;
}

function clearRestTimer() {
  if (restInterval) {
    clearInterval(restInterval);
    restInterval = null;
  }
  if (state.restTimer) {
    state.restTimer = null;
    updateRestUI();
    persistActiveSessionState();
  }
}

function startRestTimer(seconds) {
  const secs = parseRestSeconds(seconds);
  clearRestTimer();
  if (!secs) return;
  const deadline = Date.now() + secs * 1000;
  state.restTimer = { total: secs, remaining: secs, deadline };
  updateRestUI();
  restInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (state.restTimer) state.restTimer.remaining = remaining;
    updateRestUI();
    if (remaining <= 0) {
      clearRestTimer();
    }
  }, 500);
  persistActiveSessionState();
}

function skipRestTimer() {
  clearRestTimer();
  updateRestUI();
}

function prefillLogFields(row, setNumber = 1) {
  if (!row) return;
  const weightEl = document.getElementById("logWeight");
  const repsEl = document.getElementById("logReps");
  const plannedWeight = row.planned_weight ?? "";
  const plannedReps = row.reps ?? "";
  if (weightEl && (setNumber <= 1 || !weightEl.value)) {
    weightEl.value = plannedWeight;
  }
  if (repsEl && (setNumber <= 1 || !repsEl.value)) {
    repsEl.value = plannedReps;
  }
}

function getExerciseLogCounts(sessionObj = state.activeSession) {
  const counts = {};
  (sessionObj?.set_logs || []).forEach((s) => {
    const key = Number(s.exercise_id);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function initGuideFromTemplate() {
  const tpl = getSelectedTemplate();
  if (!tpl || !tpl.exercises.length) {
    state.guide = null;
    return;
  }
  state.guide = { tplId: tpl.id, exerciseIndex: 0, setNumber: 1, completed: false };
}

function initGuideFromSession() {
  if (!state.activeSession) {
    state.guide = null;
    state.sessionLocked = false;
    state.activeExerciseId = null;
    state.completedExercises = {};
    return;
  }
  const tpl = state.templates.find((t) => t.id === state.activeSession.template_id);
  if (!tpl) {
    state.guide = null;
    state.sessionLocked = false;
    state.activeExerciseId = null;
    state.completedExercises = {};
    return;
  }
  state.sessionLocked = true;
  const counts = getExerciseLogCounts(state.activeSession);
  state.completedExercises = loadCompletedExercises(state.activeSession.id) || {};
  if (state.activeExerciseId && state.completedExercises[state.activeExerciseId]) {
    state.activeExerciseId = null;
  }
  const allDone = tpl.exercises.every((row) => state.completedExercises[row.exercise_id]);
  if (!state.activeExerciseId) {
    if (allDone) {
      const lastIdx = Math.max(tpl.exercises.length - 1, 0);
      const lastRow = tpl.exercises[lastIdx];
      const done = counts[Number(lastRow.exercise_id)] || 0;
      state.guide = { tplId: tpl.id, exerciseIndex: lastIdx, setNumber: done + 1, completed: true };
    } else {
      state.guide = null;
    }
    return;
  }
  const idx = tpl.exercises.findIndex((r) => Number(r.exercise_id) === Number(state.activeExerciseId));
  if (idx === -1) {
    state.activeExerciseId = null;
    state.guide = null;
    return;
  }
  const done = counts[Number(state.activeExerciseId)] || 0;
  state.guide = { tplId: tpl.id, exerciseIndex: idx, setNumber: done + 1, completed: allDone };
}

function applyGuideToForm() {
  const logSetInput = document.getElementById("logSet");
  const submitBtn = document.querySelector("#logForm button[type='submit']");
  const exerciseSel = document.getElementById("logExercise");
  if (!state.guide) {
    clearRestTimer();
    if (exerciseSel) {
      exerciseSel.value = "";
      exerciseSel.disabled = true;
    }
    if (logSetInput) {
      logSetInput.value = "";
      logSetInput.readOnly = true;
    }
    if (submitBtn) submitBtn.disabled = true;
    updateGuideUI(null);
    return;
  }
  const tpl = state.templates.find((t) => t.id === state.guide.tplId);
  if (!tpl || !tpl.exercises.length) return;
  const row = tpl.exercises[state.guide.exerciseIndex] || tpl.exercises[0];
  setLogExerciseOptions();
  if (exerciseSel) {
    exerciseSel.value = row.exercise_id;
    exerciseSel.disabled = true;
  }
  if (logSetInput) {
    logSetInput.value = state.guide.setNumber;
    logSetInput.readOnly = true;
  }
  prefillLogFields(row, state.guide.setNumber);
  if (submitBtn) submitBtn.disabled = !!state.guide.completed;
  updateGuideUI(state.guide);
  updateRestUI();
}

function advanceGuideAfterSet(exerciseId) {
  if (!state.guide) return;
  const tpl = state.templates.find((t) => t.id === state.guide.tplId);
  if (!tpl || !tpl.exercises.length) return;
  let idx = state.guide.exerciseIndex;
  const row = tpl.exercises[idx];
  if (!row) return;
  const planned = getPlannedSets(row);
  const sameExercise = exerciseId === row.exercise_id;
  let nextSet = sameExercise ? state.guide.setNumber + 1 : state.guide.setNumber;
  let completed = false;
  if (planned && nextSet > planned) {
    if (idx + 1 < tpl.exercises.length) {
      idx = idx + 1;
      nextSet = 1;
    } else {
      completed = true;
    }
  }
  state.guide = { tplId: tpl.id, exerciseIndex: idx, setNumber: nextSet, completed };
}

function setGuidePosition(tpl, exerciseId, setNumber, completed = false) {
  if (!tpl) return;
  const idx = tpl.exercises.findIndex((r) => Number(r.exercise_id) === Number(exerciseId));
  const safeIdx = idx >= 0 ? idx : 0;
  state.activeExerciseId = exerciseId ? Number(exerciseId) : null;
  state.guide = { tplId: tpl.id, exerciseIndex: safeIdx, setNumber: setNumber || 1, completed };
}

async function handlePostSetFlow(tpl, exerciseId) {
  if (!tpl || !state.activeSession) return;
  const counts = getExerciseLogCounts(state.activeSession);
  const row = tpl.exercises.find((r) => Number(r.exercise_id) === Number(exerciseId));
  const planned = row ? getPlannedSets(row) : 0;
  const done = counts[Number(exerciseId)] || 0;

  if (planned && done >= planned) {
    const message = `Övningen klar: ${row?.exercise_name || "Övning"}. Vill du logga extraset eller markera klar?`;
    const choice = await choiceDialog(message, "Klar med övning", "Lägg till extraset");
    if (choice === "secondary") {
      setGuidePosition(tpl, exerciseId, done + 1, false);
      applyGuideToForm();
      renderTemplateExercises(tpl);
      persistActiveSessionState();
      return;
    }
    state.completedExercises = state.completedExercises || {};
    state.completedExercises[exerciseId] = true;
    saveCompletedExercises(state.activeSession.id, state.completedExercises);
    state.activeExerciseId = null;
    state.guide = null;
    applyGuideToForm();
    renderTemplateExercises(tpl);
    const allDone = tpl.exercises.every((r) => state.completedExercises[r.exercise_id]);
    if (allDone) {
      await showCompletionModal();
      await finishSession();
      return;
    } else {
      updateGuideUI(null);
    }
    persistActiveSessionState();
    return;
  }

  setGuidePosition(tpl, exerciseId, done + 1, false);
  applyGuideToForm();
  renderTemplateExercises(tpl);
  persistActiveSessionState();
}

function updateGuideUI(guide) {
  const el = document.getElementById("guideStatus");
  if (!el) return;
  if (!guide) {
    if (state.sessionLocked && state.activeSession) {
      el.textContent = "Passläge: välj en övning att starta.";
    } else {
      el.textContent = "Välj program och passmall, starta pass.";
    }
    return;
  }
  const tpl = state.templates.find((t) => t.id === guide.tplId);
  if (!tpl) {
    el.textContent = "Välj passmall.";
    return;
  }
  const row = tpl.exercises[guide.exerciseIndex] || tpl.exercises[0];
  const ex = state.exercises.find((e) => e.id === row?.exercise_id);
  const planned = getPlannedSets(row);
  if (guide.completed) {
    el.textContent = "Alla planerade set klara. Avsluta passet eller lägg extra set.";
    return;
  }
  el.textContent = `Övning: ${ex?.name || "?"} • Set ${guide.setNumber}/${planned || "?"}`;
}

function skipToNextExercise() {
  if (!state.guide) return;
  const tpl = state.templates.find((t) => t.id === state.guide.tplId);
  if (!tpl || !tpl.exercises.length) return;
  clearRestTimer();
  if (state.guide.exerciseIndex + 1 < tpl.exercises.length) {
    state.guide = { tplId: tpl.id, exerciseIndex: state.guide.exerciseIndex + 1, setNumber: 1, completed: false };
  } else {
    state.guide = {
      tplId: tpl.id,
      exerciseIndex: state.guide.exerciseIndex,
      setNumber: state.guide.setNumber,
      completed: true,
    };
  }
  persistActiveSessionState();
}

// ---------- Actions ----------
async function startSession() {
  const tplId = state.currentTemplateId || document.getElementById("templateSelect").value;
  if (!tplId || !state.currentProgramId) {
    alert("Välj program och passmall först.");
    return;
  }
  const tpl = state.templates.find((t) => t.id === tplId);
  if (!tpl) {
    alert("Passmallen hittades inte.");
    return;
  }
  state.restoredWorkout = false;
  clearRestTimer();
  const startBtn = document.getElementById("startSessionBtn");
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.style.display = "inline-flex";
  }
  try {
    const res = await api("/sessions/start", {
      method: "POST",
      body: JSON.stringify({ template_id: tplId }),
    });
    state.activeSession = res.session || res;
    state.sessionLocked = true;
    state.sessionStartedAt = Date.now();
    state.completedExercises = {};
    state.activeExerciseId = null;
    clearCompletedExercises(state.activeSession.id);
    saveCompletedExercises(state.activeSession.id, {});
    state.currentProgramId = tpl.program_id;
    setSelectorsToSession(tpl);
    setLogExerciseOptions();
    initGuideFromSession();
    applyGuideToForm();
    enableFinish();
    hideLogForm();
    showSelectorArea(false);
    enterSessionLockUI();
    renderTemplateExercises(tpl);
    updateGuideUI(state.guide);
    enableNavigationGuards();
    persistActiveSessionState(true);
    showRestoreNotice("");
    await refreshSessions();
  } catch (err) {
    console.error("Start session failed", err);
    alert(`Kunde inte starta passet: ${err.message || err}. API_BASE=${API_BASE}`);
  }
}

async function logSet(e) {
  e.preventDefault();
  if (!state.activeSession) {
    alert("Starta ett pass först.");
    return;
  }
  if (state.restTimer) {
    alert("Vila pågår. Vänta klart eller hoppa över vilan innan du loggar nästa set.");
    return;
  }
  const tpl = getCurrentTemplateForLogging();
  const selectEl = document.getElementById("logExercise");
  let exerciseIdRaw = selectEl ? selectEl.value : "";
  if (!exerciseIdRaw) {
    // försök välja första övningen om inget valt
    if (tpl && selectEl && tpl.exercises?.length) {
      const firstEx = tpl.exercises[0].exercise_id;
      selectEl.value = firstEx;
      exerciseIdRaw = String(firstEx);
    }
  }
  const exercise_id = exerciseIdRaw ? Number(exerciseIdRaw) : null;
  const payload = {
    exercise_id,
    set_number: state.guide ? state.guide.setNumber : Number(document.getElementById("logSet").value || 1),
    weight: Number(document.getElementById("logWeight").value || 0),
    reps: Number(document.getElementById("logReps").value || 0),
    rpe: Number(document.getElementById("logRpe").value || 0),
    comment: document.getElementById("logComment").value || "",
  };
  if (!exercise_id) {
    alert("Välj en övning i passet för att börja.");
    return;
  }
  if (!tpl || !(tpl.exercises || []).some((row) => Number(row.exercise_id) === Number(payload.exercise_id))) {
    alert("Övningen finns inte i passet.");
    return;
  }
  try {
    await api(`/sessions/${state.activeSession.id}/log-set`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    document.getElementById("logForm").reset();
    await refreshSessions();
    const row = getTemplateRowForExercise(payload.exercise_id, tpl);
    const restSeconds = parseRestSeconds(row?.rest);
    await handlePostSetFlow(tpl, payload.exercise_id);
    const exerciseCompleted = !!state.completedExercises?.[payload.exercise_id];
    if (state.activeSession && restSeconds && !exerciseCompleted) {
      startRestTimer(restSeconds);
    } else {
      clearRestTimer();
    }
    persistActiveSessionState();
  } catch (err) {
    console.error("Log set failed", err);
    alert("Kunde inte logga set: " + (err.message || err));
  }
}

async function finishSession() {
  if (!state.activeSession) {
    alert("Ingen aktiv session.");
    return;
  }
  clearCompletedExercises(state.activeSession.id);
  clearRestTimer();
  await api(`/sessions/${state.activeSession.id}/finish`, { method: "POST" });
  // Closed session: clear persisted state so next start is clean.
  clearPersistedSessionState(true);
  state.restoredWorkout = false;
  disableNavigationGuards();
  state.activeSession = null;
  state.sessionLocked = false;
  state.activeExerciseId = null;
  state.completedExercises = {};
  state.sessionStartedAt = null;
  hideLogForm();
  disableStartFinish();
  showSelectorArea(true);
  exitSessionLockUI();
  updateGuideUI(null);
  showRestoreNotice("");
  await loadData();
}

async function cancelSession() {
  if (!state.activeSession) {
    alert("Ingen aktiv session.");
    return;
  }
  clearCompletedExercises(state.activeSession.id);
  clearRestTimer();
  await api(`/sessions/${state.activeSession.id}/cancel`, { method: "POST" });
  // Closed session: clear persisted state so next start is clean.
  clearPersistedSessionState(true);
  state.restoredWorkout = false;
  disableNavigationGuards();
  state.activeSession = null;
  state.sessionLocked = false;
  state.activeExerciseId = null;
  state.completedExercises = {};
  state.sessionStartedAt = null;
  hideLogForm();
  disableStartFinish();
  showSelectorArea(true);
  exitSessionLockUI();
  updateGuideUI(null);
  showRestoreNotice("");
  await loadData();
}

async function clearActiveSessions() {
  const currentId = state.activeSession?.id;
  await api("/sessions/clear-active", { method: "POST" });
  clearPersistedSessionState(true);
  state.restoredWorkout = false;
  disableNavigationGuards();
  state.activeSession = null;
  state.sessionLocked = false;
  state.activeExerciseId = null;
  clearCompletedExercises(currentId);
  clearRestTimer();
  state.completedExercises = {};
  state.sessionStartedAt = null;
  hideLogForm();
  disableStartFinish();
  showSelectorArea(true);
  exitSessionLockUI();
  updateGuideUI(null);
  showRestoreNotice("");
  await loadData();
}

async function refreshSessions() {
  const prevStart = state.sessionStartedAt;
  const sessionsRes = await api("/sessions");
  state.sessions = sessionsRes || [];
  state.hasAnyActiveSessions = state.sessions.some((s) => s.status === "in_progress");
  state.activeSession = state.sessions.find((s) => s.status === "in_progress") || state.activeSession;
  restoreActiveSessionFromStorage();
  if (state.activeSession) {
    state.sessionLocked = true;
    state.sessionStartedAt =
      prevStart ||
      state.sessionStartedAt ||
      loadPersistedSessionState()?.startedAt ||
      Date.now();
    enterSessionLockUI();
    enableNavigationGuards();
  } else {
    state.sessionLocked = false;
    state.activeExerciseId = null;
    state.sessionStartedAt = null;
    clearPersistedSessionState();
    showRestoreNotice("");
    exitSessionLockUI();
  }
  initGuideFromSession();
  renderActiveSession();
  setLogExerciseOptions();
  renderSessionHistory();
  applyGuideToForm();
  persistActiveSessionState();
}

async function refreshSocial() {
  const [friendsRes, incomingReqRes, outgoingReqRes] = await Promise.all([
    api("/friends"),
    api("/friends/requests/incoming"),
    api("/friends/requests/outgoing"),
  ]);
  state.friends = friendsRes || [];
  state.incomingRequests = incomingReqRes || [];
  state.outgoingRequests = outgoingReqRes || [];
  renderFriends();
  renderFriendRequests();
}

async function sendFriendRequest() {
  const input = document.getElementById("friendUsernameInput");
  const username = (input?.value || "").trim();
  if (!username) {
    alert("Ange användarnamn.");
    return;
  }
  try {
    await api("/friends/requests", {
      method: "POST",
      body: JSON.stringify({ to_username: username }),
    });
    if (input) input.value = "";
    await refreshSocial();
  } catch (err) {
    alert("Kunde inte skicka förfrågan: " + err.message);
  }
}

async function acceptFriendRequest(id) {
  await api(`/friends/requests/${id}/accept`, { method: "POST" });
  await refreshSocial();
}

async function rejectFriendRequest(id) {
  await api(`/friends/requests/${id}/reject`, { method: "POST" });
  await refreshSocial();
}

async function viewPublicUser(username) {
  const raw =
    (username !== undefined && username !== null
      ? username
      : document.getElementById("viewUserInput")?.value) || "";
  const target = String(raw).trim();
  if (!target) {
    alert("Ange användarnamn.");
    return;
  }
  try {
    const [programs, pbs] = await Promise.all([
      api(`/users/${encodeURIComponent(target)}/programs`),
      api(`/users/${encodeURIComponent(target)}/pbs`),
    ]);
    state.viewUser = target;
    state.viewUserPrograms = programs || [];
    state.viewUserPBs = pbs || [];
    renderPublicView();
  } catch (err) {
    alert("Kunde inte hämta publicerat innehåll: " + err.message);
  }
}

async function viewPublicProgram(programId, username = state.viewUser) {
  if (!programId || !username) return;
  try {
    const data = await api(`/users/${encodeURIComponent(username)}/programs/${programId}/full`);
    const modalFn =
      typeof renderPublicProgramModal === "function"
        ? renderPublicProgramModal
        : typeof window !== "undefined" && typeof window.renderPublicProgramModal === "function"
        ? window.renderPublicProgramModal
        : null;
    if (!modalFn) {
      // fallback inline modal if helper saknas
      renderPublicProgramModalInline(data, username);
    } else {
      modalFn(data, username);
    }
  } catch (err) {
    alert("Kunde inte hämta programmet: " + err.message);
  }

  function renderPublicProgramModalInline(payload, ownerUsername) {
    if (!payload) return;
    const { program, templates } = payload;
    const tplHtml =
      templates && templates.length
        ? templates
            .map((t) => {
              const rows = (t.exercises || [])
                .map((r, idx) => {
                  const row = r.row || r;
                  const ex = r.exercise || {};
                  return `
                    <div class="meta">
                      ${idx + 1}. ${ex.name || "Övning"} • Set ${row.planned_sets || "-"} • Reps ${row.reps || "-"} • Vikt ${row.planned_weight || "-"}
                    </div>
                  `;
                })
                .join("");
              return `
                <div class="list-item column">
                  <div class="title">${t.template?.name || t.name}</div>
                  ${rows || '<div class="muted">Inga övningar.</div>'}
                </div>
              `;
            })
            .join("")
        : '<div class="muted">Inga passmallar i programmet.</div>';

    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${program?.name || "Program"}</h3>
          <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
        </div>
        <div class="muted" style="margin-bottom:12px;">${program?.description || ""}</div>
        <div class="muted small" style="margin-bottom:12px;">Publicerat av ${ownerUsername || "användare"}</div>
        <div class="stack" style="max-height:50vh;overflow:auto;">
          ${tplHtml}
        </div>
        <div class="row space modal-actions">
          <button type="button" class="btn ghost" data-action="copy-public-program" data-id="${program?.id || ""}">Kopiera till mig</button>
          <button type="button" class="btn primary" data-modal-close>Stäng</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
        closeModal();
      }
      if (e.target?.dataset?.action === "copy-public-program") {
        copyPublicProgram(e.target.dataset.id);
        closeModal();
      }
    });
    document.body.appendChild(overlay);
    currentModal = overlay;
  }
}

async function copyPublicProgram(programId) {
  if (!programId) return;
  try {
    await api(`/programs/${programId}/copy`, { method: "POST" });
    await loadData();
    if (state.viewUser) {
      await viewPublicUser(state.viewUser);
    }
    alert("Program kopierat till din profil.");
  } catch (err) {
    alert("Kunde inte kopiera programmet: " + err.message);
  }
}

async function toggleProgramPublic(id, isPublic) {
  try {
    await api(`/programs/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ is_public: isPublic }),
    });
    await loadData();
    if (state.viewUser && state.currentUser && state.viewUser === state.currentUser.username) {
      await viewPublicUser(state.viewUser);
    }
  } catch (err) {
    alert("Kunde inte uppdatera publicering: " + err.message);
  }
}

async function togglePbPublic(id, isPublic) {
  try {
    await api(`/pbs/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ is_public: isPublic }),
    });
    await loadData();
    if (state.viewUser && state.currentUser && state.viewUser === state.currentUser.username) {
      await viewPublicUser(state.viewUser);
    }
  } catch (err) {
    alert("Kunde inte uppdatera publicering: " + err.message);
  }
}

// Create/edit/delete
async function createExercise(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById("exName").value,
    muscle_group: document.getElementById("exMuscle").value,
    type: document.getElementById("exType").value,
    equipment: document.getElementById("exEquip").value,
    notes: document.getElementById("exNotes").value,
  };
  try {
    await api("/exercises", { method: "POST", body: JSON.stringify(payload) });
    e.target.reset();
    await loadData();
  } catch (err) {
    const duplicate = (err.message || "").toLowerCase().includes("already exists");
    const msg = duplicate ? "Övning finns redan i övningsbibliotek." : err.message;
    await infoDialog(msg, duplicate ? "Redan finns" : "Fel");
  }
}

async function createProgram(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById("prName").value,
    description: document.getElementById("prDesc").value,
  };
  await api("/programs", { method: "POST", body: JSON.stringify(payload) });
  e.target.reset();
  await loadData();
}

async function createTemplate(e) {
  if (e) e.preventDefault();
  const program_id = document.getElementById("tplProgram").value;
  const name = document.getElementById("tplName").value;
  if (!program_id || !name) {
    alert("Välj program och ange passnamn.");
    return;
  }
  await api("/templates", { method: "POST", body: JSON.stringify({ program_id, name }) });
  if (e?.target?.reset) e.target.reset();
  document.getElementById("tplName").value = "";
  await loadData();
}

async function addRowToTemplate(e) {
  if (e) e.preventDefault();
  const tplIdRaw = document.getElementById("rowTemplate").value;
  const tplId = tplIdRaw ? Number(tplIdRaw) : null;
  if (!tplId) {
    alert("Välj passmall först.");
    return;
  }
  const exerciseIdRaw = document.getElementById("rowExercise").value;
  const exercise_id = exerciseIdRaw ? Number(exerciseIdRaw) : null;
  if (!exercise_id || !Number.isFinite(exercise_id)) {
    alert("Välj en övning.");
    return;
  }
  const payload = {
    exercise_id,
    planned_sets: document.getElementById("rowSets").value,
    reps: document.getElementById("rowReps").value,
    planned_weight: document.getElementById("rowWeight").value,
    rpe: document.getElementById("rowRpe").value,
    rest: document.getElementById("rowRest").value,
    comment: document.getElementById("rowComment").value,
  };
  await api(`/templates/${tplId}/add-exercise`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (e?.target?.reset) e.target.reset();
  await loadData();
}

async function handleCreateTemplateClick() {
  await createTemplate(null);
}

async function handleAddRowClick() {
  await addRowToTemplate(null);
}

// add typeahead-like filter for rowExercise select via input event
document.addEventListener("DOMContentLoaded", () => {
  const rowExercise = document.getElementById("rowExercise");
  if (rowExercise) {
    rowExercise.addEventListener("input", () => {
      const term = rowExercise.value.toLowerCase();
      const options = rowExercise.querySelectorAll("option");
      options.forEach((opt) => {
        const match = opt.textContent.toLowerCase().includes(term) || !term;
        opt.style.display = match ? "block" : "none";
      });
    });
  }
});

async function deleteExercise(id) {
  const ok = await confirmDialog("Ta bort övning?");
  if (!ok) return;
  await api(`/exercises/${id}/delete`, { method: "POST" });
  await loadData();
}

async function editExercise(id) {
  const ex = state.exercises.find((e) => Number(e.id) === Number(id));
  if (!ex) return;
  openEditModal("exercise", ex);
}

async function deleteProgram(id) {
  const ok = await confirmDialog("Ta bort program och dess passmallar?");
  if (!ok) return;
  await api(`/programs/${id}/delete`, { method: "POST" });
  await loadData();
}

async function editProgram(id) {
  const pr = state.programs.find((p) => Number(p.id) === Number(id));
  if (!pr) return;
  openEditModal("program", pr);
}

async function deleteTemplate(id) {
  const ok = await confirmDialog("Ta bort passmall?");
  if (!ok) return;
  await api(`/templates/${id}/delete`, { method: "POST" });
  await loadData();
}

async function editTemplate(id) {
  const tpl = state.templates.find((t) => Number(t.id) === Number(id));
  if (!tpl) return;
  openEditModal("template", tpl);
}

async function deleteTemplateRow(tplId, rowId) {
  if (!tplId || !rowId) return;
  const ok = await confirmDialog("Ta bort övningen från passmallen?");
  if (!ok) return;
  await api(`/templates/${tplId}/remove-exercise`, {
    method: "POST",
    body: JSON.stringify({ row_id: rowId }),
  });
  await loadData();
}

async function editTemplateRow(tplId, rowId) {
  const tpl = state.templates.find((t) => Number(t.id) === Number(tplId));
  if (!tpl) return;
  const row = tpl.exercises.find((r) => Number(r.id) === Number(rowId));
  if (!row) return;
  const exerciseId = prompt("Byt övning? Ange övnings-ID (tomt behåll)", row.exercise_id) || row.exercise_id;
  if (!state.exercises.find((e) => e.id === exerciseId)) {
    alert("Övningen hittades inte. Kolla ID i övningslistan.");
    return;
  }
  const planned_sets = prompt("Set", row.planned_sets ?? "") ?? row.planned_sets;
  const reps = prompt("Reps", row.reps ?? "") ?? row.reps;
  const planned_weight = prompt("Vikt", row.planned_weight ?? "") ?? row.planned_weight;
  const rpe = prompt("RPE", row.rpe ?? "") ?? row.rpe;
  const rest = prompt("Vila", row.rest ?? "") ?? row.rest;
  const comment = prompt("Kommentar", row.comment ?? "") ?? row.comment;
  await api(`/templates/${tplId}/update-exercise`, {
    method: "POST",
    body: JSON.stringify({
      row_id: rowId,
      exercise_id: exerciseId,
      planned_sets,
      reps,
      planned_weight,
      rpe,
      rest,
      comment,
    }),
  });
  await loadData();
}

async function deleteSession(id) {
  if (!id) return;
  const ok = await confirmDialog("Ta bort loggat pass?");
  if (!ok) return;
  await api("/sessions/delete", {
    method: "POST",
    body: JSON.stringify({ session_id: id }),
  });
  await loadData();
}

// ---------- UI helpers ----------
function toggleStartButton() {
  const rawTplId = state.currentTemplateId || document.getElementById("templateSelect")?.value;
  const tplId = rawTplId ? Number(rawTplId) : null;
  const btn = document.getElementById("startSessionBtn");
  const hint = document.getElementById("startHint");
  if (btn) {
    const tpl = state.templates.find((t) => Number(t.id) === Number(tplId));
    const hasExercises = tpl && tpl.exercises && tpl.exercises.length > 0;
    const canStart = tplId && state.currentProgramId && !state.activeSession && hasExercises;
    btn.disabled = !canStart;
    btn.style.display = !state.activeSession ? "inline-flex" : "none";
    if (hint) {
      if (!tpl) hint.textContent = "Välj en passmall för att kunna starta.";
      else if (!hasExercises) hint.textContent = "Den valda passmallen saknar övningar. Lägg till i fliken Passmallar.";
      else if (state.activeSession) hint.textContent = "Ett pass är redan igång.";
      else hint.textContent = "Klar att starta.";
    }
  }
}

function disableStartFinish() {
  const startBtn = document.getElementById("startSessionBtn");
  const finishBtn = document.getElementById("finishSessionBtn");
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.style.display = "inline-flex";
  }
  if (finishBtn) finishBtn.style.display = "none";
}

function enableFinish() {
  const finishBtn = document.getElementById("finishSessionBtn");
  if (finishBtn) finishBtn.style.display = "inline-flex";
}

function hideSelectorAreaDuringSession() {
  const programSel = document.getElementById("programSelect");
  const templateSel = document.getElementById("templateSelect");
  const startBtn = document.getElementById("startSessionBtn");
  if (programSel) programSel.style.display = "none";
  if (templateSel) templateSel.style.display = "none";
  if (startBtn) startBtn.style.display = "none";
}

function showSelectorArea(show = true) {
  const programSel = document.getElementById("programSelect");
  const templateSel = document.getElementById("templateSelect");
  const startBtn = document.getElementById("startSessionBtn");
  if (show) {
    if (programSel) programSel.style.display = "inline-block";
    if (templateSel) templateSel.style.display = "inline-block";
    if (startBtn) startBtn.style.display = "inline-flex";
    toggleStartButton();
  } else {
    if (programSel) programSel.style.display = "none";
    if (templateSel) templateSel.style.display = "none";
    if (startBtn) startBtn.style.display = "none";
  }
}

function enterSessionLockUI() {
  document.body.classList.add("session-locked");
  switchTab("tab-pass");
}

function exitSessionLockUI() {
  document.body.classList.remove("session-locked");
}

function handleActionClick(e) {
  const btn = e.target.closest(".action-btn");
  if (!btn) return;
  const { action, id, tplId, rowId, username } = btn.dataset;
  const intId = id ? Number(id) : id;
  const intTplId = tplId ? Number(tplId) : tplId;
  const intRowId = rowId ? Number(rowId) : rowId;
  if (action === "edit-exercise") return editExercise(intId);
  if (action === "delete-exercise") return deleteExercise(intId);
  if (action === "edit-program") return editProgram(intId);
  if (action === "delete-program") return deleteProgram(intId);
  if (action === "edit-template") return editTemplate(intId);
  if (action === "delete-template") return deleteTemplate(intId);
  if (action === "edit-template-row") return editTemplateRow(intTplId, intRowId);
  if (action === "delete-template-row") return deleteTemplateRow(intTplId, intRowId);
  if (action === "delete-session") return deleteSession(intId);
  if (action === "toggle-session-details") return toggleSessionDetails(intId);
  if (action === "accept-request") return acceptFriendRequest(id);
  if (action === "reject-request") return rejectFriendRequest(id);
  if (action === "view-public") return viewPublicUser(username);
  if (action === "view-public-program") return viewPublicProgram(intId, username || state.viewUser);
  if (action === "copy-public-program") return copyPublicProgram(intId);
}

function handleChangeAction(e) {
  const target = e.target;
  if (!target?.dataset) return;
  const { action, id } = target.dataset;
  if (action === "toggle-program-public") return toggleProgramPublic(id, target.checked);
  if (action === "toggle-pb-public") return togglePbPublic(id, target.checked);
}

function setTemplatesMode(mode) {
  state.templatesMode = mode;
  const passWrap = document.getElementById("passFormWrap");
  const exWrap = document.getElementById("exerciseFormWrap");
  const passBtn = document.getElementById("templateModePass");
  const exBtn = document.getElementById("templateModeExercise");
  if (passWrap) passWrap.style.display = mode === "pass" ? "block" : "none";
  if (exWrap) exWrap.style.display = mode === "exercise" ? "block" : "none";
  if (passBtn) passBtn.classList.toggle("active", mode === "pass");
  if (exBtn) exBtn.classList.toggle("active", mode === "exercise");
}

function applyPbFilters() {
  const exSel = document.getElementById("pbExerciseFilter");
  const repsInput = document.getElementById("pbRepsFilter");
  state.pbFilterExercise = exSel ? exSel.value : "";
  state.pbFilterReps = repsInput ? Number(repsInput.value || 0) : 0;
  renderPBs();
}

function clearPbFilters() {
  state.pbFilterExercise = "";
  state.pbFilterReps = 0;
  const exSel = document.getElementById("pbExerciseFilter");
  const repsInput = document.getElementById("pbRepsFilter");
  if (exSel) exSel.value = "";
  if (repsInput) repsInput.value = "";
  renderPBs();
}

function hideLogForm() {
  const form = document.getElementById("logForm");
  if (form) form.style.display = "none";
  const nextBtn = document.getElementById("nextExerciseBtn");
  if (nextBtn) nextBtn.style.display = "none";
  clearRestTimer();
}

function showLogForm() {
  const form = document.getElementById("logForm");
  if (form) form.style.display = "block";
  const nextBtn = document.getElementById("nextExerciseBtn");
  if (nextBtn) nextBtn.style.display = state.sessionLocked ? "none" : "inline-flex";
  updateRestUI();
}

function setSelectorsToSession(tpl) {
  const programSel = document.getElementById("programSelect");
  const templateSel = document.getElementById("templateSelect");
  if (programSel) programSel.value = tpl.program_id;
  if (templateSel) templateSel.value = tpl.id;
  state.currentTemplateId = tpl.id;
  document.getElementById("programName").textContent = tpl.program_name || "–";
  renderTemplateExercises(tpl);
  toggleStartButton();
}

function handleLogExerciseChange() {
  const selectEl = document.getElementById("logExercise");
  const exerciseId = selectEl ? Number(selectEl.value) : null;
  if (!exerciseId) return;
  const tpl = getCurrentTemplateForLogging();
  const row = getTemplateRowForExercise(exerciseId, tpl);
  const setNum = state.guide?.setNumber || Number(document.getElementById("logSet").value || 1);
  prefillLogFields(row, setNum);
}

// ---------- Events ----------
function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll("[data-info-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.infoToggle);
      if (target) target.classList.toggle("show");
    });
  });
  const startSessionBtn = document.getElementById("startSessionBtn");
  if (startSessionBtn) startSessionBtn.addEventListener("click", startSession);
  const finishSessionBtn = document.getElementById("finishSessionBtn");
  if (finishSessionBtn) finishSessionBtn.addEventListener("click", finishSession);
  const cancelSessionBtn = document.getElementById("cancelSessionBtn");
  if (cancelSessionBtn) cancelSessionBtn.addEventListener("click", cancelSession);
  const clearActiveBtn = document.getElementById("clearActiveBtn");
  if (clearActiveBtn) clearActiveBtn.addEventListener("click", clearActiveSessions);
  const logForm = document.getElementById("logForm");
  if (logForm) logForm.addEventListener("submit", logSet);
  const logExerciseSel = document.getElementById("logExercise");
  if (logExerciseSel) logExerciseSel.addEventListener("change", handleLogExerciseChange);
  const restSkipBtn = document.getElementById("restSkipBtn");
  if (restSkipBtn) restSkipBtn.addEventListener("click", skipRestTimer);
  const nextExerciseBtn = document.getElementById("nextExerciseBtn");
  if (nextExerciseBtn)
    nextExerciseBtn.addEventListener("click", () => {
      skipToNextExercise();
      applyGuideToForm();
    });
  const newExerciseForm = document.getElementById("newExerciseForm");
  if (newExerciseForm) newExerciseForm.addEventListener("submit", createExercise);
  const newProgramForm = document.getElementById("newProgramForm");
  if (newProgramForm) newProgramForm.addEventListener("submit", createProgram);
  const createTplBtn = document.getElementById("createTemplateBtn");
  if (createTplBtn) createTplBtn.addEventListener("click", handleCreateTemplateClick);
  const addRowBtn = document.getElementById("addRowBtn");
  if (addRowBtn) addRowBtn.addEventListener("click", handleAddRowClick);
  const modePassBtn = document.getElementById("templateModePass");
  const modeExerciseBtn = document.getElementById("templateModeExercise");
  if (modePassBtn) modePassBtn.addEventListener("click", () => setTemplatesMode("pass"));
  if (modeExerciseBtn) modeExerciseBtn.addEventListener("click", () => setTemplatesMode("exercise"));
  const rowProgram = document.getElementById("rowProgram");
  if (rowProgram) {
    rowProgram.addEventListener("change", renderProgramSelects);
  }
  const pbFilterBtn = document.getElementById("pbFilterBtn");
  const pbClearBtn = document.getElementById("pbClearBtn");
  if (pbFilterBtn) pbFilterBtn.addEventListener("click", applyPbFilters);
  if (pbClearBtn) pbClearBtn.addEventListener("click", clearPbFilters);
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", () => logout());
  const sendRequestBtn = document.getElementById("sendFriendRequestBtn");
  if (sendRequestBtn) sendRequestBtn.addEventListener("click", sendFriendRequest);
  const viewUserBtn = document.getElementById("viewUserBtn");
  if (viewUserBtn) viewUserBtn.addEventListener("click", () => viewPublicUser());
  const loginBtn = document.getElementById("loginBtn");
  const registerBtn = document.getElementById("registerBtn");
  if (loginBtn) loginBtn.addEventListener("click", () => {
    setAuthMode("login");
    loginUser();
  });
  if (registerBtn) registerBtn.addEventListener("click", () => {
    if (authMode !== "register") {
      setAuthMode("register");
      return;
    }
    registerUser();
  });
  document.addEventListener("click", handleActionClick);
  document.addEventListener("change", handleChangeAction);
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const panel = document.getElementById(tabId);
  if (btn && panel) {
    btn.classList.add("active");
    panel.classList.add("active");
  }
}

function closeModal() {
  if (currentModal) {
    currentModal.remove();
    currentModal = null;
  }
}

async function confirmDialog(message = "Är du säker?") {
  return new Promise((resolve) => {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Bekräfta</h3>
          <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
        </div>
        <div class="muted" style="margin: 6px 0 14px;">${message}</div>
        <div class="row space modal-actions">
          <button type="button" class="btn ghost" data-action="cancel">Avbryt</button>
          <button type="button" class="btn danger" data-action="confirm">Ta bort</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
        closeModal();
        resolve(false);
      }
    });
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const okBtn = overlay.querySelector('[data-action="confirm"]');
    cancelBtn.addEventListener("click", () => {
      closeModal();
      resolve(false);
    });
    okBtn.addEventListener("click", () => {
      closeModal();
      resolve(true);
    });
    document.body.appendChild(overlay);
    currentModal = overlay;
  });
}

async function infoDialog(message = "Information", title = "Info") {
  return new Promise((resolve) => {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${title}</h3>
          <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
        </div>
        <div class="muted" style="margin: 6px 0 14px;">${message}</div>
        <div class="row space modal-actions">
          <div></div>
          <button type="button" class="btn primary" data-action="confirm">OK</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
        closeModal();
        resolve(true);
      }
    });
    const okBtn = overlay.querySelector('[data-action="confirm"]');
    okBtn.addEventListener("click", () => {
      closeModal();
      resolve(true);
    });
    document.body.appendChild(overlay);
    currentModal = overlay;
  });
}

async function choiceDialog(message = "Vad vill du göra?", primary = "Vidare", secondary = "Extraset") {
  return new Promise((resolve) => {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>Fortsätt</h3>
          <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
        </div>
        <div class="muted" style="margin: 6px 0 14px;">${message}</div>
        <div class="row space modal-actions">
          <button type="button" class="btn ghost" data-action="secondary">${secondary}</button>
          <button type="button" class="btn primary" data-action="primary">${primary}</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
        closeModal();
        resolve(null);
      }
    });
    const secondaryBtn = overlay.querySelector('[data-action="secondary"]');
    const primaryBtn = overlay.querySelector('[data-action="primary"]');
    secondaryBtn.addEventListener("click", () => {
      closeModal();
      resolve("secondary");
    });
    primaryBtn.addEventListener("click", () => {
      closeModal();
      resolve("primary");
    });
    document.body.appendChild(overlay);
    currentModal = overlay;
  });
}

async function showCompletionModal() {
  return new Promise((resolve) => {
    closeModal();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal success-modal">
        <div class="modal-header">
          <h3>Pass klart!</h3>
          <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
        </div>
        <div class="muted" style="margin: 6px 0 14px;">Grattis! Du är klar med passet, bra jobbat. Passet avslutas nu.</div>
        <div class="row space modal-actions">
          <button type="button" class="btn primary" data-action="ok">OK</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
        closeModal();
        resolve();
      }
    });
    const okBtn = overlay.querySelector('[data-action="ok"]');
    if (okBtn) {
      okBtn.addEventListener("click", () => {
        closeModal();
        resolve();
      });
    }
    document.body.appendChild(overlay);
    currentModal = overlay;
  });
}

function openEditModal(kind, item) {
  if (!item) return;
  closeModal();
  const titles = {
    exercise: "Redigera övning",
    program: "Redigera program",
    template: "Redigera pass",
  };
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  let fields = "";
  if (kind === "exercise") {
    fields = `
      <label class="label">Namn</label>
      <input name="name" value="${item.name || ""}" required />
      <label class="label">Muskelgrupp</label>
      <input name="muscle_group" value="${item.muscle_group || ""}" />
      <label class="label">Typ</label>
      <input name="type" value="${item.type || ""}" />
      <label class="label">Utrustning</label>
      <input name="equipment" value="${item.equipment || ""}" />
      <label class="label">Noteringar</label>
      <input name="notes" value="${item.notes || ""}" />
    `;
  } else if (kind === "program") {
    fields = `
      <label class="label">Namn</label>
      <input name="name" value="${item.name || ""}" required />
      <label class="label">Beskrivning</label>
      <input name="description" value="${item.description || ""}" />
      <label class="label">Status (t.ex. active/archived)</label>
      <input name="status" value="${item.status || "active"}" />
      <label class="label">Version</label>
      <input name="version" type="number" value="${item.version || 1}" />
    `;
  } else if (kind === "template") {
    fields = `
      <label class="label">Namn</label>
      <input name="name" value="${item.name || ""}" required />
    `;
  }
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${titles[kind] || "Redigera"}</h3>
        <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
      </div>
      <form class="stack modal-form">
        ${fields}
        <div class="row space">
          <div></div>
          <button type="submit" class="btn primary">Spara</button>
        </div>
      </form>
    </div>
  `;
  const form = overlay.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      if (kind === "exercise") {
        await api(`/exercises/${item.id}`, {
          method: "POST",
          body: JSON.stringify({
            name: data.get("name"),
            muscle_group: data.get("muscle_group"),
            type: data.get("type"),
            equipment: data.get("equipment"),
            notes: data.get("notes"),
          }),
        });
      } else if (kind === "program") {
        await api(`/programs/${item.id}`, {
          method: "POST",
          body: JSON.stringify({
            name: data.get("name"),
            description: data.get("description"),
            status: data.get("status"),
            version: Number(data.get("version") || item.version || 1),
          }),
        });
      } else if (kind === "template") {
        await api(`/templates/${item.id}`, {
          method: "POST",
          body: JSON.stringify({
            name: data.get("name"),
          }),
  });
}

function renderPublicProgramModal(data, ownerUsername) {
  if (!data) return;
  closeModal();
  const { program, templates } = data;
  const tplHtml =
    templates && templates.length
      ? templates
          .map((t) => {
            const rows = (t.exercises || [])
              .map((r, idx) => {
                const row = r.row || r;
                const ex = r.exercise || {};
                return `
                  <div class="meta">
                    ${idx + 1}. ${ex.name || "Övning"} • Set ${row.planned_sets || "-"} • Reps ${
                  row.reps || "-"
                } • Vikt ${row.planned_weight || "-"}
                  </div>
                `;
              })
              .join("");
            return `
              <div class="list-item column">
                <div class="title">${t.template?.name || t.name}</div>
                ${rows || '<div class="muted">Inga övningar.</div>'}
              </div>
            `;
          })
          .join("")
      : '<div class="muted">Inga passmallar i programmet.</div>';

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h3>${program?.name || "Program"}</h3>
        <button type="button" class="btn ghost small" data-modal-close>Stäng</button>
      </div>
      <div class="muted" style="margin-bottom:12px;">${program?.description || ""}</div>
      <div class="muted small" style="margin-bottom:12px;">Publicerat av ${ownerUsername || "användare"}</div>
      <div class="stack" style="max-height:50vh;overflow:auto;">
        ${tplHtml}
      </div>
      <div class="row space modal-actions">
        <button type="button" class="btn ghost" data-action="copy-public-program" data-id="${program?.id || ""}">Kopiera till mig</button>
        <button type="button" class="btn primary" data-modal-close>Stäng</button>
      </div>
    </div>
  `;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
      closeModal();
    }
    if (e.target?.dataset?.action === "copy-public-program") {
      copyPublicProgram(e.target.dataset.id);
      closeModal();
    }
  });
  document.body.appendChild(overlay);
  currentModal = overlay;
}

// make available globally to avoid reference issues from UI triggers
if (typeof window !== "undefined") {
  window.renderPublicProgramModal = renderPublicProgramModal;
}
      closeModal();
      await loadData();
    } catch (err) {
      alert("Kunde inte spara: " + err.message);
    }
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.dataset.modalClose !== undefined) {
      closeModal();
    }
  });
  document.body.appendChild(overlay);
  currentModal = overlay;
  const firstInput = overlay.querySelector("input, select, textarea");
  if (firstInput) firstInput.focus();
}

document.addEventListener("DOMContentLoaded", async () => {
  disableZoom();
  bindEvents();
  setTemplatesMode(state.templatesMode || "pass");
  setAuthMode("login");
  updateRestUI();
  showOverlay("Startar servern / Laddar…");
  startApiReadyPolling(true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      persistActiveSessionState(true);
    } else if (document.visibilityState === "visible") {
      const overlay = document.getElementById("appOverlay");
      const isOverlayVisible = overlay && overlay.classList.contains("visible");
      if (isOverlayVisible || !apiReady) {
        startApiReadyPolling(true);
      }
    }
  });
  window.addEventListener("online", () => startApiReadyPolling(true));
  window.addEventListener("pagehide", () => persistActiveSessionState(true));
  window.addEventListener("pageshow", () => {
    if (restoreActiveSessionFromStorage(true)) {
      renderActiveSession();
      applyGuideToForm();
    }
  });
  try {
    await loadData({ markRestored: true });
  } catch (err) {
    alert("Kunde inte ladda data: " + err.message);
  }
});

function renderAuthStatus(isAuthed) {
  const status = document.getElementById("authStatus");
  if (status) {
    status.textContent = isAuthed ? "Inloggad" : "Inte inloggad";
    status.style.color = isAuthed ? "#6cf0c2" : "";
  }
  const sessionUser = document.getElementById("sessionUser");
  const logoutBtn = document.getElementById("logoutBtn");
  const sessionChip = document.getElementById("sessionChip");
  if (sessionUser) {
    const user = state.currentUser;
    sessionUser.textContent = isAuthed && user ? `${user.username} (${user.display_name || user.email || ""})` : "Inte inloggad";
  }
  if (logoutBtn) logoutBtn.style.display = isAuthed ? "inline-flex" : "none";
  if (sessionChip) sessionChip.style.opacity = isAuthed ? 1 : 0.6;
  if (!isAuthed) setMainVisibility(false);
}

function setAuthMode(mode) {
  authMode = mode;
  const emailField = document.getElementById("authEmailWrap");
  const nameField = document.getElementById("authDisplayWrap");
  if (emailField) emailField.style.display = mode === "register" ? "grid" : "none";
  if (nameField) nameField.style.display = mode === "register" ? "grid" : "none";
  const registerBtn = document.getElementById("registerBtn");
  if (registerBtn) registerBtn.textContent = mode === "register" ? "Registrera" : "Skapa konto";
}

function setStatusIndicator(state, tooltip = "") {
  const el = document.getElementById("apiStatus");
  if (!el) return;
  el.classList.remove("ok", "fail", "unknown");
  el.classList.add(state);
  el.textContent = state === "ok" ? "✓" : state === "fail" ? "✕" : "?";
  el.title = tooltip;
}

async function loginUser() {
  const username = document.getElementById("authUsername").value;
  const password = document.getElementById("authPassword").value;
  if (!username || !password) {
    alert("Fyll i användarnamn och lösenord.");
    return;
  }
  try {
    await waitForApiReady();
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });
    if (!res.ok) {
      const err = new Error((await res.text()) || res.statusText);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    authToken = `Bearer ${data.access_token}`;
    localStorage.setItem("authToken", authToken);
    renderAuthStatus(true);
    await loadData({ markRestored: true });
  } catch (err) {
    if (!err || err.status >= 500 || err.status === undefined) {
      apiReady = false;
      showOverlay("Startar servern / Laddar…");
      waitForApiReady(true).catch(() => {});
    }
    alert("Login misslyckades: " + err.message);
  }
}

async function registerUser() {
  const email = document.getElementById("authEmail").value;
  const password = document.getElementById("authPassword").value;
  const name = document.getElementById("authDisplayName").value;
  const username = document.getElementById("authUsername").value;
  if (!email || !password || !name || !username) {
    alert("Fyll i e-post, lösenord, namn och användarnamn.");
    return;
  }
  try {
    await waitForApiReady();
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, display_name: name, username }),
    });
    if (!res.ok) {
      const err = new Error((await res.text()) || res.statusText);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    authToken = `Bearer ${data.access_token}`;
    localStorage.setItem("authToken", authToken);
    renderAuthStatus(true);
    await loadData({ markRestored: true });
  } catch (err) {
    if (!err || err.status >= 500 || err.status === undefined) {
      apiReady = false;
      showOverlay("Startar servern / Laddar…");
      waitForApiReady(true).catch(() => {});
    }
    alert("Registrering misslyckades: " + err.message);
  }
}

function setMainVisibility(show) {
  const main = document.getElementById("appMain");
  const authCard = document.getElementById("authCard");
  if (main) main.style.display = show ? "block" : "none";
  if (authCard) authCard.style.display = show ? "none" : "block";
  if (!show) {
    state.activeSession = null;
    state.viewUser = null;
    state.viewUserPrograms = [];
    state.viewUserPBs = [];
    renderPublicView();
  }
}
