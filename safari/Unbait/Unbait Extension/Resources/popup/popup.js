// iOS detection: hide third-party donation links on iOS to comply with
// App Store Guideline 3.1.1 (donations must use IAP or be removed).
if (/iP(hone|ad|od)/i.test(navigator.userAgent)) {
  document.body.classList.add("is-ios");
}

const apiKeyInput = document.getElementById("api-key");
const btnToggleKey = document.getElementById("btn-toggle-key");
const btnSaveKey = document.getElementById("btn-save-key");
const keyStatus = document.getElementById("key-status");
const btnDeclickbait = document.getElementById("btn-declickbait");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const statFound = document.getElementById("stat-found");
const statReplaced = document.getElementById("stat-replaced");
const providerSelect = document.getElementById("provider");
const providerPill = document.getElementById("provider-pill");

const PROVIDER_LABELS = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT)",
  gemini: "Google (Gemini)",
};

const PROVIDER_PLACEHOLDERS = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  gemini: "AIza... or AQ...",
};

const YT_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com"];

// Always On / mode elements
const siteModeToggle = document.getElementById("site-mode-toggle");
const siteModeBtns = siteModeToggle.querySelectorAll(".site-mode-btn");
const siteModeHint = document.getElementById("site-mode-hint");
const currentSiteEl = document.getElementById("current-site");
const btnManageSites = document.getElementById("btn-manage-sites");
const sitesPanel = document.getElementById("sites-panel");
const sitesList = document.getElementById("sites-list");
const addSiteInput = document.getElementById("add-site-input");
const btnAddSite = document.getElementById("btn-add-site");
const alwaysGistToggle = document.getElementById("always-gist-toggle");
const excludedSection = document.getElementById("excluded-section");
const excludedList = document.getElementById("excluded-list");
const addExcludedInput = document.getElementById("add-excluded-input");
const btnAddExcluded = document.getElementById("btn-add-excluded");

let _currentHostname = null;

// ---------------------------------------------------------------------------
// Helpers — site mode + storage
// ---------------------------------------------------------------------------

async function getAutoSites() {
  const data = await chrome.storage.local.get("autoSites");
  return data.autoSites || [];
}

async function saveAutoSites(sites) {
  await chrome.storage.local.set({ autoSites: sites });
}

async function getSiteMode(hostname) {
  if (!hostname) return "off";
  const sites = await getAutoSites();
  const match = sites.find((s) => s.host === hostname || (YT_HOSTS.includes(hostname) && YT_HOSTS.includes(s.host)));
  return match ? match.mode : "off";
}

async function getAlwaysGistState() {
  const data = await chrome.storage.local.get(["alwaysGist", "gistExcludedSites"]);
  return {
    enabled: !!data.alwaysGist,
    excluded: data.gistExcludedSites || [],
  };
}

function originsForHostname(hostname) {
  return [`https://${hostname}/*`, `http://${hostname}/*`];
}

async function requestSitePermission(hostname) {
  try {
    const origins = originsForHostname(hostname);
    let hasAllUrls = false;
    try { hasAllUrls = await chrome.permissions.contains({ origins: ["<all_urls>"] }); } catch {}
    if (!hasAllUrls) origins.push("<all_urls>");
    return await chrome.permissions.request({ origins });
  } catch {
    return true;
  }
}

