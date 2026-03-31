/* ═══════════════════════════════════════════════════════
   IMPULSE — app.js
═══════════════════════════════════════════════════════ */


/* ╔═══════════════════════════════════════════════════╗
   ║  1. DATABASE                                      ║
   ╚═══════════════════════════════════════════════════╝ */

let db;
const DB_NAME    = 'impulse-db';
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db      = e.target.result;
      const oldVer  = e.oldVersion;

      // Version 1 stores — create if fresh install
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
        sp.createIndex('parent_id', 'parent_id'); // for fetching sparks by parent
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

      // Version 2 migration — add parent_id index to existing sparks store
      if (oldVer === 1) {
        const tx = e.target.transaction;
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
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function dbGet(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function dbPut(storeName, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).put(record);
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).delete(id);
    request.onsuccess = () => resolve();
    request.onerror   = () => reject(request.error);
  });
}

function dbGetByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index(indexName);
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

/* getSparksByParent(parentId)
   Returns all sticky-note sparks attached to a thread or scene. */
function getSparksByParent(parentId) {
  return dbGetByIndex('sparks', 'parent_id', parentId);
}

/* clearAllStores()
   Wipes every object store in a single transaction without
   closing the DB connection. Safer than delete + reopen,
   which can fail silently on local files. */
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
   ║  2. NAVIGATION                                    ║
   ╚═══════════════════════════════════════════════════╝

   showScreen() is the single point of navigation.
   Every screen transition goes through here.

   FIX: Back buttons on inner screens no longer use
   data-target. Instead, dedicated back handlers call
   the right "navigate back" function directly, which
   also ensures lists re-render on arrival.
*/

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + id);
  if (target) {
    target.classList.add('active');
    target.scrollTop = 0;
  }
  if (id !== 'home') {
    history.pushState({ screen: id }, '', '');
  }
}

// Android hardware/gesture back button
window.addEventListener('popstate', () => {
  if (!document.getElementById('finish-overlay').classList.contains('hidden'))          { closeFinishModal();   return; }
  if (!document.getElementById('new-thread-overlay').classList.contains('hidden'))      { closeNewThreadModal(); return; }
  if (!document.getElementById('edit-thread-overlay').classList.contains('hidden'))     { closeEditThreadModal(); return; }
  if (!document.getElementById('spark-finish-overlay').classList.contains('hidden'))    { document.getElementById('spark-finish-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('settings-overlay').classList.contains('hidden'))        { closeSettings();      return; }
  if (!document.getElementById('confirm-clear-overlay').classList.contains('hidden'))   { document.getElementById('confirm-clear-overlay').classList.add('hidden'); return; }
  if (!document.getElementById('confirm-restore-overlay').classList.contains('hidden')) { document.getElementById('confirm-restore-overlay').classList.add('hidden'); pendingImportData = null; return; }
  if (!document.getElementById('action-sheet-overlay').classList.contains('hidden'))    { closeActionSheet();   return; }

  const active = document.querySelector('.screen.active');
  if (!active) return;
  const id = active.id.replace('screen-', '');

  // Mirror the same logic as the back buttons below
  if (id === 'write')            navigateBackFromWrite();
  else if (id === 'scenes')      navigateBackFromScenes();
  else if (id === 'threads')     showScreen('home');
  else if (id === 'spark-write') { saveCurrentSpark(); resetSparkWriteScreen(); showScreen('spark'); renderSparkList(); }
  else if (id === 'sticky-write') leaveStickySparkEditor();
  else if (id === 'hyp-characters') { showScreen('hypothetical'); renderHypList(); }
  else if (id === 'hyp-write')   { saveCurrentHypAnswer(); showScreen('hyp-characters'); renderHypCharactersList(currentHypId); }
  else showScreen('home');
});

/* navigateBackFromWrite()
   Saves, then goes back to scenes list and re-renders it.
   FIX: This is now the single source of truth for leaving
   the write screen — replaces the old generic back-btn handler. */
async function navigateBackFromWrite() {
  if (currentSceneId) {
    const ta = document.getElementById('write-textarea');
    if (!ta.readOnly && !ta.value.trim()) {
      // Empty scene — discard silently
      await dbDelete('scenes', currentSceneId);
      currentSceneId = null;
    } else {
      await saveCurrentScene();
    }
  }
  showScreen('scenes');
  if (currentThreadId) renderScenesList(currentThreadId);
}

/* navigateBackFromScenes()
   Goes back to threads list and re-renders it.
   FIX: Always re-renders so the list is never stale. */
async function navigateBackFromScenes() {
  exitReorderMode();
  showScreen('threads');
  renderThreadsList();
}

// Wire up back buttons directly — no data-target needed for inner screens
document.getElementById('write-back-btn').addEventListener('click', navigateBackFromWrite);

// Home button on write screen — saves first, then goes all the way home
document.getElementById('write-home-btn').addEventListener('click', async () => {
  await saveCurrentScene();
  exitReorderMode();
  showScreen('home');
});
document.getElementById('scenes-back-btn').addEventListener('click', navigateBackFromScenes);

// Home buttons (data-target="home") — save if on write screen, then go home
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.home-btn[data-target]');
  if (btn) {
    if (document.getElementById('screen-write').classList.contains('active')) {
      saveCurrentScene();
    }
    exitReorderMode();
    showScreen(btn.dataset.target);
  }
});

// Back buttons (data-target) — simple nav for non-write screens
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.back-btn[data-target]');
  if (btn) showScreen(btn.dataset.target);
});


/* ╔═══════════════════════════════════════════════════╗
   ║  3. HOME SCREEN                                   ║
   ╚═══════════════════════════════════════════════════╝ */

document.getElementById('btn-continue').addEventListener('click', async () => {
  const recent = await getMostRecentScene();
  if (recent) {
    // Find a non-complete scene to jump into first
    // If the most recent is complete, still open it (view mode)
    await openScene(recent.id);
  } else {
    // Nothing written yet — go to threads list
    showScreen('threads');
    renderThreadsList(); // FIX: always render on arrival
  }
});

/* ╔═══════════════════════════════════════════════════╗
   ║  SPARK MODE                                       ║
   ╚═══════════════════════════════════════════════════╝ */

const ARCHIVE_DAYS = 30;
let currentSparkId = null;
let sparkSaveTimer = null;
let archiveOpen    = false;

document.getElementById('btn-spark').addEventListener('click', () => {
  showScreen('spark');
  renderSparkList();
});

async function renderSparkList() {
  const list   = document.getElementById('spark-list');
  const empty  = document.getElementById('spark-empty');
  const allSparks = await dbGetAll('sparks');
  // Only show standalone sparks (not attached to threads/scenes)
  const sparks = allSparks.filter(s => !s.parent_type);
  const cutoff = Date.now() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

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

  open.forEach(spark   => list.appendChild(makeSparkItem(spark)));
  inProg.forEach(spark => list.appendChild(makeSparkItem(spark)));
  recent.forEach(spark => list.appendChild(makeSparkItem(spark)));

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
  item.className = 'spark-card' + (spark.is_complete ? ' spark-card--complete' : '');
  item.dataset.id = spark.id;

  const titleText     = spark.title || 'Untitled idea';
  const hasConclusion = spark.body && spark.body.trim().length > 0;
  const wordCount     = hasConclusion ? spark.body.trim().split(/\s+/).filter(Boolean).length : 0;

  const plainPreview = (spark.body || '')
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1').replace(/_{1,3}(.*?)_{1,3}/g, '$1')
    .split('\n')[0].trim();

  let inner = `<div class="spark-card__prompt-wrap"><p class="spark-card__prompt">${escapeHtml(titleText)}</p></div>`;

  if (spark.is_complete && hasConclusion) {
    inner += `<div class="spark-card__divider"></div>
      <p class="spark-card__conclusion">${escapeHtml(plainPreview)}</p>
      <div class="spark-card__footer">
        <span class="spark-card__meta">${wordCount} word${wordCount !== 1 ? 's' : ''}</span>
      </div>`;
  } else if (spark.is_complete && !hasConclusion) {
    inner += `<div class="spark-card__footer">
        <span class="spark-card__meta">no conclusion yet</span>
      </div>`;
  } else if (hasConclusion) {
    // Has writing but not yet finished — "in progress"
    inner += `<div class="spark-card__divider"></div>
      <p class="spark-card__conclusion">${escapeHtml(plainPreview)}</p>
      <div class="spark-card__footer">
        <span class="spark-card__in-progress">in progress · ${wordCount} word${wordCount !== 1 ? 's' : ''}</span>
      </div>`;
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
  const spark     = await dbGet('sparks', sparkId);
  currentSparkId  = spark.id;

  const ideaField = document.getElementById('spark-idea-field');
  const ta        = document.getElementById('spark-textarea');

  ideaField.value = spark.title || '';
  ta.value        = spark.body  || '';

  document.getElementById('spark-write-body').classList.remove('write-body--preview');
  document.getElementById('spark-write-header').classList.remove('write-header--view', 'faded');
  document.getElementById('spark-finish-btn').hidden = false;
  document.getElementById('spark-edit-btn').hidden   = true;

  autoResizeIdeaField();
  updateSparkFinishBtn();

  if (spark.is_complete) { openSparkViewMode(spark); return; }

  ideaField.readOnly = false;
  ta.readOnly        = false;

  showScreen('spark-write');
  setTimeout(() => {
    if (!ideaField.value.trim()) { ideaField.focus(); }
    else { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    resetSparkFade();
  }, 300);
}

/* ── New Spark — straight to editor ──────────────────*/
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

/* ── View Mode ────────────────────────────────────────*/
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
  clearTimeout(sparkFadeTimer);
  document.getElementById('spark-write-header').classList.remove('faded');
}

/* Edit button */
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
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); resetSparkFade(); }, 100);
});

