/* ═══════════════════════════════════════════════════════
   IMPULSE — app.js
═══════════════════════════════════════════════════════ */


/* ╔═══════════════════════════════════════════════════╗
   ║  1. CONSTANTS & STATE                             ║
   ╚═══════════════════════════════════════════════════╝ */

const DB_NAME    = 'impulse-db';
const DB_VERSION = 2;
const ARCHIVE_DAYS = 30;

let db;

// Current open item per mode
let currentThreadId = null;
let currentSceneId  = null;
let currentSparkId  = null;
let currentHypId    = null;
let currentCharId   = null;
let currentStickyId = null;

// Sticky spark editor context
let stickyParentType = null;
let stickyParentId   = null;

// Auto-save debounce timers
let saveTimer        = null;
let sparkSaveTimer   = null;
let hypSaveTimer     = null;
let stickyWriteTimer = null;

// Reorder mode
let sceneSortable = []; // array — one instance per section
let reorderModeOn = false;

// UI state
let sceneSparksOpen = false;
let archiveOpen     = false;

// Modal state
let editingThreadId          = null;
let editingHypId             = null;
let finishModalReturnToList  = false;
let pendingImportData        = null;
let pendingNewThreadCallback = null; // set when new-thread modal opens from a promote flow


/* ╔═══════════════════════════════════════════════════╗
   ║  2. DATABASE                                      ║
   ╚═══════════════════════════════════════════════════╝ */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db     = e.target.result;
      const oldVer = e.oldVersion;

      if (!db.objectStoreNames.contains('threads')) {
        const ts = db.createObjectStore('threads', { keyPath: 'id' });
        ts.createIndex('updated_at', 'updated_at');
      }
      if (!db.objectStoreNames.contains('scenes')) {
        const ss = db.createObjectStore('scenes', { keyPath: 'id' });
        ss.createIndex('thread_id', 'thread_id');
        ss.createIndex('updated_at', 'updated_at');
      }
      if (!db.objectStoreNames.contains('sparks')) {
        const sp = db.createObjectStore('sparks', { keyPath: 'id' });
        sp.createIndex('parent_id', 'parent_id');
      }
      if (!db.objectStoreNames.contains('hypotheticals')) {
        db.createObjectStore('hypotheticals', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('hyp_answers')) {
        const ha = db.createObjectStore('hyp_answers', { keyPath: 'id' });
        ha.createIndex('hypothetical_id', 'hypothetical_id');
      }
      if (!db.objectStoreNames.contains('characters')) {
        db.createObjectStore('characters', { keyPath: 'id' });
      }

      // v1 → v2: add parent_id index to existing sparks store
      if (oldVer === 1) {
        const tx          = e.target.transaction;
        const sparksStore = tx.objectStore('sparks');
        if (!sparksStore.indexNames.contains('parent_id')) {
          sparksStore.createIndex('parent_id', 'parent_id');
        }
      }
    };

    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onerror   = (e) => reject(e.target.error);
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function dbGet(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function dbPut(storeName, record) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).put(record);
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).delete(id);
    request.onsuccess = () => resolve();
    request.onerror   = () => reject(request.error);
  });
}

function dbGetByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readonly');
    const index   = tx.objectStore(storeName).index(indexName);
    const request = index.getAll(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

async function getMostRecentScene() {
  const scenes = await dbGetAll('scenes');
  if (!scenes.length) return null;
  return scenes.sort((a, b) => b.updated_at - a.updated_at)[0];
}

function getSparksByParent(parentId) {
  return dbGetByIndex('sparks', 'parent_id', parentId);
}

function clearAllStores() {
  const storeNames = ['threads', 'scenes', 'sparks', 'hypotheticals', 'hyp_answers', 'characters'];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    storeNames.forEach(name => tx.objectStore(name).clear());
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}


/* ╔═══════════════════════════════════════════════════╗
   ║  3. UTILITIES                                     ║
   ╚═══════════════════════════════════════════════════╝ */

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Converts *asterisk* / _underscore_ Markdown to HTML.
// Supports: ***bold italic***, **bold**, *italic*
// Runs escapeHtml first so user text can't inject HTML.
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/___([^\s][\s\S]+?[^\s])___/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^\s][\s\S]*?[^\s])__/g,   '<strong>$1</strong>')
    .replace(/\*([\s\S]+?)\*/g, '<em>$1</em>')
    .replace(/_([^\s][^_]*?[^\s])_/g,       '<em>$1</em>');
  return html;
}

// Strips basic Markdown and returns the first line as plain text.
// Used for card preview snippets.
function plainFirstLine(text) {
  if (!text) return '';
  return text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .split('\n')[0].trim();
}

// Updates the write-preview div with live Markdown.
function updatePreview() {
  const ta      = document.getElementById('write-textarea');
  const preview = document.getElementById('write-preview');
  preview.innerHTML = renderMarkdown(ta.value);
}

// Resets all state variables to null/false.
// Called on data clear and restore.
function resetAllState() {
  currentThreadId = null;
  currentSceneId  = null;
  currentSparkId  = null;
  currentHypId    = null;
  currentCharId   = null;
  currentStickyId = null;
  stickyParentType = null;
  stickyParentId   = null;
  editingThreadId          = null;
  editingHypId             = null;
  archiveOpen              = false;
  reorderModeOn            = false;
  sceneSparksOpen          = false;
  finishModalReturnToList  = false;
  pendingNewThreadCallback = null;
  sceneSortable.forEach(s => s.destroy());
  sceneSortable = [];
}


/* ╔═══════════════════════════════════════════════════╗
   ║  4. NAVIGATION                                    ║
   ╚═══════════════════════════════════════════════════╝ */

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + id);
  if (target) {
    target.classList.add('active');
    target.scrollTop = 0;
  }
  if (id !== 'home') history.pushState({ screen: id }, '', '');
  if (id === 'home') checkBackupNudge();
}

