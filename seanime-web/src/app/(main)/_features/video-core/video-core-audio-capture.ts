/**
 * Audio capture utility for extracting audio clips from video elements
 * Used for Anki mining feature
 */

import { logger } from "@/lib/helpers/debug"

const log = logger("VIDEO CORE AUDIO CAPTURE")

// Store audio context and source node globally to reuse across captures
// This is necessary because MediaElementAudioSourceNode can only be created once per video element
// and we must keep it connected to the audio destination for the video to play sound
let globalAudioContext: AudioContext | null = null
let globalAudioSource: MediaElementAudioSourceNode | null = null
let connectedVideoElement: HTMLVideoElement | null = null

/**
 * Get or create the audio context and source node for a video element
 * Once created, the source is kept connected to speakers permanently
 */
function getOrCreateAudioSource(videoElement: HTMLVideoElement): {
    audioContext: AudioContext
    source: MediaElementAudioSourceNode
} | null {
    // If we have an existing setup for a different video element, clean it up
    if (connectedVideoElement && connectedVideoElement !== videoElement) {
        log.info("Video element changed, cleaning up old audio context")
        if (globalAudioSource) {
            try { globalAudioSource.disconnect() } catch (e) {}
        }
        if (globalAudioContext) {
            try { globalAudioContext.close() } catch (e) {}
        }
        globalAudioContext = null
        globalAudioSource = null
        connectedVideoElement = null
    }

    // Return existing if already set up for this video element
    if (globalAudioContext && globalAudioSource && connectedVideoElement === videoElement) {
        log.info("Reusing existing audio context and source")
        return { audioContext: globalAudioContext, source: globalAudioSource }
    }

    // Create new audio context and source
    try {
        globalAudioContext = new AudioContext()
        globalAudioSource = globalAudioContext.createMediaElementSource(videoElement)
        // Connect to speakers - this connection is PERMANENT
        globalAudioSource.connect(globalAudioContext.destination)
        connectedVideoElement = videoElement
        log.info("Created new audio context and source, connected to speakers")
        return { audioContext: globalAudioContext, source: globalAudioSource }
    } catch (e) {
        log.warning("Failed to create MediaElementAudioSourceNode", e)
        return null
    }
}

export interface AudioCaptureOptions {
    startTime: number
    duration: number
    paddingBefore?: number // seconds before start
    paddingAfter?: number // seconds after end
}

export interface AudioCaptureResult {
    blob: Blob
    base64: string
    mimeType: string
}

/**
 * Captures audio from a video element by seeking and recording
 * Note: This will briefly play the video during capture
 */