async function removeSitePermission(hostname) {
  try {
    return await chrome.permissions.remove({ origins: originsForHostname(hostname) });
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Provider UI
// ---------------------------------------------------------------------------

function updateProviderUI(provider) {
  apiKeyInput.placeholder = PROVIDER_PLACEHOLDERS[provider] || "Enter API key";
  document.getElementById("info-anthropic").classList.toggle("hidden", provider !== "anthropic");
  document.getElementById("info-openai").classList.toggle("hidden", provider !== "openai");
  document.getElementById("info-gemini").classList.toggle("hidden", provider !== "gemini");
}

providerSelect.addEventListener("change", () => {
  const provider = providerSelect.value;
  updateProviderUI(provider);
  chrome.storage.local.set({ provider });
  chrome.storage.local.get(`apiKey_${provider}`, (data) => {
    const key = data[`apiKey_${provider}`] || "";
    apiKeyInput.value = key;
    btnDeclickbait.disabled = !key;
    btnDeleteKey.style.display = key ? "flex" : "none";
    keyStatus.textContent = key ? "Key saved" : "";
    keyStatus.className = key ? "status-msg success" : "status-msg";
  });
});

// Info / About panel toggles
const btnInfo = document.getElementById("btn-info");
const infoPanel = document.getElementById("info-panel");
btnInfo.addEventListener("click", () => {
  const isHidden = infoPanel.classList.toggle("hidden");
  btnInfo.classList.toggle("active", !isHidden);
});

const btnAbout = document.getElementById("btn-about");
const aboutPanel = document.getElementById("about-panel");
btnAbout.addEventListener("click", () => {
  const isHidden = aboutPanel.classList.toggle("hidden");
  btnAbout.textContent = isHidden ? "About Unbait" : "Close";
  if (!isHidden) {
    requestAnimationFrame(() => {
      document.body.style.height = document.body.scrollHeight + "px";
    });
  } else {
    document.body.style.height = "";
  }
});

// Footer buttons
const btnBeer = document.getElementById("btn-beer");
if (btnBeer) {
  btnBeer.addEventListener("mouseenter", () => { btnBeer.style.opacity = "0.75"; });
  btnBeer.addEventListener("mouseleave", () => { btnBeer.style.opacity = "0.35"; });
}

const btnShare = document.getElementById("btn-share");
const shareTooltip = document.getElementById("share-tooltip");
if (btnShare) {
  btnShare.addEventListener("click", async () => {
    const msg = "Unbait - See what articles are really about. De-clickbait headlines and get AI-powered summaries with a single click. Try it: https://unbait.link";
    try {
      await navigator.clipboard.writeText(msg);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = msg;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (shareTooltip) {
      shareTooltip.textContent = "Copied! Now share it";
      shareTooltip.classList.add("show");
      setTimeout(() => {
        shareTooltip.textContent = "Share";
        shareTooltip.classList.remove("show");
      }, 2000);
    }
  });
}

// ---------------------------------------------------------------------------
// Stats + general settings panels (header icons)
// ---------------------------------------------------------------------------

const btnStatsPanel = document.getElementById("btn-stats");
const statsPanel = document.getElementById("stats-panel");
const btnSettings = document.getElementById("btn-settings");
const settingsPanel = document.getElementById("settings-panel");

btnStatsPanel.addEventListener("click", () => {
  const wasHidden = statsPanel.classList.toggle("hidden");
  btnStatsPanel.classList.toggle("active", !wasHidden);
  if (!wasHidden) return;
  settingsPanel.classList.add("hidden");
  btnSettings.classList.remove("active");
});

btnSettings.addEventListener("click", () => {
  const wasHidden = settingsPanel.classList.toggle("hidden");
  btnSettings.classList.toggle("active", !wasHidden);
  if (!wasHidden) return;
  statsPanel.classList.add("hidden");
  btnStatsPanel.classList.remove("active");
});

chrome.storage.local.get("unbait_stats", (data) => {
  const stats = data.unbait_stats || {};
  document.getElementById("lifetime-unbaited").textContent = (stats.totalUnbaited || 0).toLocaleString();
  document.getElementById("lifetime-gists").textContent = (stats.totalGists || 0).toLocaleString();
  if (stats.firstUsed) {
    const d = new Date(stats.firstUsed);
    document.getElementById("lifetime-since").textContent = d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
});

// ---------------------------------------------------------------------------
// Settings panel: language, gist click mode, autoclose, YouTube
// ---------------------------------------------------------------------------

const langSelect = document.getElementById("summary-language");
langSelect.addEventListener("change", () => {
  chrome.storage.local.set({ summaryLanguage: langSelect.value });
});

const clickModeSummary = document.getElementById("click-mode-summary");
const clickModeTitle = document.getElementById("click-mode-title");
const clickModeHint = document.getElementById("click-mode-hint");

function updateClickModeUI(mode) {
  const isSummary = mode !== "title";
  clickModeSummary.classList.toggle("active", isSummary);
  clickModeTitle.classList.toggle("active", !isSummary);
  clickModeHint.textContent = isSummary ? "Double click toggles title" : "Double click shows summary";
}

clickModeSummary.addEventListener("click", () => {
  chrome.storage.local.set({ gistClickMode: "summary" });
  updateClickModeUI("summary");
});

clickModeTitle.addEventListener("click", () => {
  chrome.storage.local.set({ gistClickMode: "title" });
  updateClickModeUI("title");
});

const gistAutocloseToggle = document.getElementById("gist-autoclose-toggle");
gistAutocloseToggle.addEventListener("change", () => {
  chrome.storage.local.set({ gistAutoClose: gistAutocloseToggle.checked });
});

// YouTube subsection — depth slider + thumbnails + gist depth
const SLIDER_LABELS = {
  1: "Fast, minimal context",
  2: "Recommended balance",
  3: "More context, slower",
  4: "Maximum precision — higher API cost",
};

function updateYTSliderLabel(value) {
  const label = document.getElementById("yt-slider-label");
  if (!label) return;
  label.textContent = SLIDER_LABELS[value] || "";
}

document.getElementById("yt-transcript-slider").addEventListener("input", (e) => {
  const val = parseInt(e.target.value, 10);
  updateYTSliderLabel(val);
  chrome.storage.local.set({ ytTranscriptDepth: val });
});

document.getElementById("yt-thumbnails-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ youtubeThumbnails: e.target.checked });
});

// YouTube in-video sponsor skip
function updateSponsorUI(enabled) {
  document.getElementById("yt-sponsor-auto-row").style.display = enabled ? "" : "none";
  document.getElementById("yt-sponsor-hint").style.display = enabled ? "" : "none";
}

document.getElementById("yt-sponsor-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ ytSponsorSkip: e.target.checked });
  updateSponsorUI(e.target.checked);
});

document.getElementById("yt-sponsor-auto-toggle").addEventListener("change", (e) => {
  chrome.storage.local.set({ ytSponsorAuto: e.target.checked });
});

// YouTube gist depth slider
const GIST_DEPTH_STEPS = [15, 30, 50, 70, 85, 100];
const GIST_DEPTH_LABELS = [
  "First 15% — very fast",
  "First 30% — quick scan",
  "First half — balanced",
  "First 70% — thorough",
  "First 85% — near complete",
  "Full transcript — most accurate",
];

const gistSlider = document.getElementById("gist-transcript-slider");
const gistDepthValue = document.getElementById("gist-depth-value");
const gistSliderLabel = document.getElementById("gist-slider-label");

function updateGistSlider(idx) {
  gistDepthValue.textContent = GIST_DEPTH_STEPS[idx] + "%";
  gistSliderLabel.textContent = GIST_DEPTH_LABELS[idx];
}

gistSlider.addEventListener("input", () => {
  const idx = parseInt(gistSlider.value, 10);
  updateGistSlider(idx);
  chrome.storage.local.set({ ytGistDepth: GIST_DEPTH_STEPS[idx] });
});

async function refreshYouTubeSettingsVisibility() {
  const sites = await getAutoSites();
  const ytEnabled = sites.some((s) => YT_HOSTS.includes(s.host) && s.mode !== "off");
  document.getElementById("youtube-settings").classList.toggle("hidden", !ytEnabled);
}

// Load settings panel state
chrome.storage.local.get([
  "summaryLanguage", "gistClickMode", "gistAutoClose",
  "ytTranscriptDepth", "youtubeThumbnails", "ytGistDepth",
  "ytSponsorSkip", "ytSponsorAuto",
], (data) => {
  langSelect.value = data.summaryLanguage || "auto";
  updateClickModeUI(data.gistClickMode || "summary");
  gistAutocloseToggle.checked = data.gistAutoClose !== false;

  const ytDepth = data.ytTranscriptDepth || 2;
  document.getElementById("yt-transcript-slider").value = ytDepth;
  updateYTSliderLabel(ytDepth);
  document.getElementById("yt-thumbnails-toggle").checked = !!data.youtubeThumbnails;

  const sponsorOn = data.ytSponsorSkip !== false; // default on
  document.getElementById("yt-sponsor-toggle").checked = sponsorOn;
  document.getElementById("yt-sponsor-auto-toggle").checked = !!data.ytSponsorAuto;
  updateSponsorUI(sponsorOn);

  const savedGistDepth = data.ytGistDepth || 100;
  const idx = GIST_DEPTH_STEPS.indexOf(savedGistDepth);
  gistSlider.value = idx >= 0 ? idx : 2;
  updateGistSlider(parseInt(gistSlider.value, 10));

  refreshYouTubeSettingsVisibility();
});

// ---------------------------------------------------------------------------
// Site mode toggle (Off / Gist / Full) for current site
// ---------------------------------------------------------------------------

const SITE_MODE_HINTS = {
  off: "Unbait stays off here. Use the button above for one-time scans.",
  gist: "G icons appear automatically. Click one for an AI summary.",
  full: "Titles auto-rewrite when you visit this site.",
};

function paintSiteMode(mode) {
  for (const btn of siteModeBtns) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  siteModeHint.textContent = SITE_MODE_HINTS[mode] || "";
}

async function reloadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    // Reload so the gist-only script state is cleared and the onUpdated
    // listener in the service worker re-injects with the new mode (Full).
    chrome.tabs.reload(tab.id);
  }
}

