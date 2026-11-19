export const EQ_BANDS = [
  ['low', 60, 'lowshelf'],
  ['lowmid', 250, 'peaking'],
  ['mid', 1000, 'peaking'],
  ['himid', 4000, 'peaking'],
  ['high', 12000, 'highshelf'],
];

export class AudioEngine {
  constructor(player, getBandValue) {
    this.player = player;
    this.getBandValue = getBandValue;
    this.ctx = null;
    this.dryGain = null;
    this.wetGain = null;
    this.aiGain = null;
    this.centerGain = null;
    this.boostGain = null;
    this.analyser = null;
    this.eqFilters = {};
  }

  init() {
    if (this.ctx) return;
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    const source = this.ctx.createMediaElementSource(this.player);

    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    this.aiGain = this.ctx.createGain();
    this.centerGain = this.ctx.createGain();
    this.boostGain = this.ctx.createGain();

    const split = this.ctx.createChannelSplitter(2);
    const sum = this.ctx.createGain();
    const stereoInput = this.ctx.createGain();
    stereoInput.channelCount = 2;
    stereoInput.channelCountMode = 'explicit';
    stereoInput.channelInterpretation = 'speakers';

    source.connect(stereoInput);
    stereoInput.connect(split);
    split.connect(sum, 0);
    split.connect(sum, 1);
    sum.gain.value = 0.5;

    // Subtract only the central vocal band. Bass and upper treble retain stereo information.
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.7;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    lp.Q.value = 0.7;

    sum.connect(hp);
    hp.connect(lp);
    lp.connect(this.centerGain);

    const mix = this.ctx.createChannelMerger(2);
    split.connect(mix, 0, 0);
    split.connect(mix, 1, 1);
    this.centerGain.connect(mix, 0, 0);
    this.centerGain.connect(mix, 0, 1);

    source.connect(this.dryGain);
    source.connect(this.aiGain);
    mix.connect(this.wetGain);

    let node = this.boostGain;
    this.wetGain.connect(this.boostGain);
    this.aiGain.connect(this.boostGain);

    EQ_BANDS.forEach(([id, freq, type]) => {
      const filter = this.ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = 1;
      filter.gain.value = Number(this.getBandValue(id));
      node.connect(filter);
      node = filter;
      this.eqFilters[id] = filter;
    });

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.dryGain.connect(this.analyser);
    node.connect(this.analyser);

    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    this.analyser.connect(limiter);
    limiter.connect(this.ctx.destination);
  }

  async resume() {
    if (this.ctx && typeof this.ctx.resume === 'function') {
      await this.ctx.resume();
    }
  }

  applyMode({ singing, usingAI, vocalStrength, accompanimentGain }) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.dryGain.gain.setTargetAtTime(singing ? 0 : 1, now, 0.03);
    this.wetGain.gain.setTargetAtTime(singing && !usingAI ? 1 : 0, now, 0.03);
    this.aiGain.gain.setTargetAtTime(singing && usingAI ? 1 : 0, now, 0.03);
    this.centerGain.gain.setTargetAtTime(-Number(vocalStrength), now, 0.03);
    this.boostGain.gain.setTargetAtTime(Number(accompanimentGain), now, 0.03);
  }

  setBandGain(id, value) {
    if (this.ctx && this.eqFilters[id]) {
      this.eqFilters[id].gain.setTargetAtTime(Number(value), this.ctx.currentTime, 0.03);
    }
  }
}
