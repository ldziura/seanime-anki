import { nativePlayer_stateAtom } from "@/app/(main)/_features/native-player/native-player.atoms"
import { vc_subtitleManager } from "@/app/(main)/_features/video-core/video-core"
import { vc_mediaCaptionsManager } from "@/app/(main)/_features/video-core/video-core"
import { vc_menuOpen } from "@/app/(main)/_features/video-core/video-core-atoms"
import { vc_menuSectionOpen } from "@/app/(main)/_features/video-core/video-core-atoms"
import { vc_isFullscreen } from "@/app/(main)/_features/video-core/video-core-atoms"
import { vc_miniPlayer } from "@/app/(main)/_features/video-core/video-core-atoms"
import { vc_videoElement } from "@/app/(main)/_features/video-core/video-core-atoms"
import { vc_containerElement } from "@/app/(main)/_features/video-core/video-core-atoms"
import {
    getSubtitleOffset,
    hasExplicitSubtitleOffset,
    vc_currentPlaybackContextAtom,
    vc_settings,
    vc_subtitleOffsetsAtom,
    VideoCoreSettings,
} from "@/app/(main)/_features/video-core/video-core.atoms"
import { VideoCoreControlButtonIcon } from "@/app/(main)/_features/video-core/video-core-control-bar"
import { MediaCaptionsTrack } from "@/app/(main)/_features/video-core/video-core-media-captions"
import { VideoCoreMenu, VideoCoreMenuBody, VideoCoreMenuTitle, VideoCoreSettingSelect } from "@/app/(main)/_features/video-core/video-core-menu"
import { NormalizedTrackInfo, SubtitleManagerAutoSyncEvent } from "@/app/(main)/_features/video-core/video-core-subtitles"
import { vc_dispatchAction } from "@/app/(main)/_features/video-core/video-core.utils"
import { IconButton } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { detectTrackLanguage } from "@/lib/helpers/language"
import { useAtomValue } from "jotai"
import { useAtom, useSetAtom } from "jotai/react"
import React from "react"
import { AiFillInfoCircle } from "react-icons/ai"
import { LuCaptions, LuPaintbrush } from "react-icons/lu"
import { toast } from "sonner"

