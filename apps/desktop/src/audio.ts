export class AudioCapture {
  private streams: MediaStream[] = [];
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private flushAck: (() => void) | null = null;
  private stopped = false;
  get sampleRate() {
    return this.context?.sampleRate ?? 48000;
  }
  prepare() {
    this.context = new AudioContext();
    return this.context.sampleRate;
  }
  async start(
    systemAudio: boolean,
    onChunk: (data: ArrayBuffer) => void,
    onLevel: (level: number) => void,
    onSource: (source: "microphone" | "system", connected: boolean) => void,
    onFailure: (message: string) => void,
  ) {
    if (!this.context) throw new Error("Audio context is not prepared");
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (this.stopped) {
      mic.getTracks().forEach((t) => t.stop());
      throw new Error("Capture cancelled");
    }
    this.streams.push(mic);
    onSource("microphone", true);
    mic.getAudioTracks()[0].onended = () => {
      onSource("microphone", false);
      onFailure(
        "Microphone disconnected. Stop the meeting and check your input device.",
      );
    };
    if (systemAudio) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        if (this.stopped) {
          display.getTracks().forEach((t) => t.stop());
          throw new Error("Capture cancelled");
        }
        if (display.getAudioTracks().length) {
          this.streams.push(display);
          onSource("system", true);
          display.getAudioTracks()[0].onended = () => {
            onSource("system", false);
            onFailure(
              "System audio ended. Microphone capture is still active.",
            );
          };
        } else {
          display.getTracks().forEach((t) => t.stop());
          onSource("system", false);
          onFailure(
            "The operating system did not provide system audio. Microphone capture is active.",
          );
        }
      } catch {
        onSource("system", false);
        onFailure("System audio was not shared. Microphone capture is active.");
      }
    }
    await this.context.audioWorklet.addModule(
      new URL("pcm-worklet.js", document.baseURI).href,
    );
    if (this.stopped) throw new Error("Capture cancelled");
    this.worklet = new AudioWorkletNode(this.context, "pcm-processor");
    this.worklet.port.onmessage = (event) => {
      const value = event.data as {
        pcm?: ArrayBuffer;
        level?: number;
        flushed?: boolean;
      };
      if (value.flushed) this.flushAck?.();
      if (value.pcm) {
        onChunk(value.pcm);
        onLevel(value.level ?? 0);
      }
    };
    for (const stream of this.streams) {
      const audioStream = new MediaStream(stream.getAudioTracks());
      const source = this.context.createMediaStreamSource(audioStream);
      const gain = this.context.createGain();
      gain.gain.value = 1 / this.streams.length;
      source.connect(gain).connect(this.worklet);
    }
    const silent = this.context.createGain();
    silent.gain.value = 0;
    this.worklet.connect(silent).connect(this.context.destination);
    await this.context.resume();
  }
  async stop() {
    this.stopped = true;
    for (const stream of this.streams)
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    this.streams = [];
    if (this.worklet) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.flushAck = () => {
          clearTimeout(timer);
          resolve();
        };
        this.worklet!.port.postMessage("flush");
      });
      this.worklet.disconnect();
      this.worklet.port.close();
      this.worklet = null;
    }
    await this.context?.close();
    this.context = null;
  }
}
