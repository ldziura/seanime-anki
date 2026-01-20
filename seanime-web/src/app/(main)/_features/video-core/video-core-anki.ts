/**
 * Anki mining functionality for video-core
 * Allows creating Anki flashcards with screenshot, audio, and subtitle text
 */

import { AnkiMedia, ankiConnect, NoteInfo } from "@/lib/anki-connect"
import { logger } from "@/lib/helpers/debug"
import { useAtomValue } from "jotai"
import { useSetAtom } from "jotai/react"
import React from "react"
import { vc_subtitleManager, vc_videoElement } from "./video-core"
import { captureAudioForSubtitle, captureAudioFromCurrentPosition, imageBlobToBase64 } from "./video-core-audio-capture"
import { parseSubtitles, SubtitleCue } from "./video-core-html-subtitles"
import { vc_showOverlayFeedback } from "./video-core-overlay-display"
import { vc_ankiSettingsAtom, vc_settings } from "./video-core.atoms"

const log = logger("VIDEO CORE ANKI")

export interface CurrentSubtitle {
    text: string
    startTime: number
    endTime: number
}

/**
 * Get current subtitle from the video element's text tracks
 */
function getCurrentSubtitleFromTextTracks(videoElement: HTMLVideoElement): CurrentSubtitle | null {
    if (!videoElement.textTracks) return null

    for (let i = 0; i < videoElement.textTracks.length; i++) {
        const track = videoElement.textTracks[i]
        if (track.mode === "showing" && track.activeCues && track.activeCues.length > 0) {
            const cue = track.activeCues[0] as VTTCue
            if (cue) {
                return {
                    text: (cue as any).text || "",
                    startTime: cue.startTime,
                    endTime: cue.endTime,
                }
            }
        }
    }

    return null
}

/**
 * Get current subtitle by searching the DOM for subtitle text
 */
function getCurrentSubtitleFromDOM(): CurrentSubtitle | null {
    // Try to find subtitle text from various sources
    // 1. HTML subtitle overlay
    const htmlSubtitle = document.querySelector("#video-core-captions-wrapper .video-core-caption-text")
    if (htmlSubtitle?.textContent) {
        return {
            text: htmlSubtitle.textContent,
            startTime: 0,
            endTime: 0,
        }
    }

    // 2. JASSUB canvas overlay (text not directly accessible, but check for activity)
    const jassubCanvas = document.querySelector(".JASSUB canvas")
    if (jassubCanvas) {
        // Can't get text from canvas, but we know subtitles are active
        return null
    }

    return null
}

/**
 * Get all subtitle cues from the subtitle manager's current file track
 */
function getSubtitleCuesFromManager(subtitleManager: any): SubtitleCue[] | null {
    if (!subtitleManager) return null

    const selectedTrack = subtitleManager.getSelectedTrackNumberOrNull()
    if (selectedTrack === null) return null

    // Get file track content
    const fileTrack = subtitleManager.getFileTrack(selectedTrack)
    if (!fileTrack?.content) return null

    return parseSubtitles(fileTrack.content)
}

/**
 * Extract the word/expression from an Anki note's fields
 * Tries common field names used by Yomitan and similar tools
 */
function extractWordFromNote(noteInfo: NoteInfo): string | null {
    const fieldPriority = [
        "Word",
        "Expression",
        "Vocabulary",
        "Target",
        "Front",
        "Japanese",
        "Reading",
        "Term",
    ]

    for (const fieldName of fieldPriority) {
        const field = noteInfo.fields[fieldName]
        if (field?.value) {
            // Clean up the value - remove HTML tags and furigana readings
            let value = field.value
                .replace(/<[^>]*>/g, "") // Remove HTML tags
                .replace(/\[[^\]]*\]/g, "") // Remove furigana brackets
                .trim()
            if (value) {
                return value
            }
        }
    }

    return null
}

interface SubtitleMatchResult {
    cue: SubtitleCue
    matchType: "exact" | "time-based" | "closest"
}

/**
 * Find the best subtitle match for a given search text and current time
 * Strategy:
 * 1. If searchText provided, find cues containing the text (closest to currentTime if multiple)
 * 2. If no text match, find cue at currentTime
 * 3. If no current cue, find closest cue within 10 seconds
 */