export async function captureAudioFromVideo(
    videoElement: HTMLVideoElement,
    options: AudioCaptureOptions,
): Promise<AudioCaptureResult> {
    const {
        startTime,
        duration,
        paddingBefore = 0,
        paddingAfter = 0,
    } = options

    const effectiveStart = Math.max(0, startTime - paddingBefore)
    const effectiveDuration = duration + paddingBefore + paddingAfter

    log.info("Capturing audio", { effectiveStart, effectiveDuration })

    // Store original state
    const wasPaused = videoElement.paused
    const originalTime = videoElement.currentTime
    const originalMuted = videoElement.muted
    const originalVolume = videoElement.volume

    try {
        // Create audio context and connect to video
        const audioContext = new AudioContext()

        // Try to create MediaElementSource, but handle if already created
        let source: MediaElementAudioSourceNode
        try {
            source = audioContext.createMediaElementSource(videoElement)
        } catch (e) {
            // If the source is already created, we need to use a different approach
            log.warning("Could not create MediaElementSource, using alternative method")
            return await captureAudioAlternative(videoElement, options)
        }

        const destination = audioContext.createMediaStreamDestination()

        // Connect source to both destination (for recording) and context output (for playback)
        source.connect(destination)
        source.connect(audioContext.destination)

        // Unmute video for capture
        videoElement.muted = false
        videoElement.volume = 1

        // Seek to start position
        videoElement.currentTime = effectiveStart

        // Wait for seek to complete
        await new Promise<void>((resolve) => {
            const onSeeked = () => {
                videoElement.removeEventListener("seeked", onSeeked)
                resolve()
            }
            videoElement.addEventListener("seeked", onSeeked)
        })

        // Set up MediaRecorder
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm"

        const recorder = new MediaRecorder(destination.stream, { mimeType })
        const chunks: Blob[] = []

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data)
            }
        }

        // Start recording and play
        const recordingPromise = new Promise<Blob>((resolve, reject) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType })
                resolve(blob)
            }
            recorder.onerror = (e) => {
                reject(new Error("Recording failed"))
            }
        })

        recorder.start()
        await videoElement.play()

        // Wait for duration
        await new Promise((resolve) => setTimeout(resolve, effectiveDuration * 1000))

        // Stop recording
        recorder.stop()
        videoElement.pause()

        const blob = await recordingPromise

        // Disconnect and close audio context
        source.disconnect()
        await audioContext.close()

        // Convert to base64
        const base64 = await blobToBase64(blob)

        return {
            blob,
            base64,
            mimeType,
        }
    } finally {
        // Restore original state
        videoElement.currentTime = originalTime
        videoElement.muted = originalMuted
        videoElement.volume = originalVolume
        if (wasPaused) {
            videoElement.pause()
        }
    }
}

/**
 * Alternative audio capture method using canvas/ffmpeg
 * This is a fallback when MediaElementSource is already connected
 */
async function captureAudioAlternative(
    videoElement: HTMLVideoElement,
    options: AudioCaptureOptions,
): Promise<AudioCaptureResult> {
    const {
        startTime,
        duration,
        paddingBefore = 0,
        paddingAfter = 0,
    } = options

    const effectiveStart = Math.max(0, startTime - paddingBefore)
    const effectiveDuration = duration + paddingBefore + paddingAfter

    // Store original state
    const wasPaused = videoElement.paused
    const originalTime = videoElement.currentTime
    const originalMuted = videoElement.muted

    try {
        // Use captureStream on video element
        const stream = (videoElement as any).captureStream?.() as MediaStream | undefined
        if (!stream) {
            throw new Error("captureStream not supported on this browser")
        }

        // Get only audio tracks
        const audioTracks = stream.getAudioTracks()
        if (audioTracks.length === 0) {
            throw new Error("No audio tracks available in video")
        }

        const audioStream = new MediaStream(audioTracks)

        // Seek to start position
        videoElement.currentTime = effectiveStart
        videoElement.muted = false

        // Wait for seek
        await new Promise<void>((resolve) => {
            const onSeeked = () => {
                videoElement.removeEventListener("seeked", onSeeked)
                resolve()
            }
            videoElement.addEventListener("seeked", onSeeked)
        })

        // Set up recorder
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm"

        const recorder = new MediaRecorder(audioStream, { mimeType })
        const chunks: Blob[] = []

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data)
            }
        }

        const recordingPromise = new Promise<Blob>((resolve, reject) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType })
                resolve(blob)
            }
            recorder.onerror = () => {
                reject(new Error("Recording failed"))
            }
        })

        recorder.start()
        await videoElement.play()

        await new Promise((resolve) => setTimeout(resolve, effectiveDuration * 1000))

        recorder.stop()
        videoElement.pause()

        const blob = await recordingPromise
        const base64 = await blobToBase64(blob)

        return {
            blob,
            base64,
            mimeType,
        }
    } finally {
        videoElement.currentTime = originalTime
        videoElement.muted = originalMuted
        if (wasPaused) {
            videoElement.pause()
        }
    }
}

/**
 * Convert Blob to base64 string (without data URL prefix)
 */