/* ── Finish button gating ─────────────────────────────
   Only enabled when the conclusion has some content.
─────────────────────────────────────────────────────── */
function updateSparkFinishBtn() {
  const hasContent = document.getElementById('spark-textarea').value.trim().length > 0;
  const btn = document.getElementById('spark-finish-btn');
  btn.style.opacity       = hasContent ? '1' : '0.3';
  btn.style.pointerEvents = hasContent ? 'all' : 'none';
}

function autoResizeIdeaField() {
  const field = document.getElementById('spark-idea-field');
  field.style.height = 'auto';
  field.style.height = field.scrollHeight + 'px';
}

document.getElementById('spark-idea-field').addEventListener('input', () => {
  autoResizeIdeaField();
  clearTimeout(sparkSaveTimer);
  sparkSaveTimer = setTimeout(saveCurrentSpark, 800);
  resetSparkFade();
});

/* ── Auto-save ────────────────────────────────────────*/
document.getElementById('spark-textarea').addEventListener('input', () => {
  clearTimeout(sparkSaveTimer);
  sparkSaveTimer = setTimeout(saveCurrentSpark, 800);
  updateSparkFinishBtn();
  document.getElementById('spark-preview').innerHTML = renderMarkdown(
    document.getElementById('spark-textarea').value
  );
});

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

/* ── Silent discard if empty ──────────────────────────*/
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

/* ── Fade ─────────────────────────────────────────────*/
let sparkFadeTimer = null;
function resetSparkFade() {
  const header = document.getElementById('spark-write-header');
  if (header.classList.contains('write-header--view')) return;
  header.classList.remove('faded');
  clearTimeout(sparkFadeTimer);
  sparkFadeTimer = setTimeout(() => header.classList.add('faded'), 3000);
}
document.getElementById('spark-idea-field').addEventListener('focus', resetSparkFade);
document.getElementById('spark-idea-field').addEventListener('click', resetSparkFade);
document.getElementById('spark-textarea').addEventListener('focus', resetSparkFade);
document.getElementById('spark-textarea').addEventListener('click', resetSparkFade);
document.getElementById('spark-textarea').addEventListener('input', resetSparkFade);

function resetSparkWriteScreen() {
  document.getElementById('spark-write-header').classList.remove('write-header--view', 'faded');
  const finishBtn = document.getElementById('spark-finish-btn');
  finishBtn.hidden = false;
  finishBtn.style.opacity = '0.3';
  finishBtn.style.pointerEvents = 'none';
  document.getElementById('spark-edit-btn').hidden = true;
  document.getElementById('spark-write-body').classList.remove('write-body--preview');
}

/* ── Back / Home ──────────────────────────────────────*/
document.getElementById('spark-write-back-btn').addEventListener('click', async () => {
  await discardSparkIfEmpty();
  resetSparkWriteScreen();
  showScreen('spark');
  renderSparkList();
});

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

async function completeCurrentSpark() {
  const spark        = await dbGet('sparks', currentSparkId);
  // Auto-title from idea field, or first line of body as fallback
  spark.title        = spark.title || spark.body.split('\n')[0].slice(0, 60).trim() || '';
  spark.is_complete  = true;
  spark.completed_at = Date.now();
  spark.updated_at   = Date.now();
  await dbPut('sparks', spark);
  document.getElementById('spark-finish-overlay').classList.add('hidden');
  resetSparkWriteScreen();
  showScreen('spark');
  renderSparkList();
}

document.getElementById('spark-finish-save-btn').addEventListener('click', completeCurrentSpark);
document.getElementById('spark-finish-skip-btn').addEventListener('click', () => {
  document.getElementById('spark-finish-overlay').classList.add('hidden');
});

async function deleteSpark(sparkId) {
  await dbDelete('sparks', sparkId);
  renderSparkList();
}

function attachSparkLongPress(element, spark, titleText) {
  addLongPress(element, () => {
    showActionSheet(`"${titleText}"`, [
      { label: 'Promote / attach…', danger: false, action: () => openPromoteSparkModal(spark) },
      { label: 'Delete idea',       danger: true,  action: () => deleteSpark(spark.id) },
    ]);
  });
}

/* ╔═══════════════════════════════════════════════════╗
   ║  HYPOTHETICAL MODE                                ║
   ╚═══════════════════════════════════════════════════╝ */

let currentHypId       = null;  // which hypothetical is open
let currentCharId      = null;  // which character's answer we're writing
let hypSaveTimer       = null;
let editingHypId       = null;

/* ── Entry ────────────────────────────────────────────*/
document.getElementById('btn-hypothetical').addEventListener('click', () => {
  showScreen('hypothetical');
  renderHypList();
});


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
  card.className = 'hyp-card';
  card.dataset.id = hyp.id;

  // Get all answers for this hypothetical
  const answers    = await dbGetByIndex('hyp_answers', 'hypothetical_id', hyp.id);
  const allChars   = await dbGetAll('characters');

  const answeredIds = new Set(
    answers.filter(a => a.body && a.body.trim().length > 0 && a.is_complete).map(a => a.character_id)
  );
  const inProgIds = new Set(
    answers.filter(a => a.body && a.body.trim().length > 0 && !a.is_complete).map(a => a.character_id)
  );

  const answeredChars = allChars.filter(c => answeredIds.has(c.id));
  const inProgChars   = allChars.filter(c => inProgIds.has(c.id));
  const activeChars   = allChars.filter(c => !c.archived);
  const allChipsChars = [...answeredChars, ...inProgChars];

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
    if (overflow > 0) {
      chipsHtml += `<span class="hyp-chip hyp-chip--more">+${overflow} more</span>`;
    }
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


/* ── Character Answers Screen ─────────────────────────
   Shows all characters with their answer status for
   one hypothetical.
─────────────────────────────────────────────────────── */
async function openHypCharacters(hypId) {
  currentHypId = hypId;
  const hyp    = await dbGet('hypotheticals', hypId);

  document.getElementById('hyp-chars-title').textContent = hyp.question;
  showScreen('hyp-characters');
  renderHypCharactersList(hypId);
}

