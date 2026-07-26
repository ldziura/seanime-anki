import { getServerBaseUrl } from "@/api/client/server-url"
import { MKVParser_SubtitleEvent, MKVParser_TrackInfo } from "@/api/generated/types"
import { VideoCorePgsRenderer } from "@/app/(main)/_features/video-core/video-core-pgs-renderer"
import { vc_getSubtitleStyle } from "@/app/(main)/_features/video-core/video-core-settings-menu"
import {
    CueInterval,
    findSplitAlignment,
    parseCues,
    selectAndAlign,
    shiftAssCuesBefore,
    SplitAlignment,
    SyncCandidate,
    SyncSelection,
} from "@/app/(main)/_features/video-core/video-core-subtitle-sync"
import { SubtitleRenderMode, VideoCore_VideoPlaybackInfo, VideoCore_VideoSubtitleTrack, VideoCoreSettings } from "@/app/(main)/_features/video-core/video-core.atoms"
import { logger } from "@/lib/helpers/debug"
import { detectTrackLanguage } from "@/lib/helpers/language"
import { getAssetUrl } from "@/lib/server/assets"
import JASSUB from "jassub"
import type { ASSEvent } from "jassub/dist/worker/util"
import { toast } from "sonner"

const modernWasmUrl = "/jassub/jassub-worker-modern.wasm"
const wasmUrl = "/jassub/jassub-worker.wasm"
const workerUrl = "/jassub/jassub-worker.js"

const subtitleLog = logger("VIDEO CORE SUBTITLES")

const NO_TRACK_NUMBER = -1
const DEFAULT_FONT_NAME = "roboto medium"

// Upper bound on how many subtitle tracks auto-sync will download and score. A Jimaku
// entry can hold 30+ files; scoring them all would mean 30 conversions before we learn
// anything. The list is already in the gateway's preference order, so the correct file
// is near the front in practice.
const MAX_AUTO_SYNC_CANDIDATES = 6

// Per-candidate ceiling on fetching + converting a subtitle. Auto-sync is fire-and-forget,
// so a request that never settles would strand the whole run with no error and no result —
// which is exactly what a shared react-query mutation observer did before conversion moved
// to mutateAsync. A candidate that overruns is simply dropped from scoring.
const AUTO_SYNC_FETCH_TIMEOUT_MS = 20_000