export function VideoCoreSubtitleMenu({ inline }: { inline?: boolean }) {
    const action = useSetAtom(vc_dispatchAction)
    const isMiniPlayer = useAtomValue(vc_miniPlayer)
    const state = useAtomValue(nativePlayer_stateAtom)
    const subtitleManager = useAtomValue(vc_subtitleManager)
    const mediaCaptionsManager = useAtomValue(vc_mediaCaptionsManager)
    const videoElement = useAtomValue(vc_videoElement)
    const isFullscreen = useAtomValue(vc_isFullscreen)
    const containerElement = useAtomValue(vc_containerElement)
    const [selectedTrack, setSelectedTrack] = React.useState<number | null>(null)
    const [selectedSecondaryTrack, setSelectedSecondaryTrack] = React.useState<number | null>(null)

    const setMenuOpen = useSetAtom(vc_menuOpen)
    const setMenuSectionOpen = useSetAtom(vc_menuSectionOpen)

    const [subtitleTracks, setSubtitleTracks] = React.useState<NormalizedTrackInfo[]>([])
    const [mediaCaptionsTracks, setMediaCaptionsTracks] = React.useState<MediaCaptionsTrack[]>([])

    // Subtitle offset persistence
    const [subtitleOffsets, setSubtitleOffsets] = useAtom(vc_subtitleOffsetsAtom)
    const currentPlaybackContext = useAtomValue(vc_currentPlaybackContextAtom)
    const [settings, setSettings] = useAtom(vc_settings)

    // Apply saved offset when track changes
    const applyOffsetForTrack = React.useCallback((trackNumber: number | null, isSecondary: boolean = false) => {
        if (trackNumber === null || trackNumber === -1) return

        const { mediaId, episodeNumber } = currentPlaybackContext
        if (!mediaId || !episodeNumber) return

        // Get track info to detect language
        let trackInfo: { label?: string; language?: string } | null | undefined = null
        if (subtitleManager) {
            trackInfo = subtitleManager.getTrack(trackNumber)
        } else if (mediaCaptionsManager && !isSecondary) {
            trackInfo = mediaCaptionsManager.getTrack(trackNumber)
        }

        if (!trackInfo) return

        const language = detectTrackLanguage(trackInfo)
        if (!language) return

        // For secondary tracks, use a different key pattern
        const lookupKey = isSecondary ? `${language}_secondary` : language
        const savedOffset = getSubtitleOffset(subtitleOffsets, mediaId, episodeNumber, lookupKey)

        // Apply the offset if different from current setting
        const currentOffset = isSecondary ? (settings.secondarySubtitleDelay ?? 0) : settings.subtitleDelay
        if (savedOffset !== currentOffset) {
            const newSettings: VideoCoreSettings = isSecondary
                ? { ...settings, secondarySubtitleDelay: savedOffset }
                : { ...settings, subtitleDelay: savedOffset }
            setSettings(newSettings)
            subtitleManager?.updateSettings(newSettings)
            if (!isSecondary) {
                mediaCaptionsManager?.updateSettings(newSettings)
            }
        }
    }, [currentPlaybackContext, subtitleOffsets, settings, setSettings, subtitleManager, mediaCaptionsManager])

    // Commits an accepted auto-sync measurement: persists it as this episode's offset and
    // applies it live. The manager measures but never writes — the offset store lives here.
    const commitAutoSync = React.useCallback((ev: SubtitleManagerAutoSyncEvent) => {
        const { applied, reason, trackNumber, offsetSeconds } = ev.detail
        if (!applied) return

        const { mediaId, episodeNumber } = currentPlaybackContext
        if (!mediaId || !episodeNumber) return

        const track = subtitleManager?.getTrack(trackNumber)
        if (!track) return

        const language = detectTrackLanguage(track)
        if (!language) return

        // An offset saved for THIS episode was set deliberately and wins. An inherited
        // one is only carried over from an earlier episode, so a fresh measurement of
        // this episode is strictly better information.
        if (hasExplicitSubtitleOffset(subtitleOffsets, mediaId, episodeNumber, language)) return

        setSubtitleOffsets(prev => ({
            ...prev,
            [mediaId]: {
                ...prev[mediaId],
                [episodeNumber]: {
                    ...prev[mediaId]?.[episodeNumber],
                    [language]: offsetSeconds,
                },
            },
        }))

        const newSettings: VideoCoreSettings = { ...settings, subtitleDelay: offsetSeconds }
        setSettings(newSettings)
        subtitleManager?.updateSettings(newSettings)
        mediaCaptionsManager?.updateSettings(newSettings)

        // Only announce a correction that actually moved something — a measured 0.00s on
        // an already-correct track is not worth interrupting the episode for.
        if (Math.abs(offsetSeconds) >= 0.05 || trackNumber !== selectedTrack) {
            toast.success(`Subtitles synced (${offsetSeconds >= 0 ? "+" : ""}${offsetSeconds.toFixed(2)}s)`, {
                description: track.label || reason,
            })
        }
    }, [currentPlaybackContext, subtitleOffsets, setSubtitleOffsets, settings, setSettings, subtitleManager, mediaCaptionsManager, selectedTrack])

    // Keep the latest closure in a ref so the listener is registered once per manager
    // instead of being torn down and re-added on every render.
    const commitAutoSyncRef = React.useRef(commitAutoSync)
    commitAutoSyncRef.current = commitAutoSync

    React.useEffect(() => {
        if (!subtitleManager) return
        const listener = (ev: SubtitleManagerAutoSyncEvent) => commitAutoSyncRef.current(ev)
        subtitleManager.addEventListener("autosynced", listener)
        return () => subtitleManager.removeEventListener("autosynced", listener as EventListener)
    }, [subtitleManager])

    function onTextTrackChange() {
        setSubtitleTracks(p => subtitleManager?.getTracks?.() ?? p)
    }

    function onTrackChange(trackNumber: number | null) {
        setSelectedTrack(trackNumber)
    }

    function onSecondaryTrackChange(trackNumber: number | null) {
        setSelectedSecondaryTrack(trackNumber)
    }

    const firstRender = React.useRef(true)

    React.useEffect(() => {
        if (!videoElement) return

        /**
         * MKV subtitle tracks
         */
        if (subtitleManager) {
            if (firstRender.current) {
                // firstRender.current = false
                onTrackChange(subtitleManager?.getSelectedTrackNumberOrNull?.() ?? null)
                onSecondaryTrackChange(subtitleManager?.getSelectedSecondaryTrackNumberOrNull?.() ?? null)
            }

            // Listen for subtitle track changes
            subtitleManager.setTrackChangedEventListener(onTrackChange)
            subtitleManager.setSecondaryTrackChangedEventListener(onSecondaryTrackChange)

            // Listen for when the subtitle tracks are mounted
            subtitleManager.setTracksLoadedEventListener(tracks => {
                setSubtitleTracks(tracks)
            })
        } else if (mediaCaptionsManager) {
            /**
             * Media captions tracks
             */
            if (firstRender.current) {
                // firstRender.current = false
                setSelectedTrack(mediaCaptionsManager.getSelectedTrackIndexOrNull?.() ?? null)
            }

            // Listen for subtitle track changes
            mediaCaptionsManager.setTrackChangedEventListener(onTrackChange)

            mediaCaptionsManager.setTracksLoadedEventListener(tracks => {
                setMediaCaptionsTracks(tracks)
            })
        }
    }, [videoElement, subtitleManager, mediaCaptionsManager])

    React.useEffect(() => {
        onTextTrackChange()
    }, [subtitleManager])

    // Apply saved offsets when playback context changes (e.g., new episode)
    // or when the subtitle manager/tracks become available
    const appliedOffsetsRef = React.useRef<{ mediaId: number | null, episodeNumber: number | null }>({
        mediaId: null,
        episodeNumber: null,
    })

    React.useEffect(() => {
        const { mediaId, episodeNumber } = currentPlaybackContext
        // Only apply once per episode to avoid overwriting user changes
        if (
            mediaId && episodeNumber &&
            (appliedOffsetsRef.current.mediaId !== mediaId ||
                appliedOffsetsRef.current.episodeNumber !== episodeNumber)
        ) {
            appliedOffsetsRef.current = { mediaId, episodeNumber }

            // Apply primary track offset
            if (selectedTrack !== null && selectedTrack !== -1) {
                applyOffsetForTrack(selectedTrack, false)
            }

            // Apply secondary track offset
            if (selectedSecondaryTrack !== null && selectedSecondaryTrack !== -1) {
                applyOffsetForTrack(selectedSecondaryTrack, true)
            }
        }
    }, [currentPlaybackContext.mediaId, currentPlaybackContext.episodeNumber, selectedTrack, selectedSecondaryTrack])

    // Get active manager
    const activeManager = subtitleManager || mediaCaptionsManager
    const activeTracks = subtitleManager ? subtitleTracks : mediaCaptionsTracks

    if (isMiniPlayer || !activeTracks?.length) return null

    return (
        <VideoCoreMenu
            name="subtitle"
            trigger={<VideoCoreControlButtonIcon
                icons={[
                    ["default", LuCaptions],
                ]}
                state="default"
                onClick={() => {

                }}
            />}
        >
            <VideoCoreMenuTitle>Subtitles {(!!subtitleManager && !inline) && <Tooltip
                trigger={<AiFillInfoCircle className="text-sm" />}
                className="z-[150]"
                portalContainer={isFullscreen ? (containerElement ?? undefined) : undefined}
            >
                You can add subtitles by dragging and dropping files onto the player.
            </Tooltip>}
                <IconButton
                    intent="gray-link" size="xs"
                    onClick={() => {
                        setMenuOpen("settings")
                        React.startTransition(() => {
                            setMenuSectionOpen("Subtitle Styles")
                        })
                    }}
                    icon={<LuPaintbrush />}
                    className="absolute right-2 top-[calc(50%-1rem)]"
                /></VideoCoreMenuTitle>
            <VideoCoreMenuBody>
                {/* Primary Track - Bottom */}
                <p className="text-[--muted] text-xs mb-1">Primary (Bottom)</p>
                <VideoCoreSettingSelect
                    isFullscreen={isFullscreen}
                    containerElement={containerElement}
                    options={[
                        {
                            label: "Off",
                            value: -1,
                        },
                        ...subtitleTracks.map(track => {
                            // MKV subtitle tracks
                            return {
                                label: `${track.label || track.language?.toUpperCase() || track.languageIETF?.toUpperCase()}`,
                                value: track.number,
                                moreInfo: track.language && track.language !== track.label
                                    ? `${track.language.toUpperCase()}${track.codecID ? "/" + getSubtitleTrackType(track.codecID) : ``}`
                                    : undefined,
                            }
                        }),
                        ...mediaCaptionsTracks.map(track => {
                            return {
                                label: track.label,
                                value: track.number,
                                moreInfo: track.language && track.language !== track.label ? track.language?.toUpperCase() : undefined,
                            }
                        }),
                    ]}
                    onValueChange={(value: number) => {
                        // An explicit choice takes auto-sync out of the track-selection
                        // business for the rest of this episode.
                        subtitleManager?.markUserTrackSelection()
                        if (value === -1) {
                            activeManager?.setNoTrack()
                            setSelectedTrack(null)
                            return
                        }
                        if (subtitleManager) {
                            subtitleManager.selectTrack(value)
                        } else if (mediaCaptionsManager) {
                            mediaCaptionsManager.selectTrack(value)
                            setSelectedTrack(value)
                        }
                        // Apply saved offset for the newly selected track
                        applyOffsetForTrack(value, false)
                    }}
                    value={selectedTrack ?? -1}
                />

                {/* Secondary Track - Top. Shown whenever the file-based
                    subtitle manager has at least one track so users can
                    place a single external subtitle (e.g. Jimaku Japanese)
                    at the top — useful when the video already has burned-in
                    subs at the bottom. With one track, the secondary list
                    becomes useful only when Primary is set to Off (the
                    filter below excludes the currently-selected primary). */}
                {subtitleManager && subtitleTracks.length >= 1 && (
                    <>
                        <p className="text-[--muted] text-xs mt-3 mb-1">Secondary (Top)</p>
                        <VideoCoreSettingSelect
                            isFullscreen={isFullscreen}
                            containerElement={containerElement}
                            options={[
                                {
                                    label: "Off",
                                    value: -1,
                                },
                                ...subtitleTracks
                                    .filter(track => track.number !== selectedTrack) // Exclude primary track
                                    .map(track => ({
                                        label: `${track.label || track.language?.toUpperCase() || track.languageIETF?.toUpperCase()}`,
                                        value: track.number,
                                        moreInfo: track.language && track.language !== track.label
                                            ? `${track.language.toUpperCase()}${track.codecID ? "/" + getSubtitleTrackType(track.codecID) : ``}`
                                            : undefined,
                                    })),
                            ]}
                            onValueChange={(value: number) => {
                                if (value === -1) {
                                    subtitleManager.setNoSecondaryTrack()
                                    setSelectedSecondaryTrack(null)
                                    return
                                }
                                subtitleManager.selectSecondaryTrack(value)
                                // Apply saved offset for the newly selected secondary track
                                applyOffsetForTrack(value, true)
                            }}
                            value={selectedSecondaryTrack ?? -1}
                        />
                    </>
                )}
            </VideoCoreMenuBody>
        </VideoCoreMenu>
    )
}

export function getSubtitleTrackType(codecID: string) {
    switch (codecID) {
        case "S_TEXT/ASS":
            return "ASS"
        case "S_TEXT/SSA":
            return "SSA"
        case "S_TEXT/UTF8":
            return "TEXT"
        case "S_HDMV/PGS":
            return "PGS"
    }
    return "unknown"
}
