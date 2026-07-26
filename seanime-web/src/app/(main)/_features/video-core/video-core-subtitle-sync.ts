/**
 * Subtitle auto-sync — selects the correct subtitle file and aligns it to the audio.
 *
 * WHY THIS EXISTS
 * ---------------
 * When subtitles and audio come from the same rip (a local MKV) they share a timeline
 * and nothing is needed. Online streaming breaks that: the audio comes from a streaming
 * provider (AnimeParadise, AniZone, ...) while the Japanese subtitle comes from Jimaku —
 * two independent rips with no shared timing. Two distinct failures follow:
 *
 *   1. WRONG FILE.  A Jimaku entry commonly holds dozens of files mixing sources and
 *      numbering schemes (absolute vs season-relative), so "the first Japanese track"
 *      is frequently a *different episode*. No amount of time-shifting can fix that.
 *   2. WRONG OFFSET.  Even the correct file is typically offset by a few seconds
 *      against the provider's encode.
 *
 * Both are solved by the same measurement. We cross-correlate each candidate against a
 * subtitle track that IS known to be in sync with the audio — the provider's own
 * (usually English) track, or an embedded track from the same file. The correct episode
 * overlaps the reference dramatically better than any other episode does, so the peak
 * correlation *selects* the file, and the lag at that peak *aligns* it.
 *
 * WHY ONSETS AND NOT CUE INTERVALS
 * --------------------------------
 * `ffsubsync` marks every cue's full duration as "speech" and cross-correlates the
 * resulting bitstreams. That works when one side is a VAD envelope derived from audio,
 * but it fails badly for subtitle-vs-subtitle matching, and the reason is density:
 * subtitle display time is not speech time. Measured on real episodes, cue intervals
 * cover ~55-65% of the runtime, so *any* alignment scores ~60% overlap by chance and the
 * correlation is essentially flat. Measured peak-to-mean ratios were 1.05-1.46 — a
 * correct match was indistinguishable from a wrong episode.
 *
 * Cue *onsets* carry the signal instead. A line and its translation begin together, even
 * though they end at different times (translations run long or short). Replacing each cue
 * with a short pulse at its start time drops the duty cycle to a few percent and turns a
 * flat correlation into a sharp spike. On the same fixtures this separated a correct
 * match (peak-to-mean 4.5-8.0) from a wrong file (1.3-1.6) with a wide gap in between.
 *
 * COST
 * ----
 * Cues are sparse (a few hundred per episode), so exact interval overlap via a
 * two-pointer merge is O(n+m) per lag — no FFT needed. A full ±60 s search costs a few
 * milliseconds per candidate, cheap enough to score every candidate at episode load.
 *
 * Everything in this module is pure: no DOM, no network, no React. That is intentional —
 * it makes the scoring testable in isolation from the player.
 */

export type CueInterval = {
    start: number // seconds
    end: number   // seconds
}

/**
 * Width of the pulse each cue is reduced to, centred on its start time — effectively the
 * tolerance for calling two onsets "the same moment".
 *
 * Narrower is sharper: 0.25 s separated correct from incorrect by ~4.7x, versus ~3.2x at
 * 0.5 s. But translated lines do not start in perfect lockstep, and too tight a window
 * starts discarding genuine matches on content with looser timing. 0.5 s keeps ample
 * separation while tolerating normal onset jitter.
 */
const ONSET_PULSE_SECONDS = 0.5

/**
 * Below this many cues a reference cannot support a conclusion — a forced/signs-only
 * track, or a partial download. Real episodes carry 300-400.
 */
export const MIN_REFERENCE_CUES = 30

/** Same reasoning, applied to the candidate being judged. */
export const MIN_CANDIDATE_CUES = 30

/**
 * Acceptance thresholds. Both sit at roughly the geometric midpoint of the measured
 * correct/wrong bands (see `evaluateSyncConfidence`), which puts them about as far from
 * either band as the evidence allows — sqrt(1.42 x 4.42) = 2.5, sqrt(0.188 x 0.627) = 0.34.
 * Placing them mid-gap rather than just above the noise means a moderately unusual episode
 * has to be badly wrong, not merely unlucky, to be misjudged in either direction.
 *
 * Tune these if the feature proves too shy or too eager in practice: they are the only
 * numbers in this module that encode a preference rather than a measurement.
 */
