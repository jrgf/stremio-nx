const MiB = 1024 * 1024;
const RANGE = 8 * MiB;

// ponytail: seconds are byte/bitrate estimates; use segment timestamps if adaptive streaming is added.
/** Shared by torrent and HTTP; byte caps take precedence over time goals. */
export function bufferTargets(length: number, duration: number, observedRate = 0) {
	const average = Number.isFinite(duration) && duration > 0 ? length / duration : MiB / 2;
	const rate = Math.max(average, Number.isFinite(observedRate) ? observedRate : 0, 1);
	const startup = Math.ceil(Math.min(16 * MiB, Math.max(2 * MiB, rate * 12)));
	return {
		rate,
		startup,
		resume: startup,
		low: Math.ceil(Math.min(2 * MiB, Math.max(MiB / 4, rate))),
		ahead: Math.min(64 * MiB, Math.max(16 * MiB, Math.ceil(rate * 45 / RANGE) * RANGE)),
		behind: 8 * MiB,
	};
}
