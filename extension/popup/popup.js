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

// Always On elements
const btnToggleSite = document.getElementById("btn-toggle-site");
const toggleSiteText = document.getElementById("toggle-site-text");
const currentSiteEl = document.getElementById("current-site");
const btnManageSites = document.getElementById("btn-manage-sites");
const sitesPanel = document.getElementById("sites-panel");
const sitesList = document.getElementById("sites-list");
const addSiteInput = document.getElementById("add-site-input");
const btnAddSite = document.getElementById("btn-add-site");

let _currentHostname = null;

const PROVIDER_PLACEHOLDERS = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  gemini: "AIza...",
};

function updateProviderUI(provider) {
  apiKeyInput.placeholder = PROVIDER_PLACEHOLDERS[provider] || "Enter API key";
  // Toggle info panels
  document.getElementById("info-anthropic").classList.toggle("hidden", provider !== "anthropic");
  document.getElementById("info-openai").classList.toggle("hidden", provider !== "openai");
  document.getElementById("info-gemini").classList.toggle("hidden", provider !== "gemini");
}

// Provider change handler
providerSelect.addEventListener("change", () => {
  const provider = providerSelect.value;
  updateProviderUI(provider);
  chrome.storage.local.set({ provider });

  // Load key for this provider if we have one
  chrome.storage.local.get(`apiKey_${provider}`, (data) => {
    const key = data[`apiKey_${provider}`] || "";
    apiKeyInput.value = key;
    btnDeclickbait.disabled = !key;
    btnDeleteKey.style.display = key ? "flex" : "none";
    keyStatus.textContent = key ? "Key saved" : "";
    keyStatus.className = key ? "status-msg success" : "status-msg";
  });
});

// Info panel toggle
const btnInfo = document.getElementById("btn-info");
const infoPanel = document.getElementById("info-panel");
btnInfo.addEventListener("click", () => {
  const isHidden = infoPanel.classList.toggle("hidden");
  btnInfo.classList.toggle("active", !isHidden);
});

// About panel toggle
const btnAbout = document.getElementById("btn-about");
const aboutPanel = document.getElementById("about-panel");
btnAbout.addEventListener("click", () => {
  const isHidden = aboutPanel.classList.toggle("hidden");
  btnAbout.textContent = isHidden ? "About Unbait" : "Close";
});

// Footer icon hover (CSP-safe, no inline handlers)
const btnBeer = document.getElementById("btn-beer");
if (btnBeer) {
  btnBeer.addEventListener("mouseenter", () => { btnBeer.style.opacity = "0.75"; });
  btnBeer.addEventListener("mouseleave", () => { btnBeer.style.opacity = "0.35"; });
}

// Share button — copy message to clipboard
const btnShare = document.getElementById("btn-share");
const shareTooltip = document.getElementById("share-tooltip");
if (btnShare) {
  btnShare.addEventListener("click", async () => {
    const msg = "Unbait - See what articles are really about. Replaces clickbait headlines with clear, informative titles using AI. Try it: https://unbait.link";
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

// Load YouTube settings on popup open
const SLIDER_LABELS = {
  1: 'Fast, minimal context',
  2: { text: 'Recommended balance', bold: true },
  3: { text: 'More context, slower' },
  4: { text: 'Maximum precision \u26a0\ufe0f higher API cost', warning: true }
};

function updateSliderLabel(value) {
  const label = document.getElementById('yt-slider-label');
  const config = SLIDER_LABELS[value];
  if (!config) { label.textContent = ''; return; }
  label.textContent = typeof config === 'string' ? config : config.text;
  label.className = 'yt-slider-label-text';
  if (config.bold) label.style.fontWeight = '600';
  else label.style.fontWeight = '';
  if (config.warning) label.classList.add('yt-slider-warning');
}

function updateYTToggleState() {
  const titlesOn = document.getElementById('yt-titles-toggle').checked;
  const sliderContainer = document.getElementById('yt-slider-container');
  const icon = document.getElementById('yt-toggle-icon');
  const label = document.querySelector('.yt-main-toggle span');
  if (sliderContainer) {
    sliderContainer.classList.toggle('hidden', !titlesOn);
  }
  if (icon) {
    icon.setAttribute('stroke', titlesOn ? '#0d9488' : '#9ca3af');
  }
  if (label) {
    label.style.color = titlesOn ? '#374151' : '#9ca3af';
  }
}

chrome.storage.local.get(['youtubeEnabled', 'youtubeThumbnails', 'ytTranscriptDepth'], (data) => {
  document.getElementById('yt-titles-toggle').checked = !!data.youtubeEnabled;
  document.getElementById('yt-thumbnails-toggle').checked = !!data.youtubeThumbnails;
  const slider = document.getElementById('yt-transcript-slider');
  if (slider) {
    slider.value = data.ytTranscriptDepth || 2;
    updateSliderLabel(slider.value);
  }
  updateYTToggleState();
});

// YouTube transcript slider
document.getElementById('yt-transcript-slider')?.addEventListener('input', (e) => {
  const val = parseInt(e.target.value, 10);
  updateSliderLabel(val);
  chrome.storage.local.set({ ytTranscriptDepth: val });
});

// YouTube toggle handlers
document.getElementById('yt-titles-toggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ youtubeEnabled: e.target.checked });
  updateYTToggleState();
  if (!e.target.checked) {
    document.getElementById('yt-thumbnails-toggle').checked = false;
    chrome.storage.local.set({ youtubeThumbnails: false });
  }
});

document.getElementById('yt-thumbnails-toggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ youtubeThumbnails: e.target.checked });
  if (e.target.checked) {
    document.getElementById('yt-titles-toggle').checked = true;
    chrome.storage.local.set({ youtubeEnabled: true });
  }
});

// YouTube settings panel toggle (gear icon)
document.getElementById('btn-yt-settings').addEventListener('click', () => {
  document.getElementById('yt-settings-panel').classList.toggle('hidden');
});

// YouTube info panel toggle
document.getElementById('btn-yt-info').addEventListener('click', () => {
  document.getElementById('yt-info-panel').classList.toggle('hidden');
});

// Load saved provider + API key on popup open
chrome.storage.local.get(["provider", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini", "apiKey"], (data) => {
  // Migrate old single apiKey to anthropic-specific key and clean up
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
    // Hide provider dropdown + key input when key is saved (cleaner UI)
    showCompactKeyUI();
  }
});

