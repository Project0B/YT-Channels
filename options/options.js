/**
 * options.js — Manage page controller: category/channel CRUD, settings,
 * export/import (ARCHITECTURE.md, INTERFACE_SPEC.md §3).
 */

let state = {
  config: { schemaVersion: 1, categories: [], channels: [] },
  settings: {},
  pendingChannel: null, // {channelId, name, avatarUrl, sourceUrl, selectedCategoryIds: Set}
};

function send(type, extra) {
  return browser.runtime.sendMessage({ type, ...extra });
}

function $(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  const [{ config }, { settings }] = await Promise.all([send("GET_CONFIG"), send("GET_SETTINGS")]);
  state.config = config;
  state.settings = settings;
  renderCategories();
  renderChannels();
  renderSettings();
  wireStaticHandlers();
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function renderCategories() {
  const list = $("category-list");
  list.replaceChildren();
  const sorted = [...state.config.categories].sort((a, b) => a.order - b.order);

  sorted.forEach((cat, idx) => {
    const li = document.createElement("li");
    li.className = "category-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "category-name";
    nameSpan.textContent = cat.name;
    nameSpan.title = "Click to rename";
    nameSpan.addEventListener("click", () => startRenameCategory(li, cat));

    const reorder = document.createElement("div");
    reorder.className = "reorder-buttons";
    const upBtn = document.createElement("button");
    upBtn.textContent = "▲";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => moveCategory(sorted, idx, -1));
    const downBtn = document.createElement("button");
    downBtn.textContent = "▼";
    downBtn.disabled = idx === sorted.length - 1;
    downBtn.addEventListener("click", () => moveCategory(sorted, idx, 1));
    reorder.append(upBtn, downBtn);

    const shareBtn = document.createElement("button");
    shareBtn.className = "secondary";
    shareBtn.textContent = "Share";
    shareBtn.title = "Export just this category to share with someone else";
    shareBtn.addEventListener("click", () => shareCategory(cat));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "remove-button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteCategory(cat));

    li.append(reorder, nameSpan, shareBtn, deleteBtn);
    list.appendChild(li);
  });
}

async function shareCategory(cat) {
  const result = await send("EXPORT_CATEGORY", { categoryId: cat.id });
  if (result.error) {
    showToast(result.error);
    return;
  }
  downloadJson(result.exportData, `yt-channels-category-${slugify(cat.name)}.txt`);
}

async function moveCategory(sorted, idx, direction) {
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= sorted.length) return;
  const reordered = [...sorted];
  [reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]];
  const orderedIds = reordered.map((c) => c.id);
  const { config } = await send("REORDER_CATEGORIES", { orderedIds });
  state.config = config;
  renderCategories();
  renderChannels();
}

function startRenameCategory(li, cat) {
  li.replaceChildren();
  const input = document.createElement("input");
  input.className = "rename-input";
  input.type = "text";
  input.value = cat.name;
  li.appendChild(input);
  input.focus();
  input.select();

  const commit = async () => {
    const name = input.value.trim();
    if (!name || name === cat.name) {
      renderCategories();
      return;
    }
    const result = await send("RENAME_CATEGORY", { categoryId: cat.id, name });
    if (result.error) {
      $("category-error").textContent = result.error;
      renderCategories();
      return;
    }
    $("category-error").textContent = "";
    state.config = result.config;
    renderCategories();
    renderChannels();
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") renderCategories();
  });
}

async function deleteCategory(cat) {
  const ok = await showConfirm(
    `Delete category "${cat.name}"? Channels only in this category will move to Uncategorized.`
  );
  if (!ok) return;
  const { config } = await send("DELETE_CATEGORY", { categoryId: cat.id });
  state.config = config;
  renderCategories();
  renderChannels();
}

