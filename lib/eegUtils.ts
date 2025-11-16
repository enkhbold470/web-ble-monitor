import FFT from 'fft.js';

// Configuration
export const SAMPLING_RATE = 250; // Hz
const MIN_SAMPLES_FOR_PROCESSING = 32;

// 1. PSD Computation (Welch method, simplified)
function computePSD(eegData: number[], fs: number): { freqs: number[]; psd: number[] } {
  // Welch: split into overlapping segments, average periodograms
  // Here: just use one segment for simplicity
  const fftSize = Math.pow(2, Math.ceil(Math.log2(eegData.length)));
  const fft = new FFT(fftSize);
  const input = new Array(fftSize).fill(0);
  eegData.forEach((v, i) => (input[i] = v));
  const out = fft.createComplexArray();
  fft.realTransform(out, input);
  fft.completeSpectrum(out);
  // Compute power spectrum
  const psd: number[] = [];
  for (let i = 0; i < fftSize / 2; i++) {
    const re = out[2 * i];
    const im = out[2 * i + 1];
    psd.push((re * re + im * im) / fftSize);
  }
  // Frequency bins
  const freqs = Array.from({ length: fftSize / 2 }, (_, i) => (i * fs) / fftSize);
  return { freqs, psd };
}

// 2. Calculate 5-band PSD (Delta, Theta, Alpha, Beta, Gamma) with 5-60 Hz filter
interface BandPSD {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

export function calculate5BandPSD(eegData: number[], fs: number): BandPSD {
  try {
    if (!eegData || eegData.length < MIN_SAMPLES_FOR_PROCESSING) {
      return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    }

    // Compute PSD
    const { freqs, psd } = computePSD(eegData, fs);
    
    // Filter frequencies to 5-60 Hz range
    const filteredData: { freq: number; power: number }[] = [];
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= 5 && freqs[i] <= 60) {
        filteredData.push({ freq: freqs[i], power: psd[i] });
      }
    }

    if (filteredData.length === 0) {
      return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    }

    // Calculate power for each band within the filtered range (5-60 Hz)
    // Note: Delta (0.5-4 Hz) is below our filter, so it will be 0 or very small
    // Theta: 4-8 Hz (filtered to 5-8 Hz)
    // Alpha: 8-13 Hz
    // Beta: 12-30 Hz (or 13-30 to avoid overlap)
    // Gamma: 30-60 Hz

    const calculateBandPower = (minFreq: number, maxFreq: number): number => {
      const bandData = filteredData.filter(d => d.freq >= minFreq && d.freq <= maxFreq);
      if (bandData.length === 0) return 0;
      const sum = bandData.reduce((acc, d) => acc + d.power, 0);
      return sum / bandData.length; // Average power density
    };

    return {
      delta: calculateBandPower(0.5, 4), // Will be 0 since filtered to 5-60 Hz
      theta: calculateBandPower(5, 8),   // 5-8 Hz (partial theta)
      alpha: calculateBandPower(8, 13),  // 8-13 Hz
      beta: calculateBandPower(13, 30),  // 13-30 Hz (to avoid overlap with alpha)
      gamma: calculateBandPower(30, 60), // 30-60 Hz
    };
  } catch (e: any) {
    console.error('Error calculating 5-band PSD:', e);
    return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  }
}

// 3. Main Processing Function (simplified - returns PSD data only)
export function processEegData(userId: string, eegSamples: number[] | {value: number, timestamp?: number, stage?: string | null}[]): any {
  try {
    if (!Array.isArray(eegSamples)) throw new Error('eegSamples must be an array');
    
    if (eegSamples.length < MIN_SAMPLES_FOR_PROCESSING) {
      return { 
        error: `Insufficient data for processing. Need at least ${MIN_SAMPLES_FOR_PROCESSING} samples, got ${eegSamples.length}.`,
      };
    }

    // Convert to numeric values if objects were provided
    const numericSamples = eegSamples.map(sample => typeof sample === 'number' ? sample : sample.value);
    
    // Extract stage information if available
    const stageInfo = typeof eegSamples[0] === 'object' && eegSamples[0] && 'stage' in eegSamples[0] 
      ? (eegSamples[0] as {stage?: string | null}).stage 
      : null;
    
    // For small datasets, pad with mean value
    let processedSamples = numericSamples;
    if (processedSamples.length < SAMPLING_RATE) {
      const mean = processedSamples.reduce((a, b) => a + b, 0) / processedSamples.length;
      const paddingNeeded = SAMPLING_RATE - processedSamples.length;
      processedSamples = [...processedSamples, ...Array(paddingNeeded).fill(mean)];
    }
    
    const { freqs, psd } = computePSD(processedSamples, SAMPLING_RATE);
    
    return {
      user_id: userId,
      eeg_data: {
        raw_samples: numericSamples,
        frequencies: freqs,
        psd,
        processing_timestamp: Date.now() / 1000,
        stage: stageInfo,
      },
    };
  } catch (e: any) {
    console.error('Error in processEegData:', e);
    return { 
      error: `Error processing EEG data: ${e.message}`,
    };
  }
} 