async function renderHypCharactersList(hypId) {
  const list     = document.getElementById('hyp-characters-list');
  const empty    = document.getElementById('hyp-characters-empty');
  const allChars = await dbGetAll('characters');
  const answers  = await dbGetByIndex('hyp_answers', 'hypothetical_id', hypId);
  const answerMap = new Map(answers.map(a => [a.character_id, a]));

  // Active characters always shown
  // Archived characters shown ONLY if they have an answer for this hypothetical
  const characters = allChars.filter(c =>
    !c.archived || (c.archived && answerMap.has(c.id) && answerMap.get(c.id).body?.trim())
  );

  characters.sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = '';
  empty.style.display = characters.length === 0 ? 'flex' : 'none';

  characters.forEach(char => {
    const answer      = answerMap.get(char.id);
    const hasText     = answer && answer.body && answer.body.trim().length > 0;
    const isComplete  = answer && answer.is_complete && hasText;
    const isInProg    = hasText && !isComplete;
    const initial     = char.name.trim()[0].toUpperCase();

    const preview = hasText
      ? (() => {
          const raw = answer.body.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').split('\n')[0].trim();
          return raw.length > 50 ? raw.slice(0, 50) + '…' : raw;
        })()
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
    // Long-press → promote option (only if has content)
    if (hasText) {
      addLongPress(item, () => {
        showActionSheet(`${char.name}`, [
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

  const ta = document.getElementById('hyp-textarea');
  ta.value = existing ? (existing.body || '') : '';

  document.getElementById('hyp-write-header').classList.remove('write-header--view', 'faded');
  document.getElementById('hyp-finish-btn').hidden = false;
  document.getElementById('hyp-edit-btn').hidden   = true;

  // If already complete, open in view mode
  if (existing && existing.is_complete && existing.body?.trim()) {
    ta.readOnly = true;
    document.getElementById('hyp-write-header').classList.add('write-header--view');
    document.getElementById('hyp-finish-btn').hidden = true;
    document.getElementById('hyp-edit-btn').hidden   = false;
    showScreen('hyp-write');
    clearTimeout(hypFadeTimer);
    document.getElementById('hyp-write-header').classList.remove('faded');
    return;
  }

  ta.readOnly = false;
  showScreen('hyp-write');
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    resetHypFade();
  }, 300);
}

/* Auto-save */
document.getElementById('hyp-textarea').addEventListener('input', () => {
  clearTimeout(hypSaveTimer);
  hypSaveTimer = setTimeout(saveCurrentHypAnswer, 800);
  resetHypFade();
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
    existing.body        = body;
    existing.updated_at  = now;
    if (markComplete) existing.is_complete = true;
    await dbPut('hyp_answers', existing);
  } else {
    await dbPut('hyp_answers', {
      id: generateId(),
      hypothetical_id: currentHypId,
      character_id:    currentCharId,
      body,
      is_complete: markComplete,
      created_at: now,
      updated_at: now,
    });
  }
}

/* Fade */
let hypFadeTimer = null;
function resetHypFade() {
  const header = document.getElementById('hyp-write-header');
  if (header.classList.contains('write-header--view')) return;
  header.classList.remove('faded');
  clearTimeout(hypFadeTimer);
  hypFadeTimer = setTimeout(() => header.classList.add('faded'), 3000);
}
document.getElementById('hyp-textarea').addEventListener('focus', resetHypFade);
document.getElementById('hyp-textarea').addEventListener('click', resetHypFade);

/* Finish button */
document.getElementById('hyp-finish-btn').addEventListener('click', async () => {
  await saveCurrentHypAnswer(true);
  showScreen('hyp-characters');
  renderHypCharactersList(currentHypId);
});

/* Edit button — reopen for writing */
document.getElementById('hyp-edit-btn').addEventListener('click', async () => {
  if (!currentHypId || !currentCharId) return;
  const answers  = await dbGetByIndex('hyp_answers', 'hypothetical_id', currentHypId);
  const existing = answers.find(a => a.character_id === currentCharId);
  if (existing) {
    existing.is_complete = false;
    existing.updated_at  = Date.now();
    await dbPut('hyp_answers', existing);
  }
  const ta = document.getElementById('hyp-textarea');
  ta.readOnly = false;
  document.getElementById('hyp-write-header').classList.remove('write-header--view');
  document.getElementById('hyp-finish-btn').hidden = false;
  document.getElementById('hyp-edit-btn').hidden   = true;
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); resetHypFade(); }, 100);
});

function openHypPromoteModal() {
  const overlay = document.getElementById('promote-spark-overlay');
  const note    = document.getElementById('promote-spark-note');
  const actions = document.getElementById('promote-spark-actions');

  note.textContent = 'Copy this answer into Continue as…';
  actions.innerHTML = '';

  const buttons = [
    { label: 'New Thread',          action: () => promoteHypToNewThread() },
    { label: 'Idea on a Thread',    action: () => promoteHypToThread() },
    { label: 'Idea on a Scene',     action: () => promoteHypToScene() },
    { label: 'Cancel', ghost: true, action: () => overlay.classList.add('hidden') },
  ];

  buttons.forEach(({ label, ghost, action }) => {
    const btn = document.createElement('button');
    btn.className = ghost ? 'btn-ghost' : 'btn-primary btn-primary--lavender';
    btn.textContent = label;
    btn.style.marginBottom = 'var(--space-sm)';
    btn.addEventListener('click', () => { overlay.classList.add('hidden'); setTimeout(action, 150); });
    actions.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

async function getHypPromoteText() {
  const hyp    = await dbGet('hypotheticals', currentHypId);
  const char   = await dbGet('characters', currentCharId);
  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', currentHypId);
  const answer  = answers.find(a => a.character_id === currentCharId);
  const body    = answer?.body?.trim() || '';
  // Idea title is just the question — character name lives in the body below the divider
  const ideaTitle    = hyp.question;
  const threadTitle  = `${hyp.question} — ${char.name}`; // only used for new thread titles
  const bodyText     = body ? `${hyp.question}\n\n—\n\n${char.name}: ${body}` : `${hyp.question}\n\n—\n\n${char.name}`;
  return { ideaTitle, threadTitle, bodyText, hyp, char };
}

async function promoteHypToNewThread() {
  const { ideaTitle, threadTitle, bodyText, hyp, char } = await getHypPromoteText();
  const now      = Date.now();
  const threadId = generateId();
  const sceneId  = generateId();

  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', currentHypId);
  const answer  = answers.find(a => a.character_id === currentCharId);

  await dbPut('threads', { id: threadId, title: threadTitle, synopsis: '', created_at: now, updated_at: now });
  await dbPut('scenes', { id: sceneId, thread_id: threadId, title: '', synopsis: '', body: answer?.body || '', is_complete: false, created_at: now, updated_at: now });
  await dbPut('sparks', { id: generateId(), title: ideaTitle, body: hyp.question, parent_type: 'thread', parent_id: threadId, is_complete: false, completed_at: null, created_at: now, updated_at: now });

  await openThreadScenes(threadId);
}

async function promoteHypToThread() {
  const { ideaTitle, bodyText } = await getHypPromoteText();
  const threads = await dbGetAll('threads');
  threads.sort((a, b) => b.updated_at - a.updated_at);

  const overlay = document.getElementById('pick-thread-overlay');
  const list    = document.getElementById('pick-thread-list');
  document.getElementById('pick-thread-title').textContent = 'Attach to which thread?';
  list.innerHTML = '';

  if (threads.length === 0) {
    list.innerHTML = `<p style="font-size:0.85rem;color:var(--ink-faint);padding:var(--space-md);text-align:center">No threads yet</p>`;
  }

  threads.forEach(thread => {
    const btn = document.createElement('button');
    btn.className = 'list-item';
    btn.innerHTML = `<span class="list-item__body"><span class="list-item__title">${escapeHtml(thread.title)}</span></span><svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
    btn.addEventListener('click', async () => {
      overlay.classList.add('hidden');
      const now = Date.now();
      await dbPut('sparks', { id: generateId(), title: ideaTitle, body: bodyText, parent_type: 'thread', parent_id: thread.id, is_complete: false, completed_at: null, created_at: now, updated_at: now });
      await openThreadScenes(thread.id);
    });
    list.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

async function promoteHypToScene() {
  const { ideaTitle, bodyText } = await getHypPromoteText();
  const threads = await dbGetAll('threads');
  threads.sort((a, b) => b.updated_at - a.updated_at);

  const overlay = document.getElementById('pick-thread-overlay');
  const list    = document.getElementById('pick-thread-list');
  document.getElementById('pick-thread-title').textContent = 'Attach to which scene?';
  list.innerHTML = '';

  for (const thread of threads) {
    const header = document.createElement('p');
    header.style.cssText = 'font-size:0.72rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-faint);padding:var(--space-sm) var(--space-md) var(--space-xs);margin-top:var(--space-sm)';
    header.textContent = thread.title;
    list.appendChild(header);

    const scenes = await dbGetByIndex('scenes', 'thread_id', thread.id);
    scenes.sort((a, b) => a.created_at - b.created_at);

    if (scenes.length === 0) {
      const empty = document.createElement('p');
      empty.style.cssText = 'font-size:0.8rem;color:var(--ink-faint);padding:0 var(--space-xl);font-style:italic';
      empty.textContent = 'no scenes yet';
      list.appendChild(empty);
      continue;
    }

    scenes.forEach((scene, i) => {
      const btn = document.createElement('button');
      btn.className = 'list-item';
      btn.style.marginLeft = 'var(--space-md)';
      btn.innerHTML = `<span class="list-item__body"><span class="list-item__title" style="font-size:0.9rem">${escapeHtml(scene.title || `Scene ${i + 1}`)}</span></span><svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
      btn.addEventListener('click', async () => {
        overlay.classList.add('hidden');
        const now = Date.now();
        await dbPut('sparks', { id: generateId(), title: ideaTitle, body: bodyText, parent_type: 'scene', parent_id: scene.id, is_complete: false, completed_at: null, created_at: now, updated_at: now });
        await openThreadScenes(scene.thread_id);
        await openScene(scene.id);
      });
      list.appendChild(btn);
    });
  }

  overlay.classList.remove('hidden');
}

/* Back from answer screen */
document.getElementById('hyp-write-back-btn').addEventListener('click', async () => {
  await saveCurrentHypAnswer();
  showScreen('hyp-characters');
  renderHypCharactersList(currentHypId);
});

document.getElementById('hyp-write-home-btn').addEventListener('click', async () => {
  await saveCurrentHypAnswer();
  showScreen('home');
});


/* ── New Hypothetical Modal ───────────────────────────*/
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
    list.innerHTML = `<p style="font-size:0.82rem;color:var(--ink-faint);text-align:center;padding:var(--space-md)">No characters yet</p>`;
    return;
  }

  // Active characters
  if (active.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'font-size:0.82rem;color:var(--ink-faint);padding:var(--space-sm) var(--space-xs);font-style:italic';
    empty.textContent = 'No active characters';
    list.appendChild(empty);
  }

  active.forEach(char => {
    const row = document.createElement('div');
    row.className = 'char-manage-item';
    row.innerHTML = `
      <span class="char-manage-item__name">${escapeHtml(char.name)}</span>
      <button class="char-manage-item__archive" data-id="${char.id}" aria-label="Archive ${escapeHtml(char.name)}" title="Archive">
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

  // Archived section
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
          <button class="char-manage-item__restore" data-id="${char.id}" title="Restore">Restore</button>
          <button class="char-manage-item__delete" data-id="${char.id}" title="Delete permanently">×</button>
        </div>
      `;
      row.querySelector('.char-manage-item__restore').addEventListener('click', async () => {
        char.archived = false;
        await dbPut('characters', char);
        renderCharManageList();
      });
      row.querySelector('.char-manage-item__delete').addEventListener('click', async () => {
        // Permanent delete — also remove all their answers
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

/* Add character */
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


/* ── Long-press on hypothetical cards ────────────────*/
function attachHypLongPress(element, hyp) {
  addLongPress(element, () => {
    showActionSheet(`"${hyp.question.slice(0, 40)}…"`, [
      { label: 'Edit question', danger: false, action: () => openEditHypModal(hyp) },
      { label: 'Delete hypothetical', danger: true, action: () => deleteHyp(hyp.id) },
    ]);
  });
}

function openEditHypModal(hyp) {
  editingHypId = hyp.id;
  document.getElementById('new-hyp-question').value = hyp.question;
  document.getElementById('new-hyp-overlay').querySelector('.sheet-title').textContent = 'Edit hypothetical';
  document.getElementById('new-hyp-save-btn').textContent = 'Save';
  document.getElementById('new-hyp-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-hyp-question').focus(), 350);
}

// Patch save button to handle edit mode
const hypSaveBtn = document.getElementById('new-hyp-save-btn');
hypSaveBtn.onclick = async () => {
  const question = document.getElementById('new-hyp-question').value.trim();
  if (!question) {
    document.getElementById('new-hyp-question').style.borderColor = 'var(--lavender)';
    document.getElementById('new-hyp-question').focus();
    return;
  }
  if (editingHypId) {
    const hyp      = await dbGet('hypotheticals', editingHypId);
    hyp.question   = question;
    hyp.updated_at = Date.now();
    await dbPut('hypotheticals', hyp);
    editingHypId   = null;
  } else {
    const now = Date.now();
    await dbPut('hypotheticals', { id: generateId(), question, created_at: now, updated_at: now });
  }
  document.getElementById('new-hyp-overlay').querySelector('.sheet-title').textContent = 'New hypothetical';
  document.getElementById('new-hyp-save-btn').textContent = 'Add hypothetical';
  document.getElementById('new-hyp-overlay').classList.add('hidden');
  renderHypList();
};

async function deleteHyp(hypId) {
  // Delete all answers for this hypothetical too
  const answers = await dbGetByIndex('hyp_answers', 'hypothetical_id', hypId);
  for (const a of answers) await dbDelete('hyp_answers', a.id);
  await dbDelete('hypotheticals', hypId);
  renderHypList();
}



/* ╔═══════════════════════════════════════════════════╗
   ║  4. CONTINUE MODE                                 ║
   ╚═══════════════════════════════════════════════════╝ */

let currentThreadId = null;
let currentSceneId  = null;
let saveTimer       = null;


/* ── Threads List ─────────────────────────────────────
   FIX: Now called every time the threads screen is shown,
   so it's never showing stale/empty data.
─────────────────────────────────────────────────────── */
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
  renderScenesList(threadId); // FIX: always render on arrival
}


/* ── Scenes List ──────────────────────────────────────
   Renders scenes with drag handles for reordering.
   In-progress pinned to top, completed below.
   Each scene has a sort_order field once manually sorted.
─────────────────────────────────────────────────────── */
let sceneSortable   = null;  // SortableJS instance
let reorderModeOn   = false; // Whether reorder mode is active

async function renderScenesList(threadId) {
  const list   = document.getElementById('scenes-list');
  const empty  = document.getElementById('scenes-empty');
  const scenes = await dbGetByIndex('scenes', 'thread_id', threadId);

  // Sort: in-progress first, then completed.
  // Within each group: newest first by default (unless manually reordered).
  scenes.sort((a, b) => {
    if (a.is_complete !== b.is_complete) return a.is_complete ? 1 : -1;
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    if (a.sort_order != null) return -1;
    if (b.sort_order != null) return 1;
    return b.created_at - a.created_at; // newest first
  });

  list.innerHTML = '';

  const hasScenes = scenes.length > 0;
  empty.style.display = hasScenes ? 'none' : 'flex';
  if (!hasScenes) {
    // Destroy sortable if list is now empty
    if (sceneSortable) { sceneSortable.destroy(); sceneSortable = null; }
    return;
  }

  // Stable scene numbers based on creation order
  const chronological = [...scenes].sort((a, b) => a.created_at - b.created_at);
  const sceneNumber   = (scene) => chronological.findIndex(s => s.id === scene.id) + 1;

  scenes.forEach((scene) => {
    const item = document.createElement('div');
    item.className   = 'list-item' + (scene.is_complete ? ' list-item--complete' : '');
    item.dataset.id  = scene.id; // SortableJS reads this to know which item moved

    const titleText  = scene.title || `Scene ${sceneNumber(scene)}`;
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

    // Tap to open (ignored during drag)
    item.addEventListener('click', (e) => {
      if (reorderModeOn) return;
      if (scene.is_complete) openSceneViewMode(scene.id);
      else openScene(scene.id);
    });

    attachSceneLongPress(item, scene, titleText);
    list.appendChild(item);
  });

  // Initialise or reinitialise SortableJS — covers scenes and thread ideas together
  if (sceneSortable) sceneSortable.destroy();

  sceneSortable = Sortable.create(list, {
    handle:    '.list-item__drag',
    animation: 150,
    ghostClass:  'sortable-ghost',
    chosenClass: 'sortable-chosen',
    draggable:   '.list-item, .idea-card--thread',
    onEnd: async () => {
      const updates = [];
      list.querySelectorAll('.list-item').forEach((item, index) => {
        updates.push(dbGet('scenes', item.dataset.id).then(scene => {
          if (!scene) return;
          scene.sort_order = index;
          return dbPut('scenes', scene);
        }));
      });
      list.querySelectorAll('.idea-card--thread').forEach((card, index) => {
        updates.push(dbGet('sparks', card.dataset.id).then(spark => {
          if (!spark) return;
          spark.sort_order = index;
          return dbPut('sparks', spark);
        }));
      });
      await Promise.all(updates);
    }
  });

  // Restore reorder mode visual if it was on
  if (reorderModeOn) list.classList.add('list-body--reorder');

  // Render thread-level idea cards above scenes
  await renderThreadSparks(threadId, list);
}


/* ── Reorder Toggle Button ────────────────────────────
   Toggles reorder mode on/off.
   In reorder mode: drag handles appear, tapping a scene
   does nothing (so you don't accidentally open it mid-drag).
─────────────────────────────────────────────────────── */
// The reorder button is hidden by default — only appears as "done"
// when reorder mode is active (triggered via long-press menu).
// Clicking it exits reorder mode.
document.getElementById('btn-reorder-scenes').addEventListener('click', exitReorderMode);

// Turn off reorder mode when leaving the scenes screen
function exitReorderMode() {
  if (!reorderModeOn) return;
  reorderModeOn = false;
  document.getElementById('scenes-list').classList.remove('list-body--reorder');
  const btn = document.getElementById('btn-reorder-scenes');
  btn.classList.remove('active');
  btn.textContent = 'reorder';
  btn.hidden = true;
  if (sceneSortable) {
    sceneSortable.option('handle', '.list-item__drag');
  }
}


/* ── Markdown Renderer ────────────────────────────────
   Converts plain text with *asterisks* into HTML.
   Supports: ***bold italic***, **bold**, *italic*,
             ___bold italic___, __bold__, _italic_
   Safe: runs escapeHtml first so user text can't inject HTML.
─────────────────────────────────────────────────────── */
function renderMarkdown(text) {
  if (!text) return '';

  // 1. Escape HTML so user text is safe
  let html = escapeHtml(text);

  // 2. Apply Markdown rules (order matters — longest match first)
  html = html
    // ***bold italic*** or ___bold italic___
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/___([\s\S]+?)___/g,       '<strong><em>$1</em></strong>')
    // **bold** or __bold__
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g,     '<strong>$1</strong>')
    // *italic* or _italic_
    .replace(/\*([\s\S]+?)\*/g, '<em>$1</em>')
    .replace(/_([\s\S]+?)_/g,   '<em>$1</em>');

  return html;
}

/* updatePreview()
   Renders the textarea content into the preview div.
   Called on every keystroke in write mode so it stays live. */
function updatePreview() {
  const ta      = document.getElementById('write-textarea');
  const preview = document.getElementById('write-preview');
  preview.innerHTML = renderMarkdown(ta.value);
}


/* ── Write Mode ───────────────────────────────────────
   Opens a scene for active writing.
─────────────────────────────────────────────────────── */
async function openScene(sceneId) {
  exitReorderMode();
  const scene  = await dbGet('scenes', sceneId);
  const thread = await dbGet('threads', scene.thread_id);

  currentSceneId  = scene.id;
  currentThreadId = scene.thread_id;

  document.getElementById('write-label').textContent = thread.title;
  document.getElementById('write-finish-btn').hidden = false;
  document.getElementById('write-edit-btn').hidden   = true;
  document.getElementById('write-header').classList.remove('write-header--view');

  const ta   = document.getElementById('write-textarea');

  ta.value    = scene.body || '';
  ta.readOnly = false;
  ta.placeholder = 'begin writing…';

  // Show textarea, hide preview
  ta.closest('.write-body').classList.remove('write-body--preview');

  showScreen('write');

  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    resetFade();
  }, 300);

  await refreshSceneSparkPanel();
}


/* ── View Mode ────────────────────────────────────────
   Opens a completed scene as read-only with rendered Markdown.
─────────────────────────────────────────────────────── */
async function openSceneViewMode(sceneId) {
  exitReorderMode();
  const scene  = await dbGet('scenes', sceneId);
  const thread = await dbGet('threads', scene.thread_id);

  currentSceneId  = scene.id;
  currentThreadId = scene.thread_id;

  const label = scene.title ? `${thread.title}  ·  ${scene.title}` : thread.title;
  document.getElementById('write-label').textContent = label;

  document.getElementById('write-finish-btn').hidden = true;
  document.getElementById('write-edit-btn').hidden   = false;
  document.getElementById('write-header').classList.add('write-header--view');

  const ta = document.getElementById('write-textarea');
  ta.value    = scene.body || '';
  ta.readOnly = true;
  ta.placeholder = '';

  // Render Markdown and show preview div instead of textarea
  updatePreview();
  ta.closest('.write-body').classList.add('write-body--preview');

  showScreen('write');

  clearTimeout(fadeTimer);
  document.getElementById('write-header').classList.remove('faded');

  await refreshSceneSparkPanel();
}


/* ── Edit Button ──────────────────────────────────────
   Reopens a completed scene for editing, removing the
   "complete" flag so it becomes an in-progress scene again.
─────────────────────────────────────────────────────── */
document.getElementById('write-edit-btn').addEventListener('click', async () => {
  if (!currentSceneId) return;
  const scene       = await dbGet('scenes', currentSceneId);
  scene.is_complete = false;
  scene.updated_at  = Date.now();
  await dbPut('scenes', scene);

  // Reopen in write mode
  openScene(currentSceneId);
});


/* ── Auto-save + live Markdown ────────────────────────
   On every keystroke: debounce-save AND update preview.
─────────────────────────────────────────────────────── */
document.getElementById('write-textarea').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentScene, 800);
  updatePreview(); // live Markdown render as you type
});