function wireNewCategoryForm() {
  $("new-category-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("new-category-name");
    const name = input.value.trim();
    if (!name) return;
    const result = await send("CREATE_CATEGORY", { name });
    if (result.error) {
      $("category-error").textContent = result.error;
      return;
    }
    $("category-error").textContent = "";
    state.config = result.config;
    input.value = "";
    renderCategories();
  });
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function buildCategoryChecklist(container, selectedIds, onToggle) {
  container.replaceChildren();
  if (state.config.categories.length === 0) {
    const span = document.createElement("span");
    span.className = "hint-text";
    span.textContent = "No categories yet — this channel will be Uncategorized.";
    container.appendChild(span);
    return;
  }
  const sorted = [...state.config.categories].sort((a, b) => a.order - b.order);
  for (const cat of sorted) {
    const chip = document.createElement("label");
    chip.className = "category-chip" + (selectedIds.has(cat.id) ? " selected" : "");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.has(cat.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(cat.id);
      else selectedIds.delete(cat.id);
      chip.classList.toggle("selected", checkbox.checked);
      onToggle();
    });
    chip.append(checkbox, document.createTextNode(cat.name));
    container.appendChild(chip);
  }
}

function renderChannels() {
  const list = $("channel-list");
  const query = ($("channel-search").value || "").toLowerCase().trim();
  list.replaceChildren();

  const categoryById = new Map(state.config.categories.map((c) => [c.id, c]));
  const filtered = state.config.channels
    .filter((ch) => !query || ch.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const channel of filtered) {
    const li = document.createElement("li");
    li.className = "channel-row";

    const img = document.createElement("img");
    img.src = channel.avatarUrl || "";
    img.alt = "";

    const info = document.createElement("div");
    info.className = "channel-info";
    const nameDiv = document.createElement("div");
    nameDiv.className = "channel-name";
    nameDiv.textContent = channel.name;
    const chipsDiv = document.createElement("div");
    chipsDiv.className = "category-tags";
    info.append(nameDiv, chipsDiv);

    const selectedIds = new Set(channel.categoryIds);
    buildCategoryChecklist(chipsDiv, selectedIds, async () => {
      const result = await send("UPDATE_CHANNEL_CATEGORIES", {
        channelId: channel.channelId,
        categoryIds: Array.from(selectedIds),
      });
      state.config = result.config;
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      const ok = await showConfirm(`Remove "${channel.name}" from your list?`);
      if (!ok) return;
      const result = await send("REMOVE_CHANNEL", { channelId: channel.channelId });
      state.config = result.config;
      renderChannels();
    });

    li.append(img, info, removeBtn);
    list.appendChild(li);
  }

  void categoryById; // reserved for future use (e.g. sort-by-category)
}

function wireAddChannelForm() {
  $("add-channel-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("channel-url-input");
    const url = input.value.trim();
    if (!url) return;
    const resolveBtn = $("resolve-button");
    resolveBtn.disabled = true;
    resolveBtn.textContent = "Resolving…";
    $("resolve-error").textContent = "";

    const result = await send("RESOLVE_CHANNEL", { url });

    resolveBtn.disabled = false;
    resolveBtn.textContent = "Resolve";

    if (result.error) {
      $("resolve-error").textContent = result.error;
      return;
    }

    const existing = state.config.channels.find((c) => c.channelId === result.channelId);
    state.pendingChannel = {
      channelId: result.channelId,
      name: result.name,
      avatarUrl: result.avatarUrl,
      sourceUrl: result.sourceUrl,
      selectedCategoryIds: new Set(existing ? existing.categoryIds : []),
    };
    showPendingChannel();
    input.value = "";
  });
}

function showPendingChannel() {
  const panel = $("pending-channel");
  panel.classList.remove("hidden");
  $("pending-avatar").src = state.pendingChannel.avatarUrl || "";
  $("pending-name").textContent = state.pendingChannel.name;
  buildCategoryChecklist($("pending-categories"), state.pendingChannel.selectedCategoryIds, () => {});
}

function wirePendingChannelActions() {
  $("confirm-add-channel").addEventListener("click", async () => {
    if (!state.pendingChannel) return;
    const pc = state.pendingChannel;
    const result = await send("SAVE_CHANNEL", {
      channel: {
        channelId: pc.channelId,
        name: pc.name,
        avatarUrl: pc.avatarUrl,
        sourceUrl: pc.sourceUrl,
        categoryIds: Array.from(pc.selectedCategoryIds),
      },
    });
    state.config = result.config;
    state.pendingChannel = null;
    $("pending-channel").classList.add("hidden");
    renderChannels();
    showToast("Channel added");
  });

  $("cancel-add-channel").addEventListener("click", () => {
    state.pendingChannel = null;
    $("pending-channel").classList.add("hidden");
  });
}