export const MIN_PEAK_RATIO = 2.5
export const MIN_COVERAGE = 0.35

/**
 * How far from the winning lag a rival peak has to be before it counts as a genuinely
 * different alignment rather than the shoulder of the same one. The main lobe is about one
 * pulse wide; 2 s clears it with room to spare.
 */
const RIVAL_PEAK_EXCLUSION_SECONDS = 2.0

/**
 * Minimum ratio between the winning peak and the best rival peak elsewhere in the search
 * window. This is the gate that peakRatio cannot provide: peakRatio only says "a peak
 * exists", not "this is the RIGHT peak". Observed live on Youjo Senki S02E03, where the
 * measurement cleared peakRatio and coverage yet aligned to -14 s when the truth was
 * ~-2.5 s — two comparable peaks, and nothing in the metrics said so.
 */
export const MIN_LAG_MARGIN = 1.35

/**
 * Below this, the runner-up scored close enough that the two candidates are not really
 * distinguishable. Annotated on the verdict but deliberately never used to reject.
 */
export const MIN_UNAMBIGUOUS_MARGIN = 1.5

// +---------------------------------------------------------------+
// |                           Parsing                             |
// +---------------------------------------------------------------+

/**
 * Parses `H:MM:SS.cc`, `HH:MM:SS,mmm` and `MM:SS.mmm`.
 * ASS uses centiseconds, SRT milliseconds with a comma, VTT milliseconds with a dot.
 */
function parseTimestamp(raw: string): number | null {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw.trim())
    if (!m) return null
    const hours = m[1] ? parseInt(m[1], 10) : 0
    const minutes = parseInt(m[2], 10)
    const seconds = parseInt(m[3], 10)
    // "34" (centiseconds) -> "340" ms; "5" -> "500" ms
    const fraction = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) / 1000 : 0
    return hours * 3600 + minutes * 60 + seconds + fraction
}

/**
 * Extracts cue timings from an ASS/SSA script.
 *
 * The Start/End column indices are read from the `[Events]` `Format:` line rather than
 * assumed, because non-standard column orders do exist in the wild and a silently
 * mis-parsed reference would poison every candidate score.
 */
export function parseAssCues(content: string): CueInterval[] {
    const cues: CueInterval[] = []
    let inEvents = false
    let startIdx = 1
    let endIdx = 2

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()

        if (trimmed.startsWith("[")) {
            inEvents = trimmed.toLowerCase().startsWith("[events")
            continue
        }
        if (!inEvents) continue

        if (trimmed.toLowerCase().startsWith("format:")) {
            const fields = trimmed.slice("format:".length).split(",").map(f => f.trim().toLowerCase())
            const s = fields.indexOf("start")
            const e = fields.indexOf("end")
            if (s >= 0) startIdx = s
            if (e >= 0) endIdx = e
            continue
        }

        if (!trimmed.toLowerCase().startsWith("dialogue:")) continue

        // Only split up to the last format field — the Text column itself contains commas.
        const parts = trimmed.slice("dialogue:".length).split(",")
        const start = parseTimestamp(parts[startIdx] ?? "")
        const end = parseTimestamp(parts[endIdx] ?? "")
        if (start !== null && end !== null && end > start) {
            cues.push({ start, end })
        }
    }

    return cues
}

/** Extracts cue timings from SRT or WebVTT. */
export function parseSrtVttCues(content: string): CueInterval[] {
    const cues: CueInterval[] = []
    const cueLine = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/

    for (const line of content.split(/\r?\n/)) {
        const m = cueLine.exec(line)
        if (!m) continue
        const start = parseTimestamp(m[1])
        const end = parseTimestamp(m[2])
        if (start !== null && end !== null && end > start) {
            cues.push({ start, end })
        }
    }

    return cues
}

/** Sniffs the format and parses accordingly. */
export function parseCues(content: string): CueInterval[] {
    if (!content) return []
    if (/^\s*\[Script Info\]/i.test(content) || /^\s*Dialogue:/m.test(content)) {
        return parseAssCues(content)
    }
    return parseSrtVttCues(content)
}