function showCompactKeyUI() {
  providerSelect.style.display = "none";
  document.getElementById("btn-switch-provider").style.display = "inline";
  document.getElementById("key-input-section").style.display = "none";
  document.getElementById("key-saved-compact").style.display = "flex";
}

function showFullKeyUI() {
  providerSelect.style.display = "";
  document.getElementById("btn-switch-provider").style.display = "none";
  document.getElementById("key-input-section").style.display = "";
  document.getElementById("key-saved-compact").style.display = "none";
}

// "Edit" link to show key input again
document.getElementById("btn-edit-key").addEventListener("click", (e) => {
  e.preventDefault();
  showFullKeyUI();
});

// "Switch" link to show provider dropdown again
document.getElementById("btn-switch-provider").addEventListener("click", (e) => {
  e.preventDefault();
  providerSelect.style.display = "";
  e.target.style.display = "none";
});

// Load current tab hostname + auto-sites state + existing stats
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      _currentHostname = new URL(tab.url).hostname;
      currentSiteEl.textContent = _currentHostname;
      btnToggleSite.disabled = false;
      updateSiteToggle();
    } catch {
      currentSiteEl.textContent = "Cannot detect site";
    }
  }

  // Check if there's an active job or results for this tab
  if (tab?.id) {
    try {
      // First check service worker for active/completed job status
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

      // Also check content script for stats (e.g. from cached results)
      const stats = await chrome.tabs.sendMessage(tab.id, { action: "get-stats" });
      if (stats && stats.count > 0 && !tabStatus) {
        statsEl.classList.remove("hidden");
        statFound.textContent = stats.found || stats.count;
        statReplaced.textContent = stats.count;
      }
    } catch {
      // Content script not injected yet — no stats to show
    }
  }
})();

// Toggle key visibility with icon swap
btnToggleKey.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  document.getElementById("icon-eye").classList.toggle("hidden", isPassword);
  document.getElementById("icon-eye-off").classList.toggle("hidden", !isPassword);
});

// API key format validation per provider
function validateKeyFormat(key, provider) {
  switch (provider) {
    case "anthropic":
      if (!key.startsWith("sk-ant-")) return "Anthropic keys start with sk-ant-";
      break;
    case "openai":
      if (!key.startsWith("sk-")) return "OpenAI keys start with sk-";
      break;
    case "gemini":
      if (!key.startsWith("AIza")) return "Gemini keys start with AIza";
      break;
  }
  return null;
}

// Save API key per provider
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

// Delete API key for current provider
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

