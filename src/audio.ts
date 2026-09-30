import { estimatePitch, PitchListenerStatus, PitchOnsetTracker } from "./pitch";
import { PitchSampleDecimator, PitchSpectralFlux } from "./pitch-samples";

export type PianoListenerOptions = {
  deviceId?: string;
  /** Measured A4 tuning reference in Hz; defaults to 440. */
  referenceA4?: number;
};

/**
 * Lightweight, single-note piano pitch listener for browser microphone input.
 * Requires a secure context (HTTPS or localhost) and microphone permission.
 */
export class PianoListener {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private frameId?: number;
  private sampleBuffer?: Float32Array<ArrayBuffer>;
  private pitchBuffer?: Float32Array<ArrayBuffer>;
  private active = false;
  private generation = 0;

  /**
   * Starts microphone capture and reports confident note onsets. A held note
   * is reported once; the same pitch can report again after a quiet gap or a
   * fresh short-window attack, which supports repeated piano strikes.
   */
  async start(
    onNote: (midi: number, confidence: number) => void,
    onLevel?: (level: number) => void,
    onStatus?: (status: PitchListenerStatus) => void,
    options: PianoListenerOptions = {},
  ): Promise<void> {
    this.stop();
    const generation = this.generation;

    if (options.referenceA4 !== undefined &&
        (!Number.isFinite(options.referenceA4) || options.referenceA4 < 400 || options.referenceA4 > 480)) {
      throw new Error("The A4 tuning reference must be between 400 and 480 Hz.");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is unavailable in this browser or context.");
    }

    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (generation !== this.generation) {
        this.dispose(stream);
        return;
      }
      this.stream = stream;

      context = new AudioContext();
      this.context = context;
      if (context.state === "suspended") await context.resume();
      if (generation !== this.generation) {
        this.dispose(stream, context);
        return;
      }

      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);

      if (generation !== this.generation) {
        this.dispose(stream, context, source, analyser);
        return;
      }

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.analyser = analyser;
      this.sampleBuffer = new Float32Array(analyser.fftSize);
      // Retain the full time span while reducing pitch-search work. A proper
      // low-pass below is required before discarding alternate audio samples.
      this.pitchBuffer = new Float32Array(analyser.fftSize / 2);
      this.active = true;
      this.processFrames(onNote, generation, onLevel, onStatus, options);
    } catch (error) {
      this.dispose(stream, context, source, analyser);
      if (generation !== this.generation) return;
      this.active = false;
      if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
      this.frameId = undefined;
      this.clearReferences();
      throw error;
    }
  }

  /** Stops capture and releases the microphone and Web Audio resources. */
  stop(): void {
    this.generation++;
    this.active = false;
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.frameId = undefined;
    const stream = this.stream;
    const context = this.context;
    const source = this.source;
    const analyser = this.analyser;
    this.clearReferences();
    this.dispose(stream, context, source, analyser);
  }

  private processFrames(
    onNote: (midi: number, confidence: number) => void,
    generation: number,
    onLevel?: (level: number) => void,
    onStatus?: (status: PitchListenerStatus) => void,
    options: PianoListenerOptions = {},
  ): void {
    if (!this.analyser || !this.sampleBuffer || !this.pitchBuffer || !this.active) return;

    const quietThreshold = 0.008;
    const tracker = new PitchOnsetTracker();
    const decimator = new PitchSampleDecimator(this.analyser.context.sampleRate);
    const spectralFlux = new PitchSpectralFlux(this.pitchBuffer.length);
    let lastStatusKey = "";
    let lastStatusAt = -Infinity;

    const tick = () => {
      if (
        generation !== this.generation ||
        !this.active ||
        !this.analyser ||
        !this.sampleBuffer ||
        !this.pitchBuffer
      ) return;

      try {
        const currentAnalyser = this.analyser;
        const currentSamples = this.sampleBuffer;
        const currentPitchSamples = this.pitchBuffer;
        currentAnalyser.getFloatTimeDomainData(currentSamples);

        let sum = 0;
        for (let i = 0; i < currentSamples.length; i++) sum += currentSamples[i] * currentSamples[i];
        const rms = Math.sqrt(sum / currentSamples.length);
        onLevel?.(Math.min(1, rms * 5));
        if (generation !== this.generation || !this.active) return;

        const shortLength = Math.min(
          currentSamples.length,
          Math.max(1, Math.floor(currentAnalyser.context.sampleRate * 0.05)),
        );
        let shortSum = 0;
        for (let i = currentSamples.length - shortLength; i < currentSamples.length; i++) {
          shortSum += currentSamples[i] * currentSamples[i];
        }
        const shortRms = Math.sqrt(shortSum / shortLength);
        const now = performance.now();
        let estimate;
        decimator.process(currentSamples, currentPitchSamples);
        const novelty = spectralFlux.process(currentPitchSamples);

        estimate = rms >= quietThreshold
          ? estimatePitch(currentPitchSamples, currentAnalyser.context.sampleRate / 2, {
            minMidi: 36,
            maxMidi: 96,
            referenceA4: options.referenceA4,
          })
          : undefined;
        const tracked = tracker.update({ estimate, rms, shortRms, now, spectralFlux: novelty });
        const statusKey = `${tracked.status.state}:${tracked.status.midi ?? ""}`;
        if (statusKey !== lastStatusKey || now - lastStatusAt >= 120) {
          onStatus?.(tracked.status);
          lastStatusKey = statusKey;
          lastStatusAt = now;
        }
        if (tracked.onset) onNote(tracked.onset.midi, tracked.onset.confidence);
      } catch (error) {
        // A consumer callback or Web Audio failure should not leave the mic open.
        if (generation === this.generation) this.stop();
        throw error;
      } finally {
        if (generation === this.generation && this.active) {
          this.frameId = requestAnimationFrame(tick);
        }
      }
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private clearReferences(): void {
    this.stream = undefined;
    this.context = undefined;
    this.source = undefined;
    this.analyser = undefined;
    this.sampleBuffer = undefined;
    this.pitchBuffer = undefined;
  }

  private dispose(
    stream?: MediaStream,
    context?: AudioContext,
    source?: MediaStreamAudioSourceNode,
    analyser?: AnalyserNode,
  ): void {
    try {
      source?.disconnect();
    } catch {
      // Disconnect can fail after the context has already been closed.
    }
    try {
      analyser?.disconnect();
    } catch {
      // Disconnect can fail after the context has already been closed.
    }
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Keep releasing remaining tracks if one track is already gone.
      }
    }
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }
}