// +---------------------------------------------------------------+
// |                        Normalization                          |
// +---------------------------------------------------------------+

/**
 * Sorts by start time and merges overlapping/touching intervals into a disjoint set.
 * The two-pointer overlap scan below requires disjoint, sorted input — without merging,
 * two overlapping intervals would double-count their shared span.
 */
export function normalizeIntervals(intervals: CueInterval[]): CueInterval[] {
    const sorted = intervals
        .filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
        .sort((a, b) => a.start - b.start)

    const merged: CueInterval[] = []
    for (const cue of sorted) {
        const last = merged[merged.length - 1]
        if (last && cue.start <= last.end) {
            if (cue.end > last.end) last.end = cue.end
        } else {
            merged.push({ ...cue })
        }
    }
    return merged
}

/**
 * Reduces each cue to a short pulse at its start time — the representation the
 * correlation actually runs on. See the module header for why onsets beat durations.
 */
export function toOnsetPulses(cues: CueInterval[], width = ONSET_PULSE_SECONDS): CueInterval[] {
    return normalizeIntervals(cues.map(c => ({ start: c.start, end: c.start + width })))
}

/** Total duration covered by a disjoint interval set. */
export function totalSeconds(intervals: CueInterval[]): number {
    let total = 0
    for (const c of intervals) total += c.end - c.start
    return total
}

// +---------------------------------------------------------------+
// |                         Correlation                           |
// +---------------------------------------------------------------+

/**
 * Total overlap between `ref` and `cand` when `cand` is shifted later by `shift` seconds.
 * Both must be sorted and disjoint (see `normalizeIntervals`). O(n+m).
 */
function overlapAt(ref: CueInterval[], cand: CueInterval[], shift: number): number {
    let total = 0
    let i = 0
    let j = 0

    while (i < ref.length && j < cand.length) {
        const refStart = ref[i].start
        const refEnd = ref[i].end
        const candStart = cand[j].start + shift
        const candEnd = cand[j].end + shift

        const lo = refStart > candStart ? refStart : candStart
        const hi = refEnd < candEnd ? refEnd : candEnd
        if (hi > lo) total += hi - lo

        // Advance whichever interval ends first.
        if (refEnd < candEnd) i++
        else j++
    }

    return total
}

export type SyncCorrelation = {
    /** Seconds to add to the candidate's timings to align it with the reference. */
    offsetSeconds: number
    /** Matched onset mass at the peak, in seconds. Absolute — only comparable against the same reference. */
    overlapSeconds: number
    /** Fraction of the smaller track's onsets that matched at the peak. Normalized 0..1. */
    coverage: number
    /** Peak divided by the mean across the whole search window. How *sharp* the peak is. */
    peakRatio: number
    /** Peak divided by the best rival peak at a different lag. Answers "is THIS lag right?" */
    lagMargin: number
    /** True when the peak sits at the edge of the search window — usually means no real peak exists. */
    atSearchEdge: boolean
    refCueCount: number
    candCueCount: number
}

export type CorrelateOptions = {
    /** Half-width of the lag search, in seconds. */
    maxOffsetSeconds?: number
    /** Lag step for the first pass. */
    coarseStepSeconds?: number
    /** Lag step for the refinement pass around the coarse winner. */
    fineStepSeconds?: number
    /** Onset pulse width — the tolerance for calling two onsets simultaneous. */
    pulseSeconds?: number
}

/**
 * Finds the shift that best aligns a candidate's cue onsets with a trusted reference's.
 *
 * Takes raw cues and reduces them to onset pulses internally, so callers never have to
 * know the representation.
 *
 * Coarse-to-fine: a sweep across the full ±maxOffset window, then a fine sweep within one
 * coarse step of the winner. The coarse step must stay below the pulse width or the sweep
 * can step straight over a genuine peak.
 */