async function saveCurrentScene() {
  if (!currentSceneId) return;
  const ta = document.getElementById('write-textarea');
  if (ta.readOnly) return; // never save in view mode

  const body  = ta.value;
  const scene = await dbGet('scenes', currentSceneId);
  if (!scene) return;

  scene.body       = body;
  scene.updated_at = Date.now();
  await dbPut('scenes', scene);

  const thread = await dbGet('threads', scene.thread_id);
  if (thread) {
    thread.updated_at = Date.now();
    await dbPut('threads', thread);
  }
}


/* ── Write Header Fade ────────────────────────────────
   Only applies in write mode, not view mode.
─────────────────────────────────────────────────────── */
let fadeTimer = null;

function resetFade() {
  const header = document.getElementById('write-header');
  if (header.classList.contains('write-header--view')) return;
  header.classList.remove('faded');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => header.classList.add('faded'), 3000);
}

document.getElementById('write-textarea').addEventListener('focus', resetFade);
document.getElementById('write-textarea').addEventListener('click', resetFade);
document.getElementById('write-textarea').addEventListener('input', resetFade);


/* ── Finish Button ────────────────────────────────────
   Saves and opens the post-finish naming modal.
─────────────────────────────────────────────────────── */
document.getElementById('write-finish-btn').addEventListener('click', async () => {
  await saveCurrentScene();
  // Pre-fill with any previously saved title/synopsis
  const scene = await dbGet('scenes', currentSceneId);
  document.getElementById('finish-title').value    = scene.title    || '';
  document.getElementById('finish-synopsis').value = scene.synopsis || '';
  openFinishModal();
});

