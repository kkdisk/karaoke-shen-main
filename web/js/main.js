import { hasBackend, rpc } from './api.js';
import { AudioEngine, EQ_BANDS } from './audio-engine.js';
import {
  bindMediaSessionHandlers,
  clearMediaSession,
  setMediaSessionPlaybackState,
  updateMediaSessionMetadata,
} from './media-session.js';
import { SpectrumVisualizer } from './spectrum.js';
import {
  DEFAULT_QUALITY,
  MAX_IMPORT_BYTES,
  MAX_PLAYLIST_SIZE,
  QUALITY_STORAGE_KEY,
  STORAGE_KEY,
  normalizeQuality,
  safeThumbnail,
  sanitize,
  validItem,
} from './validation.js';

const AI_ACTIVE_STATES = ['downloading', 'preparing', 'separating', 'muxing', 'cancelling'];

const AI_STAGE_LABELS = {
  downloading: '下載影音',
  preparing: '準備音訊',
  separating: 'AI 人聲分離',
  muxing: '合成歡唱影片',
  cancelling: '取消製作',
  cancelled: '已取消',
  error: '製作失敗',
  ready: '製作完成',
};

function formatDb(value) {
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num} dB`;
}

function qualityLabel(quality) {
  return quality === 1440 ? '2K (1440p)' : `${quality}p`;
}

const PANELS_STORAGE_KEY = 'shen-panels-v1';
const TOAST_MS = 3200;

const AI_SUMMARY_LABELS = {
  ready: '已就緒',
  cancelled: '已取消',
  error: '製作失敗',
  unavailable: '無法使用',
  busy: '忙碌中',
};

/** Classify the decoded video size into a short label (2K / 1080p / 720p …). */
export function videoQualityLabel(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return '';
  // Landscape: treat ultra-wide (e.g. 1920×800) by its width; portrait: by its short side.
  const lines = w >= h ? Math.max(h, Math.round((w * 9) / 16)) : w;
  if (lines >= 2160) return '4K';
  if (lines >= 1440) return '2K';
  if (lines >= 1080) return '1080p';
  if (lines >= 720) return '720p';
  return `${lines}p`;
}

function trackNumber(index) {
  return String(index + 1).padStart(2, '0');
}

export function createApp({ doc = globalThis.document, storage = globalThis.localStorage, audioEngine: customAudio, spectrum: customSpectrum } = {}) {
  const $ = id => doc.getElementById(id);
  const player = $('player');

  let playlist = [];
  let currentIndex = -1;
  let playRequestId = 0;
  let singing = false;
  let aiMedia = null;
  let usingAI = false;
  let pollTimer = null;
  let sourceCleanup = null;
  let sourcePending = false;
  let aiAvailable = false;
  let aiChecked = false;
  let wantsResume = false;
  let selectedQuality = DEFAULT_QUALITY;

  const audio = customAudio || new AudioEngine(player, id => $(`eq-${id}`)?.value ?? 0);
  const spectrum = customSpectrum || new SpectrumVisualizer($('spectrum-canvas'), $('spectrum-container'));

  let toastTimer = null;

  /** Search feedback, shown under the search box. */
  function setSearchStatus(message) {
    const el = $('search-status');
    if (el) el.textContent = message;
  }

  /** Playback state chip next to the song title (hidden when empty). */
  function setPlayStatus(message) {
    const el = $('play-status');
    if (el) el.textContent = message;
  }

  /** Short-lived success / info message. */
  function showToast(message) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), TOAST_MS);
  }

  /** Errors stay visible (and announced) until dismissed or replaced. */
  function showError(message) {
    const wrap = $('app-error-wrap');
    if (wrap) wrap.hidden = false;
    $('app-error').textContent = message;
  }

  function clearError() {
    const wrap = $('app-error-wrap');
    if (wrap) wrap.hidden = true;
    $('app-error').textContent = '';
  }

  function setAIStatus(message) {
    $('ai-status').textContent = message;
  }

  function renderAISummary(state, percent) {
    const summary = $('ai-summary');
    if (!summary) return;
    let text = '';
    if (AI_ACTIVE_STATES.includes(state)) {
      text = AI_STAGE_LABELS[state] || '製作中';
      if (typeof percent === 'number' && Number.isFinite(percent)) text += ` ${Math.round(percent)}%`;
    } else {
      text = AI_SUMMARY_LABELS[state] || '';
    }
    if (!text && aiChecked && !aiAvailable) text = AI_SUMMARY_LABELS.unavailable;
    summary.textContent = text;
    summary.className = `panel-summary${state === 'ready' ? ' ready' : ''}${state === 'error' ? ' error' : ''}`;
  }

  function renderQualityChip() {
    const chip = $('now-quality');
    if (!chip) return;
    const label = player.hasAttribute('src') ? videoQualityLabel(player.videoWidth, player.videoHeight) : '';
    chip.textContent = label;
    chip.hidden = !label;
    if (label) chip.setAttribute('title', `實際播放畫質 ${player.videoWidth}×${player.videoHeight}`);
  }

  function renderVolume() {
    const vol = Number.isFinite(player.volume) ? player.volume : 1;
    const muted = Boolean(player.muted);
    const slider = $('volume-slider');
    slider.value = vol;
    slider.setAttribute('aria-valuetext', muted ? '靜音' : `${Math.round(vol * 100)}%`);
    const output = $('volume-val');
    if (output) output.textContent = muted ? '靜音' : `${Math.round(vol * 100)}%`;
    const icon = $('volume-icon');
    if (icon) icon.textContent = muted || vol === 0 ? '🔇' : vol < 0.5 ? '🔉' : '🔊';
    const muteBtn = $('mute-btn');
    if (muteBtn) {
      muteBtn.setAttribute('aria-pressed', String(muted));
      muteBtn.setAttribute('aria-label', muted ? '取消靜音' : '靜音');
    }
  }

  function eqPanelOpen() {
    const panel = $('eq-panel');
    return Boolean(panel && !panel.hidden && panel.open);
  }

  function restorePanels() {
    let state = {};
    try {
      state = JSON.parse(storage.getItem(PANELS_STORAGE_KEY) || '{}') || {};
    } catch {
      /* corrupt or blocked storage */
    }
    if (typeof state.ai === 'boolean') $('ai-details').open = state.ai;
    if (typeof state.eq === 'boolean') $('eq-panel').open = state.eq;
  }

  function persistPanels() {
    try {
      storage.setItem(
        PANELS_STORAGE_KEY,
        JSON.stringify({ ai: Boolean($('ai-details').open), eq: Boolean($('eq-panel').open) })
      );
    } catch {
      /* quota/private mode */
    }
  }

  function renderAIProgress(result) {
    renderAISummary(result.state, result.progress);
    const active = AI_ACTIVE_STATES.includes(result.state);
    $('ai-progress').hidden = !active && result.state !== 'ready';
    $('ai-progress-panel').hidden = !active && !['ready', 'cancelled', 'error'].includes(result.state);
    $('ai-progress-stage').textContent = AI_STAGE_LABELS[result.state] || '';
    $('ai-progress-panel').classList.toggle('ready', result.state === 'ready');

    const percent = result.progress;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      $('ai-progress').value = Math.max(0, Math.min(100, percent));
      $('ai-progress-percent').textContent = `${Math.round(percent)}%`;
    } else {
      $('ai-progress').removeAttribute('value');
      $('ai-progress-percent').textContent = active ? '等待進度…' : '';
    }

    $('ai-progress-detail').textContent = result.detail || '';
    const seconds = result.elapsed_seconds;
    $('ai-progress-elapsed').textContent =
      typeof seconds === 'number' && Number.isFinite(seconds)
        ? `已耗時 ${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`
        : '';
  }

  function songContent(item, parent) {
    const img = doc.createElement('img');
    const thumb = safeThumbnail(item.thumbnail);
    if (thumb) img.src = thumb;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;

    const info = doc.createElement('div');
    info.className = 'info';
    const title = doc.createElement('div');
    title.className = 'title';
    title.textContent = item.title;
    info.append(title);
    parent.append(img, info);
    return info;
  }

  function nowPlayingBadge() {
    const badge = doc.createElement('span');
    badge.className = 'now-badge';
    const bars = doc.createElement('span');
    bars.className = 'sound-bars';
    bars.setAttribute('aria-hidden', 'true');
    bars.append(doc.createElement('i'), doc.createElement('i'), doc.createElement('i'));
    const label = doc.createElement('span');
    label.textContent = '♪ 播放中';
    badge.append(bars, label);
    return badge;
  }

  /** Scroll only the playlist container (never the page) so the active row is visible. */
  function scrollActiveIntoView() {
    const list = $('playlist-items');
    const row = list.children?.[currentIndex];
    if (!row || typeof list.scrollTo !== 'function') return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    list.scrollTo({ top: Math.max(0, top - 8), behavior: reduce ? 'auto' : 'smooth' });
  }

  function persist() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(playlist));
    } catch {
      /* quota/private mode */
    }
  }

  function persistQuality() {
    try {
      storage.setItem(QUALITY_STORAGE_KEY, String(selectedQuality));
    } catch {
      /* quota/private mode */
    }
  }

  function updateActiveRow() {
    const list = $('playlist-items');
    Array.from(list.children || []).forEach((row, index) => {
      if (!row.classList || !row.classList.contains('playlist-item')) return;
      const isActive = index === currentIndex;
      row.classList.toggle('active', isActive);
      const playBtn = row.children?.[0];
      if (playBtn && typeof playBtn.setAttribute === 'function') {
        if (isActive) playBtn.setAttribute('aria-current', 'true');
        else playBtn.removeAttribute('aria-current');
      }
    });
  }

  function moveSong(from, to, focusAction = null) {
    if (from < 0 || from >= playlist.length || to < 0 || to >= playlist.length || from === to) return;
    const active = playlist[currentIndex];
    const [moved] = playlist.splice(from, 1);
    playlist.splice(to, 0, moved);
    currentIndex = active ? playlist.indexOf(active) : -1;
    renderPlaylist();
    if (focusAction) {
      const targetRow = $('playlist-items').children?.[to];
      const controls = targetRow?.children?.[1];
      const btnIndex = focusAction === 'up' ? 0 : 1;
      const btn = controls?.children?.[btnIndex];
      if (btn && !btn.disabled && typeof btn.focus === 'function') {
        btn.focus();
      } else {
        targetRow?.children?.[0]?.focus?.();
      }
    }
  }

  function renderPlaylist() {
    const list = $('playlist-items');
    list.replaceChildren();
    $('queue-count').textContent = `${playlist.length} 首`;

    playlist.forEach((item, index) => {
      const row = doc.createElement('li');
      row.className = `playlist-item${index === currentIndex ? ' active' : ''}`;
      row.draggable = true;

      const playBtn = doc.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'playlist-play-btn';
      playBtn.setAttribute('aria-label', `播放 ${item.title}`);
      if (index === currentIndex) playBtn.setAttribute('aria-current', 'true');
      // Keep children[0] = thumbnail, children[1] = info (title first); the number is placed with CSS `order`.
      const info = songContent(item, playBtn);
      info.append(nowPlayingBadge());
      const number = doc.createElement('span');
      number.className = 'track-no';
      number.setAttribute('aria-hidden', 'true');
      number.textContent = trackNumber(index);
      playBtn.append(number);
      playBtn.onclick = event => {
        if (event?.detail > 0) playBtn.blur?.();
        playSong(index);
      };

      const controls = doc.createElement('div');
      controls.className = 'playlist-item-controls';

      const upBtn = doc.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'item-action-btn';
      upBtn.textContent = '↑';
      upBtn.disabled = index === 0;
      upBtn.setAttribute('aria-label', `上移 ${item.title}`);
      upBtn.onclick = () => moveSong(index, index - 1, 'up');

      const downBtn = doc.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'item-action-btn';
      downBtn.textContent = '↓';
      downBtn.disabled = index === playlist.length - 1;
      downBtn.setAttribute('aria-label', `下移 ${item.title}`);
      downBtn.onclick = () => moveSong(index, index + 1, 'down');

      const removeBtn = doc.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'item-action-btn delete-btn';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', `移除 ${item.title}`);
      removeBtn.onclick = () => removeSong(index, true);

      controls.append(upBtn, downBtn, removeBtn);
      row.append(playBtn, controls);

      row.ondragstart = event => {
        event.dataTransfer.setData('text/plain', String(index));
        row.classList.add('dragging');
      };
      row.ondragend = () => row.classList.remove('dragging');
      row.ondragover = event => event.preventDefault();
      row.ondrop = event => {
        event.preventDefault();
        const value = event.dataTransfer.getData('text/plain');
        if (!/^\d+$/.test(value)) return;
        moveSong(Number(value), index);
      };

      list.append(row);
    });

    if (!playlist.length) {
      const empty = doc.createElement('li');
      empty.className = 'empty-queue';
      empty.textContent = '搜尋歌曲，開始你的歡唱清單';
      list.append(empty);
    }
    persist();
  }

  function stopPlayback() {
    ++playRequestId;
    clearTimeout(pollTimer);
    if (sourceCleanup) sourceCleanup();
    sourcePending = false;
    player.pause();
    player.removeAttribute('src');
    player.load();
    wantsResume = false;
    currentIndex = -1;
    aiMedia = null;
    usingAI = false;
    $('now-playing-title').textContent = '尚未播放歌曲';
    setPlayStatus('');
    renderQualityChip();
    setAIStatus('選擇歌曲後可製作 AI 伴奏');
    renderAIProgress({ state: 'idle' });
    $('prepare-ai-btn').disabled = true;
    $('clear-ai-cache-btn').hidden = true;
    $('cancel-ai-btn').hidden = true;
    $('use-ai').disabled = true;
    $('use-ai').checked = false;
    spectrum.stop();
    clearMediaSession();
    applyMode();
  }

  function removeSong(index, restoreFocus = false) {
    const active = playlist[currentIndex];
    const removed = playlist[index];
    playlist.splice(index, 1);

    if (removed === active) {
      stopPlayback();
      if (playlist.length) playSong(Math.min(index, playlist.length - 1));
    } else {
      currentIndex = active ? playlist.indexOf(active) : -1;
    }

    renderPlaylist();

    if (restoreFocus) {
      if (playlist.length) {
        const nextIdx = Math.min(index, playlist.length - 1);
        $('playlist-items').children?.[nextIdx]?.children?.[0]?.focus?.();
      } else {
        $('search-input')?.focus?.();
      }
    }
  }

  function addSong(item) {
    if (!validItem(item) || playlist.length >= MAX_PLAYLIST_SIZE) {
      showError(`清單上限為 ${MAX_PLAYLIST_SIZE} 首，或歌曲資料無效`);
      return;
    }
    playlist.push(sanitize(item));
    renderPlaylist();
    if (currentIndex === -1) playSong(playlist.length - 1);
  }

  function applyMode() {
    const guideBtn = $('mode-guide');
    const singingBtn = $('mode-singing');
    guideBtn.classList.toggle('active', !singing);
    guideBtn.setAttribute('aria-pressed', String(!singing));
    singingBtn.classList.toggle('active', singing);
    singingBtn.setAttribute('aria-pressed', String(singing));
    $('eq-panel').hidden = !singing;
    $('quick-mix').hidden = !singing;
    $('quick-controls').hidden = usingAI;
    $('mode-detail').textContent = usingAI
      ? 'AI 分離：保留立體聲伴奏；仍可能有分離瑕疵'
      : '快速模式：削弱中央人聲，也可能影響中央樂器';

    if (currentIndex >= 0 && playlist[currentIndex]) {
      const modeLabel = singing ? (usingAI ? 'AI 伴奏歡唱' : '快速歡唱') : '原唱導唱';
      updateMediaSessionMetadata(playlist[currentIndex], modeLabel);
    }

    audio.applyMode({
      singing,
      usingAI,
      vocalStrength: $('vocal-strength').value,
      accompanimentGain: $('accompaniment-gain').value,
    });

    // Only draw the 60fps spectrum while the EQ panel is actually expanded.
    if (singing && eqPanelOpen() && !player.paused && !doc.hidden) {
      spectrum.start(audio.analyser);
    } else {
      spectrum.stop();
    }
  }

  async function loadSource(url, token, position = 0, resume = true) {
    if (token !== playRequestId) return;
    if (sourceCleanup) sourceCleanup();
    sourcePending = true;
    wantsResume = resume;
    player.pause();
    player.src = url;
    player.load();

    await new Promise((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('影片無法載入，請重試或更換來源'));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        player.removeEventListener('loadedmetadata', ready);
        player.removeEventListener('error', failed);
        sourceCleanup = null;
        if (token === playRequestId) sourcePending = false;
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('載入逾時，請重試'));
      }, 60000);
      sourceCleanup = () => {
        cleanup();
        resolve();
      };
      player.addEventListener('loadedmetadata', ready, { once: true });
      player.addEventListener('error', failed, { once: true });
    });

    if (token !== playRequestId) return;
    if (position && player.seekable.length && Number.isFinite(player.duration)) {
      player.currentTime = Math.min(position, Math.max(0, player.duration - 0.1));
    } else if (position) {
      showToast('此串流無法跳轉，已從開頭播放。AI 快取影片支援拖曳進度。');
    }

    applyMode();
    if (resume) {
      audio.init();
      await audio.resume();
      await player.play();
    }
  }

  async function playSong(index) {
    if (index < 0 || index >= playlist.length) return;
    const token = ++playRequestId;
    clearTimeout(pollTimer);
    if (sourceCleanup) sourceCleanup();
    sourcePending = false;
    player.pause();
    player.removeAttribute('src');
    player.load();

    currentIndex = index;
    const item = playlist[index];
    aiMedia = null;
    usingAI = false;
    $('use-ai').checked = false;
    $('use-ai').disabled = true;
    renderAIProgress({ state: 'idle' });
    $('cancel-ai-btn').hidden = true;
    $('clear-ai-cache-btn').hidden = true;
    setAIStatus('正在取得這首歌曲的 AI 處理狀態…');
    $('prepare-ai-btn').disabled = !aiAvailable;
    $('now-playing-title').textContent = item.title;
    renderQualityChip();

    updateActiveRow();
    scrollActiveIntoView();
    setPlayStatus('準備中…');
    applyMode();

    try {
      audio.init();
      await audio.resume();
      const url = await rpc('get_stream_url', item.id, selectedQuality);
      if (token !== playRequestId) return;
      await loadSource(url, token);
      if (token === playRequestId) setPlayStatus('播放中');
    } catch (error) {
      if (token === playRequestId && error.name !== 'AbortError') {
        setPlayStatus('播放失敗');
        showError(`播放失敗：${error.message}`);
      }
    }
    if (token === playRequestId) pollAI(item.id, token);
  }

  function playNext() {
    if (currentIndex + 1 < playlist.length) {
      playSong(currentIndex + 1);
    } else {
      stopPlayback();
      updateActiveRow();
      setPlayStatus('清單已播放完畢');
    }
  }

  function seekBy(seconds) {
    if (!player.seekable?.length) return;
    const start = typeof player.seekable.start === 'function' ? player.seekable.start(0) : 0;
    const end = typeof player.seekable.end === 'function' ? player.seekable.end(0) : player.duration || 0;
    player.currentTime = Math.max(start, Math.min(end, player.currentTime + seconds));
  }

  async function pollAI(id, token) {
    if (token !== playRequestId) return;
    clearTimeout(pollTimer);
    try {
      const result = await rpc('accompaniment_status', id);
      if (token !== playRequestId) return;
      setAIStatus(result.message);
      renderAIProgress(result);
      $('cancel-ai-btn').hidden = !AI_ACTIVE_STATES.includes(result.state);
      $('clear-ai-cache-btn').hidden = result.state !== 'ready';
      if (result.state === 'ready') {
        aiMedia = result;
        $('use-ai').disabled = false;
        $('prepare-ai-btn').disabled = true;
      } else if (AI_ACTIVE_STATES.includes(result.state)) {
        $('prepare-ai-btn').disabled = true;
        pollTimer = setTimeout(() => pollAI(id, token), 1000);
      } else {
        $('prepare-ai-btn').disabled = !aiAvailable;
      }
    } catch (error) {
      if (token === playRequestId) {
        setAIStatus(`無法取得處理狀態，稍後重試：${error.message}`);
        pollTimer = setTimeout(() => pollAI(id, token), 3000);
      }
    }
  }

  /** Idempotent: selecting the already-active mode does nothing. */
  async function setMode(isSinging) {
    const next = Boolean(isSinging);
    if (next === singing) return;
    singing = next;
    if (usingAI) await switchAI();
    else applyMode();
  }

  function changeMode() {
    return setMode(!singing);
  }

  async function switchAI() {
    if (!aiMedia || currentIndex < 0) return;
    const token = ++playRequestId;
    clearTimeout(pollTimer);
    const position = player.currentTime;
    const resume = sourcePending ? wantsResume : !player.paused;
    usingAI = $('use-ai').checked;
    applyMode();
    try {
      const url = usingAI ? (singing ? aiMedia.karaoke : aiMedia.original) : aiMedia.original;
      await loadSource(url, token, position, resume);
    } catch (error) {
      if (token === playRequestId) showError(`切換失敗：${error.message}`);
    }
  }

  async function handleSearch(event) {
    if (event) event.preventDefault();
    const query = $('search-input').value.trim();
    if (!query || $('search-btn').disabled) return;
    if (!hasBackend()) {
      showError('請以 Python 或桌面程式啟動，搜尋需要本機後端');
      return;
    }

    $('search-btn').disabled = true;
    $('search-loader').hidden = false;
    setSearchStatus('搜尋中…');
    try {
      if (/^https?:\/\//i.test(query)) {
        addSong(await rpc('get_video_info', query));
        setSearchStatus('已加入網址歌曲');
      } else {
        const results = await rpc('search_youtube', query);
        const grid = $('results-grid');
        grid.replaceChildren();
        $('results-section').hidden = false;
        results.filter(validItem).forEach(item => {
          const card = doc.createElement('button');
          card.type = 'button';
          card.className = 'result-card';
          songContent(item, card);
          card.onclick = () => {
            addSong(item);
            $('results-section').hidden = true;
          };
          grid.append(card);
        });
        setSearchStatus(results.length ? `找到 ${results.length} 首，點選加入清單` : '沒有找到歌曲，請換個關鍵字');
      }
    } catch (error) {
      setSearchStatus('');
      showError(`搜尋失敗：${error.message || error}`);
    } finally {
      $('search-btn').disabled = false;
      $('search-loader').hidden = true;
    }
  }

  function clearPlaylist() {
    playlist = [];
    stopPlayback();
    renderPlaylist();
    showToast('已清空待播清單');
  }

  function bindEvents() {
    const searchForm = $('search-form');
    if (searchForm) {
      searchForm.addEventListener('submit', handleSearch);
    }

    $('skip-btn').onclick = playNext;

    const clearDialog = $('confirm-clear-dialog');
    $('clear-playlist-btn').onclick = () => {
      if (!playlist.length) return;
      if (clearDialog && typeof clearDialog.showModal === 'function') {
        clearDialog.returnValue = '';
        clearDialog.showModal();
      } else if (typeof globalThis.confirm === 'function' && globalThis.confirm('確定清空待播清單？')) {
        clearPlaylist();
      }
    };

    if (clearDialog) {
      clearDialog.addEventListener('close', () => {
        if (clearDialog.returnValue === 'confirm') clearPlaylist();
      });
      if (!('closedBy' in (globalThis.HTMLDialogElement?.prototype || {}))) {
        clearDialog.addEventListener('click', event => {
          if (event.target === clearDialog) clearDialog.close('cancel');
        });
      }
    }

    $('mode-guide').onclick = () => setMode(false);
    $('mode-singing').onclick = () => setMode(true);
    $('use-ai').onchange = switchAI;

    const errorClose = $('app-error-close');
    if (errorClose) errorClose.onclick = clearError;

    $('ai-details').addEventListener('toggle', persistPanels);
    $('eq-panel').addEventListener('toggle', () => {
      persistPanels();
      applyMode();
    });

    const qualitySelect = $('quality-select');
    if (qualitySelect) {
      qualitySelect.onchange = async () => {
        selectedQuality = normalizeQuality(qualitySelect.value, DEFAULT_QUALITY);
        qualitySelect.value = String(selectedQuality);
        persistQuality();
        showToast(`已設定畫質上限為 ${qualityLabel(selectedQuality)}`);
        if (currentIndex >= 0 && !usingAI) {
          await playSong(currentIndex);
        }
      };
    }

    $('prepare-ai-btn').onclick = async () => {
      const item = playlist[currentIndex];
      const token = playRequestId;
      if (!item) return;
      $('prepare-ai-btn').disabled = true;
      $('ai-details').open = true;
      renderAIProgress({ state: 'downloading', detail: '正在啟動工作…' });
      try {
        const result = await rpc('prepare_accompaniment', item.id, selectedQuality);
        if (token !== playRequestId) return;
        setAIStatus(result.message);
        renderAIProgress(result);
        if (['busy', 'unavailable', 'error'].includes(result.state)) {
          $('prepare-ai-btn').disabled = !aiAvailable;
          return;
        }
        pollAI(item.id, token);
      } catch (error) {
        if (token === playRequestId) {
          setAIStatus(error.message);
          $('prepare-ai-btn').disabled = !aiAvailable;
          renderAIProgress({ state: 'error' });
        }
      }
    };

    $('cancel-ai-btn').onclick = async () => {
      const item = playlist[currentIndex];
      const token = playRequestId;
      if (!item) return;
      try {
        const result = await rpc('cancel_accompaniment', item.id);
        if (token === playRequestId) {
          setAIStatus(result.message);
          renderAIProgress(result);
        }
      } catch (error) {
        if (token === playRequestId) showError(error.message);
      }
    };

    const clearCacheBtn = $('clear-ai-cache-btn');
    if (clearCacheBtn) {
      clearCacheBtn.onclick = async () => {
        const item = playlist[currentIndex];
        const token = playRequestId;
        if (!item) return;
        clearCacheBtn.disabled = true;
        const wasUsingAI = usingAI;
        const previousPosition = player.currentTime;
        const wasPlaying = sourcePending ? wantsResume : !player.paused;
        if (wasUsingAI) {
          usingAI = false;
          $('use-ai').checked = false;
          player.pause();
          player.removeAttribute('src');
          player.load();
          applyMode();
        }
        try {
          const result = await rpc('clear_accompaniment_cache', item.id);
          if (token !== playRequestId) return;
          setAIStatus(result.message);
          if (result.state === 'idle') {
            aiMedia = null;
            usingAI = false;
            $('use-ai').checked = false;
            $('use-ai').disabled = true;
            clearCacheBtn.hidden = true;
            $('prepare-ai-btn').disabled = !aiAvailable;
            renderAIProgress({ state: 'idle' });
            showToast('已清除此首快取，可切換畫質上限後按「製作 AI 伴奏」重新下載');
            if (wasUsingAI) await playSong(currentIndex);
          } else {
            showError(result.message);
            if (wasUsingAI && aiMedia) {
              $('use-ai').checked = true;
              usingAI = true;
              const url = singing ? aiMedia.karaoke : aiMedia.original;
              await loadSource(url, token, previousPosition, wasPlaying);
            }
            pollAI(item.id, token);
          }
        } catch (error) {
          if (token === playRequestId) {
            showError(`清除快取失敗：${error.message}`);
            if (wasUsingAI && aiMedia) {
              $('use-ai').checked = true;
              usingAI = true;
              const url = singing ? aiMedia.karaoke : aiMedia.original;
              await loadSource(url, token, previousPosition, wasPlaying).catch(() => {});
            }
            pollAI(item.id, token);
          }
        } finally {
          clearCacheBtn.disabled = false;
        }
      };
    }

    $('volume-slider').oninput = event => {
      const vol = Number(event.target.value);
      player.volume = vol;
      if (vol > 0 && player.muted) player.muted = false;
      renderVolume();
    };

    const muteBtn = $('mute-btn');
    if (muteBtn) {
      muteBtn.onclick = () => {
        player.muted = !player.muted;
        renderVolume();
      };
    }

    player.onvolumechange = renderVolume;
    player.addEventListener('loadedmetadata', renderQualityChip);

    player.onended = playNext;
    player.onplay = () => {
      audio.init();
      audio.resume().catch(error => showError(error.message));
      setMediaSessionPlaybackState('playing');
      if (!sourcePending) setPlayStatus('播放中');
      applyMode();
    };
    player.onpause = () => {
      setMediaSessionPlaybackState('paused');
      if (!sourcePending && player.hasAttribute('src')) setPlayStatus('已暫停');
      spectrum.stop();
    };
    player.onerror = () => {
      if (!sourcePending && player.hasAttribute('src')) {
        setPlayStatus('串流中斷');
        showError('串流中斷或格式不相容，請點選歌曲重試');
      }
    };

    doc.addEventListener('visibilitychange', applyMode);
    doc.addEventListener('keydown', event => {
      if (event.target?.closest?.('input,textarea,select,button,summary,dialog,[contenteditable="true"]')) return;
      if (event.code === 'Space' && player.hasAttribute('src')) {
        event.preventDefault();
        if (player.paused) player.play().catch(error => showError(error.message));
        else player.pause();
      } else if (event.ctrlKey && event.code === 'KeyN') {
        event.preventDefault();
        playNext();
      } else if (['ArrowLeft', 'ArrowRight'].includes(event.code) && player.seekable?.length) {
        event.preventDefault();
        seekBy(event.code === 'ArrowRight' ? 5 : -5);
      }
    });

    EQ_BANDS.forEach(([id]) => {
      const slider = $(`eq-${id}`);
      const output = $(`eq-${id}-val`);
      slider.oninput = event => {
        const val = event.target.value;
        const label = formatDb(val);
        if (output) output.textContent = label;
        slider.setAttribute('aria-valuetext', label);
        audio.setBandGain(id, val);
      };
    });

    $('vocal-strength').oninput = () => {
      $('vocal-strength-val').textContent = `${Math.round(Number($('vocal-strength').value) * 100)}%`;
      applyMode();
    };

    $('accompaniment-gain').oninput = () => {
      $('accompaniment-gain-val').textContent = `${Number($('accompaniment-gain').value).toFixed(1)}x`;
      applyMode();
    };

    $('eq-reset-btn').onclick = () => {
      EQ_BANDS.forEach(([id]) => {
        const slider = $(`eq-${id}`);
        const output = $(`eq-${id}-val`);
        slider.value = 0;
        slider.setAttribute('aria-valuetext', '0 dB');
        if (output) output.textContent = '0 dB';
        audio.setBandGain(id, 0);
      });
      $('vocal-strength').value = 0.8;
      $('vocal-strength').oninput();
      $('accompaniment-gain').value = 1;
      $('accompaniment-gain').oninput();
    };

    $('export-playlist-btn').onclick = () => {
      if (!playlist.length) {
        showToast('清單沒有歌曲可匯出');
        return;
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(playlist, null, 2)], { type: 'application/json' }));
      const link = doc.createElement('a');
      link.href = url;
      link.download = `shen-playlist-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    $('import-playlist-btn').onclick = () => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) {
          showError('清單檔案上限為 2MB');
          return;
        }
        try {
          const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
          if (!Array.isArray(data)) throw new Error('清單必須是陣列');
          const valid = data
            .filter(validItem)
            .slice(0, Math.max(0, MAX_PLAYLIST_SIZE - playlist.length))
            .map(sanitize);
          if (!valid.length) throw new Error('沒有有效歌曲，或清單已滿');
          playlist.push(...valid);
          renderPlaylist();
          showToast(`匯入 ${valid.length} 首；略過 ${data.length - valid.length} 筆無效或超額項目`);
        } catch (error) {
          showError(`匯入失敗：${error.message}`);
        }
      };
      input.click();
    };

    bindMediaSessionHandlers({
      onPlay: () => player.play().catch(error => showError(error.message)),
      onPause: () => player.pause(),
      onNext: playNext,
      onSeekBy: seekBy,
    });
  }

  async function bootstrap() {
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) {
        playlist = saved.filter(validItem).slice(0, MAX_PLAYLIST_SIZE).map(sanitize);
      }
      selectedQuality = normalizeQuality(storage.getItem(QUALITY_STORAGE_KEY), DEFAULT_QUALITY);
      const qualitySelect = $('quality-select');
      if (qualitySelect) qualitySelect.value = String(selectedQuality);
    } catch {
      /* recover corrupt storage */
    }
    restorePanels();
    renderPlaylist();
    renderVolume();
    if (!hasBackend()) {
      showError('請執行 python main.py 啟動本機歡唱程式');
      return;
    }
    try {
      const info = await rpc('get_quality_info');
      aiAvailable = info.ai.available;
      setAIStatus(info.ai.message);
      aiChecked = true;
      renderAISummary('idle');
      $('prepare-ai-btn').disabled = currentIndex < 0 || !aiAvailable;
      const qualitySelect = $('quality-select');
      if (qualitySelect) {
        if (info.max_quality) qualitySelect.setAttribute('title', `支援畫質：${info.max_quality}`);
        if (info.has_ffmpeg === false) qualitySelect.disabled = true;
      }
    } catch (error) {
      showError(`後端連線失敗：${error.message || error}`);
    }
  }

  bindEvents();

  return {
    bootstrap,
    renderAIProgress,
    renderPlaylist,
    updateActiveRow,
    addSong,
    removeSong,
    moveSong,
    playSong,
    playNext,
    stopPlayback,
    changeMode,
    setMode,
    switchAI,
    handleSearch,
    clearPlaylist,
    getState: () => ({ playlist, currentIndex, singing, usingAI, aiMedia, selectedQuality }),
    setState: next => {
      if ('playlist' in next) playlist = next.playlist;
      if ('currentIndex' in next) currentIndex = next.currentIndex;
      if ('singing' in next) singing = next.singing;
      if ('usingAI' in next) usingAI = next.usingAI;
      if ('aiMedia' in next) aiMedia = next.aiMedia;
      if ('selectedQuality' in next) selectedQuality = normalizeQuality(next.selectedQuality, DEFAULT_QUALITY);
    },
  };
}

if (typeof globalThis.window !== 'undefined' && globalThis.document?.getElementById?.('player')) {
  const app = createApp();
  app.bootstrap();
}