export function correlateCues(
    refCues: CueInterval[],
    candCues: CueInterval[],
    opts: CorrelateOptions = {},
): SyncCorrelation {
    const maxOffset = opts.maxOffsetSeconds ?? 60
    const pulse = opts.pulseSeconds ?? ONSET_PULSE_SECONDS
    // Never sample coarser than the pulse itself, whatever the caller asks for.
    const coarseStep = Math.min(opts.coarseStepSeconds ?? 0.1, pulse / 2)
    const fineStep = opts.fineStepSeconds ?? 0.01

    const ref = toOnsetPulses(refCues, pulse)
    const cand = toOnsetPulses(candCues, pulse)

    const empty: SyncCorrelation = {
        offsetSeconds: 0,
        overlapSeconds: 0,
        coverage: 0,
        peakRatio: 0,
        lagMargin: 0,
        atSearchEdge: false,
        refCueCount: refCues.length,
        candCueCount: candCues.length,
    }
    if (!ref.length || !cand.length) return empty

    // Keep every coarse sample so a rival peak can be found afterwards.
    const shifts: number[] = []
    const overlaps: number[] = []
    let bestShift = 0
    let bestOverlap = -1
    let sum = 0

    for (let shift = -maxOffset; shift <= maxOffset; shift += coarseStep) {
        const overlap = overlapAt(ref, cand, shift)
        shifts.push(shift)
        overlaps.push(overlap)
        sum += overlap
        if (overlap > bestOverlap) {
            bestOverlap = overlap
            bestShift = shift
        }
    }

    // Refine around the coarse winner.
    for (let shift = bestShift - coarseStep; shift <= bestShift + coarseStep; shift += fineStep) {
        const overlap = overlapAt(ref, cand, shift)
        if (overlap > bestOverlap) {
            bestOverlap = overlap
            bestShift = shift
        }
    }

    // The strongest rival peak at a genuinely DIFFERENT lag. peakRatio compares the peak
    // to the window mean, which a spurious alignment can clear comfortably while an
    // equally good alignment sits elsewhere — the peak looks tall but says nothing about
    // WHICH lag is right. Excluding a window around the winner (well beyond the main
    // lobe, which is only ~one pulse wide) isolates that question.
    let rivalOverlap = 0
    for (let i = 0; i < shifts.length; i++) {
        if (Math.abs(shifts[i] - bestShift) < RIVAL_PEAK_EXCLUSION_SECONDS) continue
        if (overlaps[i] > rivalOverlap) rivalOverlap = overlaps[i]
    }

    const meanOverlap = shifts.length > 0 ? sum / shifts.length : 0
    const denominator = Math.min(totalSeconds(ref), totalSeconds(cand))

    return {
        // Snap to the millisecond — floating-point accumulation over thousands of
        // += steps leaves noise well below any perceptible threshold.
        offsetSeconds: Math.round(bestShift * 1000) / 1000,
        overlapSeconds: bestOverlap,
        coverage: denominator > 0 ? bestOverlap / denominator : 0,
        peakRatio: meanOverlap > 0 ? bestOverlap / meanOverlap : 0,
        lagMargin: rivalOverlap > 0 ? bestOverlap / rivalOverlap : Infinity,
        atSearchEdge: Math.abs(Math.abs(bestShift) - maxOffset) < coarseStep,
        refCueCount: refCues.length,
        candCueCount: candCues.length,
    }
}

// +---------------------------------------------------------------+
// |                     Split-point alignment                     |
// +---------------------------------------------------------------+

/**
 * A cross-sourced subtitle often needs TWO offsets, not one, because the sources disagree
 * about the opening: a longer/shorter OP, a recap the other lacks, or a trimmed cold open.
 * Everything before the seam shares one offset and everything after shares another, with a
 * step of several seconds between them.
 *
 * A single global correlation handles this badly. Both alignments are real peaks, so the
 * scan simply picks whichever segment carries more dialogue — normally the post-OP body —
 * and the cold open is then wrong by the size of the step. Observed on Youjo Senki S02E03:
 * -5s before the OP, -15s after it, and the global fit chose -14.8s.
 */
export type SplitAlignment = {
    /** Seam position, in the candidate's own (unshifted) timeline. */
    atSeconds: number
    offsetBefore: number
    offsetAfter: number
    /** Combined overlap of the two segments, each at its own offset. */
    overlapSeconds: number
    /** Combined overlap divided by the best single-offset overlap. Size-dominated; informational. */
    improvement: number
    /**
     * How much better the worse-served segment does at its OWN offset than at the global
     * one. This, not `improvement`, is the gate: an OP seam leaves only ~10% of cues before
     * it, so fixing them barely moves the total, but it transforms *that segment*.
     */
    segmentGain: number
    /**
     * The weaker of the two segments' own lag margins. A dozen-odd cues can align
     * convincingly to noise; this is what separates a real seam from that.
     */
    segmentLagMargin: number
    cuesBefore: number
    cuesAfter: number
}