let finishModalReturnToList = false; // set true when editing from long-press

function openFinishModal() {
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
    scene.updated_at  = Date.now();
    // Allow clearing back to empty — empty string means "use fallback"
    scene.title    = title;
    scene.synopsis = synopsis;
    await dbPut('scenes', scene);
  }

  closeFinishModal();

  if (finishModalReturnToList) {
    renderScenesList(currentThreadId);
  } else {
    showScreen('scenes');
    renderScenesList(currentThreadId);
  }
});

document.getElementById('finish-skip-btn').addEventListener('click', async () => {
  if (currentSceneId) {
    const scene       = await dbGet('scenes', currentSceneId);
    scene.is_complete = true;
    scene.updated_at  = Date.now();
    await dbPut('scenes', scene);
  }

  closeFinishModal();
  showScreen('scenes');
  renderScenesList(currentThreadId);
});


/* ── New Thread Modal ─────────────────────────────────*/
document.getElementById('btn-new-thread').addEventListener('click', () => {
  document.getElementById('new-thread-title').value    = '';
  document.getElementById('new-thread-synopsis').value = '';
  openNewThreadModal();
});

function openNewThreadModal() {
  document.getElementById('new-thread-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-thread-title').focus(), 350);
}

function closeNewThreadModal() {
  document.getElementById('new-thread-overlay').classList.add('hidden');
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

  const sceneId = generateId();
  await dbPut('scenes', {
    id: sceneId, thread_id: threadId,
    title: '', synopsis: '', body: '',
    is_complete: false, created_at: now, updated_at: now,
  });

  closeNewThreadModal();
  await openScene(sceneId);
});


