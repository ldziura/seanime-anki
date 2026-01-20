"use client"

import { vc_currentTime, vc_subtitleManager } from "@/app/(main)/_features/video-core/video-core"
import { vc_settings, vc_subtitleRenderModeAtom } from "@/app/(main)/_features/video-core/video-core.atoms"
import { cn } from "@/components/ui/core/styling"
import { useAtomValue } from "jotai/react"
import React from "react"
import ReactDOM from "react-dom"

export interface SubtitleCue {
    start: number // in seconds
    end: number // in seconds
    text: string
}

/**
 * Parse ASS timestamp (H:MM:SS.cc) to seconds
 */
export function parseAssTime(timeStr: string): number {
    const match = timeStr.match(/(\d+):(\d+):(\d+)\.(\d+)/)
    if (!match) return -1
    const hours = parseInt(match[1], 10)
    const minutes = parseInt(match[2], 10)
    const seconds = parseInt(match[3], 10)
    const centiseconds = parseInt(match[4], 10)
    return hours * 3600 + minutes * 60 + seconds + centiseconds / 100
}

/**
 * Parse ASS subtitle content to extract cues
 */
export function parseAssSubtitles(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = []
    const lines = content.split("\n")
    let inEventsSection = false

    for (const line of lines) {
        if (line.trim().toLowerCase() === "[events]") {
            inEventsSection = true
            continue
        }
        if (line.startsWith("[") && line.endsWith("]")) {
            inEventsSection = false
            continue
        }

        if (inEventsSection && line.startsWith("Dialogue:")) {
            const parts = line.substring(9).split(",")
            if (parts.length >= 10) {
                // Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
                const startTime = parseAssTime(parts[1].trim())
                const endTime = parseAssTime(parts[2].trim())
                // Text is everything after the 9th comma
                const textStartIndex = line.indexOf(",", line.indexOf(",", line.indexOf(",", line.indexOf(",", line.indexOf(",", line.indexOf(",", line.indexOf(",", line.indexOf(",", line.indexOf(",") + 1) + 1) + 1) + 1) + 1) + 1) + 1) + 1) + 1
                let text = line.substring(textStartIndex)

                // Remove ASS formatting tags
                text = text.replace(/\{[^}]*\}/g, "")
                // Convert \N to newlines
                text = text.replace(/\\N/g, "\n")
                text = text.replace(/\\n/g, "\n")
                text = text.trim()

                if (text && startTime >= 0 && endTime > startTime) {
                    cues.push({ start: startTime, end: endTime, text })
                }
            }
        }
    }

    return cues
}

/**
 * Parse SRT timestamp (HH:MM:SS,mmm) to seconds
 */
export function parseSrtTime(timeStr: string): number {
    const match = timeStr.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
    if (!match) return -1
    const hours = parseInt(match[1], 10)
    const minutes = parseInt(match[2], 10)
    const seconds = parseInt(match[3], 10)
    const milliseconds = parseInt(match[4], 10)
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

/**
 * Parse SRT subtitle content to extract cues
 */
export function parseSrtSubtitles(content: string): SubtitleCue[] {
    const cues: SubtitleCue[] = []
    const blocks = content.trim().split(/\n\s*\n/)

    for (const block of blocks) {
        const lines = block.trim().split("\n")
        if (lines.length < 2) continue

        // Find the timing line (contains " --> ")
        let timingLineIndex = -1
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(" --> ")) {
                timingLineIndex = i
                break
            }
        }

        if (timingLineIndex === -1) continue

        const timingLine = lines[timingLineIndex]
        const timeParts = timingLine.split(" --> ")
        if (timeParts.length !== 2) continue

        const startTime = parseSrtTime(timeParts[0].trim())
        const endTime = parseSrtTime(timeParts[1].trim().split(" ")[0]) // Handle position info after time

        // Text is all lines after timing line
        const textLines = lines.slice(timingLineIndex + 1)
        let text = textLines.join("\n")

        // Remove HTML tags
        text = text.replace(/<[^>]*>/g, "")
        text = text.trim()

        if (text && startTime >= 0 && endTime > startTime) {
            cues.push({ start: startTime, end: endTime, text })
        }
    }

    return cues
}