/** Below this the two halves agree and a seam would be meaningless noise. */
export const MIN_SPLIT_DELTA_SECONDS = 1.5
/**
 * A segment must align this much better at its own offset than at the global one before a
 * seam is believed. Scale-free, so it works for a small pre-OP segment as well as an even
 * split — unlike a total-overlap ratio, which a 10%-of-cues segment can never move.
 */
export const MIN_SPLIT_SEGMENT_GAIN = 1.5

/** Each segment must also pick its own lag decisively, not merely win by a nose. */
export const MIN_SPLIT_SEGMENT_LAG_MARGIN = 1.3
/**
 * Neither side may be a scrap; too few cues and its "best offset" is meaningless. Kept low
 * because the pre-OP side is genuinely small — a cold open is often only a dozen or two
 * lines — and the delta and improvement gates already reject noise.
 */
export const MIN_SPLIT_SEGMENT_CUES = 12

/**
 * Best overlap and lag for one set of pulses against the reference, plus how decisively
 * that lag beat any rival lag. A segment can be small — a cold open is a dozen-odd lines —
 * and a handful of pulses will happily align to noise somewhere in a ±60 s window, so the
 * caller needs to know whether the winning lag actually stood out.
 */
function bestLagFor(
    ref: CueInterval[],
    pulses: CueInterval[],
    maxOffset: number,
    coarseStep: number,
    fineStep: number,
): { shift: number, overlap: number, lagMargin: number } {
    const shifts: number[] = []
    const overlaps: number[] = []
    let bestShift = 0
    let bestOverlap = -1

    for (let shift = -maxOffset; shift <= maxOffset; shift += coarseStep) {
        const overlap = overlapAt(ref, pulses, shift)
        shifts.push(shift)
        overlaps.push(overlap)
        if (overlap > bestOverlap) {
            bestOverlap = overlap
            bestShift = shift
        }
    }
    for (let shift = bestShift - coarseStep; shift <= bestShift + coarseStep; shift += fineStep) {
        const overlap = overlapAt(ref, pulses, shift)
        if (overlap > bestOverlap) {
            bestOverlap = overlap
            bestShift = shift
        }
    }

    let rival = 0
    for (let i = 0; i < shifts.length; i++) {
        if (Math.abs(shifts[i] - bestShift) < RIVAL_PEAK_EXCLUSION_SECONDS) continue
        if (overlaps[i] > rival) rival = overlaps[i]
    }

    return {
        shift: Math.round(bestShift * 1000) / 1000,
        overlap: bestOverlap,
        lagMargin: rival > 0 ? bestOverlap / rival : Infinity,
    }
}

/**
 * Looks for a single seam that explains the candidate better than one global offset.
 *
 * Seams are tried at cue-count quantiles rather than fixed times, which keeps both
 * segments large enough to align meaningfully regardless of where the dialogue sits.
 * Only run this on the winning candidate — it costs roughly one full scan per seam tried.
 */
