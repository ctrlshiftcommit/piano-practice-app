/** A pitch estimate from one monophonic audio window. */
export type PitchEstimate = {
  midi: number;
  frequency: number;
  /** Nearest MIDI note before applying a selected A4 tuning reference. */
  rawMidi?: number;
  /** Periodicity confidence from 0 (weak) to 1 (strong). */
  confidence: number;
  /** Detuning from the nearest equal-tempered MIDI note, in cents. */
  cents: number;
};

export type PitchListenerStatus = {
  state: "quiet" | "settling" | "uncertain" | "stable";
  midi?: number;
  confidence?: number;
  cents?: number;
  frequency?: number;
  rawMidi?: number;
};

export type PitchOnset = PitchEstimate;

/**
 * Estimate the strongest periodic fundamental without preferring any expected
 * score note. The cumulative-mean normalized difference (YIN) finds the first
 * convincing period instead of accepting the first raw autocorrelation peak,
 * which is often the second harmonic of a piano note.
 */
export function estimatePitch(
  samples: Float32Array<ArrayBufferLike>,
  sampleRate: number,
  options: {
    minFrequency?: number;
    maxFrequency?: number;
    minMidi?: number;
    maxMidi?: number;
    threshold?: number;
    referenceA4?: number;
  } = {},
): PitchEstimate | undefined {
  // Include the rounding interval around endpoint notes; an exact-frequency
  // cutoff rejects even correctly tuned C2/C7 after interpolation error.
  const referenceA4 = options.referenceA4 ?? 440;
  const minFrequency = options.minFrequency ?? 65.406 * (referenceA4 / 440) * 2 ** (-0.5 / 12);
  const maxFrequency = options.maxFrequency ?? 2093.005 * (referenceA4 / 440) * 2 ** (0.5 / 12);
  const minMidi = options.minMidi ?? 36;
  const maxMidi = options.maxMidi ?? 96;
  const threshold = options.threshold ?? 0.18;
  const size = samples.length;
  if (size < 32 || !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isFinite(referenceA4) || referenceA4 < 400 || referenceA4 > 480) return undefined;

  let mean = 0;
  for (let i = 0; i < size; i++) mean += samples[i];
  mean /= size;

  let energy = 0;
  for (let i = 0; i < size; i++) {
    const centered = samples[i] - mean;
    energy += centered * centered;
  }
  if (energy / size < 0.000015) return undefined;

  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(Math.floor(size / 2), Math.ceil(sampleRate / minFrequency));
  // Holding the overlap length constant makes difference values comparable
  // across lags and keeps enough recent cycles for low piano notes.
  const overlap = size - maxLag;
  if (maxLag <= minLag || overlap < 16) return undefined;

  const normalized = new Float64Array(maxLag + 1);
  let runningDifference = 0;

  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0;
    for (let i = 0; i < overlap; i++) {
      const delta = samples[i] - mean - (samples[i + lag] - mean);
      difference += delta * delta;
    }
    runningDifference += difference;
    normalized[lag] = runningDifference > 0
      ? (difference * lag) / runningDifference
      : 1;
  }

  // Select the first local minimum below YIN's threshold. If no clear dip
  // exists, retain only a high-quality global minimum; do not guess from a
  // weak periodicity peak.
  let selectedLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (normalized[lag] <= normalized[lag - 1] &&
        normalized[lag] <= normalized[Math.min(maxLag, lag + 1)] &&
        interpolatedScore(lag) < threshold) {
      selectedLag = lag;
      break;
    }
  }
  if (selectedLag < 0) {
    let bestValue = 1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (normalized[lag] < bestValue) {
        bestValue = normalized[lag];
        selectedLag = lag;
      }
    }
    if (selectedLag < 0 || bestValue > 0.22) return undefined;
  }

  // A strong second harmonic can produce an early dip at half the true period.
  // Look for a substantially better periodic match at integer multiples of
  // that dip. A pure sine has equal minima at T and 2T, so it keeps the first
  // (highest-pitch) period; the lower candidate wins only with clear evidence.
  function interpolatedScore(lag: number): number {
    const left = normalized[Math.max(1, lag - 1)];
    const center = normalized[lag];
    const right = normalized[Math.min(maxLag, lag + 1)];
    const curvature = left - 2 * center + right;
    return curvature > 0
      ? Math.max(0, center - ((left - right) ** 2) / (8 * curvature))
      : center;
  }
  const firstLag = selectedLag;
  for (let multiple = 2; multiple <= 4; multiple++) {
    const expectedLag = Math.round(firstLag * multiple);
    const searchStart = Math.max(firstLag + 1, expectedLag - 1);
    const searchEnd = Math.min(maxLag, expectedLag + 1);
    let bestLag = -1;
    let bestScore = 1;
    for (let lag = searchStart; lag <= searchEnd; lag++) {
      if (normalized[lag] > normalized[lag - 1] || normalized[lag] > normalized[lag + 1]) continue;
      if (interpolatedScore(lag) < bestScore) {
        bestScore = interpolatedScore(lag);
        bestLag = lag;
      }
    }
    if (bestLag > 0 && bestScore + 0.04 < interpolatedScore(selectedLag)) {
      selectedLag = bestLag;
    }
  }
  // At very short periods, sampling error can make a period multiple look
  // cleaner than the real high note. Abstain on an ambiguous octave instead
  // of confidently grading the lower candidate as a wrong note.
  if (firstLag < 16 && selectedLag > firstLag && interpolatedScore(firstLag) < 0.1) return undefined;

  const left = normalized[Math.max(1, selectedLag - 1)];
  const center = normalized[selectedLag];
  const right = normalized[Math.min(maxLag, selectedLag + 1)];
  const curvature = left - 2 * center + right;
  const correction = Math.abs(curvature) > 1e-9
    ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature))
    : 0;
  const period = selectedLag + correction;
  const frequency = sampleRate / period;
  if (!Number.isFinite(frequency) || frequency < minFrequency || frequency > maxFrequency) return undefined;

  const exactMidi = 69 + 12 * Math.log2(frequency / referenceA4);
  const midi = Math.round(exactMidi);
  if (midi < minMidi || midi > maxMidi) return undefined;

  return {
    midi,
    frequency,
    rawMidi: Math.round(69 + 12 * Math.log2(frequency / 440)),
    confidence: Math.max(0, Math.min(1, 1 - center)),
    cents: (exactMidi - midi) * 100,
  };
}