function hexToASSColor(hex: string, alpha: number = 0): number {
    hex = hex.replace(/^#/, "")
    if (hex.length === 3) {
        hex = hex.split("").map(c => c + c).join("")
    }
    const val = parseInt(hex, 16)
    const r = (val >> 16) & 0xFF
    const g = (val >> 8) & 0xFF
    const b = val & 0xFF
    return ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0
}

function isPGS(str: string) {
    return str === "S_HDMV/PGS"
}

// Event or file track info.
export type NormalizedTrackInfo = {
    type: "event" | "file"
    language?: string
    languageIETF?: string
    codecID?: string
    label?: string
    number: number
    forced: boolean
    default: boolean
}

export type SubtitleManagerTrackSelectedEvent = CustomEvent<{ trackNumber: number, kind: "file" | "event" }>
export type SubtitleManagerTrackDeselectedEvent = CustomEvent
export type SubtitleManagerSecondaryTrackSelectedEvent = CustomEvent<{ trackNumber: number, kind: "file" | "event" }>
export type SubtitleManagerSecondaryTrackDeselectedEvent = CustomEvent
export type SubtitleManagerTrackAddedEvent = CustomEvent<{ track: NormalizedTrackInfo }>
export type SubtitleManagerTracksLoadedEvent = CustomEvent<{ tracks: NormalizedTrackInfo[] }>
export type SubtitleManagerDestroyedEvent = CustomEvent
export type SubtitleManagerSettingsUpdatedEvent = CustomEvent<{ settings: VideoCoreSettings }>

/**
 * Emitted once per episode when auto-sync finishes measuring.
 *
 * The manager deliberately does NOT persist the offset itself — it has no access to the
 * jotai stores. It reports the measurement and lets the React layer (which already owns
 * `vc_subtitleOffsetsAtom` and the delay settings) decide what to commit. `applied` is
 * false when the acceptance policy rejected the result; the payload is still emitted so
 * the reason can be logged.
 */
export type SubtitleManagerAutoSyncEvent = CustomEvent<{
    applied: boolean
    reason: string
    trackNumber: number
    offsetSeconds: number
    selection: SyncSelection
}>

interface VideoCoreSubtitleManagerEventMap {
    "trackselected": SubtitleManagerTrackSelectedEvent
    "trackdeselected": SubtitleManagerTrackDeselectedEvent
    "secondarytrackselected": SubtitleManagerSecondaryTrackSelectedEvent
    "secondarytrackdeselected": SubtitleManagerSecondaryTrackDeselectedEvent
    "trackadded": SubtitleManagerTrackAddedEvent
    "tracksloaded": SubtitleManagerTracksLoadedEvent
    "destroyed": SubtitleManagerDestroyedEvent
    "settingsupdated": SubtitleManagerSettingsUpdatedEvent
    "autosynced": SubtitleManagerAutoSyncEvent
}

type CachedEvent = {
    event: MKVParser_SubtitleEvent
    assEvent: ASSEvent
    translatedAssEvent?: ASSEvent
    isTranslating?: boolean
}

// Manages ASS and PGS subtitle streams.
export class VideoCoreSubtitleManager extends EventTarget {
    private readonly videoElement: HTMLVideoElement
    private readonly jassubOffscreenRender: boolean
    libassRenderer: JASSUB | null = null
    pgsRenderer: VideoCorePgsRenderer | null = null
    private settings: VideoCoreSettings
    private defaultSubtitleHeader = `[Script Info]
Title: English (US)
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 640
PlayResY: 360
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default, Roboto Medium,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1.3,0,2,20,20,23,0
[Events]

`

    // Event-based tracks
    private eventTracks: Record<string, {
        info: MKVParser_TrackInfo
        events: Map<string, CachedEvent>
        styles: Record<string, number>
    }> = {}

    // PGS event-based tracks
    private pgsEventTracks: Record<string, {
        info: MKVParser_TrackInfo
        events: Map<string, MKVParser_SubtitleEvent>
    }> = {}

    // URL-based tracks (will use internal API to convert to ASS)
    private fileTracks: Record<string, {
        info: VideoCore_VideoSubtitleTrack
        content: string | null // converted content
    }> = {}

    private readonly fetchAndConvertToASS?: (url?: string, content?: string) => Promise<string | undefined>
    /**
     * OP/ED boundaries in stream time, read lazily because AniSkip often resolves after the
     * player has already mounted. Used only to add candidate seam positions to auto-sync.
     */
    private readonly getSeamHints?: () => number[]
    // Sends translate request to the server
    private readonly sendTranslateRequest: (text?: string, track?: VideoCore_VideoSubtitleTrack) => void
    private readonly translateFn?: (event: CachedEvent) => void

    private playbackInfo: VideoCore_VideoPlaybackInfo
    private currentTrackNumber: number = NO_TRACK_NUMBER
    private secondaryTrackNumber: number = NO_TRACK_NUMBER
    private fonts: string[] = []
    private hmacToken: string = ""

    private _onSelectedTrackChanged?: (track: number | null) => void
    private _onSelectedSecondaryTrackChanged?: (track: number | null) => void
    private _onTracksLoaded?: (tracks: NormalizedTrackInfo[]) => void

    // Render mode: canvas (JASSUB) or html (DOM-based)
    private renderMode: SubtitleRenderMode = "canvas"

    // Translation is active
    private translationTargetLang: string | null = null
    private shouldTranslate: string | null = null
    // Event translation queue. Once translated the event is removed
    private eventTranslationQueue = new Map<string, CachedEvent>()
    // Remember the translated file tracks to avoid re-fetching them
    private translatedFileTracks = new Map<number, { translating: boolean }>()

    // Auto-sync runs at most once per manager (i.e. once per episode/stream load).
    private autoSyncStarted = false
    // Set as soon as the user picks a track by hand. Auto-sync will still measure and
    // report an offset after that, but it will not move the selection out from under them.
    private userSelectedTrack = false
    // Parsed cue timings per track, kept separate from `fileTracks[n].content` so that
    // scoring never touches what gets handed to the renderer.
    private syncCueCache = new Map<number, CueInterval[]>()

    constructor({
        videoElement,
        jassubOffscreenRender,
        playbackInfo,
        settings,
        fetchAndConvertToASS,
        getSeamHints,
        sendTranslateRequest,
        translateTargetLang,
        hmacToken,
    }: {
        videoElement: HTMLVideoElement
        jassubOffscreenRender: boolean
        playbackInfo: VideoCore_VideoPlaybackInfo
        settings: VideoCoreSettings
        fetchAndConvertToASS: (url?: string, content?: string) => Promise<string | undefined>
        getSeamHints?: () => number[]
        sendTranslateRequest: (text?: string, track?: VideoCore_VideoSubtitleTrack) => void
        translateTargetLang: string | null
        hmacToken?: string
    }) {
        super()
        this.videoElement = videoElement
        this.jassubOffscreenRender = jassubOffscreenRender
        this.playbackInfo = playbackInfo
        this.settings = settings
        this.hmacToken = hmacToken || ""
        this.shouldTranslate = translateTargetLang
        this.translationTargetLang = translateTargetLang
        this.fetchAndConvertToASS = fetchAndConvertToASS
        this.getSeamHints = getSeamHints
        this.sendTranslateRequest = sendTranslateRequest
        this.translateFn = function (cached: CachedEvent) {
            cached.isTranslating = true
            // Send the request to the server
            this.sendTranslateRequest?.(cached.event.text)
            // Add it to the queue
            this.eventTranslationQueue.set(cached.event.text, cached)
        }

        /*
         * Event Tracks
         */
        if (this.playbackInfo?.mkvMetadata?.subtitleTracks) {
            for (const track of this.playbackInfo.mkvMetadata.subtitleTracks) {
                this._addEventTrack(track)
            }
            this._storeEventTrackStyles()
        }

        /*
         * File Tracks
         */
        if (this.playbackInfo?.subtitleTracks) {
            let trackNumber = 1000
            for (const track of this.playbackInfo.subtitleTracks) {
                if (track.useLibassRenderer) {
                    this.fileTracks[trackNumber] = {
                        info: {
                            ...track,
                            index: trackNumber,
                        },
                        content: null,
                    }
                    trackNumber++
                }
            }
        }

        this._onTracksLoaded?.(this._getTracks())

        // Select default track if we have any tracks
        if (this.playbackInfo?.mkvMetadata?.subtitleTracks || Object.keys(this.fileTracks).length > 0) {
            this._selectDefaultTrack()
        }

        // Apply subtitle delay from settings
        this.setSubtitleDelay(settings.subtitleDelay)

        subtitleLog.info("Text tracks", this.videoElement.textTracks)
        subtitleLog.info("Event Tracks", this.eventTracks)
        subtitleLog.info("PGS Event Tracks", this.pgsEventTracks)
        subtitleLog.info("File tracks", this.fileTracks)
    }

    private async _init() {
        if (!this.libassRenderer) {
            // Hold a LOCAL handle to the instance we create here. The manager can
            // be destroy()'d while we await below (rapid episode/stream switch, or
            // the player reloading when the gateway's server list updates late);
            // destroy() sets `this.libassRenderer = null`. Reading the field after
            // an await would then null-deref — that is exactly the crash that
            // froze the player:
            //   "TypeError: Cannot read properties of null (reading 'renderer')".
            // Using a local ref (never nulled) plus an identity re-check after each
            // await makes init safely abort instead of throwing.
            let renderer: JASSUB | null = null
            try {
                subtitleLog.info("Initializing libass renderer")

                const defaultFontUrl = "/fonts/Roboto-Medium.ttf"

                renderer = new JASSUB({
                    video: this.videoElement,
                    subContent: this.defaultSubtitleHeader,
                    wasmUrl: wasmUrl,
                    workerUrl: workerUrl,
                    modernWasmUrl: modernWasmUrl,
                    fonts: this.fonts,
                    defaultFont: DEFAULT_FONT_NAME,
                    availableFonts: {
                        [DEFAULT_FONT_NAME]: defaultFontUrl,
                    },
                    debug: false,
                })
                this.libassRenderer = renderer

                subtitleLog.info("Waiting for libass renderer...")
                await renderer.ready
                // Torn down while initializing? destroy() already disposed our
                // instance and nulled the field — abort before touching .renderer.
                if (this.libassRenderer !== renderer) {
                    subtitleLog.info("Subtitle manager torn down during libass init; aborting")
                    return
                }
                subtitleLog.info("Libass renderer ready")


                this.fonts = this.playbackInfo.mkvMetadata?.attachments?.filter(a => a.type === "font")
                    ?.map(a => `${getServerBaseUrl()}/api/v1/directstream/att/${a.filename}${this.hmacToken}`) || []

                if (!this.playbackInfo.libassFonts) {
                    this.fonts = [...new Set([...this.fonts, defaultFontUrl])]
                }

                this.fonts = [defaultFontUrl, ...this.fonts]

                await renderer.renderer.addFonts(this.fonts)
                if (this.libassRenderer !== renderer) {
                    subtitleLog.info("Subtitle manager torn down during font load; aborting")
                    return
                }
            }
            catch (e) {
                // A teardown race (instance replaced/nulled by destroy() mid-init)
                // is expected churn — log it quietly. Only a genuine init failure
                // should surface a toast to the user.
                const tornDown = renderer !== null && this.libassRenderer !== renderer
                if (tornDown) {
                    subtitleLog.info("Libass init aborted by teardown", e)
                } else {
                    subtitleLog.error("Error initializing libass renderer", e)
                    toast.error("Error initializing libass renderer: " + e)
                }
            }
        }

        if (!this.pgsRenderer && this.playbackInfo.mkvMetadata?.tracks?.some(t => isPGS(t.codecID))) {
            this.pgsRenderer = new VideoCorePgsRenderer({
                videoElement: this.videoElement,
                // debug: process.env.NODE_ENV === "development",
            })
        }
    }

    addEventListener<K extends keyof VideoCoreSubtitleManagerEventMap>(
        type: K,
        listener: (this: VideoCoreSubtitleManager, ev: VideoCoreSubtitleManagerEventMap[K]) => any,
        options?: boolean | AddEventListenerOptions,
    ): void
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void

    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void {
        super.addEventListener(type, listener, options)
    }

    removeEventListener<K extends keyof VideoCoreSubtitleManagerEventMap>(
        type: K,
        listener: (this: VideoCoreSubtitleManager, ev: VideoCoreSubtitleManagerEventMap[K]) => any,
        options?: boolean | EventListenerOptions,
    ): void
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ): void

    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ): void {
        super.removeEventListener(type, listener, options)
    }

    getSelectedTrackNumberOrNull(): number | null {
        if (this.currentTrackNumber === NO_TRACK_NUMBER) return null
        return this.currentTrackNumber
    }

    getTrackContent(number: number): string | null {
        return this.fileTracks[number]?.content || null
    }

    getSelectedSecondaryTrackNumberOrNull(): number | null {
        if (this.secondaryTrackNumber === NO_TRACK_NUMBER) return null
        return this.secondaryTrackNumber
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Sets the track to no track.
    setNoTrack() {
        this.currentTrackNumber = NO_TRACK_NUMBER
        this._disableNativeTextTracks()
        this.libassRenderer?.renderer?.setTrack(this.defaultSubtitleHeader)
        this.libassRenderer?.resize?.()
        this.pgsRenderer?.clear()
        this._onSelectedTrackChanged?.(NO_TRACK_NUMBER)

        const event: SubtitleManagerTrackDeselectedEvent = new CustomEvent("trackdeselected")
        this.dispatchEvent(event)
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // Sets the secondary track to no track.
    setNoSecondaryTrack() {
        this.secondaryTrackNumber = NO_TRACK_NUMBER
        this._onSelectedSecondaryTrackChanged?.(NO_TRACK_NUMBER)

        const event: SubtitleManagerSecondaryTrackDeselectedEvent = new CustomEvent("secondarytrackdeselected")
        this.dispatchEvent(event)
    }

    setTrackChangedEventListener(callback: (track: number | null) => void) {
        this._onSelectedTrackChanged = callback
    }

    setSecondaryTrackChangedEventListener(callback: (track: number | null) => void) {
        this._onSelectedSecondaryTrackChanged = callback
    }

    setTracksLoadedEventListener(callback: ((tracks: NormalizedTrackInfo[]) => void)) {
        this._onTracksLoaded = callback
    }

    // Selects a track by its number.
    async selectTrack(trackNumber: number) {
        subtitleLog.info("Track selection requested", trackNumber)
        await this._init()

        this.shouldTranslate = this.translationTargetLang

        // if (this.currentTrackNumber === trackNumber) {
        //     subtitleLog.info("Track already selected", trackNumber)
        //     return
        // }

        if (trackNumber === NO_TRACK_NUMBER) {
            subtitleLog.info("No track selected", trackNumber)
            this.setNoTrack()
            return
        }

        const track = this._getTracks()?.find?.(t => t.number === trackNumber)
        subtitleLog.info("Selecting track", trackNumber, track)

        this._disableNativeTextTracks()

        if (!track) {
            subtitleLog.error("Track not found", trackNumber)
            this.setNoTrack()
            return
        }

        // Dispatch the selected track change event
        this._onSelectedTrackChanged?.(trackNumber)

        this.currentTrackNumber = track.number // update the current track number

        /*
         * File track
         */

        // Check if this is a file track
        // If it is, fetch/convert the content and add it to the libass renderer
        const fileTrack = this.fileTracks[trackNumber]
        if (fileTrack) {
            this._handleFileTrack(trackNumber, fileTrack)
            return
        }

        /*
         * Event track
         */

        const eventTrack = this.eventTracks[trackNumber]
        if (!eventTrack) {
            subtitleLog.warning("Event track not found", trackNumber)
            return
        }

        // Don't tanslate if the event track language matches the target language
        if (!!this.translationTargetLang && detectTrackLanguage(eventTrack.info) === this.translationTargetLang) {
            subtitleLog.info("Translation target language matches event track language, not translating")
            this.shouldTranslate = null
        }

        // Handle event track
        const codecPrivate = eventTrack.info.codecPrivate?.slice?.(0, -1) || this.defaultSubtitleHeader

        // Check if this is a PGS track
        if (isPGS(eventTrack.info.codecID)) {
            // Clear PGS renderer and libass
            this.pgsRenderer?.clear()
            this.libassRenderer?.renderer?.setTrack(this.defaultSubtitleHeader)

            // Add all cached PGS events from the event map
            const pgsTrack = this.pgsEventTracks[track.number]
            if (pgsTrack?.events) {
                subtitleLog.info("Found", pgsTrack.events.size, "PGS events for track", track.number)
                for (const event of pgsTrack.events.values()) {
                    this._addPgsEvent(event)
                }
                this.pgsRenderer?.resize?.()
            } else {
                subtitleLog.warning("No PGS events found for track", track.number)
            }
        } else {
            // Handle regular ASS/text subtitles
            this.pgsRenderer?.clear()

            // Set the track (skip JASSUB if in HTML mode)
            if (this.renderMode !== "html") {
                this.libassRenderer?.renderer?.setTrack(codecPrivate)
                // Apply customization to Default styles
                await this._applySubtitleCustomization()
                this._populateEventTrack(trackNumber)
            }
        }

        const selectedEvent: SubtitleManagerTrackSelectedEvent = new CustomEvent("trackselected", { detail: { trackNumber, kind: "event" } })
        this.dispatchEvent(selectedEvent)
    }

    // Selects a secondary track by its number (for dual subtitle display in HTML mode).
    async selectSecondaryTrack(trackNumber: number) {
        subtitleLog.info("Secondary track selection requested", trackNumber)

        if (trackNumber === NO_TRACK_NUMBER) {
            subtitleLog.info("No secondary track selected", trackNumber)
            this.setNoSecondaryTrack()
            return
        }

        // Don't allow selecting the same track as primary
        if (trackNumber === this.currentTrackNumber) {
            subtitleLog.warning("Cannot select the same track as primary for secondary", trackNumber)
            return
        }

        const track = this._getTracks()?.find?.(t => t.number === trackNumber)
        subtitleLog.info("Selecting secondary track", trackNumber, track)

        if (!track) {
            subtitleLog.error("Secondary track not found", trackNumber)
            this.setNoSecondaryTrack()
            return
        }

        // Dispatch the selected track change event
        this._onSelectedSecondaryTrackChanged?.(trackNumber)

        this.secondaryTrackNumber = track.number

        // Determine kind (file or event)
        const fileTrack = this.fileTracks[trackNumber]
        const kind: "file" | "event" = fileTrack ? "file" : "event"

        // For file tracks, ensure the content is loaded before dispatching the event
        if (fileTrack && !fileTrack.content) {
            subtitleLog.info("Loading secondary file track content", trackNumber)
            await this._loadSecondaryFileTrackContent(trackNumber, fileTrack)
        }

        const selectedEvent: SubtitleManagerSecondaryTrackSelectedEvent = new CustomEvent("secondarytrackselected", { detail: { trackNumber, kind } })
        this.dispatchEvent(selectedEvent)
    }

    // Loads file track content for secondary track (without JASSUB rendering)
    private async _loadSecondaryFileTrackContent(trackNumber: number, fileTrack: { info: VideoCore_VideoSubtitleTrack, content: string | null }) {
        try {
            if (fileTrack.info.type === "ass") {
                // Fetch ASS content directly
                const content = fileTrack.info.src
                    ? await fetch(fileTrack.info.src).then(res => res.text())
                    : (fileTrack.info.content || "")
                this.fileTracks[trackNumber].content = content
                subtitleLog.info("Loaded secondary ASS track content", trackNumber)
            } else {
                // For non-ASS formats, convert to ASS using the converter
                if (this.fetchAndConvertToASS) {
                    const assContent = await this.fetchAndConvertToASS(fileTrack.info.src, fileTrack.info.content)
                    if (assContent) {
                        this.fileTracks[trackNumber].content = assContent
                        subtitleLog.info("Converted and loaded secondary track content", trackNumber)
                    }
                } else {
                    // Fallback: try to fetch raw content for SRT/VTT which can be parsed directly
                    const content = fileTrack.info.src
                        ? await fetch(fileTrack.info.src).then(res => res.text())
                        : (fileTrack.info.content || "")
                    this.fileTracks[trackNumber].content = content
                    subtitleLog.info("Loaded secondary raw track content", trackNumber)
                }
            }
        } catch (error) {
            subtitleLog.error("Error loading secondary file track content", error)
        }
    }

    destroy() {
        subtitleLog.info("Destroying subtitle manager")
        this._disableNativeTextTracks()
        this.libassRenderer?.destroy()
        this.libassRenderer = null
        this.pgsRenderer?.destroy()
        this.pgsRenderer = null
        this.eventTranslationQueue.clear()
        this.translatedFileTracks.clear()
        this.syncCueCache.clear()
        for (const trackNumber in this.eventTracks) {
            this.eventTracks[trackNumber].events.clear()
        }
        this.eventTracks = {}
        for (const trackNumber in this.pgsEventTracks) {
            this.pgsEventTracks[trackNumber].events.clear()
        }
        this.pgsEventTracks = {}
        this.fileTracks = {}
        this.currentTrackNumber = NO_TRACK_NUMBER
        this.secondaryTrackNumber = NO_TRACK_NUMBER

        const event: SubtitleManagerDestroyedEvent = new CustomEvent("destroyed")
        this.dispatchEvent(event)
    }

    private _disableNativeTextTracks() {
        if (!this.videoElement.textTracks) return

        subtitleLog.info("Disabling video element textTracks", this.videoElement.textTracks)
        for (const textTrack of this.videoElement.textTracks) {
            textTrack.mode = "disabled"
        }
        this.videoElement.textTracks.dispatchEvent(new Event("change"))
    }

    getTracks() {
        return this._getTracks()
    }

    getTrack(trackNumber: number | null) {
        return this._getTracks()?.find(t => t.number === (trackNumber ?? NO_TRACK_NUMBER))
    }

    getNextTrackNumber(trackNumber: number | null) {
        const tracks = this._getTracks()
        const nextTrackNumber = tracks.find(t => t.number > (trackNumber ?? NO_TRACK_NUMBER))?.number
        return nextTrackNumber ?? NO_TRACK_NUMBER
    }

    // Update settings and reapply subtitle customization to current track
    async updateSettings(newSettings: VideoCoreSettings) {
        this.settings = newSettings
        // Apply subtitle delay
        await this.setSubtitleDelay(newSettings.subtitleDelay)
        // Reapply customization if a track is currently selected
        if (this.currentTrackNumber !== NO_TRACK_NUMBER) {
            await this._applySubtitleCustomization()
        }

        // Dispatch Settings Updated Event
        const event: SubtitleManagerSettingsUpdatedEvent = new CustomEvent("settingsupdated", { detail: { settings: newSettings } })
        this.dispatchEvent(event)
    }

    updateShouldTranslate(shouldTranslate: string | null) {
        subtitleLog.info("Updating shouldTranslate setting", shouldTranslate)
        // If translation settings changed, we need to refresh the current track
        const translationChanged = this.shouldTranslate !== shouldTranslate
        this.shouldTranslate = shouldTranslate
        this.translationTargetLang = shouldTranslate

        if (translationChanged && this.currentTrackNumber !== NO_TRACK_NUMBER) {
            subtitleLog.info("Translation settings changed, reloading current track")
            this._reloadCurrentTrack()
        }
    }

    // This will record the events and add them to the renderers if they are new.
    async onSubtitleEvents(events: MKVParser_SubtitleEvent[]) {
        const pgsEvents: any[] = []
        const assEvents: CachedEvent[] = []

        for (const event of events) {
            // Check if this is a PGS event
            if (isPGS(event.codecID)) {
                const isNew = this._handlePgsEvent(event, false)
                if (isNew && event.trackNumber === this.currentTrackNumber && this.pgsRenderer) {
                    pgsEvents.push({
                        startTime: event.startTime / 1e3,
                        duration: event.duration / 1e3,
                        imageData: event.text, // base64 PNG
                        width: parseInt(event.extraData?.width || "0", 10),
                        height: parseInt(event.extraData?.height || "0", 10),
                        x: event.extraData?.x ? parseInt(event.extraData.x, 10) : undefined,
                        y: event.extraData?.y ? parseInt(event.extraData.y, 10) : undefined,
                        canvasWidth: event.extraData?.canvas_width ? parseInt(event.extraData.canvas_width, 10) : undefined,
                        canvasHeight: event.extraData?.canvas_height ? parseInt(event.extraData.canvas_height, 10) : undefined,
                        cropX: event.extraData?.crop_x ? parseInt(event.extraData.crop_x, 10) : undefined,
                        cropY: event.extraData?.crop_y ? parseInt(event.extraData.crop_y, 10) : undefined,
                        cropWidth: event.extraData?.crop_width ? parseInt(event.extraData.crop_width, 10) : undefined,
                        cropHeight: event.extraData?.crop_height ? parseInt(event.extraData.crop_height, 10) : undefined,
                    })
                }
            } else {
                // Record the event
                const { isNew, cachedEntry } = this._recordSubtitleEvent(event)
                // Custom: skip JASSUB queueing while in HTML render mode (HtmlSubtitleOverlay renders instead)
                if (isNew && cachedEntry && event.trackNumber === this.currentTrackNumber && this.libassRenderer && this.renderMode !== "html") {
                    assEvents.push(cachedEntry)
                }
            }
        }

        if (pgsEvents.length > 0 && this.pgsRenderer) {
            this.pgsRenderer.addEvents(pgsEvents)
        }

        if (assEvents.length > 0 && this.libassRenderer) {
            for (const cachedEntry of assEvents) {
                if (this.shouldTranslate) {
                    if (cachedEntry.translatedAssEvent) {
                        // already translated, use it
                        this.libassRenderer.renderer.createEvent(cachedEntry.translatedAssEvent)
                    } else {
                        // fetch the translation, it will be rendered once returned
                        this._fetchEventTranslationIfNeeded(cachedEntry)
                    }
                } else {
                    // not translating, use the original event
                    this.libassRenderer.renderer.createEvent(cachedEntry.assEvent)
                }
            }
        }
    }

    async setSubtitleDelay(subtitleDelay: number) {
        // Local ref + identity re-check: destroy() can null this.libassRenderer
        // during the `await ready` below, which previously threw the uncaught
        // "Cannot set properties of null (setting 'timeOffset')".
        const renderer = this.libassRenderer
        if (renderer) {
            await renderer.ready
            if (this.libassRenderer !== renderer) return
            renderer.timeOffset = -subtitleDelay
        }
        if (this.pgsRenderer) this.pgsRenderer.setTimeOffset(-subtitleDelay)
    }

    setRenderMode(mode: SubtitleRenderMode) {
        const previousMode = this.renderMode
        this.renderMode = mode

        if (mode === "html" && this.libassRenderer) {
            // Clear JASSUB canvas when switching to HTML mode to prevent duplicate rendering
            this.libassRenderer.renderer?.setTrack(this.defaultSubtitleHeader)
        } else if (mode === "canvas" && previousMode === "html" && this.currentTrackNumber !== NO_TRACK_NUMBER) {
            // Reload the current track into JASSUB when switching back to canvas mode
            subtitleLog.info("Switching back to canvas mode, reloading track", this.currentTrackNumber)
            this.selectTrack(this.currentTrackNumber)
        }
    }

    getRenderMode(): SubtitleRenderMode {
        return this.renderMode
    }

    getFileTrack(trackNumber: number) {
        return this.fileTracks[trackNumber] || null
    }

    processEventTranslationQueue(original: string, translated: string) {
        const cached = this.eventTranslationQueue.get(original)
        if (!cached) return
        this.eventTranslationQueue.delete(original)
        cached.translatedAssEvent = {
            ...cached.assEvent,
            Text: translated,
        }
        cached.isTranslating = false
        // If the track is still the active one, inject the new event immediately (skip JASSUB if in HTML mode)
        if (this.currentTrackNumber === cached.event.trackNumber && this.libassRenderer && this.renderMode !== "html") {
            this.libassRenderer.renderer.createEvent(cached.translatedAssEvent)
        }
    }

    private _getTracks(): NormalizedTrackInfo[] {
        const eventTracks = Object.values(this.eventTracks).map(t => <NormalizedTrackInfo>({
            type: "event",
            language: t.info.language,
            number: t.info.number,
            label: t.info.name,
            forced: t.info.forced,
            default: t.info.default,
            languageIETF: t.info.languageIETF,
            codecID: t.info.codecID,
        }))

        const fileTracks = Object.entries(this.fileTracks).map(([trackNumber, t]) => <NormalizedTrackInfo>({
            type: "file",
            language: t.info.language,
            number: Number(trackNumber),
            label: t.info.label,
            forced: false,
            default: t.info.default,
        }))

        return [...eventTracks, ...fileTracks].sort((a, b) => a.number - b.number)
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////\

    // +-----------------------+
    // |      Event Tracks     |
    // +-----------------------+

    // Adds a new track AFTER initialization and selects it
    async addFileTrack(track: VideoCore_VideoSubtitleTrack) {
        subtitleLog.info("Subtitle file track added", track)

        // Check if the added track is a translation
        const translatingTrack = this.translatedFileTracks.get(track.index)
        let isTranslated = false
        if (translatingTrack) {
            subtitleLog.info("Subtitle file track is a translation", translatingTrack)
            // already translated, don't add it
            if (!translatingTrack.translating) return
            translatingTrack.translating = false
            isTranslated = true
        }

        const lastFileTrackNumber = Object.keys(this.fileTracks).length
            ? Number(Object.keys(this.fileTracks)[Object.keys(this.fileTracks).length - 1])
            : 999
        const number = lastFileTrackNumber + 1
        this.fileTracks[number] = {
            info: {
                ...track,
                index: number, // update the index (track number)
            },
            content: null,
        }
        // Select the track
        await this.selectTrack(number)
        this.libassRenderer?.resize?.()
        this.pgsRenderer?.resize()

        const tracks = this._getTracks()
        const normalizedTrack = tracks.find(t => t.number === number)
        if (normalizedTrack) {
            const event: SubtitleManagerTrackAddedEvent = new CustomEvent("trackadded", { detail: { track: normalizedTrack } })
            this.dispatchEvent(event)
        }
        const event: SubtitleManagerTracksLoadedEvent = new CustomEvent("tracksloaded", { detail: { tracks: tracks } })
        this.dispatchEvent(event)

        // Flag this nerw track as translated
        if (isTranslated) {
            subtitleLog.info("Added track is translated", track)
            this.translatedFileTracks.set(number, { translating: false })
        }

        this._onTracksLoaded?.(tracks)
    }

    async addEventTrack(track: MKVParser_TrackInfo) {
        subtitleLog.info("Subtitle track added", track)
        this._addEventTrack(track)
        this._storeEventTrackStyles()
        // Select the track
        await this.selectTrack(track.number)
        this.libassRenderer?.resize?.()
        this.pgsRenderer?.resize()

        const tracks = this._getTracks()
        const normalizedTrack = tracks.find(t => t.number === track.number)
        if (normalizedTrack) {
            const event: SubtitleManagerTrackAddedEvent = new CustomEvent("trackadded", { detail: { track: normalizedTrack } })
            this.dispatchEvent(event)
        }
        const event: SubtitleManagerTracksLoadedEvent = new CustomEvent("tracksloaded", { detail: { tracks: tracks } })
        this.dispatchEvent(event)
        this._onTracksLoaded?.(tracks)
    }

    // When called for the first time, it will initialize the libass renderer.
    private async _selectDefaultTrack() {
        if (this.currentTrackNumber !== NO_TRACK_NUMBER) {
            subtitleLog.warning("A track is already selected, cannot select default track")
            return
        }
        const tracks = this._getTracks()
        subtitleLog.info("Selecting default track", tracks)

        if (!tracks?.length) {
            this.setNoTrack()
            return
        }

        if (tracks.length === 1) {
            subtitleLog.info("Only one track found, selecting it")
            await this.selectTrack(tracks[0].number)
            return
        }

        // Split preferred languages by comma and trim whitespace
        const defaultTrackNumber = getDefaultSubtitleTrackNumber(this.settings, tracks)
        subtitleLog.info("Default subtitle track number",
            defaultTrackNumber,
            this.settings.preferredSubtitleLanguage,
            this.settings.preferredSubtitleBlacklist)
        await this.selectTrack(defaultTrackNumber)
        await this._selectDefaultSecondaryTrack(tracks, defaultTrackNumber)
        // Runs after the secondary track is chosen: that track is auto-sync's reference.
        this._maybeAutoSync()
    }

    // Auto-selects the default SECONDARY track (dual subs: e.g. Japanese
    // primary + English secondary) from preferredSecondarySubtitleLanguage.
    // Unlike the primary default there is deliberately NO fallback-to-first:
    // when nothing matches, the secondary stays off.
    private async _selectDefaultSecondaryTrack(
        tracks: { label?: string, language?: string, number: number, forced?: boolean, default?: boolean }[],
        primaryTrackNumber: number,
    ) {
        if (primaryTrackNumber === NO_TRACK_NUMBER) return // no primary -> dual subs make no sense
        if (this.secondaryTrackNumber !== NO_TRACK_NUMBER) return // user already chose one
        const pref = (this.settings.preferredSecondarySubtitleLanguage ?? "").trim()
        if (!pref || pref.toLowerCase() === "none") return

        const candidates = tracks.filter(t => t.number !== primaryTrackNumber)
        if (!candidates.length) return

        const preferredLanguages = pref.split(",").map(l => l.trim()).filter(l => l.length > 0)
        for (const lang of preferredLanguages) {
            // Exact language code match (e.g. embedded MKV tracks: "eng")
            let found = candidates.filter(t => t.language?.toLowerCase() === lang.toLowerCase())
            // Label/language substring match for descriptive names (e.g.
            // onlinestream tracks: "English (AnimeParadise)") — mirrors the
            // primary default's >4-char heuristic.
            if (!found.length && lang.length > 4) {
                found = candidates.filter(t => (t.label || t.language)?.toLowerCase()?.includes(lang.toLowerCase()))
            }
            if (found.length) {
                subtitleLog.info("Auto-selecting default secondary track", found[0].number, pref)
                await this.selectSecondaryTrack(found[0].number)
                return
            }
        }
    }

    // +-----------------------+
    // |       Auto-sync       |
    // +-----------------------+

    /**
     * Records that the user picked a track themselves. Called by the subtitle menu.
     * After this, auto-sync will still report a measured offset but will never change
     * the selection — an automatic feature must not fight an explicit choice.
     */
    markUserTrackSelection() {
        this.userSelectedTrack = true
    }

    private _maybeAutoSync() {
        if (this.autoSyncStarted) return
        if (!this.settings.autoSyncSubtitles) return
        this.autoSyncStarted = true
        // Fire-and-forget. Scoring costs a few subtitle downloads and must never sit
        // between the user and playback starting.
        void this.autoSyncSubtitles().catch(e => subtitleLog.error("Auto-sync failed", e))
    }

    /**
     * Returns the tracks matching a comma-separated language preference, in preference
     * order. Mirrors the matching used for default track selection: an exact language
     * code (embedded MKV tracks: "jpn"), or — for spelled-out preferences — a substring
     * of the descriptive label (onlinestream tracks: "Japanese (Jimaku) — ...").
     */
    private _matchTracksByLanguagePref(tracks: NormalizedTrackInfo[], pref: string | undefined | null): NormalizedTrackInfo[] {
        const cleaned = (pref ?? "").trim()
        if (!cleaned || cleaned.toLowerCase() === "none") return []

        const languages = cleaned.split(",").map(l => l.trim().toLowerCase()).filter(l => l.length > 0)
        const matched: NormalizedTrackInfo[] = []

        for (const lang of languages) {
            for (const track of tracks) {
                if (matched.some(m => m.number === track.number)) continue
                const code = track.language?.toLowerCase()
                const label = (track.label || track.language || "").toLowerCase()
                if (code === lang || (lang.length > 4 && label.includes(lang))) {
                    matched.push(track)
                }
            }
        }

        return matched
    }

    /**
     * Rewrites the track's cached ASS so cues before the seam carry the pre-seam offset,
     * then reloads it into the renderer if that track is on screen. Returns whether the
     * rewrite happened — the caller must not report the post-seam offset otherwise.
     */
    private async _bakePreSeamShift(trackNumber: number, split: SplitAlignment): Promise<boolean> {
        const fileTrack = this.fileTracks[trackNumber]
        if (!fileTrack?.content) {
            subtitleLog.warning("Auto-sync: no cached content to apply the split to", trackNumber)
            return false
        }

        const delta = split.offsetBefore - split.offsetAfter
        const shifted = shiftAssCuesBefore(fileTrack.content, split.atSeconds, delta)
        if (shifted === fileTrack.content) {
            subtitleLog.warning("Auto-sync: split rewrite changed nothing", trackNumber)
            return false
        }

        this.fileTracks[trackNumber].content = shifted
        // Invalidate the parsed cues; they no longer describe the stored content.
        this.syncCueCache.delete(trackNumber)

        if (this.currentTrackNumber === trackNumber && this.renderMode !== "html") {
            this.libassRenderer?.renderer?.setTrack(shifted)
            await this._applySubtitleCustomization()
            await this.libassRenderer?.resize?.()
        }
        subtitleLog.info("Auto-sync: applied pre-seam shift", { trackNumber, delta: Number(delta.toFixed(2)) })
        return true
    }

    /** Rejects if the wrapped promise hasn't settled within AUTO_SYNC_FETCH_TIMEOUT_MS. */
    private _withTimeout<T>(p: Promise<T> | undefined, what: string): Promise<T | undefined> {
        if (!p) return Promise.resolve(undefined)
        let timer: ReturnType<typeof setTimeout>
        return Promise.race([
            p,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`auto-sync timed out: ${what}`)), AUTO_SYNC_FETCH_TIMEOUT_MS)
            }),
        ]).finally(() => clearTimeout(timer)) as Promise<T | undefined>
    }

    /** Cue timings for a track, fetching and parsing its content if needed. */
    private async _cuesForSync(trackNumber: number): Promise<CueInterval[]> {
        const cached = this.syncCueCache.get(trackNumber)
        if (cached) return cached

        let cues: CueInterval[] = []

        const eventTrack = this.eventTracks[trackNumber]
        if (eventTrack) {
            // Embedded track — already parsed by the MKV demuxer, in seconds.
            cues = Array.from(eventTrack.events.values()).map(c => ({
                start: c.event.startTime,
                end: c.event.startTime + c.event.duration,
            }))
        } else {
            const fileTrack = this.fileTracks[trackNumber]
            if (fileTrack?.content) {
                cues = parseCues(fileTrack.content)
            } else if (fileTrack?.info?.src) {
                // Prefer the server-side converter over a browser fetch: it normalizes
                // every format to ASS *and* retrieves the URL server-side, so subtitle
                // hosts that send no CORS headers (jimaku.cc among them) can still be
                // scored. The raw fetch is only a fallback for same-origin sources.
                let content: string | undefined
                try {
                    content = await this._withTimeout(
                        this.fetchAndConvertToASS?.(fileTrack.info.src, undefined),
                        `convert track ${trackNumber}`,
                    )
                }
                catch (e) {
                    subtitleLog.warning("Auto-sync: conversion failed for track", trackNumber, e)
                }
                if (!content) {
                    try {
                        content = await fetch(fileTrack.info.src).then(res => res.text())
                    }
                    catch (e) {
                        subtitleLog.warning("Auto-sync: fetch failed for track", trackNumber, e)
                    }
                }
                cues = content ? parseCues(content) : []
            } else if (fileTrack?.info?.content) {
                cues = parseCues(fileTrack.info.content)
            }
        }

        this.syncCueCache.set(trackNumber, cues)
        return cues
    }

    /**
     * Measures which subtitle track actually matches this episode and by how much it is
     * offset, using a reference track known to be in sync with the audio.
     *
     * Emits an "autosynced" event with the measurement. Applying the offset is left to
     * the React layer, which owns the persisted per-episode offsets.
     */
    async autoSyncSubtitles(): Promise<SyncSelection | null> {
        const tracks = this._getTracks().filter(t => !isPGS(t.codecID ?? ""))
        if (tracks.length < 2) return null // need a reference plus at least one candidate

        // The reference must be trusted to match the audio. The secondary track is
        // exactly that by construction — the provider's own subtitle for the stream being
        // played, or an embedded track from the same file — so prefer whatever is
        // already selected there before falling back to the language preference.
        const referenceTrack = this.secondaryTrackNumber !== NO_TRACK_NUMBER
            ? tracks.find(t => t.number === this.secondaryTrackNumber)
            : this._matchTracksByLanguagePref(tracks, this.settings.preferredSecondarySubtitleLanguage)[0]

        if (!referenceTrack) {
            subtitleLog.info("Auto-sync: no reference track available, skipping")
            return null
        }

        const candidateTracks = this._matchTracksByLanguagePref(tracks, this.settings.preferredSubtitleLanguage)
            .filter(t => t.number !== referenceTrack.number)
            .slice(0, MAX_AUTO_SYNC_CANDIDATES)

        if (!candidateTracks.length) {
            subtitleLog.info("Auto-sync: no candidate tracks in the preferred language, skipping")
            return null
        }

        subtitleLog.info("Auto-sync: scoring", candidateTracks.length, "candidates against", referenceTrack.label || referenceTrack.language)

        const [referenceCues, candidateCues] = await Promise.all([
            this._cuesForSync(referenceTrack.number),
            Promise.all(candidateTracks.map(t => this._cuesForSync(t.number))),
        ])

        const candidates: SyncCandidate[] = candidateTracks
            .map((t, i) => ({
                trackNumber: t.number,
                label: t.label || t.language || `Track ${t.number}`,
                cues: candidateCues[i],
            }))
            .filter(c => c.cues.length > 0)

        const selection = selectAndAlign(referenceCues, candidates, {}, this.currentTrackNumber)
        if (!selection) {
            subtitleLog.info("Auto-sync: not enough data to measure (sparse reference or no parsable candidate)")
            return null
        }

        subtitleLog.info("Auto-sync result", {
            verdict: selection.verdict,
            margin: selection.margin,
            ranked: selection.ranked.map(r => ({
                label: r.label,
                offset: r.correlation.offsetSeconds,
                overlap: Math.round(r.correlation.overlapSeconds),
                coverage: Number(r.correlation.coverage.toFixed(3)),
                peakRatio: Number(r.correlation.peakRatio.toFixed(2)),
                lagMargin: Number(r.correlation.lagMargin.toFixed(2)),
            })),
        })

        const { best, verdict } = selection

        // Switch to the winning file only when the user has not already chosen one.
        if (verdict.accept && !this.userSelectedTrack && best.trackNumber !== this.currentTrackNumber) {
            subtitleLog.info("Auto-sync: switching to better-matching track", best.trackNumber, best.label)
            await this.selectTrack(best.trackNumber)
        }

        // A cross-sourced subtitle often needs two offsets, not one: the sources disagree
        // about the opening, so everything before the seam is shifted differently from
        // everything after it. Look for that only on the winner, and only once the file is
        // trusted — a seam found in a mismatched file is meaningless.
        let offsetSeconds = best.correlation.offsetSeconds
        if (verdict.accept) {
            const winnerCues = this.syncCueCache.get(best.trackNumber) ?? []
            const seamHintsSeconds = this.getSeamHints?.() ?? []
            const split = findSplitAlignment(
                referenceCues,
                winnerCues,
                best.correlation.overlapSeconds,
                best.correlation.offsetSeconds,
                { seamHintsSeconds },
            )
            if (split) {
                subtitleLog.info("Auto-sync: split alignment detected", {
                    seamAt: Number(split.atSeconds.toFixed(2)),
                    before: split.offsetBefore,
                    after: split.offsetAfter,
                    segmentGain: Number(split.segmentGain.toFixed(2)),
                    segmentLagMargin: Number(split.segmentLagMargin.toFixed(2)),
                    cues: `${split.cuesBefore}/${split.cuesAfter}`,
                })
                // Keep the post-seam offset as the global delay (it covers most of the
                // episode and stays the number shown and adjustable in the UI), and bake
                // the difference into the pre-seam cues.
                if (await this._bakePreSeamShift(best.trackNumber, split)) {
                    offsetSeconds = split.offsetAfter
                }
            }
        }

        const event: SubtitleManagerAutoSyncEvent = new CustomEvent("autosynced", {
            detail: {
                applied: verdict.accept,
                reason: verdict.reason,
                trackNumber: best.trackNumber,
                // Same sign convention as `subtitleDelay`: positive means the subtitles
                // need to appear later. With a seam this is the POST-seam offset; the
                // pre-seam difference is already baked into the cue timings.
                offsetSeconds,
                selection,
            },
        })
        this.dispatchEvent(event)

        return selection
    }

    private _handlePgsEvent(event: MKVParser_SubtitleEvent, renderImmediately = true) {
        // Ensure the PGS track exists
        if (!this.pgsEventTracks[event.trackNumber]) {
            subtitleLog.warning("PGS track not initialized for track number", event.trackNumber)
            return false
        }

        const trackEventMap = this.pgsEventTracks[event.trackNumber].events
        const eventKey = this._getPgsEventKey(event)

        // Check if the event is already recorded
        if (trackEventMap.has(eventKey)) {
            return false
        }

        // Store the event
        trackEventMap.set(eventKey, event)

        // If this is the currently selected track, add the event to the renderer
        if (renderImmediately && event.trackNumber === this.currentTrackNumber && this.pgsRenderer) {
            this._addPgsEvent(event)
        }

        return true
    }

    private _getPgsEventKey(event: MKVParser_SubtitleEvent): string {
        return `${event.startTime}-${event.duration}-${event.text.substring(0, 50)}`
    }

    private _addPgsEvent(event: MKVParser_SubtitleEvent) {
        if (!this.pgsRenderer) {
            return
        }

        const pgsEvent = {
            startTime: event.startTime / 1e3,
            duration: event.duration / 1e3,
            imageData: event.text, // base64 PNG
            width: parseInt(event.extraData?.width || "0", 10),
            height: parseInt(event.extraData?.height || "0", 10),
            x: event.extraData?.x ? parseInt(event.extraData.x, 10) : undefined,
            y: event.extraData?.y ? parseInt(event.extraData.y, 10) : undefined,
            canvasWidth: event.extraData?.canvas_width ? parseInt(event.extraData.canvas_width, 10) : undefined,
            canvasHeight: event.extraData?.canvas_height ? parseInt(event.extraData.canvas_height, 10) : undefined,
            cropX: event.extraData?.crop_x ? parseInt(event.extraData.crop_x, 10) : undefined,
            cropY: event.extraData?.crop_y ? parseInt(event.extraData.crop_y, 10) : undefined,
            cropWidth: event.extraData?.crop_width ? parseInt(event.extraData.crop_width, 10) : undefined,
            cropHeight: event.extraData?.crop_height ? parseInt(event.extraData.crop_height, 10) : undefined,
        }

        this.pgsRenderer.addEvent(pgsEvent)
    }

    private async _applySubtitleCustomization() {
        if (!this.libassRenderer) {
            return
        }

        await this.libassRenderer.ready
        // Handle undefined or disabled customization
        if (!this.settings.subtitleCustomization?.enabled) {
            // Disable style override if customization is disabled
            this.libassRenderer.renderer.disableStyleOverride()
            this.libassRenderer.renderer.setDefaultFont(DEFAULT_FONT_NAME)
            return
        }

        // check if the track has only one style, if so, apply the customization to that style
        let found = false
        const eventTrack = this.eventTracks[this.currentTrackNumber]
        if (eventTrack) {
            found = true
            if (eventTrack.styles && Object.keys(eventTrack.styles).length > 1) {
                subtitleLog.info("Track has multiple styles, not applying customization")
                return
            }
        }
        const fileTrack = this.fileTracks[this.currentTrackNumber]
        if (fileTrack) {
            found = true
            // if it's a file track, it was converted from another format so has only one style
        }

        if (!found) return

        const opts = this.settings.subtitleCustomization

        const primaryColor = hexToASSColor(vc_getSubtitleStyle(opts, "primaryColor"), 0)
        const outlineColor = hexToASSColor(vc_getSubtitleStyle(opts, "outlineColor"), 0)
        const backColor = hexToASSColor(vc_getSubtitleStyle(opts, "backColor"), vc_getSubtitleStyle(opts, "backColorOpacity"))

        // devnote: jassub scales down to 30% of the og scale
        // /jassub/blob/main/src/JASSUB.cpp#L709
        let customStyle = {
            Name: "CustomDefault",
            FontName: DEFAULT_FONT_NAME, // opts.fontName || DEFAULT_FONT_NAME,
            FontSize: vc_getSubtitleStyle(opts, "fontSize"),
            PrimaryColour: primaryColor,
            SecondaryColour: primaryColor,
            OutlineColour: outlineColor,
            BackColour: backColor,
            ScaleX: ((100) / 100),
            ScaleY: ((100) / 100),
            Outline: vc_getSubtitleStyle(opts, "outline"),
            Shadow: vc_getSubtitleStyle(opts, "shadow"),
            MarginV: 120,
            BorderStyle: 1,
            Alignment: 2, // Bottom center
            MarginL: 20,
            MarginR: 20,
            Bold: 0, // customization.bold ? 1 : 0,
            Encoding: 1,
            Justify: 0,
            Blur: 0,
            Italic: 0,
            Underline: 0,
            StrikeOut: 0,
            Spacing: 0,
            Angle: 0,
            treat_fontname_as_pattern: 0,
        }

        // Apply font change
        // fontName can be something like "Noto Sans SC" or "Noto Sans SC.ttf"
        if (opts.fontName) {
            // clean font name
            const _fontName = opts.fontName.trim()
            let url = getAssetUrl(`${_fontName}.woff2`)
            if (_fontName.includes(".")) {
                url = getAssetUrl(_fontName) // use the fontname as filename if there's an extension
            }
            const fontName = _fontName.split(".")[0]

            subtitleLog.info("Applying font change", url, ", setting default font to", fontName)

            // add font if it's not already added
            if (!this.fonts.includes(url)) {
                subtitleLog.info("Adding font to renderer", fontName)
                // this.libassRenderer.renderer.setDefaultFont(fontName)
                this.fonts.push(url)
                this.libassRenderer.renderer.addFonts([url])
            }

            await this.libassRenderer!.renderer.setDefaultFont(fontName)
            customStyle.FontName = fontName
            await this.libassRenderer.renderer.styleOverride(customStyle)
        } else {
            await this.libassRenderer.renderer.setDefaultFont(DEFAULT_FONT_NAME)
            await this.libassRenderer.renderer.styleOverride(customStyle)
        }

        await this.libassRenderer.resize()
        subtitleLog.info("Applied subtitle customization override", customStyle)
    }

    private __eventMapKey(event: MKVParser_SubtitleEvent): string {
        if (event.extraData && event.extraData["_id"]) {
            return event.extraData["_id"]
        }
        return `${event.trackNumber}:${event.startTime}:${event.duration}:${this.__fastStringHash(event.text)}`
    }

    // djb2 hash for string hashing
    private __fastStringHash(str: string): number {
        let hash = 5381
        for (let i = 0, len = str.length; i < len; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
        }
        return hash >>> 0
    }

    // Stores the styles for each track.
    private _storeEventTrackStyles() {
        if (!this.playbackInfo?.mkvMetadata?.subtitleTracks) return
        for (const track of this.playbackInfo.mkvMetadata.subtitleTracks) {
            const codecPrivate = track.codecPrivate?.slice?.(0, -1) || this.defaultSubtitleHeader
            const lines = codecPrivate.replaceAll("\r\n", "\n").split("\n").filter(line => line.startsWith("Style:"))
            let index = 1
            const s: Record<string, number> = {}
            this.eventTracks[track.number].styles = s // reset styles
            for (const line of lines) {
                let styleName = line.split("Style:")[1]
                styleName = (styleName.split(",")[0] || "").trim()
                if (styleName && !s[styleName]) {
                    s[styleName] = index++
                }
            }
            this.eventTracks[track.number].styles = s
        }
    }

    private async _reloadCurrentTrack() {
        const track = this.currentTrackNumber
        // effectively flushes the renderer and re-adds events
        // using the new settings logic (skip JASSUB if in HTML mode)
        if (this.libassRenderer && this.renderMode !== "html") {
            await this.libassRenderer.ready
            this.libassRenderer?.renderer?.setTrack(this.eventTracks[track]?.info.codecPrivate?.slice(0, -1) || this.defaultSubtitleHeader)
            await this._applySubtitleCustomization()

            // Re-run the selection logic to populate events
            if (this.eventTracks[track]) {
                this._populateEventTrack(track)
            }
        }

        // Run translation logic if needed
        if (this.fileTracks[track] && this.shouldTranslate) {
            this._translateFileTrack(track)
        }
    }

    /**
     * Iterates all cached events and adds them to the renderer.
     * Handles fetching translations for existing events in the background.
     */
    private _populateEventTrack(trackNumber: number) {
        const trackEventMap = this.eventTracks[trackNumber]?.events
        if (!trackEventMap) return

        subtitleLog.info(`Populating ${trackEventMap.size} events for track ${trackNumber}`)

        for (const cached of trackEventMap.values()) {
            if (this.shouldTranslate) {
                if (cached.translatedAssEvent) {
                    // already translated, use it
                    this.libassRenderer?.renderer?.createEvent(cached.translatedAssEvent)
                } else {
                    // fetch the translation, it will be rendered by the callback
                    this._fetchEventTranslationIfNeeded(cached)
                }
            } else {
                // normal flow, just render the event
                this.libassRenderer?.renderer?.createEvent(cached.assEvent)
            }
        }

        this.libassRenderer?.resize?.()
    }

    private _createAssEvent(event: MKVParser_SubtitleEvent, index: number): ASSEvent {
        return {
            Start: event.startTime,
            Duration: event.duration,
            Style: event.extraData?.style ? this.eventTracks[event.trackNumber]?.styles?.[event.extraData?.style ?? "Default"] : 1,
            Name: event.extraData?.name ?? "",
            MarginL: event.extraData?.marginL ? Number(event.extraData.marginL) : 0,
            MarginR: event.extraData?.marginR ? Number(event.extraData.marginR) : 0,
            MarginV: event.extraData?.marginV ? Number(event.extraData.marginV) : 0,
            Effect: event.extraData?.effect ?? "",
            Text: event.text,
            ReadOrder: event.extraData?.readOrder ? Number(event.extraData.readOrder) : 1,
            Layer: event.extraData?.layer ? Number(event.extraData.layer) : 0,
            // index is based on the order of the events in the record
            // _index: index,
        }
    }

    private _addEventTrack(track: MKVParser_TrackInfo) {
        this.eventTracks[track.number] = {
            info: track,
            events: new Map(),
            styles: {},
        }

        // If this is a PGS track, initialize it in the PGS events map
        // PGS tracks will also have an entry in eventTracks
        if (isPGS(track.codecID)) {
            this.pgsEventTracks[track.number] = {
                info: track,
                events: new Map(),
            }
        }
    }

    private _fetchEventTranslationIfNeeded(cached: CachedEvent) {
        if (!this.translateFn) return
        if (cached.translatedAssEvent || cached.isTranslating) return
        if (!cached.event.text) return

        this.translateFn(cached)
    }

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // +-----------------------+
    // |      File Tracks      |
    // +-----------------------+

    private _recordSubtitleEvent(event: MKVParser_SubtitleEvent): { isNew: boolean, cachedEntry?: CachedEvent } {
        // no track map
        const trackEventMap = this.eventTracks[event.trackNumber]?.events
        if (!trackEventMap) return { isNew: false, cachedEntry: undefined }

        const eventKey = this.__eventMapKey(event)

        // return the cached entry if it exists
        if (trackEventMap.has(eventKey)) {
            return { isNew: false, cachedEntry: trackEventMap.get(eventKey) }
        }

        // create a new entry
        const assEvent = this._createAssEvent(event, trackEventMap.size)
        const cachedEntry: CachedEvent = {
            event,
            assEvent,
        }
        trackEventMap.set(eventKey, cachedEntry)
        return { isNew: true, cachedEntry }
    }

    // Called after selecting a non-translated file and shouldTranslate is true.
    private _translateFileTrack(trackNumber: number) {
        if (!this.shouldTranslate) return
        const trackToTranslate = this.fileTracks[trackNumber]
        if (!trackToTranslate) return

        // Stop other files from translating
        for (const [tn, translatingTrack] of this.translatedFileTracks.entries()) {
            if (translatingTrack.translating && tn !== trackNumber) {
                translatingTrack.translating = false
            }
        }

        // If already added, stop
        const translatingTrack = this.translatedFileTracks.get(trackNumber)
        if (translatingTrack) {
            return
        }

        // Check if it's not the same as target language
        const t = Object.values(this.fileTracks).find(t => detectTrackLanguage(t.info) === this.shouldTranslate)
        if (t && t.info.index !== trackNumber) {
            subtitleLog.info(`Track ${t.info} is already in target language`, trackNumber, ", selecting it instead")
            if (!this.translatedFileTracks.has(t.info.index)) {
                this.selectTrack(t.info.index)
            }
            this.translatedFileTracks.set(trackNumber, { translating: false })
            this.translatedFileTracks.set(t.info.index, { translating: false })
            return
        }

        // Add it, then send translate request
        this.translatedFileTracks.set(trackNumber, { translating: true })
        // Send server translate request
        this.sendTranslateRequest(undefined, trackToTranslate.info)
    }


    // Fetches the track's content and converts it to ASS.
    // If the content is already fetched, it will load it.
    private async _handleFileTrack(trackNumber: number, fileTrack: { info: VideoCore_VideoSubtitleTrack, content: string | null }) {
        subtitleLog.info("Handling file track", trackNumber, fileTrack.info)

        if (!this.fetchAndConvertToASS) {
            subtitleLog.error("fetchAndConvertToASS callback not provided")
            return
        }

        // If content is already loaded, use it
        if (!!fileTrack.content) {
            subtitleLog.info("Using cached converted content for track", trackNumber)
            // Skip JASSUB if in HTML mode
            if (this.renderMode !== "html") {
                this.libassRenderer?.renderer?.setTrack(fileTrack.content)
                await this._applySubtitleCustomization()
                await this.libassRenderer?.resize?.()
            }
            this.pgsRenderer?.resize()
            return
        }

        // Convert the subtitle to ASS format
        if (fileTrack.info.type === "ass") {
            try {
                if (fileTrack.info.src) subtitleLog.info("Fetching subtitle content", fileTrack.info.src)
                // fetch subtitle file content
                const content = fileTrack.info.src ? await fetch(fileTrack.info.src).then(res => res.text()) : (fileTrack.info.content || "")
                this.fileTracks[trackNumber].content = content // cache it
                // Skip JASSUB if in HTML mode
                if (this.renderMode !== "html") {
                    this.libassRenderer?.renderer?.setTrack(content) // load it
                    await this._applySubtitleCustomization()
                    await this.libassRenderer?.resize?.()
                }
                this.pgsRenderer?.resize()
            }
            catch (error) {
                subtitleLog.error("Error fetching subtitle content", error)
                toast.error("Failed to load subtitle track")
            }
        } else {
            try {
                subtitleLog.info("Converting subtitle to ASS format")
                const assContent = await this.fetchAndConvertToASS(fileTrack.info.src, fileTrack.info.content)

                if (!assContent) {
                    subtitleLog.error("Failed to convert subtitle to ASS format")
                    toast.error("Failed to convert subtitle track")
                    return
                }
                // Cache the converted content
                this.fileTracks[trackNumber].content = assContent
                subtitleLog.info("Loading converted ASS content")
                // Skip JASSUB if in HTML mode
                if (this.renderMode !== "html") {
                    this.libassRenderer?.renderer?.setTrack(assContent) // load it
                    await this._applySubtitleCustomization()
                    await this.libassRenderer?.resize?.()
                }
                this.pgsRenderer?.resize()
            }
            catch (error) {
                subtitleLog.error("Error loading track", error)
                toast.error("Failed to load subtitle track: " + error)
            }
        }

        const selectedEvent: SubtitleManagerTrackSelectedEvent = new CustomEvent("trackselected", { detail: { trackNumber, kind: "file" } })
        this.dispatchEvent(selectedEvent)

        this._translateFileTrack(trackNumber)
    }
}