export function findSplitAlignment(
    refCues: CueInterval[],
    candCues: CueInterval[],
    globalOverlapSeconds: number,
    globalOffsetSeconds: number,
    opts: CorrelateOptions = {},
): SplitAlignment | null {
    const maxOffset = opts.maxOffsetSeconds ?? 60
    const pulse = opts.pulseSeconds ?? ONSET_PULSE_SECONDS
    const coarseStep = Math.min(opts.coarseStepSeconds ?? 0.1, pulse / 2)
    const fineStep = opts.fineStepSeconds ?? 0.01

    const ref = toOnsetPulses(refCues, pulse)
    const sorted = [...candCues].filter(c => c.end > c.start).sort((a, b) => a.start - b.start)
    if (!ref.length || sorted.length < MIN_SPLIT_SEGMENT_CUES * 2) return null

    // Pure scorer — returns a candidate rather than mutating outer state, so the winner can
    // be tracked with plain assignments that TypeScript's narrowing can actually follow.
    const scoreAt = (idx: number): SplitAlignment | null => {
        if (idx < MIN_SPLIT_SEGMENT_CUES || sorted.length - idx < MIN_SPLIT_SEGMENT_CUES) return null

        const beforePulses = toOnsetPulses(sorted.slice(0, idx), pulse)
        const afterPulses = toOnsetPulses(sorted.slice(idx), pulse)

        const a = bestLagFor(ref, beforePulses, maxOffset, coarseStep, fineStep)
        const b = bestLagFor(ref, afterPulses, maxOffset, coarseStep, fineStep)
        const combined = a.overlap + b.overlap

        // What each segment achieves under the single global offset, for comparison.
        const beforeAtGlobal = overlapAt(ref, beforePulses, globalOffsetSeconds)
        const afterAtGlobal = overlapAt(ref, afterPulses, globalOffsetSeconds)
        const gainBefore = beforeAtGlobal > 0 ? a.overlap / beforeAtGlobal : (a.overlap > 0 ? Infinity : 1)
        const gainAfter = afterAtGlobal > 0 ? b.overlap / afterAtGlobal : (b.overlap > 0 ? Infinity : 1)

        return {
            atSeconds: sorted[idx].start,
            offsetBefore: a.shift,
            offsetAfter: b.shift,
            overlapSeconds: combined,
            improvement: globalOverlapSeconds > 0 ? combined / globalOverlapSeconds : 0,
            segmentGain: Math.max(gainBefore, gainAfter),
            segmentLagMargin: Math.min(a.lagMargin, b.lagMargin),
            cuesBefore: idx,
            cuesAfter: sorted.length - idx,
        }
    }

    let best: SplitAlignment | null = null
    let bestIdx = -1

    // Coarse sweep by cue-count quantile. It starts very low on purpose: an OP seam sits
    // early in TIME but after only a handful of cues, because a cold open is short and the
    // OP itself carries no dialogue. Starting at 10% of cues would step straight over it.
    const QUANTILE_STEP = 0.03
    for (let q = QUANTILE_STEP; q <= 0.9001; q += QUANTILE_STEP) {
        const idx = Math.floor(sorted.length * q)
        const cand = scoreAt(idx)
        if (cand && (best === null || cand.overlapSeconds > best.overlapSeconds)) {
            best = cand
            bestIdx = idx
        }
    }
    if (best === null) return null

    // Refine to the exact cue: a seam placed a few cues early leaves those cues shifted by
    // the wrong offset, which is precisely the artefact this feature exists to remove.
    const span = Math.ceil(sorted.length * QUANTILE_STEP)
    for (let idx = bestIdx - span; idx <= bestIdx + span; idx++) {
        if (idx === bestIdx) continue
        const cand = scoreAt(idx)
        if (cand && cand.overlapSeconds > best.overlapSeconds) {
            best = cand
            bestIdx = idx
        }
    }

    if (Math.abs(best.offsetBefore - best.offsetAfter) < MIN_SPLIT_DELTA_SECONDS) return null
    if (best.segmentGain < MIN_SPLIT_SEGMENT_GAIN) return null
    if (best.segmentLagMargin < MIN_SPLIT_SEGMENT_LAG_MARGIN) return null
    return best
}

/** Formats seconds as an ASS timestamp (`H:MM:SS.cc`). Negatives clamp to zero. */
function formatAssTimestamp(seconds: number): string {
    const t = Math.max(0, seconds)
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    const s = Math.floor(t % 60)
    const cs = Math.round((t - Math.floor(t)) * 100)
    // Rounding can carry into the next second.
    const carry = cs === 100
    const cs2 = carry ? 0 : cs
    const s2 = carry ? s + 1 : s
    return `${h}:${String(m).padStart(2, "0")}:${String(s2 % 60).padStart(2, "0")}.${String(cs2).padStart(2, "0")}`
}

/**
 * Shifts every ASS cue starting before `seamSeconds` by `deltaSeconds`, leaving the rest
 * untouched — the piecewise correction a seam calls for.
 *
 * The renderer only offers a single global time offset, so the second offset has to be
 * baked into the content. Expressing it as a delta relative to the post-seam offset means
 * the global offset stays the number the user sees and can still nudge by hand.
 */
