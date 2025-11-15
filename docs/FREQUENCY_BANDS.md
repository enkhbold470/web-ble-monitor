# Frequency Band PSD Calculation Documentation

## Overview

This document describes the implementation of real-time frequency band Power Spectral Density (PSD) calculation and visualization for EEG data. The system calculates five standard EEG frequency bands (Delta, Theta, Alpha, Beta, Gamma) with data filtered to the 5-60 Hz range.

## Implementation Summary

### What Was Added

1. **Frequency Band PSD Calculation Function** (`lib/eegUtils.ts`)
   - Function: `calculate5BandPSD()`
   - Filters EEG data to 5-60 Hz range before calculation
   - Computes PSD for 5 frequency bands using FFT
   - Returns power values for each band

2. **Real-time Bar Chart Component** (`components/BleReader.tsx`)
   - Component: `FrequencyBandChart`
   - Displays live PSD values as colored bars
   - Updates automatically as new EEG data arrives
   - Uses React `useMemo` for performance optimization

## Technical Details

### Frequency Bands

The system calculates PSD for the following frequency bands:

| Band | Frequency Range | Color | Notes |
|------|----------------|-------|-------|
| **Delta** | 0.5-4 Hz | Blue (#3b82f6) | Will be 0 since data is filtered to 5-60 Hz |
| **Theta** | 5-8 Hz | Purple (#8b5cf6) | Partial range (standard is 4-8 Hz) |
| **Alpha** | 8-13 Hz | Pink (#ec4899) | Full range available |
| **Beta** | 13-30 Hz | Orange (#f59e0b) | Full range (adjusted to avoid overlap with alpha) |
| **Gamma** | 30-60 Hz | Green (#10b981) | Partial range (standard is 30-100 Hz) |

### Data Processing Pipeline

1. **Input**: Array of EEG samples (raw voltage values)
2. **FFT Processing**: 
   - Computes Power Spectral Density using FFT
   - Uses Welch method (simplified, single segment)
   - FFT size is power of 2 (padded if needed)
3. **Frequency Filtering**: 
   - Filters frequencies to 5-60 Hz range
   - Only frequencies within this range are used for band calculations
4. **Band Calculation**:
   - For each band, calculates average power density
   - Sums power values within band's frequency range
   - Divides by number of frequency bins in range

### Code Structure

#### Function: `calculate5BandPSD()`

**Location**: `lib/eegUtils.ts`

**Signature**:
```typescript
export function calculate5BandPSD(eegData: number[], fs: number): BandPSD
```

**Parameters**:
- `eegData`: Array of EEG sample values (raw voltage measurements)
- `fs`: Sampling rate in Hz (currently 250 Hz)

**Returns**:
```typescript
interface BandPSD {
  delta: number;   // Power spectral density for delta band
  theta: number;   // Power spectral density for theta band
  alpha: number;   // Power spectral density for alpha band
  beta: number;    // Power spectral density for beta band
  gamma: number;   // Power spectral density for gamma band
}
```

**Algorithm**:
1. Validates input data (minimum 32 samples required)
2. Computes PSD using `computePSD()` function
3. Filters frequencies to 5-60 Hz range
4. Calculates average power for each band within filtered range
5. Returns band PSD values

#### Component: `FrequencyBandChart`

**Location**: `components/BleReader.tsx`

**Props**:
```typescript
{ data: EegDatum[] }
```

**Features**:
- Uses `useMemo` to recalculate band PSD only when data changes
- Uses last 512 samples (or available) for calculation
- Displays bars with distinct colors for each band
- Updates in real-time as new data arrives
- Shows tooltip with precise PSD values (6 decimal places)

**Display Conditions**:
- Only shown when `isStreaming === true`
- Requires at least 32 data points
- Positioned below the main EEG line chart

### Configuration

**Sampling Rate**: 250 Hz (configurable in `lib/eegUtils.ts`)

**Minimum Samples**: 32 samples required for processing

**Window Size**: Uses last 512 samples for calculation (approximately 2 seconds at 250 Hz)

## Usage

### In the UI

The frequency band chart automatically appears when:
1. BLE device is connected and streaming
2. At least 32 data points have been collected
3. Session is active

The chart displays below the main EEG line chart and updates in real-time.

### Programmatic Usage

```typescript
import { calculate5BandPSD, SAMPLING_RATE } from '@/lib/eegUtils';

// Example: Calculate band PSD from EEG samples
const eegSamples = [/* array of voltage values */];
const bandPSD = calculate5BandPSD(eegSamples, SAMPLING_RATE);

console.log('Delta:', bandPSD.delta);
console.log('Theta:', bandPSD.theta);
console.log('Alpha:', bandPSD.alpha);
console.log('Beta:', bandPSD.beta);
console.log('Gamma:', bandPSD.gamma);
```

## Performance Considerations

- **Memoization**: Uses `useMemo` to avoid recalculating on every render
- **Window Size**: Limited to 512 samples to balance accuracy and performance
- **FFT Size**: Automatically padded to next power of 2 for efficient FFT computation
- **Animation**: Disabled (`isAnimationActive={false}`) for smoother real-time updates

## Future Enhancements

Potential improvements:
1. Make window size configurable
2. Add smoothing/averaging over time windows
3. Add relative power calculations (percentage of total power)
4. Add band ratio calculations (e.g., alpha/beta ratio)
5. Support for different frequency band definitions
6. Add export functionality for band data

## Dependencies

- `fft.js`: For FFT computation
- `recharts`: For bar chart visualization
- React hooks: `useMemo` for performance optimization

## Notes

- Delta band will always be 0 since data is filtered to 5-60 Hz (delta is 0.5-4 Hz)
- Theta band uses 5-8 Hz range (partial, since standard is 4-8 Hz)
- Beta band uses 13-30 Hz to avoid overlap with alpha (8-13 Hz)
- Gamma band uses 30-60 Hz (partial, since standard is 30-100 Hz)
- All calculations use average power density (not total power)