/* ── New Scene Button ─────────────────────────────────*/
document.getElementById('btn-new-scene').addEventListener('click', async () => {
  if (!currentThreadId) return;
  const now     = Date.now();
  const sceneId = generateId();

  await dbPut('scenes', {
    id: sceneId, thread_id: currentThreadId,
    title: '', synopsis: '', body: '',
    is_complete: false, created_at: now, updated_at: now,
  });

  await openScene(sceneId);
});


/* ╔═══════════════════════════════════════════════════╗
   ║  5. SETTINGS & CLEAR DATA                         ║
   ╚═══════════════════════════════════════════════════╝ */

/* ╔═══════════════════════════════════════════════════╗
   ║  EXPORT & IMPORT                                  ║
   ╚═══════════════════════════════════════════════════╝ */

/* ── Export ───────────────────────────────────────────
   Reads all stores, packages into JSON, triggers download.
─────────────────────────────────────────────────────── */
document.getElementById('export-btn').addEventListener('click', async () => {
  try {
    const data = {
      version:     2,
      exported_at: new Date().toISOString(),
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
    const filename = `impulse-backup-${date}.json`;

    // Create a temporary link and click it to trigger download
    const a = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    closeSettings();
  } catch (err) {
    console.error('Export failed:', err);
    alert('Export failed. Please try again.');
  }
});


/* ── Import ───────────────────────────────────────────
   File picker → confirm modal → restore.
─────────────────────────────────────────────────────── */
let pendingImportData = null; // holds parsed JSON while user confirms

document.getElementById('import-btn').addEventListener('click', () => {
  // Trigger the hidden file input
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Basic validation
    if (!data.version || !data.threads || !data.scenes || !data.sparks) {
      alert('This doesn\'t look like a valid Impulse backup file.');
      return;
    }

    // Store the parsed data and show confirmation
    pendingImportData = data;
    document.getElementById('confirm-restore-filename').textContent = `File: ${file.name}`;
    closeSettings();
    setTimeout(() => {
      document.getElementById('confirm-restore-overlay').classList.remove('hidden');
    }, 200);

  } catch (err) {
    console.error('Import parse error:', err);
    alert('Could not read this file. Make sure it\'s a valid Impulse backup.');
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

document.getElementById('confirm-restore-btn').addEventListener('click', async () => {
  if (!pendingImportData) return;

  const data = pendingImportData;
  pendingImportData = null;
  document.getElementById('confirm-restore-overlay').classList.add('hidden');

  try {
    // Clear all stores without closing the DB connection
    await clearAllStores();

    // Write all records from the backup
    const stores = ['threads', 'scenes', 'sparks', 'hypotheticals', 'hyp_answers', 'characters'];
    for (const store of stores) {
      const records = data[store] || [];
      for (const record of records) {
        await dbPut(store, record);
      }
    }

    // Reset state and go home
    currentThreadId = null;
    currentSceneId  = null;
    currentSparkId  = null;
    currentHypId    = null;
    currentCharId   = null;
    currentStickyId = null;
    reorderModeOn   = false;
    sceneSparksOpen = false;

    showScreen('home');

  } catch (err) {
    console.error('Import failed:', err);
    alert('Restore failed. Your previous data may still be intact — try again.');
  }
});

function openSettings() {
  document.getElementById('settings-overlay').classList.remove('hidden');
}
function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-backdrop').addEventListener('click', closeSettings);

/* ── Clear All Data ───────────────────────────────────
   Two-step confirmation before wiping everything.
─────────────────────────────────────────────────────── */
document.getElementById('clear-data-btn').addEventListener('click', () => {
  closeSettings();
  setTimeout(() => {
    document.getElementById('confirm-clear-overlay').classList.remove('hidden');
  }, 200);
});

document.getElementById('confirm-clear-cancel-btn').addEventListener('click', () => {
  document.getElementById('confirm-clear-overlay').classList.add('hidden');
});

document.getElementById('confirm-clear-backdrop').addEventListener('click', () => {
  document.getElementById('confirm-clear-overlay').classList.add('hidden');
});

document.getElementById('confirm-clear-btn').addEventListener('click', async () => {
  try {
    // Clear all stores without closing the DB connection
    await clearAllStores();
  } catch(e) {
    console.warn('Clear error:', e);
    alert('Could not clear data. Please try again.');
    return;
  }

  // Hide overlays
  document.getElementById('confirm-clear-overlay').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');

  // Reset ALL state variables
  currentThreadId = null;
  currentSceneId  = null;
  currentSparkId  = null;
  currentHypId    = null;
  currentCharId   = null;
  currentStickyId = null;
  editingHypId    = null;
  archiveOpen     = false;
  reorderModeOn   = false;
  sceneSparksOpen = false;

  // Go home — db connection is still alive, no reopen needed
  showScreen('home');
});


/* ╔═══════════════════════════════════════════════════╗
   ║  6. ACTION SHEET (long-press context menu)        ║
   ╚═══════════════════════════════════════════════════╝

   A generic bottom sheet that appears on long-press.
   showActionSheet(title, actions) — actions is an array of:
   { label, danger, action } objects.
*/

function showActionSheet(title, actions) {
  document.getElementById('action-sheet-title').textContent = title;

  const container = document.getElementById('action-sheet-buttons');
  container.innerHTML = '';

  actions.forEach(({ label, danger, action }) => {
    const btn = document.createElement('button');
    btn.className = 'action-sheet__btn' + (danger ? ' action-sheet__btn--danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      closeActionSheet();
      setTimeout(action, 150); // slight delay feels more natural
    });
    container.appendChild(btn);
  });

  document.getElementById('action-sheet-overlay').classList.remove('hidden');
}

function closeActionSheet() {
  document.getElementById('action-sheet-overlay').classList.add('hidden');
}

document.getElementById('action-sheet-backdrop').addEventListener('click', closeActionSheet);
document.getElementById('action-sheet-cancel').addEventListener('click', closeActionSheet);


/* ── Long-press helper ────────────────────────────────
   addLongPress(element, callback)
   Fires callback after 500ms of continuous press.
   Cancels if the user moves their finger or lets go.
─────────────────────────────────────────────────────── */
function addLongPress(element, callback) {
  let timer     = null;
  let didLong   = false;

  function start(e) {
    didLong = false;
    element.classList.add('pressing');
    timer = setTimeout(() => {
      didLong = true;
      element.classList.remove('pressing');
      // Vibrate briefly if supported (nice tactile feedback on Android)
      if (navigator.vibrate) navigator.vibrate(40);
      callback(e);
    }, 500);
  }

  function cancel() {
    clearTimeout(timer);
    element.classList.remove('pressing');
  }

  function preventIfLong(e) {
    if (didLong) {
      e.preventDefault();
      e.stopPropagation();
      didLong = false;
    }
  }

  element.addEventListener('pointerdown',  start);
  element.addEventListener('pointerup',    cancel);
  element.addEventListener('pointerleave', cancel);
  element.addEventListener('pointermove',  cancel);
  element.addEventListener('click',        preventIfLong, true);
}


/* ── Delete a Thread ──────────────────────────────────*/
async function deleteThread(threadId) {
  const scenes = await dbGetByIndex('scenes', 'thread_id', threadId);
  for (const scene of scenes) await dbDelete('scenes', scene.id);
  await dbDelete('threads', threadId);
  renderThreadsList();
}

/* ── Edit Thread Modal ────────────────────────────────*/
let editingThreadId = null;

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
  // If we're currently inside this thread's scenes, update the header
  if (currentThreadId === editingThreadId) {
    document.getElementById('scenes-thread-title').textContent    = title;
    document.getElementById('scenes-thread-synopsis').textContent = synopsis;
  }
});