async function setCurrentSiteMode(mode) {
  if (!_currentHostname) return;
  const previous = await getSiteMode(_currentHostname);
  if (previous === mode) return;

  // Permission: needed when going from "off" to anything else.
  if (previous === "off" && mode !== "off") {
    // Save the intent BEFORE the dialog (popup may close mid-prompt).
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.runtime.sendMessage({
      action: "enable-site",
      hostname: _currentHostname,
      mode,
      tabId: tab?.id,
    }).catch(() => {});
    paintSiteMode(mode);

    const granted = await requestSitePermission(_currentHostname);
    if (!granted) {
      chrome.runtime.sendMessage({ action: "disable-site", hostname: _currentHostname }).catch(() => {});
      paintSiteMode("off");
    }
    return;
  }

  // Off transition — remove site + permission.
  if (mode === "off") {
    chrome.runtime.sendMessage({ action: "disable-site", hostname: _currentHostname }).catch(() => {});
    await removeSitePermission(_currentHostname);
    paintSiteMode("off");
    return;
  }

  // Switch between gist <-> full — no new permission needed.
  chrome.runtime.sendMessage({ action: "set-site-mode", hostname: _currentHostname, mode }).catch(() => {});
  paintSiteMode(mode);
  // Gist → Full: re-scan the current page so titles get rewritten now,
  // not after the next page load.
  if (previous === "gist" && mode === "full") {
    reloadCurrentTab();
  }
}

siteModeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    setCurrentSiteMode(mode);
  });
});

// ---------------------------------------------------------------------------
// Manage sites list — per-site mode picker + remove
// ---------------------------------------------------------------------------

btnManageSites.addEventListener("click", () => {
  const isHidden = sitesPanel.classList.toggle("hidden");
  btnManageSites.textContent = isHidden ? "Manage sites ›" : "Manage sites ‹";
  if (!isHidden) {
    renderSitesList();
    refreshAlwaysGistUI();
  }
});

function buildModePicker(currentMode, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "site-item-mode";
  for (const m of ["gist", "full"]) {
    const btn = document.createElement("button");
    btn.className = "site-item-mode-btn" + (currentMode === m ? " active" : "");
    btn.textContent = m === "gist" ? "Gist" : "Full";
    btn.addEventListener("click", () => onChange(m));
    wrap.appendChild(btn);
  }
  return wrap;
}

async function renderSitesList() {
  const sites = await getAutoSites();

  while (sitesList.firstChild) sitesList.removeChild(sitesList.firstChild);

  if (sites.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sites-empty";
    empty.textContent = "No sites configured yet";
    sitesList.appendChild(empty);
    return;
  }

  for (const site of sites) {
    const item = document.createElement("div");
    item.className = "site-item";

    const name = document.createElement("a");
    name.className = "site-name";
    name.textContent = site.host;
    name.href = `https://${site.host}`;
    name.target = "_blank";
    name.rel = "noopener";
    name.title = `Open ${site.host}`;

    const modePicker = buildModePicker(site.mode, async (newMode) => {
      const previousMode = site.mode;
      chrome.runtime.sendMessage({ action: "set-site-mode", hostname: site.host, mode: newMode }).catch(() => {});
      if (site.host === _currentHostname) {
        paintSiteMode(newMode);
        if (previousMode === "gist" && newMode === "full") {
          reloadCurrentTab();
        }
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", async () => {
      chrome.runtime.sendMessage({ action: "disable-site", hostname: site.host }).catch(() => {});
      await removeSitePermission(site.host);
      if (site.host === _currentHostname) paintSiteMode("off");
    });

    item.appendChild(name);
    item.appendChild(modePicker);
    item.appendChild(removeBtn);
    sitesList.appendChild(item);
  }
}

async function addSiteManually() {
  let input = addSiteInput.value.trim();
  if (!input) return;

  try {
    if (input.includes("://")) input = new URL(input).hostname;
    else if (input.includes("/")) input = new URL("https://" + input).hostname;
  } catch { /* keep as-is */ }

  const sites = await getAutoSites();
  if (!sites.some((s) => s.host === input)) {
    const granted = await requestSitePermission(input);
    if (!granted) return;
    sites.push({ host: input, mode: "full" });
    await saveAutoSites(sites);
  }

  addSiteInput.value = "";
  if (input === _currentHostname) paintSiteMode("full");
}

// React to any storage changes — the service worker writes asynchronously, so
// the UI must update when the write lands rather than after the message dispatch.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoSites) {
    refreshYouTubeSettingsVisibility();
    if (!sitesPanel.classList.contains("hidden")) renderSitesList();
    if (_currentHostname) {
      getSiteMode(_currentHostname).then((mode) => {
        paintSiteMode(mode);
        updateDeclickbaitButton();
      });
    }
  }
  if (changes.alwaysGist || changes.gistExcludedSites) {
    if (!sitesPanel.classList.contains("hidden")) refreshAlwaysGistUI();
  }
});