/**
 * Parse VTT subtitle content to extract cues
 */
export function parseVttSubtitles(content: string): SubtitleCue[] {
    // VTT is very similar to SRT, with minor differences
    // Remove WEBVTT header and any metadata
    const contentWithoutHeader = content.replace(/^WEBVTT[^\n]*\n/, "").replace(/^NOTE[^\n]*\n/gm, "")
    return parseSrtSubtitles(contentWithoutHeader)
}

/**
 * Auto-detect and parse subtitle content
 */
export function parseSubtitles(content: string): SubtitleCue[] {
    const trimmed = content.trim()

    // Detect format by content
    if (trimmed.startsWith("WEBVTT")) {
        return parseVttSubtitles(content)
    }
    if (trimmed.includes("[Script Info]") || trimmed.includes("[Events]")) {
        return parseAssSubtitles(content)
    }
    // Default to SRT (most common for simple numbered subtitle blocks)
    if (/^\d+\s*\n/.test(trimmed)) {
        return parseSrtSubtitles(content)
    }
    // Try ASS as fallback for any bracketed format
    if (trimmed.includes("[")) {
        return parseAssSubtitles(content)
    }
    // Final fallback to SRT
    return parseSrtSubtitles(content)
}

interface HtmlSubtitleOverlayProps {
    className?: string
}

/**
 * Shadow DOM wrapper component.
 * Isolates subtitle text from the rest of the page DOM, preventing Yomitan
 * from picking up UI elements when scanning for sentence context.
 */
function ShadowDomSubtitles({ children }: { children: React.ReactNode }) {
    const hostRef = React.useRef<HTMLDivElement>(null)
    const shadowRootRef = React.useRef<ShadowRoot | null>(null)
    const [mounted, setMounted] = React.useState(false)

    React.useEffect(() => {
        if (hostRef.current && !shadowRootRef.current) {
            shadowRootRef.current = hostRef.current.attachShadow({ mode: "open" })
            setMounted(true)
        }
    }, [])

    return (
        <div ref={hostRef} style={{ display: "contents" }}>
            {mounted && shadowRootRef.current &&
                ReactDOM.createPortal(children, shadowRootRef.current)}
        </div>
    )
}

/**
 * HTML-based subtitle overlay component.
 * Renders subtitles as DOM elements instead of canvas-based libass.
 * This allows external tools (like asbplayer) to interact with subtitle text in fullscreen.
 * Subtitles are rendered inside a Shadow DOM to isolate them from the rest of the page,
 * preventing Yomitan from picking up UI elements when scanning for sentence context.
 */
