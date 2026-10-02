/* Run with node tests/frontend.test.cjs; DOM doubles test state, not browser rendering. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
    set value(value) {this._value = value; this.attributes.value = String(value);}
    get value() {return this._value;}
    constructor() {
        this.style = {}; this.children = []; this.attributes = {}; this.listeners = {};
        this.value = '0'; this.paused = true; this.currentTime = 0;
        this.seekable = {length:1}; this.duration = 100;
        const classes = new Set();
        this.classList = {add:v=>classes.add(v), remove:v=>classes.delete(v),
            toggle:(v,on)=>on ? classes.add(v) : classes.delete(v), contains:v=>classes.has(v)};
    }
    append(...nodes) {this.children.push(...nodes);}
    replaceChildren(...nodes) {this.children = nodes;}
    setAttribute(key,value) {this.attributes[key] = value;}
    hasAttribute(key) {return key === 'src' ? Boolean(this.src) : key in this.attributes;}
    removeAttribute(key) {if (key === 'src') this.src = ''; if (key === 'value') this._value = 0; delete this.attributes[key];}
    addEventListener(key,callback) {(this.listeners[key] ||= []).push(callback);}
    removeEventListener(key,callback) {this.listeners[key] = (this.listeners[key] || []).filter(fn=>fn!==callback);}
    pause() {this.paused = true;}
    play() {this.paused = false; return Promise.resolve();}
    load() {queueMicrotask(() => {if (this.src) (this.listeners.loadedmetadata || []).slice().forEach(fn=>fn());});}
    click() {if (this.onclick) this.onclick();}
}

async function run() {
    const nodes = new Map();
    const document = {getElementById:id=>{if (!nodes.has(id)) nodes.set(id,new Element()); return nodes.get(id);},
        createElement:()=>new Element(), addEventListener:()=>{}, hidden:false};
    const storage = new Map();
    const context = vm.createContext({document, console, URL, Blob,
        localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
        setTimeout,clearTimeout,queueMicrotask,confirm:()=>true,
        requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},devicePixelRatio:1});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/script.js'),'utf8'),context);
    const evaluate = code => vm.runInContext(code,context);
    evaluate("renderAIProgress({state:'separating',progress:42.5,detail:'模型 1/1',elapsed_seconds:125})");
    assert.equal(nodes.get('ai-progress-panel').hidden,false);
    assert.equal(nodes.get('ai-progress').value,42.5);
    assert.equal(nodes.get('ai-progress-percent').textContent,'43%');
    assert.equal(nodes.get('ai-progress-elapsed').textContent,'已耗時 2 分 5 秒');
    evaluate("renderAIProgress({state:'separating',progress:null,detail:'模型載入中'})");
    assert.equal(nodes.get('ai-progress').hasAttribute('value'),false);
    assert.equal(nodes.get('ai-progress-percent').textContent,'等待進度…');
    evaluate("renderAIProgress({state:'cancelled',elapsed_seconds:130})");
    assert.equal(nodes.get('ai-progress').hidden,true);
    evaluate("renderAIProgress({state:'ready',progress:100})");
    assert.equal(nodes.get('ai-progress').value,100);
    assert.equal(nodes.get('ai-progress-elapsed').textContent,'');
    evaluate("renderAIProgress({state:'idle'})");
    assert.equal(nodes.get('ai-progress-panel').hidden,true);
    assert.equal(evaluate("safeThumbnail('https://evil.test/image.jpg')"),'');
    assert.equal(evaluate("safeThumbnail('javascript:alert(1)')"),'');
    assert.equal(evaluate("safeThumbnail('https://i.ytimg.com/vi/test/default.jpg')"),'https://i.ytimg.com/vi/test/default.jpg');
    assert.equal(evaluate("validItem({id:'invalid',title:'bad'})"),false);
    evaluate("playlist=[sanitize({id:'dQw4w9WgXcQ',title:'<img src=x onerror=alert(1)>',thumbnail:'https://evil.test/x'})]; renderPlaylist();");
    const row = nodes.get('playlist-items').children[0];
    assert.equal(row.children[1].children[0].textContent,'<img src=x onerror=alert(1)>');
    assert.equal(row.children[0].src,undefined);
    evaluate(`
        audioCtx = {currentTime:0,resume:()=>Promise.resolve()};
        const fakeGain = () => ({gain:{setTargetAtTime:()=>{}}});
        dryGain=fakeGain(); wetGain=fakeGain(); aiGain=fakeGain(); centerGain=fakeGain(); boostGain=fakeGain();
        let resolveStream;
        eel = {get_stream_url:()=>()=>new Promise(resolve=>{resolveStream=resolve;}),
            accompaniment_status:()=>()=>Promise.resolve({state:'idle',message:'idle'})};
        pendingPlay = playSong(0);
    `);
    await Promise.resolve(); await Promise.resolve();
    evaluate("stopPlayback(); playlist=[]; renderPlaylist(); resolveStream('/stale-stream');");
    await context.pendingPlay;
    assert.equal(evaluate('currentIndex'),-1);
    assert.equal(nodes.get('player').src,'');
    evaluate("playlist=[sanitize({id:'dQw4w9WgXcQ',title:'One'}),sanitize({id:'abcdefghijk',title:'Two'})]; currentIndex=0; renderPlaylist();");
    evaluate("removeSong(1)");
    assert.equal(evaluate('currentIndex'),0);
    assert.equal(evaluate('playlist.length'),1);
    evaluate('currentIndex=0; playNext()');
    assert.equal(evaluate('currentIndex'),-1);
    assert.equal(nodes.get('player').src,'');
    assert.equal(nodes.get('app-status').textContent,'清單已播放完畢');
    evaluate("playlist=[sanitize({id:'dQw4w9WgXcQ',title:'One'})]; currentIndex=0; aiMedia={original:'/original',karaoke:'/karaoke'}; singing=true; $('use-ai').checked=true; player.currentTime=42; player.paused=false;");
    await evaluate('switchAI()');
    assert.equal(nodes.get('player').src,'/karaoke');
    assert.equal(nodes.get('player').currentTime,42);
    await evaluate('changeMode()');
    assert.equal(nodes.get('player').src,'/original');
    assert.equal(nodes.get('player').currentTime,42);
    console.log('Frontend: safety, stale request cancellation, queue end, AI switching and position preservation OK');
}
module.exports = run;
if (require.main === module) run().catch(error=>{console.error(error);process.exitCode=1;});
