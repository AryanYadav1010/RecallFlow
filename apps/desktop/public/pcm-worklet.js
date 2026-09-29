class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(Math.round(sampleRate / 10));
    this.offset = 0;
    this.energy = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const data = this.samples.slice(0, this.offset);
    this.port.postMessage(
      { pcm: data.buffer, level: Math.sqrt(this.energy / this.offset) },
      [data.buffer],
    );
    this.offset = 0;
    this.energy = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      value = Math.max(-1, Math.min(1, value));
      this.samples[this.offset++] = value < 0 ? value * 32768 : value * 32767;
      this.energy += value * value;
      if (this.offset === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