export function HtmlSubtitleOverlay({ className }: HtmlSubtitleOverlayProps) {
    const renderMode = useAtomValue(vc_subtitleRenderModeAtom)
    const subtitleManager = useAtomValue(vc_subtitleManager)
    const currentTime = useAtomValue(vc_currentTime)
    const settings = useAtomValue(vc_settings)

    const [subtitleCues, setSubtitleCues] = React.useState<SubtitleCue[]>([])
    const [currentTrackNumber, setCurrentTrackNumber] = React.useState<number | null>(null)

    // Listen to track changes and extract cues
    React.useEffect(() => {
        if (!subtitleManager || renderMode !== "html") return

        const handleTrackSelected = (event: CustomEvent<{ trackNumber: number, kind: "file" | "event" }>) => {
            setCurrentTrackNumber(event.detail.trackNumber)
            // Extract cues from the subtitle manager
            extractCuesFromManager()
        }

        const handleTrackDeselected = () => {
            setCurrentTrackNumber(null)
            setSubtitleCues([])
        }

        const handleSettingsUpdated = () => {
            // Re-extract cues when settings change
            if (currentTrackNumber !== null) {
                extractCuesFromManager()
            }
        }

        subtitleManager.addEventListener("trackselected", handleTrackSelected as EventListener)
        subtitleManager.addEventListener("trackdeselected", handleTrackDeselected as EventListener)
        subtitleManager.addEventListener("settingsupdated", handleSettingsUpdated as EventListener)

        // Initial extraction if a track is already selected
        const selectedTrack = subtitleManager.getSelectedTrackNumberOrNull()
        if (selectedTrack !== null) {
            setCurrentTrackNumber(selectedTrack)
            extractCuesFromManager()
        }

        return () => {
            subtitleManager.removeEventListener("trackselected", handleTrackSelected as EventListener)
            subtitleManager.removeEventListener("trackdeselected", handleTrackDeselected as EventListener)
            subtitleManager.removeEventListener("settingsupdated", handleSettingsUpdated as EventListener)
        }
    }, [subtitleManager, renderMode, currentTrackNumber])

    const extractCuesFromManager = React.useCallback(() => {
        if (!subtitleManager) return

        const selectedTrack = subtitleManager.getSelectedTrackNumberOrNull()
        if (selectedTrack === null) {
            setSubtitleCues([])
            return
        }

        // Try to get file track content
        const fileTrack = subtitleManager.getFileTrack(selectedTrack)
        if (fileTrack?.content) {
            const cues = parseSubtitles(fileTrack.content)
            setSubtitleCues(cues)
            return
        }

        // For event tracks, we'll collect cues as they stream in
        // This is handled by the subtitle event listener
        setSubtitleCues([])
    }, [subtitleManager])

    // Don't render if not in HTML mode
    if (renderMode !== "html") {
        return null
    }

    // Calculate adjusted time with offset (negative delay = subtitles appear later)
    // Using subtraction to match JASSUB behavior where timeOffset = -subtitleDelay
    const subtitleDelay = settings.subtitleDelay ?? 0
    const adjustedTime = currentTime - subtitleDelay

    // Find active cues
    const activeCues = subtitleCues.filter(cue =>
        adjustedTime >= cue.start && adjustedTime <= cue.end
    )

    if (activeCues.length === 0) {
        return null
    }

    // Get caption customization settings
    const captionSettings = settings.captionCustomization

    return (
        <div
            data-vc-element="html-subtitle-overlay"
            data-html-subtitle-container
            className={cn(
                "absolute bottom-16 left-0 right-0 z-[60] text-center px-4",
                className,
            )}
            style={{ pointerEvents: "none" }}
        >
            <ShadowDomSubtitles>
                {/* Container inside shadow DOM - styles must be inline since shadow DOM doesn't inherit parent CSS */}
                <div
                    style={{
                        textAlign: "center",
                        pointerEvents: "none",
                    }}
                >
                    {activeCues.map((cue, i) => (
                        <div
                            key={`${cue.start}-${cue.end}-${i}`}
                            data-html-subtitle-cue
                            style={{
                                display: "inline-block",
                                padding: "0.5rem 0.75rem",
                                borderRadius: "0.25rem",
                                backgroundColor: `rgba(0, 0, 0, ${captionSettings?.backgroundOpacity ?? 0.7})`,
                                color: captionSettings?.textColor ?? "#FFFFFF",
                                fontSize: `${captionSettings?.fontSize ?? 5}vh`,
                                textShadow: captionSettings?.textShadow
                                    ? `${captionSettings.textShadow}px ${captionSettings.textShadow}px ${captionSettings.textShadow}px ${captionSettings.textShadowColor ?? "#000000"}`
                                    : "2px 2px 4px rgba(0, 0, 0, 0.8)",
                                whiteSpace: "pre-wrap",
                                maxWidth: "90%",
                                margin: "0 auto",
                                fontFamily: "inherit",
                                pointerEvents: "auto",
                                userSelect: "text",
                                cursor: "text",
                            }}
                        >
                            {cue.text}
                        </div>
                    ))}
                </div>
            </ShadowDomSubtitles>
        </div>
    )
}

/**
 * Hook to manage HTML subtitle cue collection from streaming events.
 * Call this in the video core to collect subtitle cues as they come in.
 */
export function useHtmlSubtitleCues() {
    const [cues, setCues] = React.useState<SubtitleCue[]>([])

    const addCue = React.useCallback((start: number, end: number, text: string) => {
        setCues(prev => {
            // Avoid duplicates
            const exists = prev.some(c => c.start === start && c.end === end && c.text === text)
            if (exists) return prev
            return [...prev, { start, end, text }]
        })
    }, [])

    const clearCues = React.useCallback(() => {
        setCues([])
    }, [])

    return { cues, addCue, clearCues }
}