/**
 * Turn overlapping frame estimates into note onsets. A pitch change by itself
 * is not an onset: a different note must settle for three frames and have a
 * fresh attack in level or spectrum. Brief quiet dips and changes within the
 * same note's decay do not rearm it.
 */
export class PitchOnsetTracker {
  private readonly quietThreshold = 0.008;
  private readonly onsetThreshold = 0.008;
  private readonly attackFloor = 0.006;
  private readonly attackRiseRatio = 1.35;
  private readonly confidenceThreshold = 0.78;
  private readonly stableFrameCount = 3;
  private readonly attackSettleMs = 190;

  private lastOnsetAt = -Infinity;
  private lastEmittedMidi?: number;
  private wasQuiet = true;
  private candidateMidi?: number;
  private candidateCents?: number;
  private candidateFrames = 0;
  private previousShortRms = 0;
  private lastAttackAt = -Infinity;
  private pendingAttackAt = -Infinity;
  private pendingOnsetUntil = -Infinity;
  private quietSince?: number;
  private fluxMean = 0;
  private fluxVariance = 0;

  update(input: {
    estimate?: PitchEstimate;
    rms: number;
    shortRms: number;
    now: number;
    /** Normalized positive spectral flux, when available from the listener. */
    spectralFlux?: number;
  }): { onset?: PitchOnset; status: PitchListenerStatus } {
    const { estimate, rms, shortRms, now } = input;
    const spectralFlux = input.spectralFlux ?? 0;
    const novelSpectrum = spectralFlux > Math.max(0.035, this.fluxMean + 3 * Math.sqrt(this.fluxVariance));
    // A changing decay envelope must not postpone the current attack, or turn
    // the same held key into another onset. A fresh key can introduce new
    // partials even while overall RMS falls beneath the previous note's tail.
    const spectralAttack = novelSpectrum && now > this.pendingOnsetUntil &&
      estimate?.midi !== this.lastEmittedMidi;
    if (!novelSpectrum) {
      // Keep an attack outlier out of the background model; otherwise it raises
      // the threshold and masks a quieter following note.
      const fluxDelta = spectralFlux - this.fluxMean;
      this.fluxMean += fluxDelta * 0.08;
      this.fluxVariance = 0.92 * (this.fluxVariance + 0.08 * fluxDelta * fluxDelta);
    }
    const freshAttack =
      shortRms >= this.attackFloor &&
      (this.previousShortRms < this.attackFloor * 0.5 ||
        shortRms >= this.previousShortRms * this.attackRiseRatio || spectralAttack) &&
      now - this.lastAttackAt >= 100;
    if (freshAttack) {
      this.lastAttackAt = now;
      this.pendingAttackAt = now;
      this.pendingOnsetUntil = now + 450;
      // Do not carry the old pitch's stable count into a new strike.
      this.candidateMidi = undefined;
      this.candidateCents = undefined;
      this.candidateFrames = 0;
    }
    this.previousShortRms = shortRms;

    if (rms < this.quietThreshold) {
      this.quietSince ??= now;
      // Unison-string beating can briefly cross the gate during a held note.
      // Rearm only after an actual quiet gap, rather than on a single dip.
      if (now - this.quietSince >= 120 && shortRms < this.quietThreshold) this.resetForQuiet();
      return { status: { state: "quiet" } };
    }
    this.quietSince = undefined;

    const hadQuietGap = this.wasQuiet && rms >= this.quietThreshold;
    if (hadQuietGap) {
      this.pendingAttackAt = now;
      this.pendingOnsetUntil = now + 450;
      this.wasQuiet = false;
    }
    if (rms >= this.onsetThreshold) this.wasQuiet = false;

    const validEstimate = estimate && estimate.confidence >= this.confidenceThreshold
      ? estimate
      : undefined;
    if (!validEstimate) {
      this.candidateMidi = undefined;
      this.candidateCents = undefined;
      this.candidateFrames = 0;
      return {
        status: {
          state: "uncertain",
          midi: estimate?.midi,
          confidence: estimate?.confidence,
          cents: estimate?.cents,
          frequency: estimate?.frequency,
          rawMidi: estimate?.rawMidi ?? estimate?.midi,
        },
      };
    }

    const sameCandidate =
      validEstimate.midi === this.candidateMidi &&
      this.candidateCents !== undefined &&
      Math.abs(validEstimate.cents - this.candidateCents) <= 35;
    if (sameCandidate) {
      this.candidateFrames++;
      this.candidateCents = this.candidateCents! * 0.65 + validEstimate.cents * 0.35;
    } else {
      this.candidateMidi = validEstimate.midi;
      this.candidateCents = validEstimate.cents;
      this.candidateFrames = 1;
    }

    const hasSettledAfterAttack = now - this.pendingAttackAt >= this.attackSettleMs;
    const isStable = this.candidateFrames >= this.stableFrameCount && hasSettledAfterAttack;
    const status: PitchListenerStatus = {
      state: isStable ? "stable" : "settling",
      midi: validEstimate.midi,
      confidence: validEstimate.confidence,
      cents: validEstimate.cents,
      frequency: validEstimate.frequency,
      rawMidi: validEstimate.rawMidi ?? validEstimate.midi,
    };
    const hasPendingAttack = now <= this.pendingOnsetUntil;
    const onset = isStable && hasPendingAttack && now - this.lastOnsetAt >= 100
      ? validEstimate
      : undefined;
    if (onset) {
      this.lastEmittedMidi = onset.midi;
      this.lastOnsetAt = now;
      this.pendingOnsetUntil = -Infinity;
      this.wasQuiet = false;
    }

    return { onset, status };
  }

  private resetForQuiet(): void {
    this.wasQuiet = true;
    this.lastEmittedMidi = undefined;
    this.candidateMidi = undefined;
    this.candidateCents = undefined;
    this.candidateFrames = 0;
    this.previousShortRms = 0;
    this.lastAttackAt = -Infinity;
    this.pendingAttackAt = -Infinity;
    this.pendingOnsetUntil = -Infinity;
  }
}