function findBestSubtitleMatch(
    cues: SubtitleCue[],
    searchText: string | null,
    currentTime: number,
): SubtitleMatchResult | null {
    if (!cues || cues.length === 0) return null

    // Strategy 1: Text-based matching
    if (searchText) {
        const textMatches = cues.filter(cue => cue.text.includes(searchText))
        if (textMatches.length > 0) {
            // If multiple matches, pick the one closest to current time
            const closest = textMatches.reduce((best, cue) => {
                const bestMidpoint = (best.start + best.end) / 2
                const cueMidpoint = (cue.start + cue.end) / 2
                const bestDist = Math.abs(bestMidpoint - currentTime)
                const cueDist = Math.abs(cueMidpoint - currentTime)
                return cueDist < bestDist ? cue : best
            })
            return { cue: closest, matchType: "exact" }
        }
    }

    // Strategy 2: Find cue at current time
    const currentCue = cues.find(cue =>
        currentTime >= cue.start && currentTime <= cue.end
    )
    if (currentCue) {
        return { cue: currentCue, matchType: "time-based" }
    }

    // Strategy 3: Find closest cue within 10 seconds
    const MAX_DISTANCE = 10 // seconds
    let closestCue: SubtitleCue | null = null
    let closestDist = Infinity

    for (const cue of cues) {
        // Use closest edge of the cue
        const distToStart = Math.abs(cue.start - currentTime)
        const distToEnd = Math.abs(cue.end - currentTime)
        const dist = Math.min(distToStart, distToEnd)

        if (dist < closestDist && dist <= MAX_DISTANCE) {
            closestDist = dist
            closestCue = cue
        }
    }

    if (closestCue) {
        return { cue: closestCue, matchType: "closest" }
    }

    return null
}

/**
 * Capture screenshot with subtitles from video element
 * Always captures from video element directly (not WebGL canvas) for reliability
 */
async function captureScreenshot(
    videoElement: HTMLVideoElement,
    subtitleManager: any,
): Promise<{ blob: Blob; base64: string } | null> {
    try {
        log.info("Starting screenshot capture", {
            videoWidth: videoElement.videoWidth,
            videoHeight: videoElement.videoHeight,
            hasLibass: !!subtitleManager?.libassRenderer,
        })

        // Always capture from video element directly for reliability
        // (WebGL canvases like Anime4K may not preserve their buffer)
        const canvas = document.createElement("canvas")
        const ctx = canvas.getContext("2d")
        if (!ctx) {
            log.error("Could not get 2d context")
            return null
        }

        canvas.width = videoElement.videoWidth
        canvas.height = videoElement.videoHeight

        // Draw video frame
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height)
        log.info("Drew video frame to canvas")

        // Add subtitles if using libass renderer
        if (subtitleManager?.libassRenderer) {
            log.info("Adding libass subtitles to screenshot")
            await addSubtitlesToCanvas(canvas, subtitleManager.libassRenderer)
        }

        const blob = await canvasToBlob(canvas)
        canvas.remove()

        if (blob && blob.size > 0) {
            const base64 = await imageBlobToBase64(blob)
            log.info("Screenshot captured successfully", { blobSize: blob.size, base64Length: base64.length })
            return { blob, base64 }
        }

        log.error("Screenshot blob is empty or null")
        return null
    } catch (error) {
        log.error("Screenshot capture failed", error)
        return null
    }
}

/**
 * Add libass subtitles to canvas
 */
async function addSubtitlesToCanvas(
    canvas: HTMLCanvasElement,
    libassRenderer: any,
): Promise<void> {
    return new Promise((resolve) => {
        const ctx = canvas.getContext("2d")
        if (!ctx || !libassRenderer._canvas) {
            resolve()
            return
        }

        libassRenderer.resize(canvas.width, canvas.height)
        setTimeout(() => {
            ctx.drawImage(libassRenderer._canvas, 0, 0, canvas.width, canvas.height)
            libassRenderer.resize(0, 0, 0, 0)
            resolve()
        }, 300)
    })
}

/**
 * Composite subtitles onto an existing image blob
 */
async function compositeSubtitlesOnCanvas(
    imageBlob: Blob,
    libassRenderer: any,
    width: number,
    height: number,
): Promise<Blob | null> {
    return new Promise((resolve) => {
        const img = new Image()
        img.onload = async () => {
            const canvas = document.createElement("canvas")
            const ctx = canvas.getContext("2d")
            if (!ctx) {
                resolve(null)
                return
            }

            canvas.width = width
            canvas.height = height
            ctx.drawImage(img, 0, 0)

            await addSubtitlesToCanvas(canvas, libassRenderer)

            canvas.toBlob((blob) => {
                canvas.remove()
                URL.revokeObjectURL(img.src)
                resolve(blob)
            }, "image/png")
        }
        img.onerror = () => resolve(null)
        img.src = URL.createObjectURL(imageBlob)
    })
}