export async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => {
            const dataUrl = reader.result as string
            // Remove the data URL prefix (e.g., "data:audio/webm;base64,")
            const base64 = dataUrl.split(",")[1]
            resolve(base64)
        }
        reader.onerror = reject
        reader.readAsDataURL(blob)
    })
}

/**
 * Convert image Blob to base64 string (without data URL prefix)
 */
export async function imageBlobToBase64(blob: Blob): Promise<string> {
    return blobToBase64(blob)
}

/**
 * Captures audio from current video position without seeking
 * Uses MediaElementAudioSourceNode for HLS compatibility, falls back to captureStream
 * @param videoElement - The video element to capture from
 * @param duration - Duration in seconds to capture
 */
export async function captureAudioFromCurrentPosition(
    videoElement: HTMLVideoElement,
    duration: number = 3,
): Promise<AudioCaptureResult> {
    log.info("Capturing audio from current position", { duration, currentTime: videoElement.currentTime })

    // Store original state
    const wasPaused = videoElement.paused
    const originalMuted = videoElement.muted
    const originalVolume = videoElement.volume

    // For recording, we'll create a temporary destination
    let recordingDestination: MediaStreamAudioDestinationNode | null = null

    try {
        // Get or create the persistent audio source
        const audioSetup = getOrCreateAudioSource(videoElement)
        let stream: MediaStream

        if (audioSetup) {
            // Create a recording destination and connect source to it (in addition to speakers)
            recordingDestination = audioSetup.audioContext.createMediaStreamDestination()
            audioSetup.source.connect(recordingDestination)
            stream = recordingDestination.stream
            log.info("Using MediaElementAudioSourceNode for capture (reusing context)")
        } else {
            // Fall back to captureStream
            log.warning("No audio source available, falling back to captureStream")
            const capturedStream = (videoElement as any).captureStream?.() as MediaStream | undefined
            if (!capturedStream) {
                throw new Error("No audio capture method available")
            }

            const audioTracks = capturedStream.getAudioTracks()
            if (audioTracks.length === 0) {
                throw new Error("No audio tracks available in video")
            }

            stream = new MediaStream(audioTracks)
        }

        // Ensure video is playing and not muted
        videoElement.muted = false
        videoElement.volume = 1
        if (wasPaused) {
            await videoElement.play()
        }

        // Set up recorder
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm"

        const recorder = new MediaRecorder(stream, { mimeType })
        const chunks: Blob[] = []

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data)
            }
        }

        const recordingPromise = new Promise<Blob>((resolve, reject) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType })
                resolve(blob)
            }
            recorder.onerror = () => {
                reject(new Error("Recording failed"))
            }
        })

        recorder.start()

        // Wait for duration
        await new Promise((resolve) => setTimeout(resolve, duration * 1000))

        // Stop recording
        recorder.stop()

        const blob = await recordingPromise
        const base64 = await blobToBase64(blob)

        log.info("Audio captured successfully", { size: blob.size, duration })

        return {
            blob,
            base64,
            mimeType,
        }
    } finally {
        // Only disconnect the recording destination, NOT the main audio path
        if (recordingDestination && globalAudioSource) {
            try {
                globalAudioSource.disconnect(recordingDestination)
            } catch (e) {
                // Ignore - may already be disconnected
            }
        }

        // Restore original state
        videoElement.muted = originalMuted
        videoElement.volume = originalVolume
        // Don't pause - let the video continue playing
    }
}

/**
 * Captures audio for a subtitle's full duration by seeking to start and recording
 * Uses MediaElementAudioSourceNode for HLS compatibility, falls back to captureStream
 * @param videoElement - The video element to capture from
 * @param startTime - Start time in seconds (subtitle start)
 * @param endTime - End time in seconds (subtitle end)
 * @param padding - Extra padding in seconds to add before/after
 */