// Android hardware / gesture back button
window.addEventListener('popstate', () => {
  // Close any open overlay first
  if (!document.getElementById('finish-overlay').classList.contains('hidden'))          { closeFinishModal();    return; }
  if (!document.getElementById('new-thread-overlay').classList.contains('hidden'))      { closeNewThreadModal(); return; }
  if (!document.getElementById('edit-thread-overlay').classList.contains('hidden'))     { closeEditThreadModal(); return; }
  if (!document.getElementById('spark-finish-overlay').classList.contains('hidden'))    { document.getElementById('spark-finish-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('new-hyp-overlay').classList.contains('hidden'))         { document.getElementById('new-hyp-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('manage-chars-overlay').classList.contains('hidden'))    { document.getElementById('manage-chars-overlay').classList.add('hidden'); renderHypCharactersList(currentHypId); return; }
  if (!document.getElementById('promote-spark-overlay').classList.contains('hidden'))   { document.getElementById('promote-spark-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('pick-thread-overlay').classList.contains('hidden'))     { document.getElementById('pick-thread-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('settings-overlay').classList.contains('hidden'))        { closeSettings();       return; }
  if (!document.getElementById('confirm-clear-overlay').classList.contains('hidden'))   { document.getElementById('confirm-clear-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('confirm-restore-overlay').classList.contains('hidden')) { document.getElementById('confirm-restore-overlay').classList.add('hidden'); pendingImportData = null; return; }
  if (!document.getElementById('action-sheet-overlay').classList.contains('hidden'))    { closeActionSheet();    return; }

  const active = document.querySelector('.screen.active');
  if (!active) return;
  const id = active.id.replace('screen-', '');

  if      (id === 'write')           navigateBackFromWrite();
  else if (id === 'scenes')          navigateBackFromScenes();
  else if (id === 'threads')         showScreen('home');
  else if (id === 'spark-write')     leaveSpark();
  else if (id === 'sticky-write')    leaveStickySparkEditor();
  else if (id === 'hyp-characters')  { showScreen('hypothetical'); renderHypList(); }
  else if (id === 'hyp-write')       { saveCurrentHypAnswer(); showScreen('hyp-characters'); renderHypCharactersList(currentHypId); }
  else                               showScreen('home');
});

async function navigateBackFromWrite() {
  if (currentSceneId) {
    const ta = document.getElementById('write-textarea');
    if (!ta.readOnly && !ta.value.trim()) {
      await dbDelete('scenes', currentSceneId);
      currentSceneId = null;
    } else {
      await saveCurrentScene();
    }
  }
  showScreen('scenes');
  if (currentThreadId) renderScenesList(currentThreadId);
}

async function navigateBackFromScenes() {
  exitReorderMode();
  showScreen('threads');
  renderThreadsList();
}

// Wire up dedicated back buttons
document.getElementById('write-back-btn').addEventListener('click', navigateBackFromWrite);
document.getElementById('scenes-back-btn').addEventListener('click', navigateBackFromScenes);

// Home buttons that save current scene before leaving
document.getElementById('write-home-btn').addEventListener('click', async () => {
  await saveCurrentScene();
  exitReorderMode();
  showScreen('home');
});

document.getElementById('scenes-home-btn').addEventListener('click', () => {
  exitReorderMode();
  showScreen('home');
});

// Generic home buttons (data-target="home")
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.home-btn[data-target]');
  if (btn) {
    exitReorderMode();
    showScreen(btn.dataset.target);
  }
});


/* ╔═══════════════════════════════════════════════════╗
   ║  5. HOME SCREEN                                   ║
   ╚═══════════════════════════════════════════════════╝ */

document.getElementById('btn-continue').addEventListener('click', async () => {
  const recent = await getMostRecentScene();
  if (recent) {
    await openScene(recent.id);
  } else {
    showScreen('threads');
    renderThreadsList();
  }
});

document.getElementById('btn-spark').addEventListener('click', () => {
  showScreen('spark');
  renderSparkList();
});

document.getElementById('btn-hypothetical').addEventListener('click', () => {
  showScreen('hypothetical');
  renderHypList();
});


/* ╔═══════════════════════════════════════════════════╗
   ║  6. CONTINUE MODE                                 ║
   ╚═══════════════════════════════════════════════════╝ */


/* ── Threads List ─────────────────────────────────────*/
async function renderThreadsList() {
  const list    = document.getElementById('threads-list');
  const empty   = document.getElementById('threads-empty');
  const threads = await dbGetAll('threads');

  threads.sort((a, b) => b.updated_at - a.updated_at);
  list.innerHTML = '';

  const hasThreads = threads.length > 0;
  empty.style.display = hasThreads ? 'none' : 'flex';
  if (!hasThreads) return;

  for (const thread of threads) {
    const btn = document.createElement('button');
    btn.className = 'list-item';
    btn.innerHTML = `
      <span class="list-item__dot"></span>
      <span class="list-item__body">
        <span class="list-item__title">${escapeHtml(thread.title)}</span>
        ${thread.synopsis ? `<span class="list-item__sub">${escapeHtml(thread.synopsis)}</span>` : ''}
      </span>
      <svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    `;
    btn.addEventListener('click', () => openThreadScenes(thread.id));
    attachThreadLongPress(btn, thread);
    list.appendChild(btn);
  }
}

async function openThreadScenes(threadId) {
  currentThreadId = threadId;
  const thread = await dbGet('threads', threadId);
  document.getElementById('scenes-thread-title').textContent    = thread.title;
  document.getElementById('scenes-thread-synopsis').textContent = thread.synopsis || '';
  showScreen('scenes');
  renderScenesList(threadId);
}


/* ── Scenes List ──────────────────────────────────────*/

// Within a section: null sort_order floats to top (newest first among nulls),
// then explicit sort_order ascending.
function sortSection(items, dateField = 'created_at') {
  return [...items].sort((a, b) => {
    const aHas = a.sort_order != null;
    const bHas = b.sort_order != null;
    if (!aHas && !bHas) return b[dateField] - a[dateField];
    if (!aHas) return -1;
    if (!bHas) return 1;
    return a.sort_order - b.sort_order;
  });
}

// Builds a single scene list-item element.
function makeSceneItem(scene, number) {
  const item = document.createElement('div');
  item.className  = 'list-item' + (scene.is_complete ? ' list-item--complete' : '');
  item.dataset.id = scene.id;

  const titleText  = scene.title || `Scene ${number}`;
  const titleClass = scene.title ? '' : ' list-item__title--untitled';
  const wordCount  = scene.body ? scene.body.trim().split(/\s+/).filter(Boolean).length : 0;
  const subText    = scene.synopsis || `${wordCount} word${wordCount !== 1 ? 's' : ''}`;

  item.innerHTML = `
    <span class="list-item__drag" aria-label="Drag to reorder">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/>
      </svg>
    </span>
    <span class="list-item__dot"></span>
    <span class="list-item__body">
      <span class="list-item__title${titleClass}">${escapeHtml(titleText)}</span>
      <span class="list-item__sub">${escapeHtml(subText)}</span>
    </span>
    ${scene.is_complete ? '<span class="list-item__badge">done</span>' : ''}
    <svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
  `;

  item.addEventListener('click', () => {
    if (reorderModeOn) return;
    if (scene.is_complete) openSceneViewMode(scene.id);
    else openScene(scene.id);
  });

  attachSceneLongPress(item, scene, titleText);
  return item;
}

async function renderScenesList(threadId) {
  const list  = document.getElementById('scenes-list');
  const empty = document.getElementById('scenes-empty');

  // Destroy all existing sortable instances before rebuilding.
  sceneSortable.forEach(s => s.destroy());
  sceneSortable = [];
  list.innerHTML = '';

  const scenes    = await dbGetByIndex('scenes', 'thread_id', threadId);
  const allSparks = await getSparksByParent(threadId);
  const ideas     = allSparks.filter(s => s.parent_type === 'thread');

  const inProgress = scenes.filter(s => !s.is_complete);
  const completed  = scenes.filter(s => s.is_complete);

  const hasContent = ideas.length > 0 || inProgress.length > 0 || completed.length > 0;
  empty.style.display = hasContent ? 'none' : 'flex';
  if (!hasContent) return;

  // Stable scene numbers based on creation order (unaffected by display order).
  const chronological = [...scenes].sort((a, b) => a.created_at - b.created_at);
  const sceneNumber   = scene => chronological.findIndex(s => s.id === scene.id) + 1;

  // Show section labels only when 2+ sections are populated.
  const populated = [ideas.length > 0, inProgress.length > 0, completed.length > 0].filter(Boolean).length;
  const showLabels = populated > 1;

  function makeSectionLabel(text) {
    const el = document.createElement('p');
    el.className   = 'scenes-section-label';
    el.textContent = text;
    return el;
  }

  // Creates a section container and registers a SortableJS instance for it.
  function makeSection(items, renderItem, store, itemSelector, dateField = 'created_at') {
    const container = document.createElement('div');
    container.className = 'scenes-section';
    sortSection(items, dateField).forEach(item => container.appendChild(renderItem(item)));

    const instance = Sortable.create(container, {
      handle: '.list-item__drag',
      animation: 150,
      chosenClass: 'sortable-chosen',
      touchStartThreshold: 3,
      onEnd: async () => {
        const updates = [];
        container.querySelectorAll(itemSelector).forEach((el, index) => {
          updates.push(
            dbGet(store, el.dataset.id).then(record => {
              if (!record) return;
              record.sort_order = index;
              return dbPut(store, record);
            })
          );
        });
        await Promise.all(updates);
      }
    });
    sceneSortable.push(instance);
    return container;
  }

  // ── Ideas ──────────────────────────────────────────
  if (ideas.length > 0) {
    if (showLabels) list.appendChild(makeSectionLabel('Ideas'));
    list.appendChild(makeSection(ideas, s => makeIdeaCard(s, 'thread'), 'sparks', '.idea-card--thread'));
  }

  // ── In Progress ────────────────────────────────────
  if (inProgress.length > 0) {
    if (showLabels) list.appendChild(makeSectionLabel('In Progress'));
    list.appendChild(makeSection(inProgress, s => makeSceneItem(s, sceneNumber(s)), 'scenes', '.list-item'));
  }

  // ── Done ───────────────────────────────────────────
  if (completed.length > 0) {
    if (showLabels) list.appendChild(makeSectionLabel('Done'));
    list.appendChild(makeSection(completed, s => makeSceneItem(s, sceneNumber(s)), 'scenes', '.list-item', 'updated_at'));
  }

  if (reorderModeOn) list.classList.add('list-body--reorder');
}


/* ── Reorder Mode/* ── Reorder Mode ─────────────────────────────────────*/
document.getElementById('btn-reorder-scenes').addEventListener('click', exitReorderMode);

function enterReorderMode() {
  reorderModeOn = true;
  document.getElementById('scenes-list').classList.add('list-body--reorder');
  sceneSortable.forEach(s => s.option('handle', '.list-item, .idea-card--thread'));
  const btn = document.getElementById('btn-reorder-scenes');
  btn.classList.add('active');
  btn.textContent = 'done';
  btn.hidden = false;
}

function exitReorderMode() {
  if (!reorderModeOn) return;
  reorderModeOn = false;
  document.getElementById('scenes-list').classList.remove('list-body--reorder');
  sceneSortable.forEach(s => s.option('handle', '.list-item__drag'));
  const btn = document.getElementById('btn-reorder-scenes');
  btn.classList.remove('active');
  btn.textContent = 'done';
  btn.hidden = true;
}


/* ── Write Mode ───────────────────────────────────────*/
async function openScene(sceneId) {
  exitReorderMode();
  const scene  = await dbGet('scenes', sceneId);
  const thread = await dbGet('threads', scene.thread_id);

  currentSceneId  = scene.id;
  currentThreadId = scene.thread_id;

  document.getElementById('scenes-thread-title').textContent    = thread.title;
  document.getElementById('scenes-thread-synopsis').textContent = thread.synopsis || '';
  document.getElementById('write-label').textContent = thread.title;
  document.getElementById('write-finish-btn').hidden = false;
  document.getElementById('write-edit-btn').hidden   = true;
  document.getElementById('write-header').classList.remove('write-header--view');

  const ta    = document.getElementById('write-textarea');
  ta.value    = scene.body || '';
  ta.readOnly = false;
  ta.placeholder = 'begin writing…';
  ta.closest('.write-body').classList.remove('write-body--preview');

  showScreen('write');
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 300);

  await refreshSceneSparkPanel();
}


/* ── View Mode ────────────────────────────────────────*/
async function openSceneViewMode(sceneId) {
  exitReorderMode();
  const scene  = await dbGet('scenes', sceneId);
  const thread = await dbGet('threads', scene.thread_id);

  currentSceneId  = scene.id;
  currentThreadId = scene.thread_id;

  document.getElementById('scenes-thread-title').textContent    = thread.title;
  document.getElementById('scenes-thread-synopsis').textContent = thread.synopsis || '';

  const label = scene.title ? `${thread.title}  ·  ${scene.title}` : thread.title;
  document.getElementById('write-label').textContent = label;
  document.getElementById('write-finish-btn').hidden = true;
  document.getElementById('write-edit-btn').hidden   = false;
  document.getElementById('write-header').classList.add('write-header--view');

  const ta    = document.getElementById('write-textarea');
  ta.value    = scene.body || '';
  ta.readOnly = true;
  ta.placeholder = '';

  updatePreview();
  ta.closest('.write-body').classList.add('write-body--preview');

  showScreen('write');
  await refreshSceneSparkPanel();
}

// Edit button — reopen completed scene for writing
document.getElementById('write-edit-btn').addEventListener('click', async () => {
  if (!currentSceneId) return;
  const scene       = await dbGet('scenes', currentSceneId);
  scene.is_complete = false;
  scene.sort_order  = null; // float to top of In Progress
  scene.updated_at  = Date.now();
  await dbPut('scenes', scene);
  openScene(currentSceneId);
});

// Auto-save + live Markdown preview on every keystroke
document.getElementById('write-textarea').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentScene, 800);
  updatePreview();
});

async function saveCurrentScene() {
  if (!currentSceneId) return;
  const ta = document.getElementById('write-textarea');
  if (ta.readOnly) return;

  const scene = await dbGet('scenes', currentSceneId);
  if (!scene) return;
  scene.body       = ta.value;
  scene.updated_at = Date.now();
  await dbPut('scenes', scene);

  const thread = await dbGet('threads', scene.thread_id);
  if (thread) { thread.updated_at = Date.now(); await dbPut('threads', thread); }
}


/* ── Finish Modal ─────────────────────────────────────*/
document.getElementById('write-finish-btn').addEventListener('click', async () => {
  await saveCurrentScene();
  const scene = await dbGet('scenes', currentSceneId);
  document.getElementById('finish-title').value    = scene.title    || '';
  document.getElementById('finish-synopsis').value = scene.synopsis || '';
  openFinishModal();
});

// Opens the modal in "finish" mode — marks scene complete on save/skip.
function openFinishModal() {
  finishModalReturnToList = false;
  document.querySelector('#finish-overlay .sheet-title').textContent = 'Scene complete';
  document.querySelector('#finish-overlay .finish-checkmark').style.visibility = '';
  document.querySelector('#finish-overlay .sheet-note').textContent = 'Want to give this scene a name or note? Totally optional.';
  document.getElementById('finish-skip-btn').textContent = 'Skip';
  document.getElementById('finish-overlay').classList.remove('hidden');
}