function wireChannelSearch() {
  $("channel-search").addEventListener("input", () => renderChannels());
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings() {
  $("setting-cache-ttl").value = state.settings.cacheTtlMinutes;
  $("setting-videos-limit").value = state.settings.videosPerCategoryLimit;
  $("setting-concurrency").value = state.settings.fetchConcurrency;
}

function wireSettingsForm() {
  $("save-settings").addEventListener("click", async () => {
    const partial = {
      cacheTtlMinutes: clampNumber($("setting-cache-ttl").value, 5, 1440, 30),
      videosPerCategoryLimit: clampNumber($("setting-videos-limit").value, 1, 500, 60),
      fetchConcurrency: clampNumber($("setting-concurrency").value, 1, 20, 6),
    };
    const result = await send("UPDATE_SETTINGS", { partial });
    state.settings = result.settings;
    renderSettings();
    const savedText = $("settings-saved");
    savedText.classList.remove("hidden");
    setTimeout(() => savedText.classList.add("hidden"), 1800);
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "category"
  );
}

function wireExportImport() {
  $("export-config").addEventListener("click", async () => {
    const { exportData } = await send("EXPORT_CONFIG");
    downloadJson(exportData, "yt-channels-config.txt");
  });

  $("import-config-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = "";

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      showToast("Invalid file — not valid JSON");
      return;
    }

    if (data && data.shareType === "category") {
      await runCategoryImportFlow(data);
    } else if (data && data.schemaVersion === 2 && Array.isArray(data.categories) && Array.isArray(data.channels)) {
      await runConfigImportV2Flow(data);
    } else {
      // Legacy schemaVersion: 1 full-config file — unchanged flow, no
      // resolution needed since the file already carries full channel data.
      const mode = await showImportDialog();
      if (!mode) return;
      const result = await send("IMPORT_CONFIG", { data, mode });
      if (result.error) {
        showToast(`Import failed: ${result.error}`);
        return;
      }
      state.config = result.config;
      renderCategories();
      renderChannels();
      showToast("Import successful");
    }
  });
}

// ---------------------------------------------------------------------------
// Compact import: identifier resolution (ROADMAP.md §A.2-A.4)
// ---------------------------------------------------------------------------

// Runs a RESOLVE_* message over a fresh "import" Port, showing progress via
// the resolving modal, and resolves with the resulting preview message (or
// an error). Mirrors feed.js's per-request Port pattern.
function resolveOverPort(requestType, data, previewType) {
  showImportProgress("Resolving channels…");
  return new Promise((resolve) => {
    const port = browser.runtime.connect({ name: "import" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "IMPORT_PROGRESS") {
        setImportProgressText(`Resolving channels… (${msg.resolved}/${msg.total})`);
      } else if (msg.type === previewType) {
        hideImportProgress();
        port.disconnect();
        resolve({ ok: true, ...msg });
      } else if (msg.type === "IMPORT_RESOLVE_ERROR") {
        hideImportProgress();
        port.disconnect();
        resolve({ ok: false, error: msg.error });
      }
    });
    port.postMessage({ type: requestType, data });
  });
}

async function runCategoryImportFlow(data) {
  const preview = await resolveOverPort("RESOLVE_CATEGORY_IMPORT", data, "IMPORT_PREVIEW_CATEGORY");
  if (!preview.ok) {
    showToast(`Import failed: ${preview.error}`);
    return;
  }
  if (preview.channels.length === 0) {
    showToast("Nothing in that file could be resolved");
    return;
  }

  const collision = state.config.categories.find(
    (c) => c.name.toLowerCase() === preview.categoryName.toLowerCase()
  );
  const choice = await showCategoryImportPreview(preview, Boolean(collision));
  if (!choice.confirmed) return;

  const result = await send("COMMIT_CATEGORY_IMPORT", {
    categoryName: preview.categoryName,
    channels: preview.channels,
    collisionMode: choice.collisionMode,
  });
  state.config = result.config;
  renderCategories();
  renderChannels();
  const failedNote = preview.errors.length > 0 ? ` — ${preview.errors.length} couldn't be resolved` : "";
  showToast(`Imported "${preview.categoryName}"${failedNote}`);
}