/**
 * Convert canvas to blob
 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => {
        canvas.toBlob(resolve, "image/png")
    })
}

/**
 * Hook for Anki mining functionality
 */
export function useVideoCoreAnki() {
    const videoElement = useAtomValue(vc_videoElement)
    const subtitleManager = useAtomValue(vc_subtitleManager)
    const ankiSettings = useAtomValue(vc_ankiSettingsAtom)
    const settings = useAtomValue(vc_settings)
    const showFeedback = useSetAtom(vc_showOverlayFeedback)

    const miningInProgress = React.useRef(false)

    /**
     * Get current subtitle text and timing
     */
    const getCurrentSubtitle = React.useCallback((): CurrentSubtitle | null => {
        if (!videoElement) return null

        // Try text tracks first
        const textTrackSub = getCurrentSubtitleFromTextTracks(videoElement)
        if (textTrackSub && textTrackSub.text) {
            return textTrackSub
        }

        // Try DOM
        const domSub = getCurrentSubtitleFromDOM()
        if (domSub && domSub.text) {
            return {
                ...domSub,
                startTime: videoElement.currentTime - 2,
                endTime: videoElement.currentTime + 1,
            }
        }

        return null
    }, [videoElement])

    /**
     * Mine current frame to Anki
     */
    const mineToAnki = React.useCallback(async () => {
        if (!videoElement || !ankiSettings.enabled) {
            showFeedback({ message: "Anki mining not enabled", type: "message" })
            return
        }

        if (miningInProgress.current) {
            showFeedback({ message: "Mining in progress..." })
            return
        }

        if (!ankiSettings.deckName || !ankiSettings.modelName) {
            showFeedback({ message: "Please configure Anki settings" })
            return
        }

        miningInProgress.current = true
        showFeedback({ message: "Mining to Anki...", duration: 2000 })

        try {
            // Get current subtitle for timing
            const subtitle = getCurrentSubtitle()
            const currentTime = videoElement.currentTime

            log.info("Mining with subtitle", { subtitle, currentTime })

            // Capture screenshot first (doesn't need seeking)
            const screenshot = await captureScreenshot(videoElement, subtitleManager)

            // Capture audio for full subtitle duration, or fall back to current position
            let audioResult = null
            if (subtitle && subtitle.startTime > 0 && subtitle.endTime > subtitle.startTime) {
                try {
                    log.info("Capturing full subtitle audio", {
                        start: subtitle.startTime,
                        end: subtitle.endTime,
                    })
                    audioResult = await captureAudioForSubtitle(
                        videoElement,
                        subtitle.startTime,
                        subtitle.endTime,
                        ankiSettings.audioPaddingBefore,
                    )
                } catch (error) {
                    log.warning("Audio capture with timing failed, trying current position", error)
                    try {
                        audioResult = await captureAudioFromCurrentPosition(videoElement, 3)
                    } catch (fallbackError) {
                        log.warning("Fallback audio capture also failed", fallbackError)
                    }
                }
            } else {
                // No subtitle timing available, capture from current position
                log.info("No subtitle timing, capturing audio from current position")
                try {
                    audioResult = await captureAudioFromCurrentPosition(videoElement, 3)
                } catch (error) {
                    log.warning("Audio capture from current position failed", error)
                }
            }

            // Prepare note fields
            const fields: Record<string, string> = {}
            if (ankiSettings.sentenceField && subtitle?.text) {
                // Clean up subtitle text (remove ASS formatting tags)
                const cleanText = subtitle.text
                    .replace(/\{[^}]*\}/g, "") // Remove ASS tags like {\i1}
                    .replace(/\\N/g, "\n") // Convert line breaks
                    .trim()
                fields[ankiSettings.sentenceField] = cleanText
            }

            // Prepare media
            const timestamp = Date.now()
            const audio: AnkiMedia[] = []
            const picture: AnkiMedia[] = []

            if (audioResult && ankiSettings.audioField) {
                audio.push({
                    data: audioResult.base64,
                    filename: `seanime_${timestamp}.webm`,
                    fields: [ankiSettings.audioField],
                })
            }

            if (screenshot && ankiSettings.imageField) {
                picture.push({
                    data: screenshot.base64,
                    filename: `seanime_${timestamp}.png`,
                    fields: [ankiSettings.imageField],
                })
            }

            // Update AnkiConnect URL if needed
            ankiConnect.setUrl(ankiSettings.ankiConnectUrl)

            // Add note to Anki
            const noteId = await ankiConnect.addNote({
                deckName: ankiSettings.deckName,
                modelName: ankiSettings.modelName,
                fields,
                audio: audio.length > 0 ? audio : undefined,
                picture: picture.length > 0 ? picture : undefined,
            })

            log.info("Card created", { noteId })
            showFeedback({ message: "Card created!", type: "message", duration: 1500 })
        } catch (error) {
            log.error("Mining failed", error)
            showFeedback({
                message: `Anki error: ${error instanceof Error ? error.message : "Unknown error"}`,
                duration: 3000,
            })
        } finally {
            miningInProgress.current = false
        }
    }, [
        videoElement,
        ankiSettings,
        subtitleManager,
        showFeedback,
        getCurrentSubtitle,
    ])

    /**
     * Update last created card with new screenshot/audio
     * Works with cards created by Seanime or external tools like Yomitan
     * Always fetches the latest card from Anki (forceRefresh)
     * Uses subtitle-aware audio capture: finds the subtitle cue containing the word from the card
     */
    const updateLastCard = React.useCallback(async () => {
        if (!videoElement || !ankiSettings.enabled) {
            showFeedback({ message: "Anki mining not enabled" })
            return
        }

        if (miningInProgress.current) {
            showFeedback({ message: "Mining in progress..." })
            return
        }

        if (!ankiSettings.deckName) {
            showFeedback({ message: "Please configure Anki deck" })
            return
        }

        miningInProgress.current = true
        showFeedback({ message: "Finding last card...", duration: 2000 })

        // Update AnkiConnect URL
        ankiConnect.setUrl(ankiSettings.ankiConnectUrl)

        // ALWAYS fetch fresh from Anki to get the latest card (including Yomitan cards)
        const lastNoteId = await ankiConnect.getOrFetchLastNoteId(ankiSettings.deckName, true)

        if (!lastNoteId) {
            miningInProgress.current = false
            showFeedback({ message: "No cards found in deck" })
            return
        }

        log.info("Updating card", { noteId: lastNoteId })
        showFeedback({ message: "Updating card...", duration: 2000 })

        try {
            const currentTime = videoElement.currentTime

            // Step 1: Get note info to extract the word
            let searchWord: string | null = null
            try {
                const notesInfo = await ankiConnect.notesInfo([lastNoteId])
                if (notesInfo && notesInfo.length > 0) {
                    searchWord = extractWordFromNote(notesInfo[0])
                    log.info("Extracted word from note", { word: searchWord, noteId: lastNoteId })
                }
            } catch (error) {
                log.warning("Failed to get note info, will use time-based matching", error)
            }

            // Step 2: Get subtitle cues from the subtitle manager
            const subtitleCues = getSubtitleCuesFromManager(subtitleManager)
            log.info("Got subtitle cues", { count: subtitleCues?.length ?? 0 })

            // Step 3: Find the best matching subtitle cue
            let matchResult: SubtitleMatchResult | null = null
            if (subtitleCues && subtitleCues.length > 0) {
                matchResult = findBestSubtitleMatch(subtitleCues, searchWord, currentTime)
                if (matchResult) {
                    log.info("Found subtitle match", {
                        matchType: matchResult.matchType,
                        start: matchResult.cue.start,
                        end: matchResult.cue.end,
                        text: matchResult.cue.text.substring(0, 50) + (matchResult.cue.text.length > 50 ? "..." : ""),
                    })
                }
            }

            // Capture screenshot (video doesn't need to be paused for this)
            log.info("Capturing screenshot...")
            const screenshot = await captureScreenshot(videoElement, subtitleManager)
            log.info("Screenshot result", {
                success: !!screenshot,
                size: screenshot?.blob.size,
                base64Length: screenshot?.base64.length
            })

            // Step 4: Capture audio using the matched subtitle timing or fallback
            // Apply subtitle delay offset: positive delay means subtitles appear later,
            // so we need to capture audio later than the raw cue times
            const subtitleDelay = settings.subtitleDelay ?? 0
            let audioResult = null
            if (matchResult) {
                // Use the matched subtitle cue's timing, adjusted for subtitle delay
                const adjustedStart = matchResult.cue.start + subtitleDelay
                const adjustedEnd = matchResult.cue.end + subtitleDelay
                try {
                    log.info("Capturing audio for matched subtitle", {
                        matchType: matchResult.matchType,
                        rawStart: matchResult.cue.start,
                        rawEnd: matchResult.cue.end,
                        subtitleDelay,
                        adjustedStart,
                        adjustedEnd,
                    })
                    audioResult = await captureAudioForSubtitle(
                        videoElement,
                        adjustedStart,
                        adjustedEnd,
                        ankiSettings.audioPaddingBefore,
                    )
                    log.info("Audio result", {
                        success: !!audioResult,
                        size: audioResult?.blob.size
                    })
                } catch (error) {
                    log.warning("Audio capture with subtitle timing failed, trying current position", error)
                    try {
                        audioResult = await captureAudioFromCurrentPosition(videoElement, 3)
                        log.info("Fallback audio result", {
                            success: !!audioResult,
                            size: audioResult?.blob.size
                        })
                    } catch (fallbackError) {
                        log.warning("Fallback audio capture also failed", fallbackError)
                    }
                }
            } else {
                // No subtitle match found, try the old method or fall back to 3 seconds
                const domSubtitle = getCurrentSubtitle()
                if (domSubtitle && domSubtitle.startTime > 0 && domSubtitle.endTime > domSubtitle.startTime) {
                    try {
                        log.info("Capturing audio from DOM subtitle timing", {
                            start: domSubtitle.startTime,
                            end: domSubtitle.endTime,
                        })
                        audioResult = await captureAudioForSubtitle(
                            videoElement,
                            domSubtitle.startTime,
                            domSubtitle.endTime,
                            ankiSettings.audioPaddingBefore,
                        )
                    } catch (error) {
                        log.warning("DOM subtitle audio capture failed", error)
                    }
                }

                if (!audioResult) {
                    // Final fallback: capture 3 seconds from current position
                    log.info("No subtitle timing available, capturing 3 seconds from current position")
                    try {
                        audioResult = await captureAudioFromCurrentPosition(videoElement, 3)
                        log.info("Audio from current position result", {
                            success: !!audioResult,
                            size: audioResult?.blob.size
                        })
                    } catch (error) {
                        log.warning("Audio capture from current position failed", error)
                    }
                }
            }

            const timestamp = Date.now()
            const audio: AnkiMedia[] = []
            const picture: AnkiMedia[] = []

            if (audioResult && ankiSettings.audioField) {
                audio.push({
                    data: audioResult.base64,
                    filename: `seanime_${timestamp}.webm`,
                    fields: [ankiSettings.audioField],
                })
                log.info("Added audio to note", { field: ankiSettings.audioField })
            }

            if (screenshot && ankiSettings.imageField) {
                picture.push({
                    data: screenshot.base64,
                    filename: `seanime_${timestamp}.png`,
                    fields: [ankiSettings.imageField],
                })
                log.info("Added picture to note", { field: ankiSettings.imageField })
            }

            log.info("Sending update to AnkiConnect", {
                noteId: lastNoteId,
                hasAudio: audio.length > 0,
                hasPicture: picture.length > 0
            })

            await ankiConnect.updateNoteFields(
                lastNoteId,
                {},
                audio.length > 0 ? audio : undefined,
                picture.length > 0 ? picture : undefined,
            )

            // Show success message with match type info
            const matchInfo = matchResult ? ` (${matchResult.matchType} match)` : ""
            log.info("Card updated successfully", { noteId: lastNoteId, matchType: matchResult?.matchType })
            showFeedback({ message: `Card updated!${matchInfo}`, type: "message", duration: 1500 })
        } catch (error) {
            log.error("Update failed", error)
            showFeedback({
                message: `Update error: ${error instanceof Error ? error.message : "Unknown error"}`,
                duration: 3000,
            })
        } finally {
            miningInProgress.current = false
        }
    }, [
        videoElement,
        ankiSettings,
        settings,
        subtitleManager,
        showFeedback,
        getCurrentSubtitle,
    ])

    return {
        mineToAnki,
        updateLastCard,
        getCurrentSubtitle,
        isEnabled: ankiSettings.enabled,
    }
}
