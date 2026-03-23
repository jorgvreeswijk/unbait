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

// Load saved provider + API key on popup open
chrome.storage.local.get(["provider", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini", "apiKey"], (data) => {
  // Migrate old single apiKey to anthropic-specific key
  if (data.apiKey && !data.apiKey_anthropic) {
    chrome.storage.local.set({ apiKey_anthropic: data.apiKey });
    data.apiKey_anthropic = data.apiKey;
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
  }
});

// Load current tab hostname + auto-sites state
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
})();

// Toggle key visibility with icon swap
btnToggleKey.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  document.getElementById("icon-eye").classList.toggle("hidden", isPassword);
  document.getElementById("icon-eye-off").classList.toggle("hidden", !isPassword);
});

// Save API key per provider
btnSaveKey.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = "Please enter an API key";
    keyStatus.className = "status-msg error";
    return;
  }
  const provider = providerSelect.value;
  chrome.storage.local.set({ [`apiKey_${provider}`]: key, provider }, () => {
    keyStatus.textContent = "Key saved";
    keyStatus.className = "status-msg success";
    btnDeclickbait.disabled = false;
    btnDeleteKey.style.display = "flex";
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

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject content script via scripting API (works with activeTab)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content/content.css"],
    });

    // Send de-clickbait message to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "de-clickbait",
    });

    if (response && response.error) {
      statusEl.textContent = response.error;
      statusEl.className = "status-msg error";
    } else if (response && response.success) {
      statusEl.textContent = "Done!";
      statusEl.className = "status-msg success";
      statsEl.classList.remove("hidden");
      statFound.textContent = response.found || 0;
      statReplaced.textContent = response.count || 0;
    } else {
      statusEl.textContent = "No response from page";
      statusEl.className = "status-msg error";
    }
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

    const name = document.createElement("span");
    name.className = "site-name";
    name.textContent = site;

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