async function runConfigImportV2Flow(data) {
  const preview = await resolveOverPort("RESOLVE_CONFIG_IMPORT_V2", data, "IMPORT_PREVIEW_CONFIG_V2");
  if (!preview.ok) {
    showToast(`Import failed: ${preview.error}`);
    return;
  }
  if (preview.channels.length === 0) {
    showToast("Nothing in that file could be resolved");
    return;
  }

  const mode = await showImportDialog();
  if (!mode) return;

  const result = await send("COMMIT_CONFIG_IMPORT_V2", {
    categories: preview.categories,
    channels: preview.channels,
    mode,
  });
  if (result.error) {
    showToast(`Import failed: ${result.error}`);
    return;
  }
  state.config = result.config;
  renderCategories();
  renderChannels();
  const failedNote = preview.errors.length > 0 ? ` — ${preview.errors.length} couldn't be resolved` : "";
  showToast(`Import successful${failedNote}`);
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

function showConfirm(text) {
  return new Promise((resolve) => {
    const modal = $("confirm-dialog");
    $("confirm-dialog-text").textContent = text;
    modal.classList.remove("hidden");

    const cleanup = (result) => {
      modal.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      resolve(result);
    };
    const yesBtn = $("confirm-dialog-yes");
    const noBtn = $("confirm-dialog-no");
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
  });
}

function showImportDialog() {
  return new Promise((resolve) => {
    const modal = $("import-dialog");
    modal.classList.remove("hidden");

    const cleanup = (result) => {
      modal.classList.add("hidden");
      replaceBtn.removeEventListener("click", onReplace);
      mergeBtn.removeEventListener("click", onMerge);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const replaceBtn = $("import-replace");
    const mergeBtn = $("import-merge");
    const cancelBtn = $("import-cancel");
    const onReplace = () => cleanup("replace");
    const onMerge = () => cleanup("merge");
    const onCancel = () => cleanup(null);
    replaceBtn.addEventListener("click", onReplace);
    mergeBtn.addEventListener("click", onMerge);
    cancelBtn.addEventListener("click", onCancel);
  });
}

function showImportProgress(text) {
  $("import-progress-text").textContent = text;
  $("import-progress-dialog").classList.remove("hidden");
}

function setImportProgressText(text) {
  $("import-progress-text").textContent = text;
}

function hideImportProgress() {
  $("import-progress-dialog").classList.add("hidden");
}

// preview: {categoryName, channels: [{channelId,name,avatarUrl,sourceUrl}], errors: [{identifier,error}]}
// Resolves {confirmed: false} on cancel, or {confirmed: true, collisionMode: "merge"|"new"|null}.
function showCategoryImportPreview(preview, hasCollision) {
  return new Promise((resolve) => {
    $("import-preview-category-name").textContent = preview.categoryName;
    const count = preview.channels.length;
    $("import-preview-summary").textContent = `${count} channel${count === 1 ? "" : "s"} resolved`;

    const list = $("import-preview-channel-list");
    list.replaceChildren();
    for (const ch of preview.channels) {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = ch.avatarUrl || "";
      img.alt = "";
      const span = document.createElement("span");
      span.textContent = ch.name;
      li.append(img, span);
      list.appendChild(li);
    }

    const errorsEl = $("import-preview-errors");
    errorsEl.textContent =
      preview.errors.length > 0
        ? `${preview.errors.length} channel(s) couldn't be resolved and will be skipped: ${preview.errors
            .map((e) => e.identifier)
            .join(", ")}`
        : "";

    const collisionEl = $("import-collision-choice");
    collisionEl.classList.toggle("hidden", !hasCollision);
    if (hasCollision) {
      collisionEl.querySelector('input[value="merge"]').checked = true;
    }

    const modal = $("import-category-preview-dialog");
    modal.classList.remove("hidden");

    const cleanup = (result) => {
      modal.classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const confirmBtn = $("import-preview-confirm");
    const cancelBtn = $("import-preview-cancel");
    const onConfirm = () => {
      const collisionMode = hasCollision
        ? collisionEl.querySelector('input[name="collision-mode"]:checked').value
        : null;
      cleanup({ confirmed: true, collisionMode });
    };
    const onCancel = () => cleanup({ confirmed: false });
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}

let toastTimer = null;
function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2500);
}

// ---------------------------------------------------------------------------

function wireStaticHandlers() {
  wireNewCategoryForm();
  wireAddChannelForm();
  wirePendingChannelActions();
  wireChannelSearch();
  wireSettingsForm();
  wireExportImport();
}

init();