btnAddSite.addEventListener("click", addSiteManually);
addSiteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addSiteManually(); });

// ---------------------------------------------------------------------------
// Always Gist toggle + excluded sites
// ---------------------------------------------------------------------------

async function refreshAlwaysGistUI() {
  const { enabled, excluded } = await getAlwaysGistState();
  alwaysGistToggle.checked = enabled;
  excludedSection.classList.toggle("hidden", !enabled);
  renderExcludedList(excluded);
}

function renderExcludedList(excluded) {
  while (excludedList.firstChild) excludedList.removeChild(excludedList.firstChild);
  if (!excluded.length) {
    const empty = document.createElement("div");
    empty.className = "sites-empty";
    empty.textContent = "No excluded sites";
    excludedList.appendChild(empty);
    return;
  }
  for (const host of excluded) {
    const item = document.createElement("div");
    item.className = "site-item";
    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = host;
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", async () => {
      const data = await chrome.storage.local.get("gistExcludedSites");
      const filtered = (data.gistExcludedSites || []).filter((h) => h !== host);
      await chrome.storage.local.set({ gistExcludedSites: filtered });
      refreshAlwaysGistUI();
    });
    item.appendChild(name);
    item.appendChild(removeBtn);
    excludedList.appendChild(item);
  }
}

alwaysGistToggle.addEventListener("change", async () => {
  const enabled = alwaysGistToggle.checked;
  if (enabled) {
    // <all_urls> is needed for both content script registration and fetching
    // article bodies for summaries.
    try {
      const has = await chrome.permissions.contains({ origins: ["<all_urls>"] });
      if (!has) {
        const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
        if (!granted) {
          alwaysGistToggle.checked = false;
          return;
        }
      }
    } catch {
      // Safari / no support for optional <all_urls> — proceed.
    }
  }
  await chrome.storage.local.set({ alwaysGist: enabled });
  refreshAlwaysGistUI();
});