/* Long-press a thread → Edit title/synopsis or Delete */
function attachThreadLongPress(element, thread) {
  addLongPress(element, () => {
    showActionSheet(`"${thread.title}"`, [
      {
        label:  'Edit title & synopsis',
        danger: false,
        action: () => openEditThreadModal(thread),
      },
      {
        label:  'Delete thread & all scenes',
        danger: true,
        action: () => deleteThread(thread.id),
      },
    ]);
  });
}


/* ── Delete a Scene ───────────────────────────────────*/
async function deleteScene(sceneId) {
  await dbDelete('scenes', sceneId);
  renderScenesList(currentThreadId);
}

/* Long-press a scene → Reorder / Edit title & note / Delete */
function attachSceneLongPress(element, scene, sceneTitle) {
  addLongPress(element, () => {
    showActionSheet(`"${sceneTitle}"`, [
      {
        label:  'Reorder',
        danger: false,
        action: () => enterReorderMode(),
      },
      {
        label:  'Edit title & note',
        danger: false,
        action: () => openFinishModalForScene(scene.id),
      },
      {
        label:  'Delete scene',
        danger: true,
        action: () => deleteScene(scene.id),
      },
    ]);
  });
}

/* openFinishModalForScene(sceneId)
   Opens the finish/naming modal pre-filled for any scene,
   even ones not currently open in the write screen.
   Used by the long-press "Edit title & note" action. */
async function openFinishModalForScene(sceneId) {
  // Temporarily set currentSceneId so the save button knows what to update
  currentSceneId = sceneId;
  const scene = await dbGet('scenes', sceneId);
  document.getElementById('finish-title').value    = scene.title    || '';
  document.getElementById('finish-synopsis').value = scene.synopsis || '';
  // Override save behaviour: don't navigate away, just save and close
  finishModalReturnToList = true;
  openFinishModal();
}

/* enterReorderMode()
   Activates reorder mode on the scenes list — same as the
   old button, now triggered from the long-press menu. */
function enterReorderMode() {
  const list = document.getElementById('scenes-list');
  const btn  = document.getElementById('btn-reorder-scenes');
  reorderModeOn = true;
  list.classList.add('list-body--reorder');
  btn.classList.add('active');
  btn.textContent = 'done';
  btn.hidden = false;
  // Switch to whole-card dragging for both scenes and idea cards
  if (sceneSortable) {
    sceneSortable.option('handle', '.list-item, .idea-card--thread');
  }
}



/* ╔═══════════════════════════════════════════════════╗
   ║  CROSS-MODE INTEGRATION                           ║
   ╚═══════════════════════════════════════════════════╝

   Sticky sparks: idea-only notes attached to a thread
   or scene. No conclusion, no completion state.
   parent_type: 'thread' | 'scene' | null (standalone)
   parent_id:   the thread or scene id, or null
*/

let sceneSparksOpen   = false;
let currentStickyId   = null; // currently open sticky spark in editor


/* ══ SCENES HOME BUTTON ══════════════════════════════*/
document.getElementById('scenes-home-btn').addEventListener('click', async () => {
  await saveCurrentScene();
  exitReorderMode();
  showScreen('home');
});


/* ══ THREAD-LEVEL IDEAS ══════════════════════════════
   Tappable idea cards that float above scenes in the
   Scenes list. Tap to open a full editor.
═══════════════════════════════════════════════════ */

document.getElementById('btn-new-thread-spark').addEventListener('click', () => {
  openStickySparkEditor(null, 'thread', currentThreadId);
});

async function renderThreadSparks(threadId, container) {
  const allSparks    = await getSparksByParent(threadId);
  const threadSparks = allSparks.filter(s => s.parent_type === 'thread');
  threadSparks.sort((a, b) => {
    if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
    return b.created_at - a.created_at;
  });

  container.querySelectorAll('.idea-card--thread').forEach(el => el.remove());

  threadSparks.forEach(spark => {
    const card = makeIdeaCard(spark, 'thread');
    const firstScene = container.querySelector('.list-item');
    if (firstScene) container.insertBefore(card, firstScene);
    else container.appendChild(card);
  });
}

function makeIdeaCard(spark, level) {
  const card = document.createElement('div');
  card.className   = `idea-card idea-card--${level}`;
  card.dataset.sparkId = spark.id;
  card.dataset.id      = spark.id;

  const text      = spark.title || spark.body || '';
  const wordCount = spark.body ? spark.body.trim().split(/\s+/).filter(Boolean).length : 0;
  const preview   = text.split('\n')[0].slice(0, 80);

  // Thread ideas get a drag handle; scene ideas do not
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



/* ══ SCENE-LEVEL IDEAS ═══════════════════════════════
   Collapsible panel at top of write screen.
   Shows inline idea cards above the writing area.
═══════════════════════════════════════════════════ */

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

  // ALWAYS reset label to avoid stale counts
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
  sceneSparks.forEach(spark => {
    list.appendChild(makeIdeaCard(spark, 'scene'));
  });

  // Restore open state
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


/* ══ STICKY SPARK FULL EDITOR ════════════════════════
   Full-screen editor for thread/scene ideas.
   Replaces the old modal approach.
═══════════════════════════════════════════════════ */

async function openStickySparkEditor(sparkId, parentType, parentId) {
  const ta    = document.getElementById('sticky-write-textarea');
  const label = document.getElementById('sticky-write-label');

  // Set the context label
  if (parentType === 'thread') {
    const thread = await dbGet('threads', parentId);
    label.textContent = thread ? `Idea — ${thread.title}` : 'Thread idea';
  } else {
    const scene  = await dbGet('scenes', parentId);
    const thread = scene ? await dbGet('threads', scene.thread_id) : null;
    label.textContent = thread ? `Idea — ${thread.title}` : 'Scene idea';
  }

  if (sparkId) {
    // Editing existing
    const spark = await dbGet('sparks', sparkId);
    ta.value          = spark.body || spark.title || '';
    currentStickyId   = sparkId;
  } else {
    // Creating new — pre-create so autosave works
    const now     = Date.now();
    const newId   = generateId();
    await dbPut('sparks', {
      id: newId, title: '', body: '',
      parent_type: parentType, parent_id: parentId,
      is_complete: false, completed_at: null,
      created_at: now, updated_at: now,
    });
    ta.value          = '';
    currentStickyId   = newId;
  }

  // Store where to return to
  document.getElementById('screen-sticky-write')._parentType = parentType;
  document.getElementById('screen-sticky-write')._parentId   = parentId;

  showScreen('sticky-write');
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 300);
}

// Auto-save
let stickyWriteTimer = null;
document.getElementById('sticky-write-textarea').addEventListener('input', () => {
  clearTimeout(stickyWriteTimer);
  stickyWriteTimer = setTimeout(saveStickySparkEdits, 600);
});

async function saveStickySparkEdits() {
  if (!currentStickyId) return;
  const text  = document.getElementById('sticky-write-textarea').value;
  const spark = await dbGet('sparks', currentStickyId);
  if (!spark) return;
  spark.title      = text.split('\n')[0].slice(0, 80).trim();
  spark.body       = text;
  spark.updated_at = Date.now();
  await dbPut('sparks', spark);
}

async function leaveStickySparkEditor() {
  await saveStickySparkEdits();
  // Discard if empty
  const text = document.getElementById('sticky-write-textarea').value.trim();
  if (!text && currentStickyId) {
    await dbDelete('sparks', currentStickyId);
  }
  const screen     = document.getElementById('screen-sticky-write');
  const parentType = screen._parentType;
  const parentId   = screen._parentId;
  currentStickyId   = null;

  // Return to the right place
  if (parentType === 'thread') {
    showScreen('scenes');
    renderScenesList(parentId);
  } else {
    // Return to write screen — the scene sparks panel will refresh
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
  currentStickyId = null;
  showScreen('home');
});


/* ══ PROMOTE A SPARK ════════════════════════════════
   Long-press a complete Spark → promote flow.
═══════════════════════════════════════════════════ */