export function shiftAssCuesBefore(content: string, seamSeconds: number, deltaSeconds: number): string {
    if (!content || !deltaSeconds) return content

    let inEvents = false
    let startIdx = 1
    let endIdx = 2

    return content.split(/\r?\n/).map(line => {
        const trimmed = line.trim()

        if (trimmed.startsWith("[")) {
            inEvents = trimmed.toLowerCase().startsWith("[events")
            return line
        }
        if (!inEvents) return line

        if (trimmed.toLowerCase().startsWith("format:")) {
            const fields = trimmed.slice("format:".length).split(",").map(f => f.trim().toLowerCase())
            const s = fields.indexOf("start")
            const e = fields.indexOf("end")
            if (s >= 0) startIdx = s
            if (e >= 0) endIdx = e
            return line
        }

        const lower = trimmed.toLowerCase()
        if (!lower.startsWith("dialogue:") && !lower.startsWith("comment:")) return line

        const prefixEnd = line.indexOf(":") + 1
        const prefix = line.slice(0, prefixEnd)
        const parts = line.slice(prefixEnd).split(",")
        const start = parseTimestamp(parts[startIdx] ?? "")
        const end = parseTimestamp(parts[endIdx] ?? "")
        if (start === null || end === null) return line
        if (start >= seamSeconds) return line

        parts[startIdx] = formatAssTimestamp(start + deltaSeconds)
        parts[endIdx] = formatAssTimestamp(end + deltaSeconds)
        return prefix + parts.join(",")
    }).join("\n")
}

// +---------------------------------------------------------------+
// |                    Selection & acceptance                     |
// +---------------------------------------------------------------+

export type SyncCandidate = {
    trackNumber: number
    label: string
    cues: CueInterval[]
}

export type ScoredCandidate = {
    trackNumber: number
    label: string
    correlation: SyncCorrelation
}

export type SyncVerdict = {
    accept: boolean
    /** Short human-readable justification — surfaced in the player log and the OSD. */
    reason: string
}

export type SyncSelection = {
    best: ScoredCandidate
    runnerUp: ScoredCandidate | null
    /** best.overlapSeconds / runnerUp.overlapSeconds, or Infinity when there is no runner-up. */
    margin: number
    verdict: SyncVerdict
    /** Every candidate, best first — for logging/diagnostics. */
    ranked: ScoredCandidate[]
}

/**
 * Decides whether a measured alignment is trustworthy enough to apply automatically.
 *
 * This is the gap the server-side implementation has: `select_synced_subtitle()` is a pure
 * argmax with no threshold, so when every candidate is the wrong episode it confidently
 * returns the least-wrong one and says nothing. Both fixture sets that exercise that case
 * here — JP ep05, which matches no reference at all, and the three Solo Leveling candidates
 * that are ep13's subtitle served for ep1 — are rejected by the gates below.
 *
 * Rejecting is cheap: track selection and the stored/inherited offset are left untouched,
 * exactly as if the feature did not exist. So the only question is "is this better than
 * doing nothing?", and the bar is set to answer that conservatively — a missed sync costs
 * a manual adjustment, a wrong one silently desyncs the episode while looking deliberate.
 *
 * Measured on the fixtures in `condense-service/tests/test_data/` and `_debug/`:
 *
 *                    correct match      wrong file       threshold
 *   peakRatio        4.42 - 4.84        1.29 - 1.42      >= 2.5
 *   coverage         0.627 - 0.669      0.170 - 0.188    >= 0.35
 *   margin           x3.42 - 3.73       x1.02 - 1.08     (not gated — see below)
 */
