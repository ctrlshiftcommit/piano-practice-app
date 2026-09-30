/**
 * Anti-alias the microphone signal before its 2:1 pitch-search decimation.
 * A two-point average leaves strong upper piano partials above the new Nyquist
 * frequency; those fold into unrelated frequencies and can create octave dips.
 * This windowed-sinc low-pass also keeps the search focused on lower partials.
 */
export class PitchSampleDecimator {
  private readonly kernel: Float64Array;

  constructor(sampleRate: number) {
    const taps = 63;
    const cutoff = Math.min(3000, sampleRate * 0.2) / sampleRate;
    this.kernel = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - (taps - 1) / 2;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
      this.kernel[i] = sinc * window;
      sum += this.kernel[i];
    }
    for (let i = 0; i < taps; i++) this.kernel[i] /= sum;
  }

  process(source: Float32Array<ArrayBufferLike>, target: Float32Array<ArrayBufferLike>): void {
    for (let i = 0; i < target.length; i++) {
      const end = i * 2 + 1;
      let value = 0;
      for (let tap = 0; tap < this.kernel.length; tap++) {
        value += this.kernel[tap] * (source[end - tap] ?? 0);
      }
      target[i] = value;
    }
  }
}

/** Positive spectral flux after normalizing away overall level changes. */
export class PitchSpectralFlux {
  private readonly size: number;
  private readonly real: Float64Array;
  private readonly imaginary: Float64Array;
  private readonly previous: Float64Array;
  private readonly window: Float64Array;
  private readonly reversed: Uint32Array;
  private readonly cosine: Float64Array;
  private readonly sine: Float64Array;

  constructor(size: number) {
    this.size = size;
    this.real = new Float64Array(size);
    this.imaginary = new Float64Array(size);
    this.previous = new Float64Array(size / 2);
    this.window = new Float64Array(size);
    this.reversed = new Uint32Array(size);
    this.cosine = new Float64Array(size / 2);
    this.sine = new Float64Array(size / 2);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let source = i, reversed = 0;
      for (let bit = 0; bit < bits; bit++) {
        reversed = (reversed << 1) | (source & 1);
        source >>= 1;
      }
      this.reversed[i] = reversed;
      this.window[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)) +
        0.08 * Math.cos(4 * Math.PI * i / (size - 1));
      if (i < size / 2) {
        this.cosine[i] = Math.cos(-2 * Math.PI * i / size);
        this.sine[i] = Math.sin(-2 * Math.PI * i / size);
      }
    }
  }

  process(samples: Float32Array<ArrayBufferLike>): number {
    for (let i = 0; i < this.size; i++) {
      this.real[this.reversed[i]] = samples[i] * this.window[i];
      this.imaginary[i] = 0;
    }
    for (let width = 2; width <= this.size; width *= 2) {
      const half = width / 2, stride = this.size / width;
      for (let start = 0; start < this.size; start += width) {
        for (let i = 0; i < half; i++) {
          const left = start + i, right = left + half, twiddle = i * stride;
          const real = this.real[right] * this.cosine[twiddle] - this.imaginary[right] * this.sine[twiddle];
          const imaginary = this.real[right] * this.sine[twiddle] + this.imaginary[right] * this.cosine[twiddle];
          this.real[right] = this.real[left] - real;
          this.imaginary[right] = this.imaginary[left] - imaginary;
          this.real[left] += real;
          this.imaginary[left] += imaginary;
        }
      }
    }
    let total = 0;
    for (let i = 2; i < this.previous.length; i++) {
      this.real[i] = Math.hypot(this.real[i], this.imaginary[i]);
      total += this.real[i];
    }
    let flux = 0;
    for (let i = 2; i < this.previous.length; i++) {
      const magnitude = total > 1e-9 ? this.real[i] / total : 0;
      flux += Math.max(0, magnitude - this.previous[i]);
      this.previous[i] = magnitude;
    }
    return flux;
  }
}
