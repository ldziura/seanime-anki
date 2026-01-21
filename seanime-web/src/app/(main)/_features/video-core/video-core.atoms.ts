import {
    VideoCore_PlaybackType,
    VideoCore_VideoPlaybackInfo,
    VideoCore_VideoSource,
    VideoCore_VideoSubtitleTrack,
} from "@/api/generated/types"
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

export type VideoCoreLifecycleState = {
    active: boolean
    playbackInfo: VideoCore_VideoPlaybackInfo | null
    playbackError: string | null
    loadingState: string | null
}

export type {
    VideoCore_VideoSubtitleTrack, VideoCore_PlaybackType, VideoCore_VideoSource, VideoCore_VideoPlaybackInfo,
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type VideoCoreSettings = {
    preferredSubtitleLanguage: string
    preferredSubtitleBlacklist: string
    preferredAudioLanguage: string
    subtitleDelay: number // in seconds (primary track)
    secondarySubtitleDelay: number // in seconds (secondary track)
    // Video enhancement settings
    videoEnhancement: {
        enabled: boolean
        contrast: number      // 0.8 - 1.2 (1.0 = default)
        saturation: number    // 0.8 - 1.3 (1.0 = default)
        brightness: number    // 0.9 - 1.1 (1.0 = default)
    }
    // Subtitle customization settings (ASS)
    subtitleCustomization: {
        enabled: boolean
        fontSize?: number
        fontName?: string
        primaryColor?: string
        outlineColor?: string
        backColor?: string
        backColorOpacity?: number
        outline?: number
        shadow?: number
    }
    // Caption customization settings (non-ASS)
    captionCustomization: {
        fontSize?: number
        secondaryFontSize?: number // Independent font size for secondary track (undefined = same as primary)
        textColor?: string
        backgroundColor?: string
        backgroundOpacity?: number
        textShadow?: number
        textShadowColor?: string
    }
}

export const vc_initialSettings: VideoCoreSettings = {
    preferredSubtitleLanguage: "en,eng,english",
    preferredSubtitleBlacklist: "",
    preferredAudioLanguage: "jpn,jp,jap,japanese",
    subtitleDelay: 0,
    secondarySubtitleDelay: 0,
    videoEnhancement: {
        enabled: true,
        contrast: 1.05,
        saturation: 1.1,
        brightness: 1.02,
    },
    subtitleCustomization: {
        enabled: false,
    },
    captionCustomization: {},
}

// Wrapped atom for backward compatibility
export const vc_settingsRaw = atomWithStorage<Partial<VideoCoreSettings>>("sea-video-core-settings",
    vc_initialSettings,
    undefined,
    { getOnInit: true })

export const vc_settings = atom(
    (get) => {
        const settings = get(vc_settingsRaw)
        return {
            ...vc_initialSettings,
            ...settings,
            subtitleCustomization: {
                ...vc_initialSettings.subtitleCustomization,
                ...(settings.subtitleCustomization || {}),
            },
            captionCustomization: {
                ...vc_initialSettings.captionCustomization,
                ...(settings.captionCustomization || {}),
            },
            videoEnhancement: {
                ...vc_initialSettings.videoEnhancement,
                ...(settings.videoEnhancement || {}),
            },
        } as VideoCoreSettings
    },
    (get, set, update: VideoCoreSettings) => {
        set(vc_settingsRaw, update)
    },
)

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface VideoCoreKeybindings {
    seekForward: { key: string; value: number }
    seekBackward: { key: string; value: number }
    seekForwardFine: { key: string; value: number }
    seekBackwardFine: { key: string; value: number }
    nextChapter: { key: string }
    previousChapter: { key: string }
    volumeUp: { key: string; value: number }
    volumeDown: { key: string; value: number }
    mute: { key: string }
    cycleSubtitles: { key: string }
    cycleAudio: { key: string }
    nextEpisode: { key: string }
    previousEpisode: { key: string }
    fullscreen: { key: string }
    pictureInPicture: { key: string }
    increaseSpeed: { key: string; value: number }
    decreaseSpeed: { key: string; value: number }
    takeScreenshot: { key: string }
    ankiMine: { key: string }
    ankiUpdateLast: { key: string }
}

export const vc_defaultKeybindings: VideoCoreKeybindings = {
    seekForward: { key: "KeyD", value: 30 },
    seekBackward: { key: "KeyA", value: 30 },
    seekForwardFine: { key: "ArrowRight", value: 2 },
    seekBackwardFine: { key: "ArrowLeft", value: 2 },
    nextChapter: { key: "KeyE" },
    previousChapter: { key: "KeyQ" },
    volumeUp: { key: "ArrowUp", value: 5 },
    volumeDown: { key: "ArrowDown", value: 5 },
    mute: { key: "KeyM" },
    cycleSubtitles: { key: "KeyJ" },
    cycleAudio: { key: "KeyK" },
    nextEpisode: { key: "KeyN" },
    previousEpisode: { key: "KeyB" },
    fullscreen: { key: "KeyF" },
    pictureInPicture: { key: "KeyP" },
    increaseSpeed: { key: "BracketRight", value: 0.1 },
    decreaseSpeed: { key: "BracketLeft", value: 0.1 },
    takeScreenshot: { key: "KeyI" },
    ankiMine: { key: "Backquote" },
    ankiUpdateLast: { key: "Backslash" },
}

export const vc_keybindingsAtom = atomWithStorage("sea-video-core-keybindings", vc_defaultKeybindings, undefined, { getOnInit: true })

export const vc_useLibassRendererAtom = atomWithStorage("sea-video-core-use-libass-renderer", true, undefined, { getOnInit: true })

export const vc_showChapterMarkersAtom = atomWithStorage("sea-video-core-chapter-markers", true, undefined, { getOnInit: true })
export const vc_highlightOPEDChaptersAtom = atomWithStorage("sea-video-core-highlight-op-ed-chapters", true, undefined, { getOnInit: true })
export const vc_beautifyImageAtom = atomWithStorage("sea-video-core-increase-saturation", false, undefined, { getOnInit: true })
export const vc_autoNextAtom = atomWithStorage("sea-video-core-auto-next", true, undefined, { getOnInit: true })
export const vc_autoPlayVideoAtom = atomWithStorage("sea-video-core-auto-play", true, undefined, { getOnInit: true })
export const vc_autoSkipOPEDAtom = atomWithStorage("sea-video-core-auto-skip-op-ed", false, undefined, { getOnInit: true })
export const vc_storedVolumeAtom = atomWithStorage("sea-video-core-volume", 1, undefined, { getOnInit: true })
export const vc_storedMutedAtom = atomWithStorage("sea-video-core-muted", false, undefined, { getOnInit: true })
export const vc_storedPlaybackRateAtom = atomWithStorage("sea-video-core-playback-rate", 1, undefined, { getOnInit: true })

// Subtitle render mode: "canvas" uses libass (default), "html" uses DOM-based rendering
export type SubtitleRenderMode = "canvas" | "html"
export const vc_subtitleRenderModeAtom = atomWithStorage<SubtitleRenderMode>("sea-vc-subtitleRenderMode", "canvas", undefined, { getOnInit: true })

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Anki Mining Settings
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export interface AnkiSettings {
    enabled: boolean
    ankiConnectUrl: string
    deckName: string
    modelName: string
    sentenceField: string
    audioField: string
    imageField: string
    audioPaddingBefore: number // seconds before subtitle start
    audioPaddingAfter: number // seconds after subtitle end
}

export const vc_initialAnkiSettings: AnkiSettings = {
    enabled: false,
    ankiConnectUrl: "http://127.0.0.1:8765",
    deckName: "",
    modelName: "",
    sentenceField: "",
    audioField: "",
    imageField: "",
    audioPaddingBefore: 0.25,
    audioPaddingAfter: 0.25,
}

export const vc_ankiSettingsAtom = atomWithStorage<AnkiSettings>(
    "sea-video-core-anki-settings",
    vc_initialAnkiSettings,
    undefined,
    { getOnInit: true },
)
