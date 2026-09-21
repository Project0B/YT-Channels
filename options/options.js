/**
 * options.js — Manage page controller: category/channel CRUD, settings,
 * export/import (ARCHITECTURE.md, INTERFACE_SPEC.md §3).
 */

let state = {
  config: { schemaVersion: 1, categories: [], channels: [] },
  settings: {},
  currentDetailCategoryId: null, // set while the category detail view (ROADMAP.md §B.2) is open
  noVideoChannelIds: new Set(), // channels with no long-form uploads and nothing but Shorts
};

// Message types that can change what the feed page would render (config or
// settings). Tracked so "Open Feed" can tell an already-open feed tab to
// reload only when something here actually changed, instead of reloading it
// unconditionally on every visit.
const CONFIG_CHANGING_MESSAGE_TYPES = new Set([
  "SAVE_CHANNEL",
  "UPDATE_CHANNEL_CATEGORIES",
  "REMOVE_CHANNEL",
  "CREATE_CATEGORY",
  "RENAME_CATEGORY",
  "DELETE_CATEGORY",
  "REORDER_CATEGORIES",
  "UPDATE_SETTINGS",
  "IMPORT_CONFIG",
  "COMMIT_CATEGORY_IMPORT",
  "COMMIT_CONFIG_IMPORT_V2",
]);
let configChangedSinceLastFeedVisit = false;

async function send(type, extra) {
  const result = await browser.runtime.sendMessage({ type, ...extra });
  if (CONFIG_CHANGING_MESSAGE_TYPES.has(type) && result && !result.error) {
    configChangedSinceLastFeedVisit = true;
  }
  return result;
}

function $(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  const [{ config }, { settings }, { channelIds }] = await Promise.all([
    send("GET_CONFIG"),
    send("GET_SETTINGS"),
    send("GET_EMPTY_CHANNELS"),
  ]);
  state.config = config;
  state.settings = settings;
  state.noVideoChannelIds = new Set(channelIds);
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
    // Row click opens the category detail view (ROADMAP.md §B.2). Every
    // interactive control within the row must stopPropagation so it doesn't
    // also trigger that — rename moved behind its own icon for exactly this
    // reason, rather than living on a name-click that would now collide.
    li.addEventListener("click", () => openCategoryDetail(cat.id));

    const nameSpan = document.createElement("span");
    nameSpan.className = "category-name";
    nameSpan.textContent = cat.name;

    const renameBtn = document.createElement("button");
    renameBtn.className = "icon-button";
    renameBtn.title = "Rename category";
    renameBtn.setAttribute("aria-label", `Rename ${cat.name}`);
    renameBtn.appendChild(createIcon("pencil"));
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRenameCategory(li, cat);
    });

    const reorder = document.createElement("div");
    reorder.className = "reorder-buttons";
    const upBtn = document.createElement("button");
    upBtn.title = "Move up";
    upBtn.setAttribute("aria-label", `Move ${cat.name} up`);
    upBtn.appendChild(createIcon("chevron-up"));
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveCategory(sorted, idx, -1);
    });
    const downBtn = document.createElement("button");
    downBtn.title = "Move down";
    downBtn.setAttribute("aria-label", `Move ${cat.name} down`);
    downBtn.appendChild(createIcon("chevron-down"));
    downBtn.disabled = idx === sorted.length - 1;
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveCategory(sorted, idx, 1);
    });
    reorder.append(upBtn, downBtn);

    const shareBtn = document.createElement("button");
    shareBtn.className = "secondary";
    shareBtn.textContent = "Share";
    shareBtn.title = "Export just this category to share with someone else";
    shareBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      shareCategory(cat);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "remove-button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCategory(cat);
    });

    li.append(reorder, nameSpan, renameBtn, shareBtn, deleteBtn);
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
  input.addEventListener("click", (e) => e.stopPropagation());
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
  if (state.currentDetailCategoryId === cat.id) {
    closeCategoryDetail();
  }
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
// Category detail view (ROADMAP.md §B.2)
// ---------------------------------------------------------------------------

