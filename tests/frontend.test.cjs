/* Run with node tests/frontend.test.cjs or deno run --allow-read tests/frontend.test.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class Element {
  set value(value) {
    this._value = value;
    this.attributes.value = String(value);
  }
  get value() {
    return this._value;
  }
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.value = '0';
    this.paused = true;
    this.currentTime = 0;
    this.seekable = { length: 1, start: () => 0, end: () => 100 };
    this.duration = 100;
    this.focused = false;
    this.returnValue = '';
    this.modalOpen = false;
    const classes = new Set();
    this.classList = {
      add: v => classes.add(v),
      remove: v => classes.delete(v),
      toggle: (v, on) => (on ? classes.add(v) : classes.delete(v)),
      contains: v => classes.has(v),
    };
    Object.defineProperty(this, 'className', {
      get: () => Array.from(classes).join(' '),
      set: value => {
        classes.clear();
        String(value || '')
          .split(/\s+/)
          .filter(Boolean)
          .forEach(c => classes.add(c));
      },
    });
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  getAttribute(key) {
    return this.attributes[key];
  }
  hasAttribute(key) {
    return key === 'src' ? Boolean(this.src) : key in this.attributes;
  }
  removeAttribute(key) {
    if (key === 'src') this.src = '';
    if (key === 'value') this._value = 0;
    delete this.attributes[key];
  }
  addEventListener(key, callback) {
    (this.listeners[key] ||= []).push(callback);
  }
  removeEventListener(key, callback) {
    this.listeners[key] = (this.listeners[key] || []).filter(fn => fn !== callback);
  }
  dispatch(key, event = {}) {
    (this.listeners[key] || []).slice().forEach(fn => fn(event));
  }
  focus() {
    this.focused = true;
  }
  blur() {
    this.focused = false;
  }
  showModal() {
    this.modalOpen = true;
  }
  close(value) {
    this.modalOpen = false;
    if (value !== undefined) this.returnValue = value;
    this.dispatch('close');
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  load() {
    queueMicrotask(() => {
      if (this.src) (this.listeners.loadedmetadata || []).slice().forEach(fn => fn());
    });
  }
  click() {
    if (this.onclick) this.onclick();
  }
}

async function run() {
  const { normalizeQuality, safeThumbnail, sanitize, validItem } = await import(
    pathToFileURL(path.join(__dirname, '../web/js/validation.js')).href
  );
  const { SpectrumVisualizer } = await import(
    pathToFileURL(path.join(__dirname, '../web/js/spectrum.js')).href
  );
  const { createApp } = await import(
    pathToFileURL(path.join(__dirname, '../web/js/main.js')).href
  );

  // 1. Validation & XSS safety
  assert.equal(safeThumbnail('https://evil.test/image.jpg'), '');
  assert.equal(safeThumbnail('javascript:alert(1)'), '');
  assert.equal(
    safeThumbnail('https://i.ytimg.com/vi/test/default.jpg'),
    'https://i.ytimg.com/vi/test/default.jpg'
  );
  assert.equal(validItem({ id: 'invalid', title: 'bad' }), false);

  // 2. Setup mock DOM, Media Session, and ResizeObserver
  const nodes = new Map();
  const doc = {
    getElementById: id => {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    createElement: tag => new Element(tag),
    addEventListener: () => {},
    hidden: false,
  };
  const storageMap = new Map();
  const storage = {
    getItem: k => storageMap.get(k),
    setItem: (k, v) => storageMap.set(k, v),
  };

  let resizeCallback = null;
  globalThis.ResizeObserver = class {
    constructor(cb) {
      resizeCallback = cb;
    }
    observe() {}
    disconnect() {}
  };
  globalThis.devicePixelRatio = 2;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  const mediaActions = {};
  const mockMediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: (action, handler) => {
      mediaActions[action] = handler;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaSession: mockMediaSession },
    configurable: true,
  });
  globalThis.MediaMetadata = class {
    constructor(data) {
      Object.assign(this, data);
    }
  };

  const fakeAudio = {
    analyser: null,
    init() {},
    resume: () => Promise.resolve(),
    applyMode() {},
    setBandGain() {},
  };

  // Test SpectrumVisualizer uses ResizeObserver instead of reading clientWidth per frame
  const canvas = doc.getElementById('spectrum-canvas');
  canvas.width = 400;
  canvas.height = 120;
  const spectrum = new SpectrumVisualizer(canvas, doc.getElementById('spectrum-container'));
  assert.equal(typeof resizeCallback, 'function');
  resizeCallback([{ contentRect: { width: 300, height: 100 } }]);
  assert.equal(canvas.width, 600);
  assert.equal(canvas.height, 200);

  const app = createApp({ doc, storage, audioEngine: fakeAudio, spectrum });
  await app.bootstrap();

  // 3. AI progress rendering
  app.renderAIProgress({ state: 'separating', progress: 42.5, detail: '模型 1/1', elapsed_seconds: 125 });
  assert.equal(nodes.get('ai-progress-panel').hidden, false);
  assert.equal(nodes.get('ai-progress').value, 42.5);
  assert.equal(nodes.get('ai-progress-percent').textContent, '43%');
  assert.equal(nodes.get('ai-progress-elapsed').textContent, '已耗時 2 分 5 秒');

  app.renderAIProgress({ state: 'separating', progress: null, detail: '模型載入中' });
  assert.equal(nodes.get('ai-progress').hasAttribute('value'), false);
  assert.equal(nodes.get('ai-progress-percent').textContent, '等待進度…');

  app.renderAIProgress({ state: 'cancelled', elapsed_seconds: 130 });
  assert.equal(nodes.get('ai-progress').hidden, true);

  app.renderAIProgress({ state: 'ready', progress: 100 });
  assert.equal(nodes.get('ai-progress').value, 100);
  assert.equal(nodes.get('ai-progress-elapsed').textContent, '');

  app.renderAIProgress({ state: 'idle' });
  assert.equal(nodes.get('ai-progress-panel').hidden, true);

  // 4. Non-nested playlist structure & XSS safety
  app.setState({
    playlist: [
      sanitize({ id: 'dQw4w9WgXcQ', title: '<img src=x onerror=alert(1)>', thumbnail: 'https://evil.test/x' }),
    ],
  });
  app.renderPlaylist();
  const row = nodes.get('playlist-items').children[0];
  assert.equal(row.tagName, 'LI');
  assert.equal(row.getAttribute('role'), undefined);
  const playBtn = row.children[0];
  const controls = row.children[1];
  assert.equal(playBtn.tagName, 'BUTTON');
  assert.equal(playBtn.children[1].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(playBtn.children[0].src, undefined);
  assert.equal(controls.children.length, 3); // up, down, delete

  // 5. Stale request cancellation & in-place active row update (preserves DOM identity)
  let resolveStream;
  globalThis.eel = {
    get_stream_url: () => () =>
      new Promise(resolve => {
        resolveStream = resolve;
      }),
    accompaniment_status: () => () => Promise.resolve({ state: 'idle', message: 'idle' }),
  };
  const pendingPlay = app.playSong(0);
  assert.equal(nodes.get('playlist-items').children[0], row);
  assert.equal(playBtn.getAttribute('aria-current'), 'true');
  assert.equal(mockMediaSession.metadata.title, '<img src=x onerror=alert(1)>');
  await Promise.resolve();
  await Promise.resolve();
  app.stopPlayback();
  app.setState({ playlist: [] });
  app.renderPlaylist();
  resolveStream('/stale-stream');
  await pendingPlay;
  assert.equal(app.getState().currentIndex, -1);
  assert.equal(nodes.get('player').src, '');

  // 6. Queue manipulation, keyboard reorder, focus restoration & queue end
  app.setState({
    playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' }), sanitize({ id: 'abcdefghijk', title: 'Two' })],
    currentIndex: 0,
  });
  app.renderPlaylist();
  app.moveSong(1, 0, 'up');
  assert.equal(app.getState().playlist[0].title, 'Two');
  assert.equal(app.getState().currentIndex, 1);

  app.removeSong(0, true);
  assert.equal(app.getState().currentIndex, 0);
  assert.equal(app.getState().playlist.length, 1);
  assert.equal(nodes.get('playlist-items').children[0].children[0].focused, true);

  app.playNext();
  assert.equal(app.getState().currentIndex, -1);
  assert.equal(nodes.get('player').src, '');
  assert.equal(nodes.get('play-status').textContent, '清單已播放完畢');

  // 7. Native <dialog> clear playlist flow (including Esc after prior confirm)
  app.setState({ playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })], currentIndex: 0 });
  app.renderPlaylist();
  nodes.get('clear-playlist-btn').click();
  const dialog = nodes.get('confirm-clear-dialog');
  assert.equal(dialog.modalOpen, true);
  dialog.close('confirm');
  assert.equal(app.getState().playlist.length, 0);

  // Re-open dialog and simulate Esc (closes without passing a new returnValue)
  app.setState({ playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })], currentIndex: 0 });
  app.renderPlaylist();
  nodes.get('clear-playlist-btn').click();
  assert.equal(dialog.returnValue, '');
  dialog.close();
  assert.equal(app.getState().playlist.length, 1);

  // Mouse-clicking a playlist item blurs the button so Spacebar toggles play/pause
  const rowBtn = nodes.get('playlist-items').children[0].children[0];
  rowBtn.focus();
  rowBtn.onclick({ detail: 1 });
  assert.equal(rowBtn.focused, false);

  // 8. AI switching & position preservation
  app.setState({
    playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })],
    currentIndex: 0,
    aiMedia: { original: '/original', karaoke: '/karaoke' },
    singing: true,
  });
  nodes.get('use-ai').checked = true;
  nodes.get('player').currentTime = 42;
  nodes.get('player').paused = false;
  await app.switchAI();
  assert.equal(nodes.get('player').src, '/karaoke');
  assert.equal(nodes.get('player').currentTime, 42);
  await app.changeMode();
  assert.equal(nodes.get('player').src, '/original');
  assert.equal(nodes.get('player').currentTime, 42);

  // 9. Quality selector (720p / 1080p / 2K 1440p) persistence & RPC propagation
  assert.equal(normalizeQuality('720'), 720);
  assert.equal(normalizeQuality('1440'), 1440);
  assert.equal(normalizeQuality('9999'), 1080);

  let requestedStreamQuality = null;
  let requestedAIQuality = null;
  globalThis.eel = {
    get_stream_url: (id, q) => () => {
      requestedStreamQuality = q;
      return Promise.resolve(`/proxy_stream?v=${id}&q=${q}`);
    },
    prepare_accompaniment: (id, q) => () => {
      requestedAIQuality = q;
      return Promise.resolve({ state: 'downloading', message: 'downloading' });
    },
    accompaniment_status: () => () => Promise.resolve({ state: 'idle', message: 'idle' }),
  };
  app.setState({
    playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })],
    currentIndex: 0,
    usingAI: false,
  });
  const qualitySelect = nodes.get('quality-select');
  qualitySelect.value = '1440';
  await qualitySelect.onchange();
  assert.equal(app.getState().selectedQuality, 1440);
  assert.equal(storage.getItem('shen-quality-v1'), '1440');
  assert.equal(requestedStreamQuality, 1440);
  await nodes.get('prepare-ai-btn').onclick();
  assert.equal(requestedAIQuality, 1440);

  // Clear AI cache failure restores AI playback & position
  globalThis.eel.clear_accompaniment_cache = () => () =>
    Promise.resolve({ state: 'error', message: '檔案使用中' });
  app.setState({
    playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })],
    currentIndex: 0,
    aiMedia: { original: '/original', karaoke: '/karaoke' },
    singing: true,
    usingAI: true,
  });
  nodes.get('player').currentTime = 33;
  nodes.get('player').paused = false;
  nodes.get('clear-ai-cache-btn').hidden = false;
  await nodes.get('clear-ai-cache-btn').onclick();
  assert.equal(app.getState().usingAI, true);
  assert.equal(nodes.get('player').src, '/karaoke');
  assert.equal(nodes.get('player').currentTime, 33);

  // Clear AI cache success resets state & releases AI playback
  let clearedId = null;
  globalThis.eel.clear_accompaniment_cache = id => () => {
    clearedId = id;
    return Promise.resolve({ state: 'idle', message: '已清除此首快取' });
  };
  await nodes.get('clear-ai-cache-btn').onclick();
  assert.equal(clearedId, 'dQw4w9WgXcQ');
  assert.equal(app.getState().aiMedia, null);
  assert.equal(app.getState().usingAI, false);
  assert.equal(nodes.get('clear-ai-cache-btn').hidden, true);
  assert.equal(nodes.get('use-ai').disabled, true);

  // 10. UI redesign: segmented mode buttons are idempotent and expose aria-pressed
  app.setState({ usingAI: false, aiMedia: null, singing: false });
  await app.setMode(true);
  assert.equal(app.getState().singing, true);
  assert.equal(nodes.get('mode-singing').getAttribute('aria-pressed'), 'true');
  assert.equal(nodes.get('mode-guide').getAttribute('aria-pressed'), 'false');
  assert.equal(nodes.get('quick-mix').hidden, false);
  await nodes.get('mode-singing').onclick(); // clicking the active mode must not toggle back
  assert.equal(app.getState().singing, true);
  await nodes.get('mode-guide').onclick();
  assert.equal(app.getState().singing, false);
  assert.equal(nodes.get('quick-mix').hidden, true);
  assert.equal(nodes.get('eq-panel').hidden, true);

  // Spectrum only runs while the EQ <details> is expanded
  let spectrumStarts = 0;
  const realStart = spectrum.start;
  spectrum.start = () => {
    spectrumStarts += 1;
  };
  nodes.get('player').paused = false;
  nodes.get('eq-panel').open = false;
  await app.setMode(true);
  assert.equal(spectrumStarts, 0);
  nodes.get('eq-panel').open = true;
  nodes.get('eq-panel').dispatch('toggle');
  assert.equal(spectrumStarts, 1);
  assert.equal(JSON.parse(storage.getItem('shen-panels-v1')).eq, true);
  spectrum.start = realStart;
  await app.setMode(false);

  // AI <summary> shows compact progress
  app.renderAIProgress({ state: 'separating', progress: 57.4 });
  assert.equal(nodes.get('ai-summary').textContent, 'AI 人聲分離 57%');
  app.renderAIProgress({ state: 'ready', progress: 100 });
  assert.equal(nodes.get('ai-summary').textContent, '已就緒');
  assert.equal(nodes.get('ai-summary').classList.contains('ready'), true);

  // Playlist rows: track number + now-playing badge without breaking the row structure
  app.setState({
    playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' }), sanitize({ id: 'abcdefghijk', title: 'Two' })],
    currentIndex: 1,
  });
  app.renderPlaylist();
  const secondBtn = nodes.get('playlist-items').children[1].children[0];
  assert.equal(secondBtn.children[0].tagName, 'IMG');
  assert.equal(secondBtn.children[1].children[0].textContent, 'Two');
  assert.equal(secondBtn.children[1].children[1].className, 'now-badge');
  assert.equal(secondBtn.children[2].textContent, '02');
  assert.equal(nodes.get('playlist-items').children[1].classList.contains('active'), true);

  // Actual playback quality label
  const { videoQualityLabel } = await import(pathToFileURL(path.join(__dirname, '../web/js/main.js')).href);
  assert.equal(videoQualityLabel(2560, 1440), '2K');
  assert.equal(videoQualityLabel(1920, 1080), '1080p');
  assert.equal(videoQualityLabel(1920, 800), '1080p'); // ultra-wide
  assert.equal(videoQualityLabel(1280, 720), '720p');
  assert.equal(videoQualityLabel(640, 360), '360p');
  assert.equal(videoQualityLabel(0, 0), '');

  // Errors persist in the alert banner; success messages go to the toast
  app.clearPlaylist();
  assert.equal(nodes.get('toast').textContent, '已清空待播清單');
  app.addSong({ id: 'bad', title: 'x' });
  assert.equal(nodes.get('app-error-wrap').hidden, false);
  assert.match(nodes.get('app-error').textContent, /清單上限/);
  nodes.get('app-error-close').onclick();
  assert.equal(nodes.get('app-error-wrap').hidden, true);

  // A later successful playback clears a stale error
  app.addSong({ id: 'bad', title: 'x' });
  assert.equal(nodes.get('app-error-wrap').hidden, false);
  globalThis.eel.get_stream_url = id => () => Promise.resolve(`/proxy_stream?v=${id}`);
  app.setState({ playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })], currentIndex: -1 });
  await app.playSong(0);
  assert.equal(nodes.get('app-error-wrap').hidden, true);
  assert.equal(nodes.get('app-error').textContent, '');

  // Sound bars freeze while paused
  nodes.get('player').onpause();
  assert.equal(nodes.get('playlist-items').classList.contains('is-paused'), true);
  nodes.get('player').onplay();
  assert.equal(nodes.get('playlist-items').classList.contains('is-paused'), false);

  // Onboarding hint shows only while the queue is empty
  app.setState({ playlist: [], currentIndex: -1 });
  nodes.get('search-status').textContent = '';
  app.renderPlaylist();
  assert.equal(nodes.get('search-status').textContent, '搜尋歌曲或匯入清單，開始歡唱');
  app.setState({ playlist: [sanitize({ id: 'dQw4w9WgXcQ', title: 'One' })] });
  app.renderPlaylist();
  assert.equal(nodes.get('search-status').textContent, '');

  // 11. Media Session handlers bound
  assert.equal(typeof mediaActions.play, 'function');
  assert.equal(typeof mediaActions.nexttrack, 'function');

  console.log(
    'Frontend: ESM modules, a11y list, ResizeObserver spectrum, dialog confirm, Media Session, safety, stale cancellation & AI switching OK'
  );
}

module.exports = run;
if (require.main === module) {
  run().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