export async function captureAudioForSubtitle(
    videoElement: HTMLVideoElement,
    startTime: number,
    endTime: number,
    padding: number = 0.25,
): Promise<AudioCaptureResult> {
    const effectiveStart = Math.max(0, startTime - padding)
    const effectiveEnd = endTime + padding
    const duration = effectiveEnd - effectiveStart

    log.info("Capturing audio for subtitle", {
        startTime,
        endTime,
        effectiveStart,
        effectiveEnd,
        duration,
        currentTime: videoElement.currentTime,
    })

    // Store original state - including play state
    const wasPaused = videoElement.paused
    const originalTime = videoElement.currentTime
    const originalMuted = videoElement.muted
    const originalVolume = videoElement.volume

    // For recording, we'll create a temporary destination
    let recordingDestination: MediaStreamAudioDestinationNode | null = null

    try {
        // Get or create the persistent audio source
        const audioSetup = getOrCreateAudioSource(videoElement)
        let stream: MediaStream

        if (audioSetup) {
            // Create a recording destination and connect source to it (in addition to speakers)
            recordingDestination = audioSetup.audioContext.createMediaStreamDestination()
            audioSetup.source.connect(recordingDestination)
            stream = recordingDestination.stream
            log.info("Using MediaElementAudioSourceNode for capture (reusing context)")
        } else {
            // Fall back to captureStream
            log.warning("No audio source available, falling back to captureStream")
            const capturedStream = (videoElement as any).captureStream?.() as MediaStream | undefined
            if (!capturedStream) {
                throw new Error("No audio capture method available")
            }

            const audioTracks = capturedStream.getAudioTracks()
            if (audioTracks.length === 0) {
                throw new Error("No audio tracks available in video")
            }

            stream = new MediaStream(audioTracks)
        }

        // Seek to start position
        videoElement.currentTime = effectiveStart

        // Wait for seek to complete and buffer to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                videoElement.removeEventListener("seeked", onSeeked)
                videoElement.removeEventListener("canplay", onCanPlay)
                reject(new Error("Seek timeout"))
            }, 5000)

            const onSeeked = () => {
                videoElement.removeEventListener("seeked", onSeeked)
                // Wait a bit more for buffer
                setTimeout(() => {
                    clearTimeout(timeout)
                    videoElement.removeEventListener("canplay", onCanPlay)
                    resolve()
                }, 100)
            }

            const onCanPlay = () => {
                // Already ready
            }

            videoElement.addEventListener("seeked", onSeeked)
            videoElement.addEventListener("canplay", onCanPlay)
        })

        log.info("Seeked to start, beginning recording")

        // Unmute for recording
        videoElement.muted = false
        videoElement.volume = 1

        // Set up recorder
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm"

        const recorder = new MediaRecorder(stream, { mimeType })
        const chunks: Blob[] = []

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                chunks.push(e.data)
            }
        }

        const recordingPromise = new Promise<Blob>((resolve, reject) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: mimeType })
                resolve(blob)
            }
            recorder.onerror = () => {
                reject(new Error("Recording failed"))
            }
        })

        // Start recording and play
        recorder.start()
        await videoElement.play()

        // Wait for the subtitle duration
        await new Promise((resolve) => setTimeout(resolve, duration * 1000))

        // Stop recording
        recorder.stop()

        const blob = await recordingPromise
        const base64 = await blobToBase64(blob)

        log.info("Subtitle audio captured successfully", { size: blob.size, duration })

        return {
            blob,
            base64,
            mimeType,
        }
    } finally {
        // Only disconnect the recording destination, NOT the main audio path
        if (recordingDestination && globalAudioSource) {
            try {
                globalAudioSource.disconnect(recordingDestination)
            } catch (e) {
                // Ignore - may already be disconnected
            }
        }

        // Restore original state
        videoElement.currentTime = originalTime
        videoElement.muted = originalMuted
        videoElement.volume = originalVolume

        // Restore play state - if video was playing before, resume playback
        if (!wasPaused) {
            videoElement.play().catch(() => {})
        }
    }
}