function openCategoryDetail(categoryId) {
  state.currentDetailCategoryId = categoryId;
  $("list-view").classList.add("hidden");
  $("category-detail-view").classList.remove("hidden");
  renderCategoryDetail();
  window.scrollTo(0, 0);
}

function closeCategoryDetail() {
  state.currentDetailCategoryId = null;
  $("category-detail-view").classList.add("hidden");
  $("list-view").classList.remove("hidden");
}

function findCurrentDetailCategory() {
  return state.config.categories.find((c) => c.id === state.currentDetailCategoryId);
}

function renderCategoryDetail() {
  const category = findCurrentDetailCategory();
  if (!category) {
    // Deleted from elsewhere, or stale state — bail back to the list rather
    // than showing a detail view for a category that no longer exists.
    closeCategoryDetail();
    return;
  }
  $("category-detail-name").textContent = category.name;

  const list = $("category-detail-channel-list");
  list.replaceChildren();
  const members = state.config.channels
    .filter((ch) => ch.categoryIds.includes(category.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (members.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint-text";
    empty.textContent = "No channels in this category yet — add one above.";
    list.appendChild(empty);
    return;
  }

  for (const channel of members) {
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
    info.append(nameDiv, ...channelNote(channel));

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-button";
    removeBtn.textContent = "Remove from category";
    removeBtn.addEventListener("click", async () => {
      const nextCategoryIds = channel.categoryIds.filter((id) => id !== category.id);
      const result = await send("UPDATE_CHANNEL_CATEGORIES", {
        channelId: channel.channelId,
        categoryIds: nextCategoryIds,
      });
      state.config = result.config;
      renderCategoryDetail();
    });

    li.append(img, info, removeBtn);
    list.appendChild(li);
  }
}

function startRenameCategoryDetail(category) {
  const nameEl = $("category-detail-name");
  const input = document.createElement("input");
  input.className = "rename-input";
  input.type = "text";
  input.value = category.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const restore = (name) => {
    const span = document.createElement("span");
    span.className = "category-detail-name";
    span.id = "category-detail-name";
    span.textContent = name;
    input.replaceWith(span);
  };

  const commit = async () => {
    const name = input.value.trim();
    if (!name || name === category.name) {
      restore(category.name);
      return;
    }
    const result = await send("RENAME_CATEGORY", { categoryId: category.id, name });
    if (result.error) {
      showToast(result.error);
      restore(category.name);
      return;
    }
    state.config = result.config;
    renderCategories();
    restore(name);
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") restore(category.name);
  });
}

function wireCategoryDetailHeader() {
  $("category-detail-back").addEventListener("click", closeCategoryDetail);

  $("category-detail-rename").addEventListener("click", () => {
    const category = findCurrentDetailCategory();
    if (category) startRenameCategoryDetail(category);
  });

  $("category-detail-share").addEventListener("click", () => {
    const category = findCurrentDetailCategory();
    if (category) shareCategory(category);
  });

  $("category-detail-delete").addEventListener("click", () => {
    const category = findCurrentDetailCategory();
    if (category) deleteCategory(category);
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

function channelNote(channel) {
  if (!state.noVideoChannelIds.has(channel.channelId)) return [];
  const note = document.createElement("div");
  note.className = "channel-note";
  note.textContent = "No long-form videos to show";
  note.title = "This channel has no regular videos (only Shorts, or nothing), so it adds nothing to your feeds.";
  return [note];
}

function renderChannels() {
  const list = $("channel-list");
  const query = ($("channel-search").value || "").toLowerCase().trim();
  list.replaceChildren();

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
    info.append(nameDiv, ...channelNote(channel), chipsDiv);

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
}

// Reusable resolve → pending-preview → confirm add-channel flow, shared by
// the global Channels section and the category detail view (ROADMAP.md
// §B.3) — both always offer the full multi-category checklist; the only
// difference is which category (if any) the checklist pre-checks by
// default. `getDefaultCategoryId` is a thunk (not a fixed value) since the
// detail-view instance's "current category" changes as the user navigates
// between categories without the page reloading.
function createAddChannelController(ids, { getDefaultCategoryId = () => null, onSaved } = {}) {
  const form = $(ids.form);
  const input = $(ids.input);
  const resolveButton = $(ids.resolveButton);
  const errorEl = $(ids.errorEl);
  const pendingPanel = $(ids.pendingPanel);
  const pendingAvatar = $(ids.pendingAvatar);
  const pendingName = $(ids.pendingName);
  const pendingCategories = $(ids.pendingCategories);
  const confirmButton = $(ids.confirmButton);
  const cancelButton = $(ids.cancelButton);

  let pendingChannel = null;

  function showPending() {
    pendingPanel.classList.remove("hidden");
    pendingAvatar.src = pendingChannel.avatarUrl || "";
    pendingName.textContent = pendingChannel.name;
    buildCategoryChecklist(pendingCategories, pendingChannel.selectedCategoryIds, () => {});
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    resolveButton.disabled = true;
    resolveButton.textContent = "Resolving…";
    errorEl.textContent = "";

    const result = await send("RESOLVE_CHANNEL", { url });

    resolveButton.disabled = false;
    resolveButton.textContent = "Resolve";

    if (result.error) {
      errorEl.textContent = result.error;
      return;
    }

    const existing = state.config.channels.find((c) => c.channelId === result.channelId);
    const selectedCategoryIds = new Set(existing ? existing.categoryIds : []);
    const defaultCategoryId = getDefaultCategoryId();
    if (defaultCategoryId) selectedCategoryIds.add(defaultCategoryId);

    pendingChannel = {
      channelId: result.channelId,
      name: result.name,
      avatarUrl: result.avatarUrl,
      sourceUrl: result.sourceUrl,
      selectedCategoryIds,
    };
    showPending();
    input.value = "";
  });

  confirmButton.addEventListener("click", async () => {
    if (!pendingChannel) return;
    const pc = pendingChannel;
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
    pendingChannel = null;
    pendingPanel.classList.add("hidden");
    if (onSaved) onSaved(result.config);
    showToast("Channel added");
  });

  cancelButton.addEventListener("click", () => {
    pendingChannel = null;
    pendingPanel.classList.add("hidden");
  });
}

function wireAddChannelForms() {
  createAddChannelController(
    {
      form: "add-channel-form",
      input: "channel-url-input",
      resolveButton: "resolve-button",
      errorEl: "resolve-error",
      pendingPanel: "pending-channel",
      pendingAvatar: "pending-avatar",
      pendingName: "pending-name",
      pendingCategories: "pending-categories",
      confirmButton: "confirm-add-channel",
      cancelButton: "cancel-add-channel",
    },
    { onSaved: () => renderChannels() }
  );

  createAddChannelController(
    {
      form: "detail-add-channel-form",
      input: "detail-channel-url-input",
      resolveButton: "detail-resolve-button",
      errorEl: "detail-resolve-error",
      pendingPanel: "detail-pending-channel",
      pendingAvatar: "detail-pending-avatar",
      pendingName: "detail-pending-name",
      pendingCategories: "detail-pending-categories",
      confirmButton: "detail-confirm-add-channel",
      cancelButton: "detail-cancel-add-channel",
    },
    {
      getDefaultCategoryId: () => state.currentDetailCategoryId,
      onSaved: () => {
        renderChannels();
        renderCategoryDetail();
      },
    }
  );
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
  $("setting-max-columns").value = state.settings.maxVideosPerRow;
}

function wireSettingsForm() {
  $("save-settings").addEventListener("click", async () => {
    const partial = {
      cacheTtlMinutes: clampNumber($("setting-cache-ttl").value, 5, 1440, 30),
      videosPerCategoryLimit: clampNumber($("setting-videos-limit").value, 1, 500, 60),
      fetchConcurrency: clampNumber($("setting-concurrency").value, 1, 20, 6),
      maxVideosPerRow: clampNumber($("setting-max-columns").value, 2, 8, 4),
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
  // Number("") is 0, not NaN — a cleared field would otherwise clamp to
  // `min` instead of falling back to the default, which is not what
  // clearing a field and saving is supposed to do.
  if (value === "" || value === null || value === undefined) return fallback;
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

// Modals are shown/hidden via a plain .hidden class toggle, with no focus
// management of their own — so Tab/Shift+Tab could still reach (and click)
// controls in the page behind an "open" modal. `inert` (Firefox 112+, well
// within this extension's strict_min_version) is the standard fix:
// applied to every non-modal top-level container while any modal is open,
// it makes that whole subtree unfocusable and unclickable, not just
// visually covered. Reference-counted since import flows can show a
// progress modal immediately followed by a preview modal.
const INERT_TARGETS = ["page-header", "list-view", "category-detail-view"];
let openModalCount = 0;
let preModalFocusedElement = null;

function showModal(modalEl) {
  if (openModalCount === 0) {
    preModalFocusedElement = document.activeElement;
    for (const id of INERT_TARGETS) {
      $(id)?.setAttribute("inert", "");
    }
  }
  openModalCount++;
  modalEl.classList.remove("hidden");
  // querySelector alone can't tell a genuinely focusable element from one
  // sitting inside a still-hidden child (e.g. the collision-choice radios,
  // hidden unless there's an actual collision) — offsetParent === null is a
  // cheap, reliable "not rendered" check, and .focus() is a no-op on a
  // hidden element anyway, so skip straight to the first visible one.
  for (const el of modalEl.querySelectorAll("button, input, [href], [tabindex]")) {
    if (el.offsetParent !== null) {
      el.focus();
      break;
    }
  }
}

function hideModal(modalEl) {
  modalEl.classList.add("hidden");
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0) {
    for (const id of INERT_TARGETS) {
      $(id)?.removeAttribute("inert");
    }
    if (preModalFocusedElement && document.contains(preModalFocusedElement)) {
      preModalFocusedElement.focus();
    }
    preModalFocusedElement = null;
  }
}

function showConfirm(text) {
  return new Promise((resolve) => {
    const modal = $("confirm-dialog");
    $("confirm-dialog-text").textContent = text;
    showModal(modal);

    const cleanup = (result) => {
      hideModal(modal);
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
    showModal(modal);

    const cleanup = (result) => {
      hideModal(modal);
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
  showModal($("import-progress-dialog"));
}

function setImportProgressText(text) {
  $("import-progress-text").textContent = text;
}

function hideImportProgress() {
  hideModal($("import-progress-dialog"));
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
    showModal(modal);

    const cleanup = (result) => {
      hideModal(modal);
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
// Sidebar scroll-spy (ROADMAP.md §B.1) — links are plain anchor jumps
// (CSS `scroll-behavior: smooth` handles the actual scrolling); this only
// highlights whichever section is currently in view as the user scrolls.
// ---------------------------------------------------------------------------

function wireSidebarScrollSpy() {
  const links = new Map(
    Array.from(document.querySelectorAll(".sidebar-link")).map((a) => [a.dataset.section, a])
  );
  if (links.size === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const link = links.get(entry.target.id);
        if (!link) continue;
        links.forEach((l) => l.classList.remove("active"));
        link.classList.add("active");
      }
    },
    { rootMargin: "-15% 0px -70% 0px", threshold: 0 }
  );

  for (const id of links.keys()) {
    const el = $(id);
    if (el) observer.observe(el);
  }
}

// ---------------------------------------------------------------------------

function wireStaticHandlers() {
  wireNewCategoryForm();
  wireAddChannelForms();
  wireCategoryDetailHeader();
  wireChannelSearch();
  wireSettingsForm();
  wireExportImport();
  wireSidebarScrollSpy();
  wireOpenFeedLink();
}

// Same reasoning as feed.js's "Manage" link: a real <a href> so
// middle-click/ctrl-click/"Open in New Tab" still explicitly open a second
// tab, but a plain left click asks background.js to focus an already-open
// feed tab instead of piling up duplicates — reloading it first if anything
// here actually changed since it was last visited, so it doesn't keep
// showing stale categories/channels/settings.
function wireOpenFeedLink() {
  $("open-feed-link").addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    send("OPEN_OR_FOCUS_FEED", { reloadIfExisting: configChangedSinceLastFeedVisit });
    configChangedSinceLastFeedVisit = false;
  });
}

init();