function openPromoteSparkModal(spark) {
  const overlay = document.getElementById('promote-spark-overlay');
  const note    = document.getElementById('promote-spark-note');
  const actions = document.getElementById('promote-spark-actions');

  note.textContent = spark.body && spark.body.trim()
    ? 'What would you like to do with this Spark?'
    : 'This Spark has no conclusion yet — you can only attach its idea.';

  actions.innerHTML = '';
  const buttons = [];

  if (spark.body && spark.body.trim()) {
    buttons.push({ label: 'Promote conclusion → new Thread', action: () => promoteSparkToNewThread(spark) });
  }
  buttons.push({ label: 'Attach to existing Thread', action: () => attachSparkToThread(spark) });
  buttons.push({ label: 'Attach to existing Scene',  action: () => attachSparkToScene(spark) });
  buttons.push({ label: 'Cancel', ghost: true, action: () => overlay.classList.add('hidden') });

  buttons.forEach(({ label, ghost, action }) => {
    const btn = document.createElement('button');
    btn.className = ghost ? 'btn-ghost' : 'btn-primary';
    btn.textContent = label;
    btn.style.marginBottom = 'var(--space-sm)';
    btn.addEventListener('click', () => { overlay.classList.add('hidden'); setTimeout(action, 150); });
    actions.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

document.getElementById('promote-spark-backdrop').addEventListener('click', () => {
  document.getElementById('promote-spark-overlay').classList.add('hidden');
});

async function promoteSparkToNewThread(spark) {
  const now      = Date.now();
  const threadId = generateId();
  const sceneId  = generateId();
  const threadTitle = spark.title || spark.body.split('\n')[0].slice(0, 60).trim() || 'New Thread';

  await dbPut('threads', { id: threadId, title: threadTitle, synopsis: '', created_at: now, updated_at: now });
  // Conclusion becomes first scene — untitled, body preserved
  await dbPut('scenes', { id: sceneId, thread_id: threadId, title: '', synopsis: '', body: spark.body || '', is_complete: false, created_at: now, updated_at: now });

  if (spark.title) {
    await dbPut('sparks', { id: generateId(), title: spark.title, body: spark.title, parent_type: 'thread', parent_id: threadId, is_complete: false, completed_at: null, created_at: now, updated_at: now });
  }

  await dbDelete('sparks', spark.id);
  await openThreadScenes(threadId);
}

async function attachSparkToThread(spark) {
  const threads = await dbGetAll('threads');
  threads.sort((a, b) => b.updated_at - a.updated_at);

  const overlay = document.getElementById('pick-thread-overlay');
  const list    = document.getElementById('pick-thread-list');
  document.getElementById('pick-thread-title').textContent = 'Attach to which thread?';
  list.innerHTML = '';

  if (threads.length === 0) {
    list.innerHTML = `<p style="font-size:0.85rem;color:var(--ink-faint);padding:var(--space-md);text-align:center">No threads yet</p>`;
  }

  threads.forEach(thread => {
    const btn = document.createElement('button');
    btn.className = 'list-item';
    btn.innerHTML = `<span class="list-item__body"><span class="list-item__title">${escapeHtml(thread.title)}</span></span><svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
    btn.addEventListener('click', async () => {
      overlay.classList.add('hidden');
      const now      = Date.now();
      const ideaText = spark.title || spark.body.split('\n')[0].slice(0, 60).trim();
      // If there's a conclusion, fold it in below the idea with a divider
      const bodyText = spark.body && spark.body.trim() && spark.body.trim() !== ideaText
        ? `${ideaText}\n\n—\n\n${spark.body.trim()}`
        : ideaText;
      await dbPut('sparks', {
        id: generateId(), title: ideaText, body: bodyText,
        parent_type: 'thread', parent_id: thread.id,
        is_complete: false, completed_at: null,
        created_at: now, updated_at: now,
      });
      await dbDelete('sparks', spark.id);
      await openThreadScenes(thread.id);
    });
    list.appendChild(btn);
  });

  overlay.classList.remove('hidden');
}

async function attachSparkToScene(spark) {
  const threads = await dbGetAll('threads');
  threads.sort((a, b) => b.updated_at - a.updated_at);

  const overlay = document.getElementById('pick-thread-overlay');
  const list    = document.getElementById('pick-thread-list');
  list.innerHTML = '';

  if (threads.length === 0) {
    list.innerHTML = `<p style="font-size:0.85rem;color:var(--ink-faint);padding:var(--space-md);text-align:center">No threads yet</p>`;
    overlay.classList.remove('hidden');
    return;
  }

  // Build a flat list: thread header + its scenes indented
  for (const thread of threads) {
    // Thread label (non-tappable)
    const header = document.createElement('p');
    header.style.cssText = 'font-size:0.72rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-faint);padding:var(--space-sm) var(--space-md) var(--space-xs);margin-top:var(--space-sm)';
    header.textContent = thread.title;
    list.appendChild(header);

    const scenes = await dbGetByIndex('scenes', 'thread_id', thread.id);
    scenes.sort((a, b) => a.created_at - b.created_at);

    if (scenes.length === 0) {
      const empty = document.createElement('p');
      empty.style.cssText = 'font-size:0.8rem;color:var(--ink-faint);padding:0 var(--space-xl);font-style:italic';
      empty.textContent = 'no scenes yet';
      list.appendChild(empty);
      continue;
    }

    scenes.forEach((scene, i) => {
      const btn = document.createElement('button');
      btn.className = 'list-item';
      btn.style.marginLeft = 'var(--space-md)';
      const sceneTitle = scene.title || `Scene ${i + 1}`;
      btn.innerHTML = `<span class="list-item__body"><span class="list-item__title" style="font-size:0.9rem">${escapeHtml(sceneTitle)}</span></span><svg class="list-item__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
      btn.addEventListener('click', async () => {
        overlay.classList.add('hidden');
        const now      = Date.now();
        const ideaText = spark.title || spark.body.split('\n')[0].slice(0, 60).trim();
        const bodyText = spark.body && spark.body.trim() && spark.body.trim() !== ideaText
          ? `${ideaText}\n\n—\n\n${spark.body.trim()}`
          : ideaText;
        await dbPut('sparks', {
          id: generateId(), title: ideaText, body: bodyText,
          parent_type: 'scene', parent_id: scene.id,
          is_complete: false, completed_at: null,
          created_at: now, updated_at: now,
        });
        await dbDelete('sparks', spark.id);
        await openThreadScenes(scene.thread_id);
        await openScene(scene.id);
      });
      list.appendChild(btn);
    });
  }

  document.getElementById('pick-thread-title').textContent = 'Attach to which scene?';
  overlay.classList.remove('hidden');
}

document.getElementById('pick-thread-backdrop').addEventListener('click', () => {
  document.getElementById('pick-thread-overlay').classList.add('hidden');
});


function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ╔═══════════════════════════════════════════════════╗
   ║  7. SERVICE WORKER                                ║
   ╚═══════════════════════════════════════════════════╝ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Impulse: service worker registered ✓'))
      .catch(err => console.warn('Impulse: service worker failed', err));
  });
}


/* ╔═══════════════════════════════════════════════════╗
   ║  INIT                                             ║
   ╚═══════════════════════════════════════════════════╝ */

openDB()
  .then(() => console.log('Impulse: database ready ✓'))
  .catch(err => console.error('Impulse: database error', err));


/* ╔═══════════════════════════════════════════════════╗
   ║  THEME TOGGLE                                     ║
   ╚═══════════════════════════════════════════════════╝

   Three modes: system (default), light, dark.
   Preference stored in localStorage so it survives
   page reloads. Applied via data-theme on <html>.
*/

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark')        root.setAttribute('data-theme', 'dark');
  else if (theme === 'light')  root.setAttribute('data-theme', 'light');
  else                         root.removeAttribute('data-theme');

  // Update theme-color meta tags to match
  const isDark = theme === 'dark' ||
    (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(el => {
    el.setAttribute('content', isDark ? '#1c1610' : '#f5efe6');
  });

  // Update active button state
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });

  localStorage.setItem('impulse-theme', theme);
}

// Wire up the three buttons
document.getElementById('theme-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-btn');
  if (btn) applyTheme(btn.dataset.theme);
});

// Apply saved preference on load (before DB is ready, so it's instant)
applyTheme(localStorage.getItem('impulse-theme') || 'system');

