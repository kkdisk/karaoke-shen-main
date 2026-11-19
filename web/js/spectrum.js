export class SpectrumVisualizer {
  constructor(canvas, container = canvas?.parentElement) {
    this.canvas = canvas;
    this.container = container;
    this.animId = null;
    this.width = canvas?.width || 400;
    this.height = canvas?.height || 120;
    this.observer = null;
    this.setupResizeObserver();
  }

  setupResizeObserver() {
    if (!this.canvas || typeof globalThis.ResizeObserver !== 'function') return;
    const target = this.container || this.canvas;
    this.observer = new globalThis.ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const ratio = globalThis.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(entry.contentRect.width * ratio));
      const h = Math.max(1, Math.round(entry.contentRect.height * ratio));
      this.syncDimensions(w, h);
    });
    this.observer.observe(target);
  }

  syncDimensions(width, height) {
    this.width = width;
    this.height = height;
    if (this.canvas && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  start(analyser) {
    if (!analyser || !this.canvas || this.animId !== null) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      const { width, height } = this;
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#03dac6';
      const bar = width / data.length;
      for (let i = 0; i < data.length; i++) {
        const h = (data[i] / 255) * height;
        ctx.fillRect(i * bar, height - h, Math.max(1, bar - 1), h);
      }
      this.animId = globalThis.requestAnimationFrame(draw);
    };
    draw();
  }

  stop() {
    if (this.animId !== null) {
      globalThis.cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  destroy() {
    this.stop();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