export function evaluateSyncConfidence(selection: {
    best: ScoredCandidate
    runnerUp: ScoredCandidate | null
    margin: number
}): SyncVerdict {
    const c = selection.best.correlation

    // A peak jammed against the edge of the search window means the sweep never found a
    // real maximum — it just ran out of room. Nothing else about the result is meaningful.
    if (c.atSearchEdge) {
        return { accept: false, reason: `no peak within the search window (${c.offsetSeconds.toFixed(1)}s)` }
    }

    // A handful of cues is a signs/forced track or a truncated download, not dialogue.
    // Both metrics below are ratios and stay happily undefined-ish on tiny inputs.
    if (c.candCueCount < MIN_CANDIDATE_CUES) {
        return { accept: false, reason: `too few cues to judge (${c.candCueCount})` }
    }

    // The two gates are deliberately ANDed. peakRatio asks "is there a spike?" and
    // coverage asks "did most of the track actually land on it?" — a genuine match
    // clears both by a wide margin, and requiring both costs nothing on real matches
    // while closing the door on a metric being fooled in isolation.
    if (c.peakRatio < MIN_PEAK_RATIO) {
        return { accept: false, reason: `correlation too flat (peak/mean ${c.peakRatio.toFixed(2)})` }
    }
    if (c.coverage < MIN_COVERAGE) {
        return { accept: false, reason: `too few onsets matched (${(c.coverage * 100).toFixed(0)}%)` }
    }
    // A tall peak is not the same as the RIGHT peak. If some other lag scores nearly as
    // well, the measurement cannot say which is correct, and applying either is a coin
    // flip dressed up as a result.
    if (c.lagMargin < MIN_LAG_MARGIN) {
        return {
            accept: false,
            reason: `alignment ambiguous — a rival lag scores almost as well (${c.lagMargin.toFixed(2)}x)`,
        }
    }

    // Note what margin is NOT used for: rejection. A margin near 1.0 legitimately means
    // "two candidates are equally good" — most often the same file listed twice under
    // different Jimaku names, where either choice is correct. Gating on it would reject
    // that perfectly good case. A wrong-file set is already caught above, because it
    // fails peakRatio and coverage regardless of how its candidates rank against each
    // other. So margin only ever annotates the verdict.
    const ambiguous = selection.runnerUp !== null && selection.margin < MIN_UNAMBIGUOUS_MARGIN

    return {
        accept: true,
        reason: ambiguous
            ? `matched (peak/mean ${c.peakRatio.toFixed(1)}, ${(c.coverage * 100).toFixed(0)}% onsets; runner-up close)`
            : `matched (peak/mean ${c.peakRatio.toFixed(1)}, ${(c.coverage * 100).toFixed(0)}% onsets)`,
    }
}

/**
 * Scores every candidate against the reference and ranks them.
 *
 * Returns `null` only when there is nothing to decide (no candidates, or a reference too
 * sparse to measure against). Otherwise it always returns a ranked result — whether that
 * result should actually be *used* is `verdict`'s call, never this function's.
 */
export function selectAndAlign(
    reference: CueInterval[],
    candidates: SyncCandidate[],
    opts: CorrelateOptions = {},
    /** Track currently on screen; kept in a tie rather than switching arbitrarily. */
    preferTrackNumber?: number | null,
): SyncSelection | null {
    if (!candidates.length) return null
    if (reference.length < MIN_REFERENCE_CUES) return null

    const ranked: ScoredCandidate[] = candidates
        .map(c => ({
            trackNumber: c.trackNumber,
            label: c.label,
            correlation: correlateCues(reference, c.cues, opts),
        }))
        .sort((a, b) => b.correlation.overlapSeconds - a.correlation.overlapSeconds)

    let best = ranked[0]
    const runnerUp = ranked[1] ?? null
    const margin = runnerUp && runnerUp.correlation.overlapSeconds > 0
        ? best.correlation.overlapSeconds / runnerUp.correlation.overlapSeconds
        : Infinity

    // When the top candidates are effectively tied, "best" is arbitrary — commonly the same
    // release offered as both .srt and .ass. Switching the user's track on that basis
    // changes what they see for no measured benefit, so prefer the track already selected
    // and report ITS offset (which is what will actually be rendered).
    if (preferTrackNumber != null && margin < MIN_UNAMBIGUOUS_MARGIN) {
        const incumbent = ranked.find(r => r.trackNumber === preferTrackNumber)
        if (incumbent) best = incumbent
    }

    return {
        best,
        runnerUp,
        margin,
        verdict: evaluateSyncConfidence({ best, runnerUp, margin }),
        ranked,
    }
}