// Opens the modal in "edit" mode — saves title/note only, no complete state change.
async function openFinishModalForScene(sceneId) {
  currentSceneId = sceneId;
  const scene = await dbGet('scenes', sceneId);
  document.getElementById('finish-title').value    = scene.title    || '';
  document.getElementById('finish-synopsis').value = scene.synopsis || '';
  finishModalReturnToList = true;
  document.querySelector('#finish-overlay .sheet-title').textContent = 'Edit scene';
  document.querySelector('#finish-overlay .finish-checkmark').style.visibility = 'hidden';
  document.querySelector('#finish-overlay .sheet-note').textContent = 'Update this scene\'s title or note.';
  document.getElementById('finish-skip-btn').textContent = 'Cancel';
  document.getElementById('finish-overlay').classList.remove('hidden');
}

function closeFinishModal() {
  document.getElementById('finish-overlay').classList.add('hidden');
  finishModalReturnToList = false;
}

document.getElementById('finish-backdrop').addEventListener('click', closeFinishModal);

document.getElementById('finish-save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('finish-title').value.trim();
  const synopsis = document.getElementById('finish-synopsis').value.trim();

  if (currentSceneId) {
    const scene       = await dbGet('scenes', currentSceneId);
    scene.is_complete = finishModalReturnToList ? scene.is_complete : true;
    if (!finishModalReturnToList) scene.sort_order = null; // float to top of Done
    scene.title       = title;
    scene.synopsis    = synopsis;
    scene.updated_at  = Date.now();
    await dbPut('scenes', scene);
  }

  closeFinishModal();
  showScreen('scenes');
  renderScenesList(currentThreadId);
});

document.getElementById('finish-skip-btn').addEventListener('click', async () => {
  if (finishModalReturnToList) {
    // In edit mode, "Cancel" just closes without changing anything.
    closeFinishModal();
    return;
  }
  // In finish mode, "Skip" marks the scene complete and returns to list.
  if (currentSceneId) {
    const scene       = await dbGet('scenes', currentSceneId);
    scene.is_complete = true;
    scene.sort_order  = null; // float to top of Done
    scene.updated_at  = Date.now();
    await dbPut('scenes', scene);
  }
  closeFinishModal();
  showScreen('scenes');
  renderScenesList(currentThreadId);
});


/* ── New Thread Modal ─────────────────────────────────
   Pass suggestedTitle and a callback to use from promote flows.
   When called with no args it behaves as normal (create + open).
─────────────────────────────────────────────────────── */
document.getElementById('btn-new-thread').addEventListener('click', () => openNewThreadModal());

function openNewThreadModal(suggestedTitle = '', callback = null) {
  document.getElementById('new-thread-title').value    = suggestedTitle;
  document.getElementById('new-thread-synopsis').value = '';
  pendingNewThreadCallback = callback;
  document.getElementById('new-thread-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-thread-title').focus(), 350);
}

function closeNewThreadModal() {
  document.getElementById('new-thread-overlay').classList.add('hidden');
  pendingNewThreadCallback = null;
}

document.getElementById('new-thread-backdrop').addEventListener('click', closeNewThreadModal);
document.getElementById('new-thread-cancel-btn').addEventListener('click', closeNewThreadModal);

document.getElementById('new-thread-save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('new-thread-title').value.trim();
  const synopsis = document.getElementById('new-thread-synopsis').value.trim();

  if (!title) {
    const input = document.getElementById('new-thread-title');
    input.style.borderColor = 'var(--rose)';
    input.focus();
    return;
  }

  const now      = Date.now();
  const threadId = generateId();
  await dbPut('threads', { id: threadId, title, synopsis, created_at: now, updated_at: now });
  const cb = pendingNewThreadCallback;
  closeNewThreadModal();

  if (cb) {
    await cb(threadId);
  } else {
    // Default: create first empty scene and open it
    const sceneId = generateId();
    await dbPut('scenes', {
      id: sceneId, thread_id: threadId,
      title: '', synopsis: '', body: '',
      is_complete: false, created_at: now, updated_at: now,
    });
    await openScene(sceneId);
  }
});


/* ── Edit Thread Modal ────────────────────────────────*/
function openEditThreadModal(thread) {
  editingThreadId = thread.id;
  document.getElementById('edit-thread-title').value    = thread.title;
  document.getElementById('edit-thread-synopsis').value = thread.synopsis || '';
  document.getElementById('edit-thread-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-thread-title').focus(), 350);
}

function closeEditThreadModal() {
  document.getElementById('edit-thread-overlay').classList.add('hidden');
  editingThreadId = null;
}

document.getElementById('edit-thread-backdrop').addEventListener('click', closeEditThreadModal);
document.getElementById('edit-thread-cancel-btn').addEventListener('click', closeEditThreadModal);

document.getElementById('edit-thread-save-btn').addEventListener('click', async () => {
  const title    = document.getElementById('edit-thread-title').value.trim();
  const synopsis = document.getElementById('edit-thread-synopsis').value.trim();
  if (!title) {
    document.getElementById('edit-thread-title').style.borderColor = 'var(--rose)';
    document.getElementById('edit-thread-title').focus();
    return;
  }
  const thread      = await dbGet('threads', editingThreadId);
  thread.title      = title;
  thread.synopsis   = synopsis;
  thread.updated_at = Date.now();
  await dbPut('threads', thread);
  closeEditThreadModal();
  renderThreadsList();
  // Update scenes header if we're currently inside this thread
  if (currentThreadId === thread.id) {
    document.getElementById('scenes-thread-title').textContent    = title;
    document.getElementById('scenes-thread-synopsis').textContent = synopsis;
  }
});


/* ── New Scene Button ─────────────────────────────────*/
document.getElementById('btn-new-scene').addEventListener('click', async () => {
  if (!currentThreadId) return;
  const now     = Date.now();
  const sceneId = generateId();
  // null sort_order → floats to top of In Progress section automatically
  await dbPut('scenes', {
    id: sceneId, thread_id: currentThreadId,
    title: '', synopsis: '', body: '',
    is_complete: false,
    created_at: now, updated_at: now,
  });
  await openScene(sceneId);
});


/* ── Long-press: Thread ───────────────────────────────*/
function attachThreadLongPress(element, thread) {
  addLongPress(element, () => {
    showActionSheet(`"${thread.title}"`, [
      { label: 'Edit title & synopsis',    danger: false, action: () => openEditThreadModal(thread) },
      { label: 'Delete thread & all scenes', danger: true, action: () => deleteThread(thread.id) },
    ]);
  });
}

async function deleteThread(threadId) {
  const scenes = await dbGetByIndex('scenes', 'thread_id', threadId);
  for (const scene of scenes) await dbDelete('scenes', scene.id);
  // Also delete any sparks attached to this thread
  const sparks = await getSparksByParent(threadId);
  for (const spark of sparks) await dbDelete('sparks', spark.id);
  await dbDelete('threads', threadId);
  renderThreadsList();
}


/* ── Long-press: Scene ────────────────────────────────*/
function attachSceneLongPress(element, scene, sceneTitle) {
  addLongPress(element, () => {
    if (reorderModeOn) return;
    showActionSheet(`"${sceneTitle}"`, [
      { label: 'Edit title & note', danger: false, action: () => openFinishModalForScene(scene.id) },
      { label: 'Reorder',           danger: false, action: () => enterReorderMode() },
      { label: 'Delete scene',      danger: true,  action: () => deleteScene(scene.id) },
    ]);
  });
}

async function deleteScene(sceneId) {
  // Also delete any sparks attached to this scene
  const sparks = await getSparksByParent(sceneId);
  for (const spark of sparks) await dbDelete('sparks', spark.id);
  await dbDelete('scenes', sceneId);
  renderScenesList(currentThreadId);
}


/* ╔═══════════════════════════════════════════════════╗
   ║  7. SPARK MODE                                    ║
   ╚═══════════════════════════════════════════════════╝ */


/* ── Spark List ───────────────────────────────────────*/
async function renderSparkList() {
  const list      = document.getElementById('spark-list');
  const empty     = document.getElementById('spark-empty');
  const allSparks = await dbGetAll('sparks');
  const sparks    = allSparks.filter(s => !s.parent_type);
  const cutoff    = Date.now() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

  const open     = sparks.filter(s => !s.is_complete && !(s.body && s.body.trim()));
  const inProg   = sparks.filter(s => !s.is_complete && s.body && s.body.trim());
  const recent   = sparks.filter(s => s.is_complete && (s.completed_at || 0) >= cutoff);
  const archived = sparks.filter(s => s.is_complete && (s.completed_at || 0) < cutoff);

  const byNewest = (a, b) => b.created_at - a.created_at;
  open.sort(byNewest);
  inProg.sort(byNewest);
  recent.sort((a, b) => b.completed_at - a.completed_at);
  archived.sort((a, b) => b.completed_at - a.completed_at);

  list.innerHTML = '';
  const total = open.length + inProg.length + recent.length;
  empty.style.display = (total === 0 && archived.length === 0) ? 'flex' : 'none';

  [...open, ...inProg, ...recent].forEach(spark => list.appendChild(makeSparkItem(spark)));

  const archiveSection = document.getElementById('spark-archive-section');
  const archiveList    = document.getElementById('spark-archive-list');
  if (archived.length > 0) {
    archiveSection.hidden = false;
    archiveList.innerHTML = '';
    archived.forEach(spark => archiveList.appendChild(makeSparkItem(spark)));
    archiveList.hidden = !archiveOpen;
    document.getElementById('spark-archive-toggle').classList.toggle('open', archiveOpen);
  } else {
    archiveSection.hidden = true;
  }
}

function makeSparkItem(spark) {
  const item = document.createElement('div');
  item.className  = 'spark-card' + (spark.is_complete ? ' spark-card--complete' : '');
  item.dataset.id = spark.id;

  const titleText     = spark.title || 'Untitled idea';
  const hasConclusion = spark.body && spark.body.trim().length > 0;
  const wordCount     = hasConclusion ? spark.body.trim().split(/\s+/).filter(Boolean).length : 0;
  const plainPreview  = plainFirstLine(spark.body);

  let inner = `<div class="spark-card__prompt-wrap"><p class="spark-card__prompt">${escapeHtml(titleText)}</p></div>`;

  if (spark.is_complete && hasConclusion) {
    inner += `
      <div class="spark-card__divider"></div>
      <p class="spark-card__conclusion">${escapeHtml(plainPreview)}</p>
      <div class="spark-card__footer"><span class="spark-card__meta">${wordCount} word${wordCount !== 1 ? 's' : ''}</span></div>`;
  } else if (spark.is_complete) {
    inner += `<div class="spark-card__footer"><span class="spark-card__meta">no conclusion yet</span></div>`;
  } else if (hasConclusion) {
    inner += `
      <div class="spark-card__divider"></div>
      <p class="spark-card__conclusion">${escapeHtml(plainPreview)}</p>
      <div class="spark-card__footer"><span class="spark-card__in-progress">in progress · ${wordCount} word${wordCount !== 1 ? 's' : ''}</span></div>`;
  } else {
    inner += `<span class="spark-card__unanswered">unanswered</span>`;
  }

  item.innerHTML = inner;
  item.addEventListener('click', () => openSpark(spark.id));
  attachSparkLongPress(item, spark, titleText);
  return item;
}