async function addExcludedManually() {
  let input = addExcludedInput.value.trim();
  if (!input) return;
  try {
    if (input.includes("://")) input = new URL(input).hostname;
    else if (input.includes("/")) input = new URL("https://" + input).hostname;
  } catch { /* keep as-is */ }
  const data = await chrome.storage.local.get("gistExcludedSites");
  const list = data.gistExcludedSites || [];
  if (!list.includes(input)) {
    list.push(input);
    await chrome.storage.local.set({ gistExcludedSites: list });
  }
  addExcludedInput.value = "";
  refreshAlwaysGistUI();
}

btnAddExcluded.addEventListener("click", addExcludedManually);
addExcludedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addExcludedManually(); });

// ---------------------------------------------------------------------------
// Provider + API key (load + save flow)
// ---------------------------------------------------------------------------

chrome.storage.local.get(["provider", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini", "apiKey"], (data) => {
  // Migrate old single apiKey to anthropic-specific key
  if (data.apiKey && !data.apiKey_anthropic) {
    chrome.storage.local.set({ apiKey_anthropic: data.apiKey });
    chrome.storage.local.remove("apiKey");
    data.apiKey_anthropic = data.apiKey;
  } else if (data.apiKey) {
    chrome.storage.local.remove("apiKey");
  }

  const provider = data.provider || "anthropic";
  providerSelect.value = provider;
  updateProviderUI(provider);

  const key = data[`apiKey_${provider}`] || "";
  if (key) {
    apiKeyInput.value = key;
    btnDeclickbait.disabled = false;
    btnDeleteKey.style.display = "flex";
    keyStatus.textContent = "Key saved";
    keyStatus.className = "status-msg success";
    showCompactKeyUI();
  } else {
    document.getElementById("welcome-msg").style.display = "block";
  }
});

function showCompactKeyUI() {
  const provider = providerSelect.value;
  providerSelect.style.display = "none";
  providerPill.textContent = PROVIDER_LABELS[provider] || provider;
  providerPill.style.display = "inline-flex";
  document.getElementById("key-input-section").style.display = "none";
  document.getElementById("key-saved-compact").style.display = "flex";
  document.getElementById("welcome-msg").style.display = "none";
}

function showFullKeyUI() {
  providerSelect.style.display = "";
  providerPill.style.display = "none";
  document.getElementById("key-input-section").style.display = "";
  document.getElementById("key-saved-compact").style.display = "none";
}

document.getElementById("btn-edit-key").addEventListener("click", (e) => {
  e.preventDefault();
  showFullKeyUI();
});

providerPill.addEventListener("click", () => { showFullKeyUI(); });

btnToggleKey.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  document.getElementById("icon-eye").classList.toggle("hidden", isPassword);
  document.getElementById("icon-eye-off").classList.toggle("hidden", !isPassword);
});

