// Honest, plain-language copy for the BERGER·1 panel info popovers.
//
// Every claim here is a scientific claim about what the instrument does and does NOT
// measure, so it must stay true to the code that actually runs:
//   - band edges are the REAL BAND_DEFS from dsp.ts (delta 0.5–4, theta 4–8, alpha 8–13,
//     beta 13–30, gamma 30–45);
//   - the focus score is the Pope, Bogart & Bartolome (1995) engagement index beta/(alpha+theta)
//     (PMID 7647180), never theta-over-beta;
//   - the sensor is a single AROUND-EAR dry channel (never "frontal"/"prefrontal"/"Fp1");
//   - analysis states association, never causation.
// The `caveats` array is not optional decoration: it is what keeps the readout from lying.

export interface Explainer {
	/** Panel heading this explains, e.g. 'SPECTRUM · WELCH PSD' */
	title: string;
	/** How to read it. Plain language, short paragraphs. */
	body: string[];
	/** What it does NOT tell you. Never omit these. */
	caveats: string[];
}

export type ExplainerKey = 'scope' | 'psd' | 'bands' | 'spectrogram' | 'berger' | 'focus';

export const EXPLAINERS: Record<ExplainerKey, Explainer> = {
	scope: {
		title: 'EEG ACTIVITY · CH1',
		body: [
			'The band-passed CH1 trace: 1–45 Hz with a 60 Hz mains notch. This is the raw time-domain signal every other panel is computed from.',
			'Each pixel column shows the min–max range of the samples that land in it, so a fast transient survives being squeezed onto the screen even at 2000 SPS — a spike is never averaged away.',
			'SWEEP sets how many seconds span the screen (8 divisions across). µV/DIV sets the vertical gain (4 divisions tall). AUTOSET fits the trace to the 99.5th-percentile amplitude. HOLD freezes the trace so you can inspect it.'
		],
		caveats: [
			'On AUTO gain the trace always fills the screen no matter how quiet the true signal is — read the µV/div label, not the apparent size of the wiggle.',
			'Blinks and jaw clenches are far larger than any brain rhythm, so the biggest deflections on screen are usually artifact, not cortex.'
		]
	},

	psd: {
		title: 'SPECTRUM · WELCH PSD',
		body: [
			'The power spectrum: how much signal sits at each frequency. It updates live (about twice a second), but each estimate is a 10 s trailing average of 75%-overlapped Hann-windowed segments — so after you change state it takes up to ~10 s for the spectrum to fully catch up.',
			'Read it by finding peaks. A relaxed subject shows a bump near ~10 Hz (alpha) that grows when the eyes close, sitting on a 1/f slope that falls off toward higher frequencies.'
		],
		caveats: [
			'The vertical axis is auto-ranged and unlabelled — it shows the SHAPE of the spectrum, not absolute power (internally it is µV²/Hz).',
			'On one around-ear dry electrode the alpha bump is small and can hide under low-frequency drift or muscle noise.',
			'A flat line, or spikes spread across every frequency, means poor electrode contact — not brain signal.'
		]
	},

	bands: {
		title: 'BAND POWER',
		body: [
			'Each bar is the PSD integrated over one named frequency band. The focus score uses only beta (its numerator) and alpha + theta (its denominator).',
			'DELTA · 0.5–4 Hz — the slowest waves; deep sleep and large body movement.',
			'THETA · 4–8 Hz — drowsiness, memory and meditative states; part of the focus denominator.',
			'ALPHA · 8–13 Hz — relaxed wakefulness; rises on eye closure (the Berger effect), the one band here with a clean physiological test.',
			'BETA · 13–30 Hz — alert, active concentration; the numerator of the focus score.',
			'GAMMA · 30–45 Hz — sometimes cited in relation to attention.'
		],
		caveats: [
			'DELTA: the 1–45 Hz band-pass attenuates 0.5–1 Hz, and on a dry electrode this band is mostly motion, sweat and electrode drift — treat it as an artifact monitor, not brain.',
			'THETA: on one channel it also catches eye movement (EOG) and slow drift.',
			'ALPHA: it is generated at the back of the head, so an around-ear electrode sees it weak; a ~10 Hz mu rhythm can mimic it.',
			'BETA: it overlaps jaw, temporalis and neck EMG — clenching your teeth raises beta exactly like concentrating does, and one channel cannot separate them.',
			'GAMMA: on a dry single channel this is almost entirely muscle EMG and mains-harmonic residue. It is not used in the focus score.'
		]
	},

	spectrogram: {
		title: 'SPECTROGRAM · WATERFALL',
		body: [
			'The spectrum over time. X is time, with the newest stripe at the RIGHT and the picture scrolling left (about 65 s shown). Y is frequency: 0 Hz at the bottom up to min(45 Hz, 0.49·fs) at the top.',
			'Colour is power in dB — dark is low, bright green through white is high.',
			'Look for a steady bright line near 10 Hz that brightens when you close your eyes; bright vertical streaks are blinks or movement; a bright band hugging the bottom is drift.'
		],
		caveats: [
			'Contrast auto-scales to the visible window, so brightness is RELATIVE, not absolute — a bright stripe means "louder than the rest of this window", not a fixed power level.',
			'The bright vertical streaks and the bottom-hugging band are artifact (blinks, movement, drift), not brain rhythm — do not read them as signal.'
		]
	},

	berger: {
		title: 'ALPHA TEST · EYES OPEN / CLOSED',
		body: [
			'Hans Berger, 1929: occipital alpha desynchronises (drops) with the eyes open and synchronises (rises) with the eyes closed in a relaxed subject. It is the canonical positive control that the rig is reading cortex at all.',
			'The guided test alternates 20 s eyes-open and 20 s eyes-closed blocks three times, discards the first 2 s after each transition, rejects any 2 s sub-epoch containing blinks or muscle artifact, and averages the alpha power within each condition. C/O is the closed-eyes alpha over the open-eyes alpha.'
		],
		caveats: [
			'This electrode is around-ear, far from the occipital alpha generator, so expect a modest ratio — NOT the textbook 2–5×. That is why the verdict is judged by consistency across blocks, not a fixed threshold.',
			'Eye closure also relaxes facial muscle, which lowers broadband power and can masquerade as an alpha rise.',
			'A ~10 Hz mu rhythm can leak in and inflate the ratio.'
		]
	},

	focus: {
		title: 'FOCUS',
		body: [
			'The Pope, Bogart & Bartolome (1995) engagement index, beta/(alpha+theta) (PMID 7647180).',
			'It is an unbounded ratio, so it is mapped to 0–100 by a logistic against YOUR OWN baseline, frozen after the first 20 s. 50 means your own baseline.'
		],
		caveats: [
			'It is NOT comparable between people, and only meaningful within a single session.',
			'It requires ≥175 SPS — below that, beta sits above the Nyquist limit or 60 Hz mains folds into the beta band.',
			'Clenching your jaw raises it exactly like concentrating does.',
			'A detached electrode collapses alpha+theta and would read as flawless concentration, which is why signalOk and calibrating gate the display.'
		]
	}
};
