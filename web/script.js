'use strict';
const $ = id => document.getElementById(id);
const player = $('player');
let playlist = [], currentIndex = -1, playRequestId = 0;
let singing = false, aiMedia = null, usingAI = false, pollTimer = null;
let sourceCleanup = null, sourcePending = false, aiAvailable = false;
let wantsResume = false;
let audioCtx, dryGain, wetGain, aiGain, centerGain, boostGain, analyser;
let eqFilters = {}, spectrumAnimId = null;
const bands = [['low',60,'lowshelf'],['lowmid',250,'peaking'],['mid',1000,'peaking'],['himid',4000,'peaking'],['high',12000,'highshelf']];
async function rpc(name, ...args) {
    const result = await eel[name](...args)();
    if (result && typeof result === 'object' && typeof result.error === 'string') throw new Error(result.error);
    return result;
}

function notice(message, error = false) {
    $('app-status').textContent = message;
    $('app-status').classList.toggle('error', error);
}
const aiActiveStates = ['downloading','preparing','separating','muxing','cancelling'];
function renderAIProgress(result) {
    const stages = {downloading:'下載影音', preparing:'準備音訊', separating:'AI 人聲分離', muxing:'合成歡唱影片',
        cancelling:'取消製作', cancelled:'已取消', error:'製作失敗', ready:'製作完成'};
    const active = aiActiveStates.includes(result.state);
    $('ai-progress').hidden = !active && result.state !== 'ready';
    $('ai-progress-panel').hidden = !active && !['ready','cancelled','error'].includes(result.state);
    $('ai-progress-stage').textContent = stages[result.state] || '';
    const percent = result.progress;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
        $('ai-progress').value = Math.max(0,Math.min(100,percent));
        $('ai-progress-percent').textContent = `${Math.round(percent)}%`;
    } else {
        $('ai-progress').removeAttribute('value');
        $('ai-progress-percent').textContent = active ? '等待進度…' : '';
    }
    $('ai-progress-detail').textContent = result.detail || '';
    const seconds = result.elapsed_seconds;
    $('ai-progress-elapsed').textContent = typeof seconds === 'number' && Number.isFinite(seconds)
        ? `已耗時 ${Math.floor(seconds/60)} 分 ${Math.floor(seconds%60)} 秒` : '';
}
function safeThumbnail(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'i.ytimg.com' || url.hostname.endsWith('.ytimg.com')) ? url.href : '';
    } catch { return ''; }
}
function validItem(item) {
    return item && /^[A-Za-z0-9_-]{11}$/.test(item.id) && typeof item.id === 'string' &&
        typeof item.title === 'string' && item.title.length <= 500;
}
function sanitize(item) {
    return {id:item.id, title:item.title, thumbnail:safeThumbnail(item.thumbnail), url:`https://www.youtube.com/watch?v=${item.id}`};
}
function songContent(item, parent) {
    const img = document.createElement('img');
    const thumb = safeThumbnail(item.thumbnail);
    if (thumb) img.src = thumb;
    img.alt = ''; img.loading = 'lazy'; img.draggable = false;
    const info = document.createElement('div'); info.className = 'info';
    const title = document.createElement('div'); title.className = 'title'; title.textContent = item.title;
    info.append(title); parent.append(img, info);
}
function persist() {
    try { localStorage.setItem('shen-playlist-v2', JSON.stringify(playlist)); } catch { /* quota/private mode */ }
}
function renderPlaylist() {
    $('playlist-items').replaceChildren();
    $('queue-count').textContent = `${playlist.length} 首`;
    playlist.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = `playlist-item ${index === currentIndex ? 'active' : ''}`;
        row.draggable = true; row.tabIndex = 0; row.setAttribute('role','button');
        row.setAttribute('aria-label', `播放 ${item.title}`);
        songContent(item, row);
        const remove = document.createElement('button'); remove.className = 'delete-btn';
        remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${item.title}`);
        remove.onclick = event => { event.stopPropagation(); removeSong(index); };
        row.append(remove);
        row.onclick = () => playSong(index);
        row.onkeydown = event => { if (event.target === row && ['Enter',' '].includes(event.key)) {event.preventDefault(); playSong(index);} };
        row.ondragstart = event => {event.dataTransfer.setData('text/plain', String(index)); row.classList.add('dragging');};
        row.ondragend = () => row.classList.remove('dragging');
        row.ondragover = event => event.preventDefault();
        row.ondrop = event => {
            event.preventDefault();
            const value = event.dataTransfer.getData('text/plain');
            if (!/^\d+$/.test(value)) return;
            const from = Number(value);
            if (from >= playlist.length || from === index) return;
            const active = playlist[currentIndex];
            const [moved] = playlist.splice(from,1); playlist.splice(index,0,moved);
            currentIndex = active ? playlist.indexOf(active) : -1;
            renderPlaylist();
        };
        $('playlist-items').append(row);
    });
    if (!playlist.length) {
        const empty = document.createElement('p'); empty.className = 'empty-queue';
        empty.textContent = '搜尋歌曲，開始你的歡唱清單'; $('playlist-items').append(empty);
    }
    persist();
}
function stopPlayback() {
    ++playRequestId; clearTimeout(pollTimer);
    if (sourceCleanup) sourceCleanup();
    sourcePending = false; player.pause(); player.removeAttribute('src'); player.load();
    wantsResume = false;
    currentIndex = -1; aiMedia = null; usingAI = false;
    $('now-playing-title').textContent = '尚未播放歌曲';
    $('ai-status').textContent = '選擇歌曲後可製作 AI 伴奏';
    renderAIProgress({state:'idle'});
    $('prepare-ai-btn').disabled = true;
    $('cancel-ai-btn').hidden = true;
    $('use-ai').disabled = true; $('use-ai').checked = false;
    stopSpectrum(); applyMode();
}
function removeSong(index) {
    const active = playlist[currentIndex], removed = playlist[index];
    playlist.splice(index,1);
    if (removed === active) {
        stopPlayback();
        if (playlist.length) playSong(Math.min(index,playlist.length-1));
    } else currentIndex = active ? playlist.indexOf(active) : -1;
    renderPlaylist();
}
function addSong(item) {
    if (!validItem(item) || playlist.length >= 500) {notice('清單上限為 500 首，或歌曲資料無效',true); return;}
    playlist.push(sanitize(item)); renderPlaylist();
    if (currentIndex === -1) playSong(playlist.length-1);
}

function initAudio() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(player);
    dryGain = audioCtx.createGain(); wetGain = audioCtx.createGain(); aiGain = audioCtx.createGain();
    centerGain = audioCtx.createGain(); boostGain = audioCtx.createGain();
    const split = audioCtx.createChannelSplitter(2), sum = audioCtx.createGain();
    const stereoInput = audioCtx.createGain();
    stereoInput.channelCount = 2; stereoInput.channelCountMode = 'explicit';
    stereoInput.channelInterpretation = 'speakers';
    source.connect(stereoInput); stereoInput.connect(split);
    split.connect(sum,0); split.connect(sum,1); sum.gain.value = 0.5;
    // Subtract only the central vocal band. Bass and upper treble retain stereo information.
    const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 0.7;
    const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000; lp.Q.value = 0.7;
    sum.connect(hp); hp.connect(lp); lp.connect(centerGain);
    const mix = audioCtx.createChannelMerger(2);
    split.connect(mix,0,0); split.connect(mix,1,1);
    centerGain.connect(mix,0,0); centerGain.connect(mix,0,1);
    source.connect(dryGain); source.connect(aiGain); mix.connect(wetGain);
    let node = boostGain;
    wetGain.connect(boostGain); aiGain.connect(boostGain);
    bands.forEach(([id,freq,type]) => {
        const filter = audioCtx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq;
        filter.Q.value = 1; filter.gain.value = Number($(`eq-${id}`).value);
        node.connect(filter); node = filter; eqFilters[id] = filter;
    });
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    dryGain.connect(analyser); node.connect(analyser);
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.1;
    analyser.connect(limiter); limiter.connect(audioCtx.destination);
    applyMode();
}
function applyMode() {
    $('karaoke-knob').classList.toggle('active',singing);
    $('karaoke-knob').setAttribute('aria-pressed', String(singing));
    $('label-guide').classList.toggle('active',!singing);
    $('label-singing').classList.toggle('active',singing);
    $('eq-panel').classList.toggle('visible',singing);
    $('quick-controls').hidden = usingAI;
    $('mode-detail').textContent = usingAI ? 'AI 分離：保留立體聲伴奏；仍可能有分離瑕疵' : '快速模式：削弱中央人聲，也可能影響中央樂器';
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    dryGain.gain.setTargetAtTime(singing ? 0 : 1, now, 0.03);
    wetGain.gain.setTargetAtTime(singing && !usingAI ? 1 : 0, now, 0.03);
    aiGain.gain.setTargetAtTime(singing && usingAI ? 1 : 0, now, 0.03);
    centerGain.gain.setTargetAtTime(-Number($('vocal-strength').value), now, 0.03);
    boostGain.gain.setTargetAtTime(Number($('accompaniment-gain').value), now, 0.03);
    if (singing && !player.paused && !document.hidden) startSpectrum(); else stopSpectrum();
}

async function loadSource(url, token, position = 0, resume = true) {
    if (token !== playRequestId) return;
    if (sourceCleanup) sourceCleanup();
    sourcePending = true;
    wantsResume = resume;
    player.pause(); player.src = url; player.load();
    await new Promise((resolve,reject) => {
        const ready = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('影片無法載入，請重試或更換來源')); };
        const cleanup = () => {
            clearTimeout(timeout); player.removeEventListener('loadedmetadata',ready);
            player.removeEventListener('error',failed); sourceCleanup = null;
            if (token === playRequestId) sourcePending = false;
        };
        const timeout = setTimeout(() => {cleanup(); reject(new Error('載入逾時，請重試'));},60000);
        sourceCleanup = () => {cleanup(); resolve();};
        player.addEventListener('loadedmetadata',ready,{once:true});
        player.addEventListener('error',failed,{once:true});
    });
    if (token !== playRequestId) return;
    if (position && player.seekable.length && Number.isFinite(player.duration)) {
        player.currentTime = Math.min(position,Math.max(0,player.duration-0.1));
    } else if (position) notice('此串流無法跳轉，已從開頭播放。AI 快取影片支援拖曳進度。');
    applyMode();
    if (resume) {
        initAudio(); await audioCtx.resume();
        await player.play();
    }
}
async function playSong(index) {
    if (index < 0 || index >= playlist.length) return;
    const token = ++playRequestId;
    clearTimeout(pollTimer);
    if (sourceCleanup) sourceCleanup();
    sourcePending = false;
    player.pause(); player.removeAttribute('src'); player.load();
    currentIndex = index; const item = playlist[index];
    aiMedia = null; usingAI = false; $('use-ai').checked = false; $('use-ai').disabled = true;
    renderAIProgress({state:'idle'});
    $('cancel-ai-btn').hidden = true;
    $('ai-status').textContent = '正在取得這首歌曲的 AI 處理狀態…';
    $('prepare-ai-btn').disabled = !aiAvailable;
    $('now-playing-title').textContent = item.title;
    renderPlaylist(); notice('正在準備播放…'); applyMode();
    try {
        initAudio(); await audioCtx.resume();
        const url = await rpc('get_stream_url',item.id);
        if (token !== playRequestId) return;
        await loadSource(url,token);
        if (token === playRequestId) notice('播放中；可切換導唱或歡唱');
    } catch (error) {
        if (token === playRequestId && error.name !== 'AbortError') notice(`播放失敗：${error.message}`,true);
    }
    if (token === playRequestId) pollAI(item.id,token);
}
function playNext() {
    if (currentIndex + 1 < playlist.length) playSong(currentIndex+1);
    else {stopPlayback(); renderPlaylist(); notice('清單已播放完畢');}
}
async function pollAI(id,token) {
    if (token !== playRequestId) return;
    clearTimeout(pollTimer);
    try {
        const result = await rpc('accompaniment_status',id);
        if (token !== playRequestId) return;
        $('ai-status').textContent = result.message;
        renderAIProgress(result);
        $('cancel-ai-btn').hidden = !aiActiveStates.includes(result.state);
        if (result.state === 'ready') {
            aiMedia = result; $('use-ai').disabled = false; $('prepare-ai-btn').disabled = true;
        } else if (aiActiveStates.includes(result.state)) {
            $('prepare-ai-btn').disabled = true;
            pollTimer = setTimeout(() => pollAI(id,token),1000);
        } else $('prepare-ai-btn').disabled = !aiAvailable;
    } catch (error) {if (token === playRequestId) {
        $('ai-status').textContent = `無法取得處理狀態，稍後重試：${error.message}`;
        pollTimer = setTimeout(() => pollAI(id,token),3000);
    }}
}
async function changeMode() {
    singing = !singing;
    if (usingAI) await switchAI(); else applyMode();
}
async function switchAI() {
    if (!aiMedia || currentIndex < 0) return;
    const token = ++playRequestId;
    clearTimeout(pollTimer);
    const position = player.currentTime, resume = sourcePending ? wantsResume : !player.paused;
    usingAI = $('use-ai').checked;
    applyMode();
    try {
        const url = usingAI ? (singing ? aiMedia.karaoke : aiMedia.original) : aiMedia.original;
        await loadSource(url,token,position,resume);
    } catch (error) {if (token === playRequestId) notice(`切換失敗：${error.message}`,true);}
}

$('search-btn').onclick = async () => {
    const query = $('search-input').value.trim(); if (!query) return;
    if (typeof eel === 'undefined') {notice('請以 Python 或桌面程式啟動，搜尋需要本機後端',true); return;}
    $('search-btn').disabled = true; $('search-loader').style.display = 'block';
    try {
        if (/^https?:\/\//i.test(query)) addSong(await rpc('get_video_info',query));
        else {
            const results = await rpc('search_youtube',query);
            $('results-grid').replaceChildren(); $('results-section').style.display = 'block';
            results.filter(validItem).forEach(item => {
                const card = document.createElement('button'); card.className = 'result-card';
                songContent(item,card); card.onclick = () => {addSong(item); $('results-section').style.display = 'none';};
                $('results-grid').append(card);
            });
            notice(results.length ? `找到 ${results.length} 首，點選加入清單` : '沒有找到歌曲，請換個關鍵字');
        }
    } catch (error) {notice(`搜尋失敗：${error.message || error}`,true);}
    finally {$('search-btn').disabled = false; $('search-loader').style.display = 'none';}
};
$('search-input').onkeydown = event => {if (event.key === 'Enter' && !$('search-btn').disabled) $('search-btn').click();};
$('skip-btn').onclick = playNext;
$('clear-playlist-btn').onclick = () => {if (confirm('確定清空待播清單？')) {playlist = []; stopPlayback(); renderPlaylist();}};
$('karaoke-knob').onclick = changeMode;
$('use-ai').onchange = switchAI;
$('prepare-ai-btn').onclick = async () => {
    const item = playlist[currentIndex], token = playRequestId;
    if (!item) return;
    $('prepare-ai-btn').disabled = true;
    renderAIProgress({state:'downloading',detail:'正在啟動工作…'});
    try {
        const result = await rpc('prepare_accompaniment',item.id);
        if (token !== playRequestId) return;
        $('ai-status').textContent = result.message;
        renderAIProgress(result);
        if (['busy','unavailable','error'].includes(result.state)) {$('prepare-ai-btn').disabled = !aiAvailable; return;}
        pollAI(item.id,token);
    } catch (error) {if (token === playRequestId) {
        $('ai-status').textContent = error.message; $('prepare-ai-btn').disabled = !aiAvailable;
        renderAIProgress({state:'error'});
    }}
};
$('cancel-ai-btn').onclick = async () => {
    const item = playlist[currentIndex], token = playRequestId;
    if (!item) return;
    try {
        const result = await rpc('cancel_accompaniment',item.id);
        if (token === playRequestId) {$('ai-status').textContent = result.message; renderAIProgress(result);}
    } catch (error) {if (token === playRequestId) notice(error.message,true);}
};
$('volume-slider').oninput = event => {player.volume = Number(event.target.value);};
player.onvolumechange = () => {$('volume-slider').value = player.muted ? 0 : player.volume;};
player.onended = playNext;
player.onplay = () => {initAudio(); audioCtx.resume().catch(error => notice(error.message,true)); applyMode();};
player.onpause = stopSpectrum;
player.onerror = () => {if (!sourcePending && player.hasAttribute('src')) notice('串流中斷或格式不相容，請點選歌曲重試',true);};
document.addEventListener('visibilitychange',applyMode);
document.addEventListener('keydown',event => {
    if (event.target.closest('input,textarea,button,[contenteditable="true"]')) return;
    if (event.code === 'Space' && player.hasAttribute('src')) {
        event.preventDefault(); if (player.paused) player.play().catch(error => notice(error.message,true)); else player.pause();
    } else if (event.ctrlKey && event.code === 'KeyN') {event.preventDefault(); playNext();}
    else if (['ArrowLeft','ArrowRight'].includes(event.code) && player.seekable.length) {
        event.preventDefault(); player.currentTime = Math.max(player.seekable.start(0),Math.min(player.seekable.end(0),player.currentTime+(event.code === 'ArrowRight' ? 5 : -5)));
    }
});
bands.forEach(([id]) => {$(`eq-${id}`).oninput = event => {if (eqFilters[id]) eqFilters[id].gain.setTargetAtTime(Number(event.target.value),audioCtx.currentTime,0.03);};});
$('vocal-strength').oninput = () => {$('vocal-strength-val').textContent = `${Math.round(Number($('vocal-strength').value)*100)}%`; applyMode();};
$('accompaniment-gain').oninput = () => {$('accompaniment-gain-val').textContent = `${Number($('accompaniment-gain').value).toFixed(1)}x`; applyMode();};
$('eq-reset-btn').onclick = () => {
    bands.forEach(([id]) => {$(`eq-${id}`).value = 0; if (eqFilters[id]) eqFilters[id].gain.setTargetAtTime(0,audioCtx.currentTime,0.03);});
    $('vocal-strength').value = 0.8; $('vocal-strength').oninput();
    $('accompaniment-gain').value = 1; $('accompaniment-gain').oninput();
};
function startSpectrum() {
    if (!analyser || spectrumAnimId !== null) return;
    const canvas = $('spectrum-canvas'), ctx = canvas.getContext('2d');
    const data = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
        const ratio = devicePixelRatio || 1;
        const width = Math.round(canvas.clientWidth*ratio), height = Math.round(canvas.clientHeight*ratio);
        if (canvas.width !== width || canvas.height !== height) {canvas.width = width; canvas.height = height;}
        analyser.getByteFrequencyData(data); ctx.clearRect(0,0,width,height); ctx.fillStyle = '#03dac6';
        const bar = width/data.length;
        data.forEach((value,i) => {const h = value/255*height; ctx.fillRect(i*bar,height-h,Math.max(1,bar-1),h);});
        spectrumAnimId = requestAnimationFrame(draw);
    }; draw();
}
function stopSpectrum() {
    if (spectrumAnimId !== null) cancelAnimationFrame(spectrumAnimId);
    spectrumAnimId = null;
}
$('export-playlist-btn').onclick = () => {
    if (!playlist.length) {notice('清單沒有歌曲可匯出'); return;}
    const url = URL.createObjectURL(new Blob([JSON.stringify(playlist,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `shen-playlist-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
};
$('import-playlist-btn').onclick = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async () => {
        const file = input.files[0]; if (!file) return;
        if (file.size > 2*1024*1024) {notice('清單檔案上限為 2MB',true); return;}
        try {
            const data = JSON.parse((await file.text()).replace(/^\uFEFF/,''));
            if (!Array.isArray(data)) throw new Error('清單必須是陣列');
            const valid = data.filter(validItem).slice(0,Math.max(0,500-playlist.length)).map(sanitize);
            if (!valid.length) throw new Error('沒有有效歌曲，或清單已滿');
            playlist.push(...valid); renderPlaylist();
            notice(`匯入 ${valid.length} 首；略過 ${data.length-valid.length} 筆無效或超額項目`);
        } catch (error) {notice(`匯入失敗：${error.message}`,true);}
    }; input.click();
};
async function bootstrap() {
    try {
        const saved = JSON.parse(localStorage.getItem('shen-playlist-v2') || '[]');
        if (Array.isArray(saved)) playlist = saved.filter(validItem).slice(0,500).map(sanitize);
    } catch { /* recover corrupt storage */ }
    renderPlaylist();
    if (typeof eel === 'undefined') {notice('請執行 python main.py 啟動本機歡唱程式'); return;}
    try {
        const info = await rpc('get_quality_info'); aiAvailable = info.ai.available;
        $('quality-status').textContent = info.max_quality;
        $('ai-status').textContent = info.ai.message;
        $('prepare-ai-btn').disabled = currentIndex < 0 || !aiAvailable;
    } catch (error) {notice(`後端連線失敗：${error.message || error}`,true);}
}
bootstrap();