function validateKeyFormat(key, provider) {
  switch (provider) {
    case "anthropic":
      if (!key.startsWith("sk-ant-")) return "Anthropic keys start with sk-ant-";
      break;
    case "openai":
      if (!key.startsWith("sk-")) return "OpenAI keys start with sk-";
      break;
    case "gemini":
      // Google is migrating from "Standard" keys (AIza...) to "Auth" keys
      // (AQ...) — accept both so keys created after the mid-2026 transition
      // aren't rejected.
      if (!key.startsWith("AIza") && !key.startsWith("AQ")) {
        return "Gemini keys start with AIza or AQ";
      }
      break;
  }
  return null;
}

btnSaveKey.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = "Please enter an API key";
    keyStatus.className = "status-msg error";
    return;
  }
  const provider = providerSelect.value;
  const formatError = validateKeyFormat(key, provider);
  if (formatError) {
    keyStatus.textContent = formatError;
    keyStatus.className = "status-msg error";
    return;
  }
  chrome.storage.local.set({ [`apiKey_${provider}`]: key, provider }, () => {
    keyStatus.textContent = "Key saved";
    keyStatus.className = "status-msg success";
    btnDeclickbait.disabled = false;
    btnDeleteKey.style.display = "flex";
    showCompactKeyUI();
  });
});

const btnDeleteKey = document.getElementById("btn-delete-key");
btnDeleteKey.addEventListener("click", () => {
  const provider = providerSelect.value;
  chrome.storage.local.remove(`apiKey_${provider}`, () => {
    apiKeyInput.value = "";
    keyStatus.textContent = "Key removed";
    keyStatus.className = "status-msg";
    btnDeclickbait.disabled = true;
    btnDeleteKey.style.display = "none";
    showFullKeyUI();
  });
});

// ---------------------------------------------------------------------------
// Current tab + de-clickbait button (contextual label)
// ---------------------------------------------------------------------------

async function updateDeclickbaitButton() {
  if (!_currentHostname) return;
  const mode = await getSiteMode(_currentHostname);
  if (mode === "full") {
    btnDeclickbait.textContent = "Re-scan this page";
  } else if (mode === "gist") {
    btnDeclickbait.textContent = "Rewrite titles for this page";
  } else {
    btnDeclickbait.textContent = "De-clickbait this page";
  }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      _currentHostname = new URL(tab.url).hostname;
      currentSiteEl.textContent = _currentHostname;
      const mode = await getSiteMode(_currentHostname);
      paintSiteMode(mode);
      updateDeclickbaitButton();
    } catch {
      currentSiteEl.textContent = "Cannot detect site";
    }
  }

  if (tab?.id) {
    try {
      const tabStatus = await chrome.runtime.sendMessage({
        action: "get-tab-status",
        tabId: tab.id,
      });

      if (tabStatus) {
        if (tabStatus.state === "working") {
          btnDeclickbait.disabled = true;
          btnDeclickbait.classList.add("processing");
          btnDeclickbait.textContent = "Working...";
          statusEl.textContent = tabStatus.text || "Processing...";
          statusEl.className = "status-msg";
        } else if (tabStatus.state === "done") {
          statusEl.textContent = "Done!";
          statusEl.className = "status-msg success";
          if (tabStatus.found) {
            statsEl.classList.remove("hidden");
            statFound.textContent = tabStatus.found;
            statReplaced.textContent = tabStatus.count || 0;
          }
        } else if (tabStatus.state === "error") {
          statusEl.textContent = tabStatus.text;
          statusEl.className = "status-msg error";
        }
      }

      const stats = await chrome.tabs.sendMessage(tab.id, { action: "get-stats" });
      if (stats && stats.count > 0 && !tabStatus) {
        statsEl.classList.remove("hidden");
        statFound.textContent = stats.found || stats.count;
        statReplaced.textContent = stats.count;
      }
    } catch { /* content script not injected yet */ }
  }
})();