// De-clickbait button
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

    // Inject content script via scripting API (works with activeTab)
    const isYouTube = _currentHostname === 'www.youtube.com';
    const scriptFile = isYouTube ? "content/youtube.js" : "content/content.js";
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [scriptFile],
      });
    } catch (injectErr) {
      console.error("[Unbait] Script injection failed:", injectErr);
      statusEl.textContent = `Injection failed: ${injectErr.message}`;
      statusEl.className = "status-msg error";
      btnDeclickbait.disabled = false;
      btnDeclickbait.classList.remove("processing");
      btnDeclickbait.textContent = "De-clickbait!";
      return;
    }
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/content.css"],
    });

    // Small delay for YouTube to let the script initialize
    if (isYouTube) await new Promise((r) => setTimeout(r, 100));

    // Send de-clickbait message to content script
    const action = isYouTube ? 'de-clickbait-youtube' : 'de-clickbait';

    // Fire the request — don't await. Poll for status instead.
    chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});

    // Poll service worker for live status updates
    const pollInterval = setInterval(async () => {
      try {
        const status = await chrome.runtime.sendMessage({ action: "get-status", tabId: tab.id });
        if (!status) return;

        if (status.state === "working") {
          statusEl.textContent = status.text || "Working...";
          statusEl.className = "status-msg";
          // Show live count if available
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
          btnDeclickbait.textContent = "De-clickbait!";
        } else if (status.state === "error") {
          clearInterval(pollInterval);
          statusEl.textContent = status.text || "Error";
          statusEl.className = "status-msg error";
          btnDeclickbait.disabled = false;
          btnDeclickbait.classList.remove("processing");
          btnDeclickbait.textContent = "De-clickbait!";
        }
      } catch {
        // Service worker may be inactive, ignore
      }
    }, 500);

    // Safety: stop polling after 2 minutes
    setTimeout(() => {
      clearInterval(pollInterval);
      btnDeclickbait.disabled = false;
      btnDeclickbait.classList.remove("processing");
      btnDeclickbait.textContent = "De-clickbait!";
    }, 120000);

    return; // Don't fall through to the button reset below
  } catch (err) {
    statusEl.textContent = "Cannot connect to page. Try refreshing.";
    statusEl.className = "status-msg error";
  }

  btnDeclickbait.disabled = false;
  btnDeclickbait.classList.remove("processing");
  btnDeclickbait.textContent = "De-clickbait!";
});

// --- Always On: site management with dynamic permissions ---

function originsForHostname(hostname) {
  return [`https://${hostname}/*`, `http://${hostname}/*`];
}

async function requestSitePermission(hostname) {
  try {
    return await chrome.permissions.request({ origins: originsForHostname(hostname) });
  } catch {
    // Safari may not support dynamic permissions — allow anyway
    return true;
  }
}

async function removeSitePermission(hostname) {
  try {
    return await chrome.permissions.remove({ origins: originsForHostname(hostname) });
  } catch {
    // Safari may not support dynamic permissions — ignore
    return true;
  }
}

async function getAutoSites() {
  const data = await chrome.storage.sync.get("autoSites");
  return data.autoSites || [];
}

async function saveAutoSites(sites) {
  await chrome.storage.sync.set({ autoSites: sites });
}

async function updateSiteToggle() {
  if (!_currentHostname) return;
  const sites = await getAutoSites();
  const isActive = sites.includes(_currentHostname);

  if (isActive) {
    toggleSiteText.textContent = "Active on this site";
    btnToggleSite.classList.add("active");
  } else {
    toggleSiteText.textContent = "Enable for this site";
    btnToggleSite.classList.remove("active");
  }
}

btnToggleSite.addEventListener("click", async () => {
  if (!_currentHostname) return;
  const sites = await getAutoSites();
  const index = sites.indexOf(_currentHostname);

  if (index >= 0) {
    // Disable: remove from list and revoke permission
    sites.splice(index, 1);
    await saveAutoSites(sites);
    await removeSitePermission(_currentHostname);
  } else {
    // Enable: request permission first, only add if granted
    const granted = await requestSitePermission(_currentHostname);
    if (!granted) return;
    sites.push(_currentHostname);
    await saveAutoSites(sites);
  }

  updateSiteToggle();
  renderSitesList();
});

// Manage sites toggle
btnManageSites.addEventListener("click", () => {
  const isHidden = sitesPanel.classList.toggle("hidden");
  btnManageSites.textContent = isHidden ? "Manage sites \u203a" : "Manage sites \u2039";
  if (!isHidden) renderSitesList();
});

async function renderSitesList() {
  const sites = await getAutoSites();

  // Clear existing children safely
  while (sitesList.firstChild) {
    sitesList.removeChild(sitesList.firstChild);
  }

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
    name.textContent = site;
    name.href = `https://${site}`;
    name.target = "_blank";
    name.rel = "noopener";
    name.title = `Open ${site}`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", async () => {
      const updated = (await getAutoSites()).filter((s) => s !== site);
      await saveAutoSites(updated);
      await removeSitePermission(site);
      renderSitesList();
      updateSiteToggle();
    });

    item.appendChild(name);
    item.appendChild(removeBtn);
    sitesList.appendChild(item);
  }
}

// Add site manually
async function addSiteManually() {
  let input = addSiteInput.value.trim();
  if (!input) return;

  // Extract hostname from URL if a full URL was entered
  try {
    if (input.includes("://")) {
      input = new URL(input).hostname;
    } else if (input.includes("/")) {
      input = new URL("https://" + input).hostname;
    }
  } catch {
    // keep as-is
  }

  const sites = await getAutoSites();
  if (!sites.includes(input)) {
    // Request permission first
    const granted = await requestSitePermission(input);
    if (!granted) return;
    sites.push(input);
    await saveAutoSites(sites);
  }

  addSiteInput.value = "";
  renderSitesList();
  updateSiteToggle();
}

btnAddSite.addEventListener("click", addSiteManually);
addSiteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSiteManually();
});

// Clear title cache (all providers)
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
  const cacheKeys = Object.keys(allData).filter((k) => k.startsWith("unbait_cache") || k.startsWith("unbait_yt_cache"));
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