document.getElementById('spark-archive-toggle').addEventListener('click', () => {
  archiveOpen = !archiveOpen;
  document.getElementById('spark-archive-list').hidden = !archiveOpen;
  document.getElementById('spark-archive-toggle').classList.toggle('open', archiveOpen);
});


/* ── Open a Spark ─────────────────────────────────────*/
async function openSpark(sparkId) {
  const spark    = await dbGet('sparks', sparkId);
  currentSparkId = spark.id;

  const ideaField = document.getElementById('spark-idea-field');
  const ta        = document.getElementById('spark-textarea');

  ideaField.value = spark.title || '';
  ta.value        = spark.body  || '';

  document.getElementById('spark-write-body').classList.remove('write-body--preview');
  document.getElementById('spark-write-header').classList.remove('write-header--view');
  document.getElementById('spark-finish-btn').hidden = false;
  document.getElementById('spark-edit-btn').hidden   = true;

  resetIdeaFieldHeight();
  updateSparkFinishBtn();

  if (spark.is_complete) { openSparkViewMode(spark); return; }

  ideaField.readOnly = false;
  ta.readOnly        = false;
  showScreen('spark-write');
  setTimeout(() => {
    if (!ideaField.value.trim()) ideaField.focus();
    else { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }, 300);
}

function openSparkViewMode(spark) {
  const ideaField = document.getElementById('spark-idea-field');
  const ta        = document.getElementById('spark-textarea');
  ideaField.readOnly = true;
  ta.readOnly        = true;
  document.getElementById('spark-finish-btn').hidden = true;
  document.getElementById('spark-edit-btn').hidden   = false;
  document.getElementById('spark-write-header').classList.add('write-header--view');
  document.getElementById('spark-preview').innerHTML = renderMarkdown(ta.value);
  document.getElementById('spark-write-body').classList.add('write-body--preview');
  showScreen('spark-write');
}

function resetSparkWriteScreen() {
  document.getElementById('spark-write-header').classList.remove('write-header--view');
  document.getElementById('spark-write-body').classList.remove('write-body--preview');
  document.getElementById('spark-finish-btn').hidden = false;
  document.getElementById('spark-edit-btn').hidden   = true;
  updateSparkFinishBtn();
}


/* ── New Spark ────────────────────────────────────────*/
document.getElementById('btn-new-spark').addEventListener('click', async () => {
  const now     = Date.now();
  const sparkId = generateId();
  await dbPut('sparks', {
    id: sparkId, title: '', body: '',
    is_complete: false, completed_at: null,
    created_at: now, updated_at: now,
  });
  await openSpark(sparkId);
});


/* ── Edit Button ──────────────────────────────────────*/
document.getElementById('spark-edit-btn').addEventListener('click', async () => {
  if (!currentSparkId) return;
  const spark       = await dbGet('sparks', currentSparkId);
  spark.is_complete = false;
  spark.updated_at  = Date.now();
  await dbPut('sparks', spark);

  const ideaField = document.getElementById('spark-idea-field');
  const ta        = document.getElementById('spark-textarea');
  ideaField.readOnly = false;
  ta.readOnly        = false;
  document.getElementById('spark-write-body').classList.remove('write-body--preview');
  document.getElementById('spark-write-header').classList.remove('write-header--view');
  document.getElementById('spark-finish-btn').hidden = false;
  document.getElementById('spark-edit-btn').hidden   = true;
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 100);
});


/* ── Finish button gating — only enabled when conclusion has content ──*/
function updateSparkFinishBtn() {
  const hasContent = document.getElementById('spark-textarea').value.trim().length > 0;
  const btn = document.getElementById('spark-finish-btn');
  btn.style.opacity       = hasContent ? '1' : '0.3';
  btn.style.pointerEvents = hasContent ? 'all' : 'none';
}

// Full reset — sets height correctly from scratch. Use on open only.
function resetIdeaFieldHeight() {
  const field = document.getElementById('spark-idea-field');
  field.style.height = 'auto';
  field.style.height = field.scrollHeight + 'px';
}

// Grow-only resize — called on every keystroke.
// Never collapses to 'auto', because that momentary collapse triggers
// the browser's scroll-to-focused logic which on mobile (where the
// visual viewport is smaller than the layout viewport due to the
// keyboard) snaps the screen down past the keyboard on every keypress.
function autoResizeIdeaField() {
  const field = document.getElementById('spark-idea-field');
  const needed = field.scrollHeight;
  if (needed > field.offsetHeight) {
    field.style.height = needed + 'px';
  }
}

document.getElementById('spark-idea-field').addEventListener('input', () => {
  autoResizeIdeaField();
  clearTimeout(sparkSaveTimer);
  sparkSaveTimer = setTimeout(saveCurrentSpark, 800);
});

document.getElementById('spark-textarea').addEventListener('input', () => {
  clearTimeout(sparkSaveTimer);
  sparkSaveTimer = setTimeout(saveCurrentSpark, 800);
  updateSparkFinishBtn();
  document.getElementById('spark-preview').innerHTML = renderMarkdown(
    document.getElementById('spark-textarea').value
  );
});


/* ── Auto-save ────────────────────────────────────────*/
async function saveCurrentSpark() {
  if (!currentSparkId) return;
  const ta = document.getElementById('spark-textarea');
  if (ta.readOnly) return;
  const spark = await dbGet('sparks', currentSparkId);
  if (!spark) return;
  spark.title      = document.getElementById('spark-idea-field').value.trim();
  spark.body       = ta.value;
  spark.updated_at = Date.now();
  await dbPut('sparks', spark);
}

async function discardSparkIfEmpty() {
  if (!currentSparkId) return;
  const ideaField = document.getElementById('spark-idea-field');
  const ta        = document.getElementById('spark-textarea');
  if (!ideaField.value.trim() && !ta.value.trim()) {
    await dbDelete('sparks', currentSparkId);
  } else {
    await saveCurrentSpark();
  }
}

// Shared function for leaving the spark write screen
async function leaveSpark() {
  await discardSparkIfEmpty();
  resetSparkWriteScreen();
  showScreen('spark');
  renderSparkList();
}


/* ── Back / Home ──────────────────────────────────────*/
document.getElementById('spark-write-back-btn').addEventListener('click', leaveSpark);
document.getElementById('spark-write-home-btn').addEventListener('click', async () => {
  await discardSparkIfEmpty();
  resetSparkWriteScreen();
  showScreen('home');
});


/* ── Finish ───────────────────────────────────────────*/
document.getElementById('spark-finish-btn').addEventListener('click', async () => {
  await saveCurrentSpark();
  document.getElementById('spark-finish-overlay').classList.remove('hidden');
});

document.getElementById('spark-finish-backdrop').addEventListener('click', () => {
  document.getElementById('spark-finish-overlay').classList.add('hidden');
});

document.getElementById('spark-finish-save-btn').addEventListener('click', async () => {
  const spark        = await dbGet('sparks', currentSparkId);
  spark.title        = spark.title || (spark.body || '').split('\n')[0].slice(0, 60).trim();
  spark.is_complete  = true;
  spark.completed_at = Date.now();
  spark.updated_at   = Date.now();
  await dbPut('sparks', spark);
  document.getElementById('spark-finish-overlay').classList.add('hidden');
  resetSparkWriteScreen();
  showScreen('spark');
  renderSparkList();
});

document.getElementById('spark-finish-skip-btn').addEventListener('click', () => {
  document.getElementById('spark-finish-overlay').classList.add('hidden');
});

async function deleteSpark(sparkId) {
  await dbDelete('sparks', sparkId);
  renderSparkList();
}


/* ── Long-press: Spark ────────────────────────────────*/
function attachSparkLongPress(element, spark, titleText) {
  addLongPress(element, () => {
    showActionSheet(`"${titleText}"`, [
      { label: 'Promote / attach…', danger: false, action: () => openPromoteSparkModal(spark) },
      { label: 'Delete idea',       danger: true,  action: () => deleteSpark(spark.id) },
    ]);
  });
}


/* ╔═══════════════════════════════════════════════════╗
   ║  8. HYPOTHETICAL MODE                             ║
   ╚═══════════════════════════════════════════════════╝ */


/* ── Hypotheticals List ───────────────────────────────*/
async function renderHypList() {
  const list  = document.getElementById('hyp-list');
  const empty = document.getElementById('hyp-empty');
  const hyps  = await dbGetAll('hypotheticals');

  hyps.sort((a, b) => b.created_at - a.created_at);
  list.innerHTML = '';
  empty.style.display = hyps.length === 0 ? 'flex' : 'none';

  for (const hyp of hyps) {
    const card = await makeHypCard(hyp);
    list.appendChild(card);
  }
}

async function makeHypCard(hyp) {
  const card = document.createElement('div');
  card.className  = 'hyp-card';
  card.dataset.id = hyp.id;

  const answers    = await dbGetByIndex('hyp_answers', 'hypothetical_id', hyp.id);
  const allChars   = await dbGetAll('characters');

  const answeredIds = new Set(answers.filter(a => a.body?.trim() && a.is_complete).map(a => a.character_id));
  const inProgIds   = new Set(answers.filter(a => a.body?.trim() && !a.is_complete).map(a => a.character_id));
  const activeChars = allChars.filter(c => !c.archived);

  const allChipsChars = [
    ...allChars.filter(c => answeredIds.has(c.id)),
    ...allChars.filter(c => inProgIds.has(c.id)),
  ];

  const MAX_CHIPS = 8;
  const shown     = allChipsChars.slice(0, MAX_CHIPS);
  const overflow  = allChipsChars.length - MAX_CHIPS;

  let chipsHtml = '';
  if (activeChars.length === 0) {
    chipsHtml = `<p class="hyp-card__no-chars">no characters yet</p>`;
  } else if (allChipsChars.length === 0) {
    chipsHtml = `<p class="hyp-card__no-chars">no answers yet</p>`;
  } else {
    chipsHtml = `<div class="hyp-card__chips">`;
    shown.forEach(c => {
      const cls = answeredIds.has(c.id) ? 'hyp-chip--answered' : 'hyp-chip--inprog';
      chipsHtml += `<span class="hyp-chip ${cls}">${escapeHtml(c.name)}</span>`;
    });
    if (overflow > 0) chipsHtml += `<span class="hyp-chip hyp-chip--more">+${overflow} more</span>`;
    chipsHtml += `</div>`;
  }

  card.innerHTML = `
    <div class="hyp-card__question-wrap"><p class="hyp-card__question">${escapeHtml(hyp.question)}</p></div>
    ${chipsHtml}
  `;

  card.addEventListener('click', () => openHypCharacters(hyp.id));
  attachHypLongPress(card, hyp);
  return card;
}


/* ── Character Answers Screen ─────────────────────────*/
async function openHypCharacters(hypId) {
  currentHypId = hypId;
  const hyp    = await dbGet('hypotheticals', hypId);
  document.getElementById('hyp-chars-title').textContent = hyp.question;
  showScreen('hyp-characters');
  renderHypCharactersList(hypId);
}

