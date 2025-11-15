import FFT from 'fft.js';

// Configuration
export const SAMPLING_RATE = 512; // Hz
export const ONE_MINUTE_SAMPLES = SAMPLING_RATE * 2;
export const LOW_BETA_THRESHOLD = 0.34;
export const TRACKING_WINDOW_SECONDS = 300; // 5 minutes
export const ALERT_THRESHOLD_PERCENT = 80;
export const MIN_SAMPLES_FOR_PROCESSING = 32; // Reduced from 1024 to 32 for shorter sessions

// In-memory user beta tracking (for demo, not persistent)
const userBetaReadings: Record<string, Array<{ t: number; beta: number }>> = {};

// 1. PSD Computation (Welch method, simplified)
export function computePSD(eegData: number[], fs: number): { freqs: number[]; psd: number[] } {
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

// 2. Compute Beta Power (12-30 Hz)
export function computeBetaPower(freqs: number[], psd: number[]): number {
  if (!freqs || !psd || freqs.length !== psd.length) {
    console.warn('Invalid freqs or psd arrays');
    return 0;
  }
  
  const betaIdx = freqs.map((f, i) => (f >= 12 && f <= 30 ? i : -1)).filter(i => i !== -1);
  
  if (betaIdx.length === 0) {
    console.warn('No beta frequencies found in range 12-30 Hz');
    return 0;
  }
  
  const betaVals = betaIdx.map(i => psd[i]).filter(val => !isNaN(val) && val >= 0);
  
  if (betaVals.length === 0) {
    console.warn('No valid beta power values found');
    return 0;
  }
  
  const betaPower = betaVals.reduce((a, b) => a + b, 0) / betaVals.length;
  
  // Ensure we return a positive number
  return Math.max(0, betaPower);
}

// 3. Low Beta Persistence Checking
export function checkLowBetaPersistence(userId: string, betaPower: number): boolean {
  const now = Date.now() / 1000;
  if (!userBetaReadings[userId]) userBetaReadings[userId] = [];
  userBetaReadings[userId].push({ t: now, beta: betaPower });
  // Remove old
  userBetaReadings[userId] = userBetaReadings[userId].filter(r => r.t >= now - TRACKING_WINDOW_SECONDS);
  if (userBetaReadings[userId].length < (SAMPLING_RATE * 60) / ONE_MINUTE_SAMPLES) return false;
  const lowReadings = userBetaReadings[userId].filter(r => r.beta < LOW_BETA_THRESHOLD).length;
  const percentLow = (lowReadings / userBetaReadings[userId].length) * 100;
  return percentLow >= ALERT_THRESHOLD_PERCENT;
}

// 4. Focus Level Calculation
export function calculateFocusLevel(betaPower: number): number {
  // Handle edge cases
  if (isNaN(betaPower) || betaPower < 0) {
    return 0;
  }
  
  const MIN_BETA = 0.0001; // Very small minimum to avoid division by zero
  const MAX_BETA = 1.0;
  
  // Clamp the beta power to the valid range
  const clamped = Math.max(MIN_BETA, Math.min(MAX_BETA, betaPower));
  
  // Calculate focus level as a percentage (0-100)
  const focusLevel = ((clamped - MIN_BETA) / (MAX_BETA - MIN_BETA)) * 100;
  
  // Round to 1 decimal place
  return Math.round(focusLevel * 10) / 10;
}

// Define valid stage types
type Stage = 
  | "1_Baseline_Relaxed"
  | "2_Cognitive_Warmup"
  | "3_Focused_Task"
  | "4_Post_Task_Rest";

// 5. Main Processing Function
export function processEegData(userId: string, eegSamples: number[] | {value: number, timestamp?: number, stage?: Stage | string | null}[]): any {
  try {
    if (!Array.isArray(eegSamples)) throw new Error('eegSamples must be an array');
    
    // Reduced minimum requirement for shorter sessions
    if (eegSamples.length < MIN_SAMPLES_FOR_PROCESSING) {
      return { 
        error: `Insufficient data for processing. Need at least ${MIN_SAMPLES_FOR_PROCESSING} samples, got ${eegSamples.length}.`,
        focus_level: 0,
        beta_power: 0,
        low_beta_warning: false
      };
    }

    // Convert to numeric values if objects were provided
    const numericSamples = eegSamples.map(sample => typeof sample === 'number' ? sample : sample.value);
    
    // Extract stage information for enhanced analysis if available
    const stageInfo = typeof eegSamples[0] === 'object' && 'stage' in eegSamples[0] ? 
      (eegSamples[0] as {stage?: Stage | string | null}).stage : null;
    
    // For small datasets, pad with zeros or use simpler processing
    let processedSamples = numericSamples;
    if (processedSamples.length < SAMPLING_RATE) {
      // Pad with mean value to reach minimum for FFT
      const mean = processedSamples.reduce((a, b) => a + b, 0) / processedSamples.length;
      const paddingNeeded = SAMPLING_RATE - processedSamples.length;
      processedSamples = [...processedSamples, ...Array(paddingNeeded).fill(mean)];
    }
    
    const { freqs, psd } = computePSD(processedSamples, SAMPLING_RATE);
    const betaPower = computeBetaPower(freqs, psd);
    const lowBetaWarning = checkLowBetaPersistence(userId, betaPower);
    const focusLevel = calculateFocusLevel(betaPower);
    
    return {
      user_id: userId,
      eeg_data: {
        raw_samples: numericSamples,
        frequencies: freqs,
        psd,
        focus_level: focusLevel,
        processing_timestamp: Date.now() / 1000,
        stage: stageInfo,
      },
      beta_power: betaPower,
      low_beta_warning: lowBetaWarning,
      focus_level: focusLevel,
    };
  } catch (e: any) {
    console.error('Error in processEegData:', e);
    return { 
      error: `Error processing EEG data: ${e.message}`,
      focus_level: 0,
      beta_power: 0,
      low_beta_warning: false
    };
  }
} 