export function getDefaultSubtitleTrackNumber(
    settings: VideoCoreSettings,
    _tracks: { label?: string, language?: string, number: number, forced?: boolean, default?: boolean }[] | null = null,
): number {
    // Split preferred languages by comma and trim whitespace
    const preferredLanguages = settings.preferredSubtitleLanguage
        .split(",")
        .map(lang => lang.trim())
        .filter(lang => lang.length > 0)

    const blacklistLabels = (settings.preferredSubtitleBlacklist ?? "")
        .split(",")
        .map(label => label.trim().toLowerCase())
        .filter(label => label.length > 0)

    let tracks = _tracks ?? []
    // remove blacklisted tracks if there are more than one
    if (blacklistLabels.length && tracks.length > 1) {
        tracks = tracks?.filter?.(t => !t.label || !blacklistLabels.includes(t.label?.toLowerCase())) ?? []
    }

    // Try each preferred language in order
    for (const preferredLang of preferredLanguages) {
        let foundTracks = tracks?.filter?.(t => t.language?.toLowerCase() === preferredLang?.toLowerCase())
        if (foundTracks?.length) {
            // Find default or forced track
            const defaultIndex = foundTracks.findIndex(t => t.forced)
            return foundTracks[defaultIndex >= 0 ? defaultIndex : 0].number
        }
        // if the preferred lang is more than 4 characters, compare it to label
        // this will find a language with label 'English - 1080p' if the preferred lang is 'english'
        if (preferredLang.length > 4) {
            foundTracks = tracks?.filter?.(t => t.label?.toLowerCase().includes(preferredLang.toLowerCase()))
            if (foundTracks?.length) {
                return foundTracks[0].number
            }
        }
        if (preferredLang === "none") {
            return NO_TRACK_NUMBER
        }
    }

    // No preferred tracks found, look for default or forced tracks
    const defaultOrForcedTracks = tracks?.filter?.(t => t.default || t.forced)
    if (defaultOrForcedTracks?.length) {
        // Prioritize default tracks over forced tracks
        const defaultIndex = defaultOrForcedTracks.findIndex(t => t.default)
        return defaultOrForcedTracks[defaultIndex >= 0 ? defaultIndex : 0].number
    }

    // No forced/default tracks found, select the first track
    return tracks?.[0]?.number ?? NO_TRACK_NUMBER
}