btnDeclickbait.addEventListener("click", async () => {
  statusEl.textContent = "Scanning headlines...";
  statusEl.className = "status-msg";
  statsEl.classList.add("hidden");
  btnDeclickbait.disabled = true;
  btnDeclickbait.classList.add("processing");
  btnDeclickbait.textContent = "Working...";
  const _startTime = Date.now();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isYouTube = YT_HOSTS.includes(_currentHostname);
    const scriptFile = isYouTube ? "content/youtube.js" : "content/content.js";
    const extraFiles = isYouTube ? [] : ["content/html-utils.js"];
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/shared.js", ...extraFiles, scriptFile],
      });
    } catch (injectErr) {
      console.error("[Unbait] Script injection failed:", injectErr);
      statusEl.textContent = `Injection failed: ${injectErr.message}`;
      statusEl.className = "status-msg error";
      btnDeclickbait.disabled = false;
      btnDeclickbait.classList.remove("processing");
      updateDeclickbaitButton();
      return;
    }
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/content.css"],
    });

    if (isYouTube) await new Promise((r) => setTimeout(r, 100));

    const action = isYouTube ? "de-clickbait-youtube" : "de-clickbait";
    chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});

    const pollInterval = setInterval(async () => {
      try {
        const status = await chrome.runtime.sendMessage({ action: "get-status", tabId: tab.id });
        if (!status) return;
        if (status.state === "working") {
          statusEl.textContent = status.text || "Working...";
          statusEl.className = "status-msg";
          if (status.found) {
            statsEl.classList.remove("hidden");
            statFound.textContent = status.found;
            statReplaced.textContent = status.count || 0;
          }
        } else if (status.state === "done") {
          clearInterval(pollInterval);
          const elapsed = ((Date.now() - _startTime) / 1000).toFixed(1);
          statusEl.textContent = `Done! (${elapsed}s)`;
          statusEl.className = "status-msg success";
          statsEl.classList.remove("hidden");
          statFound.textContent = status.found || 0;
          statReplaced.textContent = status.count || 0;
          btnDeclickbait.disabled = false;
          btnDeclickbait.classList.remove("processing");
          updateDeclickbaitButton();
        } else if (status.state === "error") {
          clearInterval(pollInterval);
          statusEl.textContent = status.text || "Error";
          statusEl.className = "status-msg error";
          btnDeclickbait.disabled = false;
          btnDeclickbait.classList.remove("processing");
          updateDeclickbaitButton();
        }
      } catch { /* SW inactive */ }
    }, 500);

    setTimeout(() => {
      clearInterval(pollInterval);
      btnDeclickbait.disabled = false;
      btnDeclickbait.classList.remove("processing");
      updateDeclickbaitButton();
    }, 120000);
    return;
  } catch (err) {
    statusEl.textContent = "Cannot connect to page. Try refreshing.";
    statusEl.className = "status-msg error";
  }

  btnDeclickbait.disabled = false;
  btnDeclickbait.classList.remove("processing");
  updateDeclickbaitButton();
});

// ---------------------------------------------------------------------------
// Cache clearing
// ---------------------------------------------------------------------------

const btnClearCache = document.getElementById("btn-clear-cache");
const _clearCacheOrigHTML = btnClearCache.cloneNode(true);
function restoreClearBtn() {
  btnClearCache.textContent = "";
  for (const child of [..._clearCacheOrigHTML.childNodes]) {
    btnClearCache.appendChild(child.cloneNode(true));
  }
  btnClearCache.style.color = "";
}
btnClearCache.addEventListener("click", async () => {
  const allData = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(allData).filter((k) =>
    k.startsWith("unbait_cache") || k.startsWith("unbait_yt_cache") ||
    k.startsWith("gist_cache") || k.startsWith("gist_yt_cache"));
  if (cacheKeys.length === 0) {
    btnClearCache.textContent = "Cache is empty";
    setTimeout(restoreClearBtn, 1500);
    return;
  }
  await chrome.storage.local.remove(cacheKeys);
  btnClearCache.textContent = `Cleared ${cacheKeys.length} cache(s)`;
  btnClearCache.style.color = "#0d9488";
  setTimeout(restoreClearBtn, 2000);
});