async function renderHypCharactersList(hypId) {
  const list      = document.getElementById('hyp-characters-list');
  const empty     = document.getElementById('hyp-characters-empty');
  const allChars  = await dbGetAll('characters');
  const answers   = await dbGetByIndex('hyp_answers', 'hypothetical_id', hypId);
  const answerMap = new Map(answers.map(a => [a.character_id, a]));

  // Active characters always shown; archived only if they have an answer
  const characters = allChars.filter(c =>
    !c.archived || (c.archived && answerMap.get(c.id)?.body?.trim())
  );
  characters.sort((a, b) => a.name.localeCompare(b.name));

  list.innerHTML = '';
  empty.style.display = characters.length === 0 ? 'flex' : 'none';

  characters.forEach(char => {
    const answer     = answerMap.get(char.id);
    const hasText    = !!(answer?.body?.trim());
    const isComplete = hasText && answer.is_complete;
    const isInProg   = hasText && !isComplete;
    const initial    = char.name.trim()[0].toUpperCase();

    const preview = hasText
      ? (() => { const raw = plainFirstLine(answer.body); return raw.length > 50 ? raw.slice(0, 50) + '…' : raw; })()
      : null;

    const item = document.createElement('button');
    item.className = 'char-answer-item'
      + (isComplete ? ' char-answer-item--answered' : '')
      + (isInProg   ? ' char-answer-item--inprog'   : '');

    item.innerHTML = `
      <div class="char-answer-item__avatar">${escapeHtml(initial)}</div>
      <div class="char-answer-item__body">
        <span class="char-answer-item__name">${escapeHtml(char.name)}</span>
        ${isComplete ? `<span class="char-answer-item__preview">${escapeHtml(preview)}</span>`
          : isInProg ? `<span class="char-answer-item__preview char-answer-item__preview--inprog">in progress…</span>`
          : `<span class="char-answer-item__preview">no answer yet</span>`}
      </div>
      <svg class="char-answer-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    `;
    item.addEventListener('click', () => openHypAnswer(hypId, char.id));

    if (hasText) {
      addLongPress(item, () => {
        showActionSheet(char.name, [
          { label: 'Promote / attach to Thread…', danger: false, action: () => {
            currentHypId  = hypId;
            currentCharId = char.id;
            openHypPromoteModal();
          }},
        ]);
      });
    }
    list.appendChild(item);
  });
}

document.getElementById('hyp-chars-back-btn').addEventListener('click', () => {
  showScreen('hypothetical');
  renderHypList();
});


/* ── Answer Writing Screen ────────────────────────────*/
async function openHypAnswer(hypId, charId) {
  const hyp     = await dbGet('hypotheticals', hypId);
  const char    = await dbGet('characters', charId);
  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', hypId);
  const existing = answers.find(a => a.character_id === charId);

  currentHypId  = hypId;
  currentCharId = charId;

  document.getElementById('hyp-write-character').textContent = char.name;
  document.getElementById('hyp-write-question').textContent  = hyp.question;

  const ta  = document.getElementById('hyp-textarea');
  ta.value  = existing ? (existing.body || '') : '';

  document.getElementById('hyp-write-header').classList.remove('write-header--view');
  document.getElementById('hyp-finish-btn').hidden = false;
  document.getElementById('hyp-edit-btn').hidden   = true;

  if (existing?.is_complete && existing.body?.trim()) {
    ta.readOnly = true;
    document.getElementById('hyp-write-header').classList.add('write-header--view');
    document.getElementById('hyp-finish-btn').hidden = true;
    document.getElementById('hyp-edit-btn').hidden   = false;
    showScreen('hyp-write');
    return;
  }

  ta.readOnly = false;
  showScreen('hyp-write');
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 300);
}

document.getElementById('hyp-textarea').addEventListener('input', () => {
  clearTimeout(hypSaveTimer);
  hypSaveTimer = setTimeout(saveCurrentHypAnswer, 800);
});

async function saveCurrentHypAnswer(markComplete = false) {
  if (!currentHypId || !currentCharId) return;
  const ta   = document.getElementById('hyp-textarea');
  if (ta.readOnly && !markComplete) return;
  const body    = ta.value;
  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', currentHypId);
  const existing = answers.find(a => a.character_id === currentCharId);
  const now      = Date.now();

  if (existing) {
    existing.body       = body;
    existing.updated_at = now;
    if (markComplete) existing.is_complete = true;
    await dbPut('hyp_answers', existing);
  } else {
    await dbPut('hyp_answers', {
      id: generateId(), hypothetical_id: currentHypId,
      character_id: currentCharId, body,
      is_complete: markComplete, created_at: now, updated_at: now,
    });
  }
}

// Finish button
document.getElementById('hyp-finish-btn').addEventListener('click', async () => {
  await saveCurrentHypAnswer(true);
  showScreen('hyp-characters');
  renderHypCharactersList(currentHypId);
});

// Edit button
document.getElementById('hyp-edit-btn').addEventListener('click', async () => {
  if (!currentHypId || !currentCharId) return;
  const answers  = await dbGetByIndex('hyp_answers', 'hypothetical_id', currentHypId);
  const existing = answers.find(a => a.character_id === currentCharId);
  if (existing) { existing.is_complete = false; existing.updated_at = Date.now(); await dbPut('hyp_answers', existing); }
  const ta  = document.getElementById('hyp-textarea');
  ta.readOnly = false;
  document.getElementById('hyp-write-header').classList.remove('write-header--view');
  document.getElementById('hyp-finish-btn').hidden = false;
  document.getElementById('hyp-edit-btn').hidden   = true;
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 100);
});

// Back / Home from answer screen
document.getElementById('hyp-write-back-btn').addEventListener('click', async () => {
  await saveCurrentHypAnswer();
  showScreen('hyp-characters');
  renderHypCharactersList(currentHypId);
});

document.getElementById('hyp-write-home-btn').addEventListener('click', async () => {
  await saveCurrentHypAnswer();
  showScreen('home');
});


/* ── New / Edit Hypothetical Modal ────────────────────*/
document.getElementById('btn-new-hyp').addEventListener('click', () => {
  editingHypId = null;
  document.getElementById('new-hyp-question').value = '';
  document.getElementById('new-hyp-overlay').querySelector('.sheet-title').textContent = 'New hypothetical';
  document.getElementById('new-hyp-save-btn').textContent = 'Add hypothetical';
  document.getElementById('new-hyp-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-hyp-question').focus(), 350);
});

document.getElementById('new-hyp-backdrop').addEventListener('click', () => {
  document.getElementById('new-hyp-overlay').classList.add('hidden');
});
document.getElementById('new-hyp-cancel-btn').addEventListener('click', () => {
  document.getElementById('new-hyp-overlay').classList.add('hidden');
});

document.getElementById('new-hyp-save-btn').addEventListener('click', async () => {
  const question = document.getElementById('new-hyp-question').value.trim();
  if (!question) {
    const input = document.getElementById('new-hyp-question');
    input.style.borderColor = 'var(--lavender)';
    input.focus();
    return;
  }
  const now = Date.now();
  if (editingHypId) {
    const hyp      = await dbGet('hypotheticals', editingHypId);
    hyp.question   = question;
    hyp.updated_at = now;
    await dbPut('hypotheticals', hyp);
    editingHypId   = null;
  } else {
    await dbPut('hypotheticals', { id: generateId(), question, created_at: now, updated_at: now });
  }
  // Reset modal to "new" state
  document.getElementById('new-hyp-overlay').querySelector('.sheet-title').textContent = 'New hypothetical';
  document.getElementById('new-hyp-save-btn').textContent = 'Add hypothetical';
  document.getElementById('new-hyp-overlay').classList.add('hidden');
  renderHypList();
});

function openEditHypModal(hyp) {
  editingHypId = hyp.id;
  document.getElementById('new-hyp-question').value = hyp.question;
  document.getElementById('new-hyp-overlay').querySelector('.sheet-title').textContent = 'Edit hypothetical';
  document.getElementById('new-hyp-save-btn').textContent = 'Save';
  document.getElementById('new-hyp-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-hyp-question').focus(), 350);
}

async function deleteHyp(hypId) {
  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', hypId);
  for (const a of answers) await dbDelete('hyp_answers', a.id);
  await dbDelete('hypotheticals', hypId);
  renderHypList();
}

function attachHypLongPress(element, hyp) {
  addLongPress(element, () => {
    showActionSheet(`"${hyp.question.slice(0, 40)}…"`, [
      { label: 'Edit question',        danger: false, action: () => openEditHypModal(hyp) },
      { label: 'Delete hypothetical',  danger: true,  action: () => deleteHyp(hyp.id) },
    ]);
  });
}


/* ── Manage Characters Modal ──────────────────────────*/
document.getElementById('btn-manage-characters').addEventListener('click', () => {
  document.getElementById('new-char-input').value = '';
  document.getElementById('manage-chars-overlay').classList.remove('hidden');
  renderCharManageList();
});

document.getElementById('manage-chars-backdrop').addEventListener('click', () => {
  document.getElementById('manage-chars-overlay').classList.add('hidden');
  renderHypCharactersList(currentHypId);
});
document.getElementById('manage-chars-close').addEventListener('click', () => {
  document.getElementById('manage-chars-overlay').classList.add('hidden');
  renderHypCharactersList(currentHypId);
});

async function renderCharManageList() {
  const list     = document.getElementById('char-list-manage');
  const allChars = await dbGetAll('characters');
  allChars.sort((a, b) => a.name.localeCompare(b.name));

  const active   = allChars.filter(c => !c.archived);
  const archived = allChars.filter(c => c.archived);

  list.innerHTML = '';

  if (active.length === 0 && archived.length === 0) {
    list.innerHTML = `<p class="modal-empty-hint">No characters yet</p>`;
    return;
  }

  if (active.length === 0) {
    const p = document.createElement('p');
    p.className = 'modal-empty-sub';
    p.textContent   = 'No active characters';
    list.appendChild(p);
  }

  active.forEach(char => {
    const row = document.createElement('div');
    row.className = 'char-manage-item';
    row.innerHTML = `
      <span class="char-manage-item__name">${escapeHtml(char.name)}</span>
      <button class="char-manage-item__archive" aria-label="Archive ${escapeHtml(char.name)}" title="Archive">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
      </button>
    `;
    row.querySelector('.char-manage-item__archive').addEventListener('click', async () => {
      char.archived = true;
      await dbPut('characters', char);
      renderCharManageList();
    });
    list.appendChild(row);
  });

  if (archived.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'char-archive-divider';
    divider.innerHTML = `<span>Archived</span>`;
    list.appendChild(divider);

    archived.forEach(char => {
      const row = document.createElement('div');
      row.className = 'char-manage-item char-manage-item--archived';
      row.innerHTML = `
        <span class="char-manage-item__name">${escapeHtml(char.name)}</span>
        <div class="char-manage-item__actions">
          <button class="char-manage-item__restore" title="Restore">Restore</button>
          <button class="char-manage-item__delete" title="Delete permanently">×</button>
        </div>
      `;
      row.querySelector('.char-manage-item__restore').addEventListener('click', async () => {
        char.archived = false;
        await dbPut('characters', char);
        renderCharManageList();
      });
      row.querySelector('.char-manage-item__delete').addEventListener('click', async () => {
        const answers = await dbGetAll('hyp_answers');
        for (const a of answers.filter(a => a.character_id === char.id)) {
          await dbDelete('hyp_answers', a.id);
        }
        await dbDelete('characters', char.id);
        renderCharManageList();
      });
      list.appendChild(row);
    });
  }
}

async function addCharacter() {
  const input = document.getElementById('new-char-input');
  const name  = input.value.trim();
  if (!name) return;
  const now = Date.now();
  await dbPut('characters', { id: generateId(), name, created_at: now });
  input.value = '';
  renderCharManageList();
  input.focus();
}

document.getElementById('char-add-btn').addEventListener('click', addCharacter);
document.getElementById('new-char-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addCharacter(); }
});


/* ╔═══════════════════════════════════════════════════╗
   ║  9. CROSS-MODE INTEGRATION                        ║
   ╚═══════════════════════════════════════════════════╝ */


/* ── Shared pickers ───────────────────────────────────
   showPickThreadModal and showPickSceneModal are the single
   source of truth for all promote / attach flows.
   onSelect receives the chosen thread or scene object.
─────────────────────────────────────────────────────── */
async function showPickThreadModal(headerText, onSelect) {
  const threads = await dbGetAll('threads');
  threads.sort((a, b) => b.updated_at - a.updated_at);

  const overlay = document.getElementById('pick-thread-overlay');
  const list    = document.getElementById('pick-thread-list');
  document.getElementById('pick-thread-title').textContent = headerText;
  list.innerHTML = '';

  if (threads.length === 0) {
    list.innerHTML = `<p class="modal-empty-hint">No threads yet</p>`;
  }

  threads.forEach(thread => {
    const btn = document.createElement('button');
    btn.className = 'list-item';
    btn.innerHTML = `
      <span class="list-item__body"><span class="list-item__title">${escapeHtml(thread.title)}</span></span>
      <svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    `;
    btn.addEventListener('click', () => { overlay.classList.add('hidden'); onSelect(thread); });
    list.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

async function showPickSceneModal(headerText, onSelect) {
  const threads = await dbGetAll('threads');
  threads.sort((a, b) => b.updated_at - a.updated_at);

  const overlay = document.getElementById('pick-thread-overlay');
  const list    = document.getElementById('pick-thread-list');
  document.getElementById('pick-thread-title').textContent = headerText;
  list.innerHTML = '';

  if (threads.length === 0) {
    list.innerHTML = `<p class="modal-empty-hint">No threads yet</p>`;
    overlay.classList.remove('hidden');
    return;
  }

  for (const thread of threads) {
    const header = document.createElement('p');
    header.className = 'pick-thread-header';
    header.textContent = thread.title;
    list.appendChild(header);

    const scenes = await dbGetByIndex('scenes', 'thread_id', thread.id);
    scenes.sort((a, b) => a.created_at - b.created_at);

    if (scenes.length === 0) {
      const p = document.createElement('p');
      p.className   = 'pick-scene-empty';
      p.textContent   = 'no scenes yet';
      list.appendChild(p);
      continue;
    }

    scenes.forEach((scene, i) => {
      const btn = document.createElement('button');
      btn.className = 'list-item';
      btn.classList.add('pick-scene-item');
      btn.innerHTML = `
        <span class="list-item__body"><span class="list-item__title">${escapeHtml(scene.title || `Scene ${i + 1}`)}</span></span>
        <svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      `;
      btn.addEventListener('click', () => { overlay.classList.add('hidden'); onSelect(scene); });
      list.appendChild(btn);
    });
  }

  overlay.classList.remove('hidden');
}

document.getElementById('pick-thread-backdrop').addEventListener('click', () => {
  document.getElementById('pick-thread-overlay').classList.add('hidden');
});


/* ── Thread-level idea cards ──────────────────────────*/
document.getElementById('btn-new-thread-spark').addEventListener('click', () => {
  openStickySparkEditor(null, 'thread', currentThreadId);
});


function makeIdeaCard(spark, level) {
  const card = document.createElement('div');
  card.className      = `idea-card idea-card--${level}`;
  card.dataset.sparkId = spark.id;
  card.dataset.id      = spark.id;

  // Use body as the single source of truth; derive display text from first line
  const text      = plainFirstLine(spark.body || spark.title || '');
  const wordCount = spark.body ? spark.body.trim().split(/\s+/).filter(Boolean).length : 0;
  const preview   = text.slice(0, 80);

  const dragHandle = level === 'thread'
    ? `<span class="idea-card__drag list-item__drag" aria-label="Drag to reorder">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/>
        </svg>
      </span>`
    : '';

  card.innerHTML = `
    ${dragHandle}
    <span class="idea-card__icon">✦</span>
    <div class="idea-card__body">
      <p class="idea-card__preview">${escapeHtml(preview)}</p>
      ${wordCount > 5 ? `<p class="idea-card__meta">${wordCount} words</p>` : ''}
    </div>
  `;

  card.addEventListener('click', () => {
    if (reorderModeOn && level === 'thread') return;
    openStickySparkEditor(spark.id, spark.parent_type, spark.parent_id);
  });

  addLongPress(card, () => {
    if (reorderModeOn) return;
    const actions = [];
    if (level === 'thread') {
      actions.push({ label: 'Reorder', danger: false, action: () => enterReorderMode() });
    }
    actions.push({ label: 'Delete idea', danger: true, action: async () => {
      await dbDelete('sparks', spark.id);
      if (level === 'thread') renderScenesList(spark.parent_id);
      else loadSceneSparks(spark.parent_id);
    }});
    showActionSheet(`"${preview.slice(0, 40)}"`, actions);
  });

  return card;
}


/* ── Scene-level ideas panel ──────────────────────────*/
document.getElementById('scene-sparks-toggle').addEventListener('click', () => {
  sceneSparksOpen = !sceneSparksOpen;
  const list = document.getElementById('scene-sparks-list');
  list.style.display = sceneSparksOpen ? 'flex' : 'none';
  document.getElementById('scene-sparks-toggle').classList.toggle('open', sceneSparksOpen);
});

document.getElementById('btn-new-scene-spark').addEventListener('click', () => {
  openStickySparkEditor(null, 'scene', currentSceneId);
});
document.getElementById('btn-new-scene-spark-empty').addEventListener('click', () => {
  openStickySparkEditor(null, 'scene', currentSceneId);
});

async function loadSceneSparks(sceneId) {
  const allSparks   = await getSparksByParent(sceneId);
  const sceneSparks = allSparks.filter(s => s.parent_type === 'scene');

  const panel      = document.getElementById('scene-sparks-panel');
  const emptyStrip = document.getElementById('scene-sparks-empty-strip');
  const list       = document.getElementById('scene-sparks-list');
  const label      = document.getElementById('scene-sparks-label');

  list.innerHTML = '';

  if (sceneSparks.length === 0) {
    panel.hidden      = true;
    emptyStrip.hidden = false;
    return;
  }

  panel.hidden      = false;
  emptyStrip.hidden = true;
  label.textContent = `Ideas (${sceneSparks.length})`;

  sceneSparks.sort((a, b) => b.created_at - a.created_at);
  sceneSparks.forEach(spark => list.appendChild(makeIdeaCard(spark, 'scene')));

  list.style.display = sceneSparksOpen ? 'flex' : 'none';
  document.getElementById('scene-sparks-toggle').classList.toggle('open', sceneSparksOpen);
}

async function refreshSceneSparkPanel() {
  if (!currentSceneId) return;
  sceneSparksOpen = false;
  document.getElementById('scene-sparks-list').style.display = 'none';
  document.getElementById('scene-sparks-toggle').classList.remove('open');
  await loadSceneSparks(currentSceneId);
}


/* ── Sticky Spark Editor ──────────────────────────────*/
async function openStickySparkEditor(sparkId, parentType, parentId) {
  const ta    = document.getElementById('sticky-write-textarea');
  const label = document.getElementById('sticky-write-label');

  // Set context label
  if (parentType === 'thread') {
    const thread  = await dbGet('threads', parentId);
    label.textContent = thread ? `Idea — ${thread.title}` : 'Thread idea';
  } else {
    const scene  = await dbGet('scenes', parentId);
    const thread = scene ? await dbGet('threads', scene.thread_id) : null;
    label.textContent = thread ? `Idea — ${thread.title}` : 'Scene idea';
  }

  if (sparkId) {
    const spark = await dbGet('sparks', sparkId);
    ta.value        = spark.body || spark.title || '';
    currentStickyId = sparkId;
  } else {
    const now   = Date.now();
    const newId = generateId();
    await dbPut('sparks', {
      id: newId, title: '', body: '',
      parent_type: parentType, parent_id: parentId,
      is_complete: false, completed_at: null,
      created_at: now, updated_at: now,
    });
    ta.value        = '';
    currentStickyId = newId;
  }

  // Store parent context in JS variables (not DOM properties)
  stickyParentType = parentType;
  stickyParentId   = parentId;

  showScreen('sticky-write');
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 300);
}

document.getElementById('sticky-write-textarea').addEventListener('input', () => {
  clearTimeout(stickyWriteTimer);
  stickyWriteTimer = setTimeout(saveStickySparkEdits, 600);
});

async function saveStickySparkEdits() {
  if (!currentStickyId) return;
  const text  = document.getElementById('sticky-write-textarea').value;
  const spark = await dbGet('sparks', currentStickyId);
  if (!spark) return;
  // Derive title from first line of body — single source of truth
  spark.title      = plainFirstLine(text).slice(0, 80);
  spark.body       = text;
  spark.updated_at = Date.now();
  await dbPut('sparks', spark);
}

async function leaveStickySparkEditor() {
  await saveStickySparkEdits();
  // Discard if empty
  const text = document.getElementById('sticky-write-textarea').value.trim();
  if (!text && currentStickyId) await dbDelete('sparks', currentStickyId);

  const parentType = stickyParentType;
  const parentId   = stickyParentId;
  currentStickyId  = null;
  stickyParentType = null;
  stickyParentId   = null;

  if (parentType === 'thread') {
    showScreen('scenes');
    renderScenesList(parentId);
  } else {
    if (currentSceneId) {
      showScreen('write');
      await loadSceneSparks(currentSceneId);
    } else {
      showScreen('scenes');
    }
  }
}

document.getElementById('sticky-write-back-btn').addEventListener('click', leaveStickySparkEditor);
document.getElementById('sticky-write-done-btn').addEventListener('click', leaveStickySparkEditor);
document.getElementById('sticky-write-home-btn').addEventListener('click', async () => {
  await saveStickySparkEdits();
  const text = document.getElementById('sticky-write-textarea').value.trim();
  if (!text && currentStickyId) await dbDelete('sparks', currentStickyId);
  currentStickyId  = null;
  stickyParentType = null;
  stickyParentId   = null;
  showScreen('home');
});


/* ── Promote a Spark ──────────────────────────────────*/
function openPromoteSparkModal(spark) {
  const overlay = document.getElementById('promote-spark-overlay');
  const actions = document.getElementById('promote-spark-actions');

  overlay.querySelector('.sheet-title').textContent = 'Promote';
  document.getElementById('promote-spark-note').textContent = spark.body?.trim()
    ? 'What would you like to do with this Spark?'
    : 'This Spark has no conclusion yet — you can only attach its idea.';

  actions.innerHTML = '';
  const buttons = [];

  if (spark.body?.trim()) {
    buttons.push({ label: 'Promote to new Thread',   action: () => promoteSparkToNewThread(spark) });
  }
  buttons.push({ label: 'Attach to existing Thread', action: () => attachSparkToThread(spark) });
  buttons.push({ label: 'Attach to existing Scene',  action: () => attachSparkToScene(spark) });
  buttons.push({ label: 'Cancel', ghost: true,        action: () => overlay.classList.add('hidden') });

  buttons.forEach(({ label, ghost, action }) => {
    const btn = document.createElement('button');
    btn.className = ghost ? 'btn-ghost' : 'btn-primary';
    btn.textContent = label;
    btn.classList.add('promote-action-btn');
    btn.addEventListener('click', () => { overlay.classList.add('hidden'); setTimeout(action, 150); });
    actions.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

document.getElementById('promote-spark-backdrop').addEventListener('click', () => {
  document.getElementById('promote-spark-overlay').classList.add('hidden');
});

// Promote conclusion → new Thread (opens naming modal)
function promoteSparkToNewThread(spark) {
  const suggestedTitle = spark.title || plainFirstLine(spark.body).slice(0, 60) || 'New Thread';
  openNewThreadModal(suggestedTitle, async (threadId) => {
    const now     = Date.now();

    // The spark's conclusion (body) becomes the first scene
    await dbPut('scenes', {
      id: generateId(), thread_id: threadId,
      title: '', synopsis: '', body: spark.body || '',
      is_complete: false, created_at: now, updated_at: now,
    });

    // The spark's idea (title) becomes a thread-level idea card
    const ideaText = spark.title || plainFirstLine(spark.body).slice(0, 80);
    if (ideaText) {
      await dbPut('sparks', {
        id: generateId(), title: ideaText, body: ideaText,
        parent_type: 'thread', parent_id: threadId,
        is_complete: false, completed_at: null, created_at: now, updated_at: now,
      });
    }

    await dbDelete('sparks', spark.id);
    await openThreadScenes(threadId);
  });
}

async function attachSparkToThread(spark) {
  await showPickThreadModal('Attach to which thread?', async (thread) => {
    const now      = Date.now();
    const ideaText = spark.title || plainFirstLine(spark.body).slice(0, 60);
    const bodyText = spark.body?.trim() && spark.body.trim() !== ideaText
      ? `${ideaText}\n\n—\n\n${spark.body.trim()}`
      : ideaText;
    await dbPut('sparks', {
      id: generateId(), title: ideaText, body: bodyText,
      parent_type: 'thread', parent_id: thread.id,
      is_complete: false, completed_at: null, created_at: now, updated_at: now,
    });
    await dbDelete('sparks', spark.id);
    await openThreadScenes(thread.id);
  });
}

async function attachSparkToScene(spark) {
  await showPickSceneModal('Attach to which scene?', async (scene) => {
    const now      = Date.now();
    const ideaText = spark.title || plainFirstLine(spark.body).slice(0, 60);
    const bodyText = spark.body?.trim() && spark.body.trim() !== ideaText
      ? `${ideaText}\n\n—\n\n${spark.body.trim()}`
      : ideaText;
    await dbPut('sparks', {
      id: generateId(), title: ideaText, body: bodyText,
      parent_type: 'scene', parent_id: scene.id,
      is_complete: false, completed_at: null, created_at: now, updated_at: now,
    });
    await dbDelete('sparks', spark.id);
    await openThreadScenes(scene.thread_id);
    await openScene(scene.id);
  });
}


/* ── Promote a Hypothetical Answer ───────────────────*/
function openHypPromoteModal() {
  const overlay = document.getElementById('promote-spark-overlay');
  const actions = document.getElementById('promote-spark-actions');

  overlay.querySelector('.sheet-title').textContent = 'Promote';
  document.getElementById('promote-spark-note').textContent = 'What would you like to do with this answer?';

  actions.innerHTML = '';

  const buttons = [
    { label: 'Promote to new Thread',    action: () => promoteHypToNewThread() },
    { label: 'Attach to existing Thread', action: () => promoteHypToThread() },
    { label: 'Attach to existing Scene',  action: () => promoteHypToScene() },
    { label: 'Cancel', ghost: true,       action: () => overlay.classList.add('hidden') },
  ];

  buttons.forEach(({ label, ghost, action }) => {
    const btn = document.createElement('button');
    btn.className = ghost ? 'btn-ghost' : 'btn-primary btn-primary--lavender';
    btn.textContent = label;
    btn.classList.add('promote-action-btn');
    btn.addEventListener('click', () => { overlay.classList.add('hidden'); setTimeout(action, 150); });
    actions.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

async function getHypPromoteText() {
  const hyp     = await dbGet('hypotheticals', currentHypId);
  const char    = await dbGet('characters',    currentCharId);
  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', currentHypId);
  const answer  = answers.find(a => a.character_id === currentCharId);
  const body    = answer?.body?.trim() || '';

  const ideaTitle   = hyp.question;
  const threadTitle = `${hyp.question} — ${char.name}`;
  const bodyText    = body
    ? `${hyp.question}\n\n—\n\n${char.name}: ${body}`
    : `${hyp.question}\n\n—\n\n${char.name}`;

  return { ideaTitle, threadTitle, bodyText, hyp, char, answer };
}

// Promote hyp answer → new Thread (opens naming modal)
async function promoteHypToNewThread() {
  const { threadTitle, hyp, char, answer } = await getHypPromoteText();
  openNewThreadModal(threadTitle, async (threadId) => {
    const now = Date.now();

    // The character's answer becomes the first scene
    await dbPut('scenes', {
      id: generateId(), thread_id: threadId,
      title: char.name, synopsis: '', body: answer?.body || '',
      is_complete: false, created_at: now, updated_at: now,
    });

    // The hypothetical question becomes a thread-level idea card
    await dbPut('sparks', {
      id: generateId(), title: hyp.question, body: hyp.question,
      parent_type: 'thread', parent_id: threadId,
      is_complete: false, completed_at: null, created_at: now, updated_at: now,
    });

    await openThreadScenes(threadId);
  });
}

async function promoteHypToThread() {
  const { ideaTitle, bodyText } = await getHypPromoteText();
  await showPickThreadModal('Attach to which thread?', async (thread) => {
    const now = Date.now();
    await dbPut('sparks', {
      id: generateId(), title: ideaTitle, body: bodyText,
      parent_type: 'thread', parent_id: thread.id,
      is_complete: false, completed_at: null, created_at: now, updated_at: now,
    });
    await openThreadScenes(thread.id);
  });
}

async function promoteHypToScene() {
  const { ideaTitle, bodyText } = await getHypPromoteText();
  await showPickSceneModal('Attach to which scene?', async (scene) => {
    const now = Date.now();
    await dbPut('sparks', {
      id: generateId(), title: ideaTitle, body: bodyText,
      parent_type: 'scene', parent_id: scene.id,
      is_complete: false, completed_at: null, created_at: now, updated_at: now,
    });
    await openThreadScenes(scene.thread_id);
    await openScene(scene.id);
  });
}


/* ╔═══════════════════════════════════════════════════╗
   ║  10. SETTINGS, EXPORT & IMPORT                    ║
   ╚═══════════════════════════════════════════════════╝ */

function openSettings()  { document.getElementById('settings-overlay').classList.remove('hidden'); }
function closeSettings() { document.getElementById('settings-overlay').classList.add('hidden'); }

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-backdrop').addEventListener('click', closeSettings);

// Export
document.getElementById('export-btn').addEventListener('click', async () => {
  try {
    const data = {
      version:        2,
      exported_at:    new Date().toISOString(),
      threads:        await dbGetAll('threads'),
      scenes:         await dbGetAll('scenes'),
      sparks:         await dbGetAll('sparks'),
      hypotheticals:  await dbGetAll('hypotheticals'),
      hyp_answers:    await dbGetAll('hyp_answers'),
      characters:     await dbGetAll('characters'),
    };
    const json     = JSON.stringify(data, null, 2);
    const blob     = new Blob([json], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const date     = new Date().toISOString().slice(0, 10);
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = `impulse-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    localStorage.setItem('impulse-last-backup', Date.now().toString());
    checkBackupNudge();
    closeSettings();
  } catch (err) {
    console.error('Export failed:', err);
    alert('Export failed. Please try again.');
  }
});

// Import — step 1: pick file
document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.version || !data.threads || !data.scenes || !data.sparks) {
      alert("This doesn't look like a valid Impulse backup file.");
      return;
    }
    pendingImportData = data;
    document.getElementById('confirm-restore-filename').textContent = `File: ${file.name}`;
    closeSettings();
    setTimeout(() => { document.getElementById('confirm-restore-overlay').classList.remove('hidden'); }, 200);
  } catch (err) {
    console.error('Import parse error:', err);
    alert("Could not read this file. Make sure it's a valid Impulse backup.");
  }
});

document.getElementById('confirm-restore-backdrop').addEventListener('click', () => {
  document.getElementById('confirm-restore-overlay').classList.add('hidden');
  pendingImportData = null;
});
document.getElementById('confirm-restore-cancel-btn').addEventListener('click', () => {
  document.getElementById('confirm-restore-overlay').classList.add('hidden');
  pendingImportData = null;
});

// Import — step 2: confirm and restore
document.getElementById('confirm-restore-btn').addEventListener('click', async () => {
  if (!pendingImportData) return;
  const data    = pendingImportData;
  pendingImportData = null;
  document.getElementById('confirm-restore-overlay').classList.add('hidden');

  try {
    await clearAllStores();
    const stores = ['threads', 'scenes', 'sparks', 'hypotheticals', 'hyp_answers', 'characters'];
    for (const store of stores) {
      for (const record of (data[store] || [])) {
        await dbPut(store, record);
      }
    }
    resetAllState();
    showScreen('home');
  } catch (err) {
    console.error('Import failed:', err);
    alert('Restore failed. Your previous data may still be intact — try again.');
  }
});

// Clear all data
document.getElementById('clear-data-btn').addEventListener('click', () => {
  closeSettings();
  setTimeout(() => { document.getElementById('confirm-clear-overlay').classList.remove('hidden'); }, 200);
});

document.getElementById('confirm-clear-cancel-btn').addEventListener('click', () => {
  document.getElementById('confirm-clear-overlay').classList.add('hidden');
});
document.getElementById('confirm-clear-backdrop').addEventListener('click', () => {
  document.getElementById('confirm-clear-overlay').classList.add('hidden');
});

document.getElementById('confirm-clear-btn').addEventListener('click', async () => {
  try {
    await clearAllStores();
  } catch (e) {
    console.warn('Clear error:', e);
    alert('Could not clear data. Please try again.');
    return;
  }
  document.getElementById('confirm-clear-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
  resetAllState();
  showScreen('home');
});


/* ╔═══════════════════════════════════════════════════╗
   ║  11. ACTION SHEET & LONG PRESS                    ║
   ╚═══════════════════════════════════════════════════╝ */

function showActionSheet(title, actions) {
  document.getElementById('action-sheet-title').textContent = title;
  const container = document.getElementById('action-sheet-buttons');
  container.innerHTML = '';

  actions.forEach(({ label, danger, action }) => {
    const btn = document.createElement('button');
    btn.className   = 'action-sheet__btn' + (danger ? ' action-sheet__btn--danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { closeActionSheet(); setTimeout(action, 150); });
    container.appendChild(btn);
  });

  document.getElementById('action-sheet-overlay').classList.remove('hidden');
}

function closeActionSheet() {
  document.getElementById('action-sheet-overlay').classList.add('hidden');
}

document.getElementById('action-sheet-backdrop').addEventListener('click', closeActionSheet);
document.getElementById('action-sheet-cancel').addEventListener('click', closeActionSheet);

// addLongPress — fires callback after 500ms of continuous press
function addLongPress(element, callback) {
  let timer   = null;
  let didLong = false;

  function start(e) {
    didLong = false;
    element.classList.add('pressing');
    timer = setTimeout(() => {
      didLong = true;
      element.classList.remove('pressing');
      if (navigator.vibrate) navigator.vibrate(40);
      callback(e);
    }, 500);
  }

  function cancel() {
    clearTimeout(timer);
    element.classList.remove('pressing');
  }

  function preventIfLong(e) {
    if (didLong) { e.preventDefault(); e.stopPropagation(); didLong = false; }
  }

  element.addEventListener('pointerdown',  start);
  element.addEventListener('pointerup',    cancel);
  element.addEventListener('pointerleave', cancel);
  element.addEventListener('pointermove',  cancel);
  element.addEventListener('click',        preventIfLong, true);
}


/* ╔═══════════════════════════════════════════════════╗
   ║  12. THEME                                        ║
   ╚═══════════════════════════════════════════════════╝ */

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark')       root.setAttribute('data-theme', 'dark');
  else if (theme === 'light') root.setAttribute('data-theme', 'light');
  else                        root.removeAttribute('data-theme');

  const isDark = theme === 'dark' ||
    (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(el => {
    el.setAttribute('content', isDark ? '#1c1610' : '#f5efe6');
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });

  localStorage.setItem('impulse-theme', theme);
}

document.getElementById('theme-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-btn');
  if (btn) applyTheme(btn.dataset.theme);
});

// Apply saved preference immediately (before DB is ready)
applyTheme(localStorage.getItem('impulse-theme') || 'system');


/* ╔═══════════════════════════════════════════════════╗
   ║  14. MARKDOWN EXPORT                              ║
   ╚═══════════════════════════════════════════════════╝ */

// Strips characters that are illegal or annoying in file/folder names.
function sanitiseFilename(str) {
  if (!str || !str.trim()) return 'Untitled';
  return str
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')   // illegal on Windows/Android
    .replace(/\.{2,}/g, '.')        // no double dots
    .replace(/\s+/g, ' ')           // collapse whitespace
    .slice(0, 80)                   // keep paths sane
    .trim() || 'Untitled';
}

// Converts any multi-line / multi-paragraph text into a proper markdown blockquote.
// Every line (including blank lines between paragraphs) gets a "> " prefix,
// which prevents blank lines from breaking out of the blockquote block.
function toBlockquote(str) {
  return str.trim().split('\n').map(line => '> ' + line).join('\n');
}


function firstFiveWords(str, n = 5) {
  if (!str || !str.trim()) return 'Untitled';
  return str.trim().split(/\s+/).slice(0, n).join(' ');
}

// Builds the text content of a single markdown file.
// No title heading — the filename is the only identifier.
function buildMarkdownFile({ synopsis, body }) {
  const parts = [];
  if (synopsis) parts.push(toBlockquote(synopsis) + '\n');
  if (synopsis && body) parts.push('');
  if (body)     parts.push(body.trim());
  return parts.join('\n') + '\n';
}

document.getElementById('export-md-btn').addEventListener('click', async () => {
  try {
    const zip = new JSZip();
    const date = new Date().toISOString().slice(0, 10);
    const root = zip.folder(`impulse-${date}`);

    // ── Continue: threads → scenes ───────────────────
    const continueFolder = root.folder('continue');
    const threads = await dbGetAll('threads');
    threads.sort((a, b) => a.created_at - b.created_at);

    for (const thread of threads) {
      const threadName   = sanitiseFilename(thread.title);
      const threadFolder = continueFolder.folder(threadName);

      const scenes = await dbGetByIndex('scenes', 'thread_id', thread.id);
      // Sort by sort_order then created_at (mirrors the in-app order)
      scenes.sort((a, b) => {
        const aHas = a.sort_order != null, bHas = b.sort_order != null;
        if (!aHas && !bHas) return a.created_at - b.created_at;
        if (!aHas) return -1;
        if (!bHas) return 1;
        return a.sort_order - b.sort_order;
      });

      for (let i = 0; i < scenes.length; i++) {
        const scene    = scenes[i];
        const num      = String(i + 1).padStart(2, '0');
        const name     = sanitiseFilename(scene.title || `Scene ${i + 1}`);
        const filename = `${num} - ${name}.md`;

        let content = buildMarkdownFile({
          synopsis: scene.synopsis || null,
          body:     scene.body    || '',
        });

        // Append any scene-level spark ideas after a divider
        const sceneSparks = await getSparksByParent(scene.id);
        if (sceneSparks.length) {
          sceneSparks.sort((a, b) => a.created_at - b.created_at);
          content += '\n---\n\n### Ideas\n';
          sceneSparks.forEach(s => {
            const ideaText = s.body || s.title || 'Untitled idea';
            content += '\n' + toBlockquote(ideaText) + '\n';
          });
        }

        threadFolder.file(filename, content);
      }

      // Thread-level spark ideas as _[threadname] ideas.md
      const threadSparks = await getSparksByParent(thread.id);
      if (threadSparks.length) {
        let ideasContent = '';
        threadSparks.sort((a, b) => a.created_at - b.created_at);
        threadSparks.forEach((s, idx) => {
          if (idx > 0) ideasContent += '\n';
          const ideaText = s.body || s.title || 'Untitled idea';
          ideasContent += toBlockquote(ideaText) + '\n';
        });
        threadFolder.file(`_${threadName} ideas.md`, ideasContent);
      }
    }

    // ── Spark ─────────────────────────────────────────
    const sparkFolder  = root.folder('spark');
    const allSparks    = await dbGetAll('sparks');
    const rootSparks   = allSparks.filter(s => !s.parent_type);
    rootSparks.sort((a, b) => a.created_at - b.created_at);

    rootSparks.forEach(spark => {
      const ideaText = spark.title || spark.body || 'Untitled';
      const filename = sanitiseFilename(firstFiveWords(ideaText)) + '.md';

      let content = '';
      if (ideaText.trim()) content += toBlockquote(ideaText) + '\n';
      if (spark.body && spark.title && spark.body.trim()) {
        content += '\n---\n\n' + spark.body.trim() + '\n';
      }

      sparkFolder.file(filename, content);
    });

    // ── Hypotheticals ─────────────────────────────────
    const hypFolder  = root.folder('hypotheticals');
    const hyps       = await dbGetAll('hypotheticals');
    const characters = await dbGetAll('characters');
    const charMap    = new Map(characters.map(c => [c.id, c]));
    hyps.sort((a, b) => a.created_at - b.created_at);

    for (const hyp of hyps) {
      const folderName   = sanitiseFilename(firstFiveWords(hyp.question));
      const hypSubFolder = hypFolder.folder(folderName);

      const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', hyp.id);
      answers.sort((a, b) => {
        const ca = charMap.get(a.character_id);
        const cb = charMap.get(b.character_id);
        return (ca?.name || '').localeCompare(cb?.name || '');
      });

      answers.forEach(answer => {
        const char     = charMap.get(answer.character_id);
        const charName = sanitiseFilename(char?.name || 'Unknown');

        let content = toBlockquote(hyp.question) + '\n';
        if (answer.body && answer.body.trim()) {
          content += '\n---\n\n' + answer.body.trim() + '\n';
        }

        hypSubFolder.file(`${charName}.md`, content);
      });
    }

    // ── Generate & download ───────────────────────────
    const blob = await zip.generateAsync({ type: 'blob' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `impulse-${date}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    closeSettings();

  } catch (err) {
    console.error('Markdown export failed:', err);
    alert('Export failed. Please try again.');
  }
});


/* ╔═══════════════════════════════════════════════════╗
   ║  15. BACKUP NUDGE                                 ║
   ╚═══════════════════════════════════════════════════╝ */

const BACKUP_NUDGE_DAYS = 7;

function checkBackupNudge() {
  const nudge    = document.getElementById('backup-nudge');
  const lastStr  = localStorage.getItem('impulse-last-backup');
  if (!lastStr) {
    // Never backed up — show nudge only if there's actually data worth backing up.
    // We check this async and show if so.
    dbGetAll('threads').then(threads => {
      if (threads.length > 0) nudge.classList.remove('hidden');
    }).catch(() => {});
    return;
  }
  const daysSince = (Date.now() - parseInt(lastStr, 10)) / (1000 * 60 * 60 * 24);
  if (daysSince >= BACKUP_NUDGE_DAYS) {
    nudge.classList.remove('hidden');
  } else {
    nudge.classList.add('hidden');
  }
}

// Tapping the nudge opens settings so they can export right away.
document.getElementById('backup-nudge').addEventListener('click', () => {
  openSettings();
});



if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Impulse: service worker registered ✓'))
      .catch(err => console.warn('Impulse: service worker failed', err));
  });
}

openDB()
  .then(() => {
    console.log('Impulse: database ready ✓');
    checkBackupNudge();
  })
  .catch(err => console.error('Impulse: database error', err));
