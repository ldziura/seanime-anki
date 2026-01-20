import {
    ElectronPlaybackMethod,
    PlaybackDownloadedMedia,
    PlaybackTorrentStreaming,
    useCurrentDevicePlaybackSettings,
    useExternalPlayerLink,
} from "@/app/(main)/_atoms/playback.atoms"
import { vc_ankiSettingsAtom, AnkiSettings, vc_initialAnkiSettings } from "@/app/(main)/_features/video-core/video-core.atoms"
import { useServerStatus } from "@/app/(main)/_hooks/use-server-status"
import { useMediastreamActiveOnDevice } from "@/app/(main)/mediastream/_lib/mediastream.atoms"
import { SettingsCard, SettingsPageHeader } from "@/app/(main)/settings/_components/settings-card"
import { __settings_tabAtom } from "@/app/(main)/settings/_components/settings-page.atoms"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/core/styling"
import { NumberInput } from "@/components/ui/number-input"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { TextInput } from "@/components/ui/text-input"
import { ankiConnect } from "@/lib/anki-connect"
import { logger } from "@/lib/helpers/debug"
import { __isElectronDesktop__ } from "@/types/constants"

const ankiLog = logger("ANKI SETTINGS")
import { useAtom, useSetAtom } from "jotai"
import React from "react"
import { BiDesktop } from "react-icons/bi"
import { LuCirclePlay, LuClapperboard, LuExternalLink, LuLaptop } from "react-icons/lu"
import { MdOutlineBroadcastOnHome } from "react-icons/md"
import { RiSettings3Fill } from "react-icons/ri"
import { TbCards } from "react-icons/tb"
import { toast } from "sonner"

type PlaybackSettingsProps = {
    children?: React.ReactNode
}

export function PlaybackSettings(props: PlaybackSettingsProps) {

    const {
        children,
        ...rest
    } = props

    const serverStatus = useServerStatus()

    const {
        downloadedMediaPlayback,
        setDownloadedMediaPlayback,
        torrentStreamingPlayback,
        setTorrentStreamingPlayback,
        electronPlaybackMethod,
        setElectronPlaybackMethod,
    } = useCurrentDevicePlaybackSettings()

    const { activeOnDevice, setActiveOnDevice } = useMediastreamActiveOnDevice()
    const { externalPlayerLink } = useExternalPlayerLink()
    const setTab = useSetAtom(__settings_tabAtom)

    const usingNativePlayer = __isElectronDesktop__ && electronPlaybackMethod === ElectronPlaybackMethod.NativePlayer

    return (
        <>
            <div className="space-y-4">
                <SettingsPageHeader
                    title="Video playback"
                    description="Choose how anime is played on this device"
                    icon={LuCirclePlay}
                />

                <div className="flex items-center gap-2 text-sm bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 border border-gray-200 dark:border-gray-800">
                    <BiDesktop className="text-lg text-gray-500" />
                    <span className="text-gray-600 dark:text-gray-400">Device:</span>
                    <span className="font-medium">{serverStatus?.clientDevice || "-"}</span>
                    <span className="text-gray-400">•</span>
                    <span className="font-medium">{serverStatus?.clientPlatform || "-"}</span>
                </div>
            </div>

            {(!externalPlayerLink && (downloadedMediaPlayback === PlaybackDownloadedMedia.ExternalPlayerLink || torrentStreamingPlayback === PlaybackTorrentStreaming.ExternalPlayerLink)) && (
                <Alert
                    intent="alert-basic"
                    description={
                        <div className="flex items-center justify-between gap-3">
                            <span>No external player custom scheme has been set</span>
                            <Button
                                intent="gray-outline"
                                size="sm"
                                onClick={() => setTab("external-player-link")}
                            >
                                Add
                            </Button>
                        </div>
                    }
                />
            )}

            {__isElectronDesktop__ && (
                <SettingsCard
                    title="Seanime Denshi"
                    className="border-2 border-dashed dark:border-gray-700 bg-gradient-to-r from-indigo-50/50 to-pink-50/50 dark:from-gray-900/20 dark:to-gray-900/20"
                >
                    <div className="space-y-4">

                        <div className="flex items-center gap-4">
                            <div className="p-3 rounded-lg bg-gradient-to-br from-indigo-500/20 to-indigo-500/20 border border-indigo-500/20">
                                <LuClapperboard className="text-2xl text-indigo-600 dark:text-indigo-400" />
                            </div>
                            <div className="flex-1">
                                <Switch
                                    label="Use built-in player"
                                    help="When enabled, all media playback will use the built-in player (overrides settings below)"
                                    value={electronPlaybackMethod === ElectronPlaybackMethod.NativePlayer}
                                    onValueChange={v => {
                                        setElectronPlaybackMethod(v ? ElectronPlaybackMethod.NativePlayer : ElectronPlaybackMethod.Default)
                                        toast.success("Playback settings updated")
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </SettingsCard>
            )}

            <SettingsCard
                title="Downloaded Media"
                description="Choose how to play anime files stored on your device"
                className={cn(
                    "transition-all duration-200",
                    usingNativePlayer && "opacity-50",
                )}
            >
                <div className="space-y-4">

                    {/* Option Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* Desktop Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                downloadedMediaPlayback === PlaybackDownloadedMedia.Default && !activeOnDevice
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setDownloadedMediaPlayback(PlaybackDownloadedMedia.Default)
                                setActiveOnDevice(false)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuLaptop className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">Desktop Media Player</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Opens files in your system player with automatic
                                                                                                tracking</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Web Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                downloadedMediaPlayback === PlaybackDownloadedMedia.Default && activeOnDevice
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                                !serverStatus?.mediastreamSettings?.transcodeEnabled && "opacity-50",
                            )}
                            onClick={() => {
                                if (serverStatus?.mediastreamSettings?.transcodeEnabled) {
                                    setDownloadedMediaPlayback(PlaybackDownloadedMedia.Default)
                                    setActiveOnDevice(true)
                                    toast.success("Playback settings updated")
                                }
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <MdOutlineBroadcastOnHome className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">Transcoding / Direct Play</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">
                                            {serverStatus?.mediastreamSettings?.transcodeEnabled
                                                ? "Plays in browser with transcoding"
                                                : "Transcoding not enabled"
                                            }
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* External Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                downloadedMediaPlayback === PlaybackDownloadedMedia.ExternalPlayerLink
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setDownloadedMediaPlayback(PlaybackDownloadedMedia.ExternalPlayerLink)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuExternalLink className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">External Player Link</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Send stream URL to another application</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </SettingsCard>

            <SettingsCard
                title="Torrent & Debrid Streaming"
                description="Choose how to play streamed content from torrents and debrid services"
                className={cn(
                    "transition-all duration-200",
                    usingNativePlayer && "opacity-50",
                )}
            >
                <div className="space-y-4">

                    {/* Option Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Desktop Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                torrentStreamingPlayback === PlaybackTorrentStreaming.Default
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setTorrentStreamingPlayback(PlaybackTorrentStreaming.Default)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuLaptop className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">Desktop Media Player</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Opens streams in your system player with automatic
                                                                                                tracking</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* External Player Option */}
                        <div
                            className={cn(
                                "p-4 rounded-lg border cursor-pointer transition-all",
                                torrentStreamingPlayback === PlaybackTorrentStreaming.ExternalPlayerLink
                                    ? "border-[--brand] bg-brand-900/10"
                                    : "border-gray-700 hover:border-gray-600",
                            )}
                            onClick={() => {
                                setTorrentStreamingPlayback(PlaybackTorrentStreaming.ExternalPlayerLink)
                                toast.success("Playback settings updated")
                            }}
                        >
                            <div className="flex items-start gap-3">
                                <LuExternalLink className="text-xl text-brand-600 dark:text-brand-400 mt-1" />
                                <div className="flex-1 space-y-2">
                                    <div>
                                        <p className="font-medium">External Player Link</p>
                                        <p className="text-xs text-gray-600 dark:text-gray-400">Send stream URL to another application</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </SettingsCard>

            <AnkiMiningSettings />

            <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 dark:bg-gray-900/30 rounded-lg p-3 border border-gray-200 dark:border-gray-800 border-dashed">
                <RiSettings3Fill className="text-base" />
                <span>Settings are saved automatically</span>
            </div>

        </>
    )
}

function AnkiMiningSettings() {
    const [ankiSettings, setAnkiSettings] = useAtom(vc_ankiSettingsAtom)
    const [connectionStatus, setConnectionStatus] = React.useState<"untested" | "testing" | "success" | "failed">("untested")
    const [decks, setDecks] = React.useState<string[]>([])
    const [models, setModels] = React.useState<string[]>([])
    const [fields, setFields] = React.useState<string[]>([])
    const [loading, setLoading] = React.useState(false)

    const updateSetting = <K extends keyof AnkiSettings>(key: K, value: AnkiSettings[K]) => {
        setAnkiSettings(prev => ({ ...prev, [key]: value }))
    }

    const testConnection = async () => {
        ankiLog.info("Testing connection", { url: ankiSettings.ankiConnectUrl })
        setConnectionStatus("testing")
        ankiConnect.setUrl(ankiSettings.ankiConnectUrl)

        try {
            const success = await ankiConnect.testConnection()
            ankiLog.info("Test connection result", { success })
            if (success) {
                setConnectionStatus("success")
                toast.success("Connected to AnkiConnect")
                // Fetch decks and models
                await fetchAnkiData()
            } else {
                setConnectionStatus("failed")
                toast.error("Failed to connect to AnkiConnect")
            }
        } catch (error) {
            ankiLog.error("Test connection exception", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            })
            setConnectionStatus("failed")
            toast.error("Failed to connect to AnkiConnect")
        }
    }

    const fetchAnkiData = async () => {
        setLoading(true)
        ankiConnect.setUrl(ankiSettings.ankiConnectUrl)

        try {
            const [deckList, modelList] = await Promise.all([
                ankiConnect.getDecks(),
                ankiConnect.getModels(),
            ])
            setDecks(deckList)
            setModels(modelList)

            // If a model is selected, fetch its fields
            if (ankiSettings.modelName && modelList.includes(ankiSettings.modelName)) {
                const fieldList = await ankiConnect.getModelFields(ankiSettings.modelName)
                setFields(fieldList)
            }
        } catch (error) {
            toast.error("Failed to fetch Anki data")
        } finally {
            setLoading(false)
        }
    }

    const handleModelChange = async (modelName: string) => {
        updateSetting("modelName", modelName)

        if (modelName) {
            ankiConnect.setUrl(ankiSettings.ankiConnectUrl)
            try {
                const fieldList = await ankiConnect.getModelFields(modelName)
                setFields(fieldList)
                // Reset field mappings if they're not in the new model
                if (!fieldList.includes(ankiSettings.sentenceField)) {
                    updateSetting("sentenceField", "")
                }
                if (!fieldList.includes(ankiSettings.audioField)) {
                    updateSetting("audioField", "")
                }
                if (!fieldList.includes(ankiSettings.imageField)) {
                    updateSetting("imageField", "")
                }
            } catch (error) {
                toast.error("Failed to fetch model fields")
            }
        }
    }

    const handleDeckChange = async (deckName: string) => {
        updateSetting("deckName", deckName)

        if (deckName) {
            setLoading(true)
            ankiConnect.setUrl(ankiSettings.ankiConnectUrl)
            try {
                // Auto-detect the note type used in this deck
                const detectedModel = await ankiConnect.detectDeckNoteType(deckName)
                if (detectedModel) {
                    ankiLog.info("Auto-detected note type for deck", { deckName, detectedModel })
                    // Set the model and fetch its fields (handleModelChange fetches fields directly from Anki)
                    await handleModelChange(detectedModel)
                    toast.success(`Auto-detected note type: ${detectedModel}`)
                } else {
                    ankiLog.info("No note type detected for deck (deck may be empty)", { deckName })
                }
            } catch (error) {
                ankiLog.error("Failed to auto-detect note type", { deckName, error })
                // Don't show error toast - manual selection is still available
            } finally {
                setLoading(false)
            }
        }
    }

    // Load data when enabled
    React.useEffect(() => {
        if (ankiSettings.enabled && connectionStatus === "untested") {
            testConnection()
        }
    }, [ankiSettings.enabled])

    return (
        <SettingsCard
            title="Anki Mining"
            description="Create Anki flashcards from the video player with screenshot, audio, and subtitle"
        >
            <div className="space-y-4">
                <div className="flex items-center gap-4">
                    <div className="p-3 rounded-lg bg-gradient-to-br from-green-500/20 to-green-500/20 border border-green-500/20">
                        <TbCards className="text-2xl text-green-600 dark:text-green-400" />
                    </div>
                    <div className="flex-1">
                        <Switch
                            label="Enable Anki Mining"
                            help="Press ` (backtick) to create a card, \ (backslash) to update the last card"
                            value={ankiSettings.enabled}
                            onValueChange={(v) => {
                                updateSetting("enabled", v)
                                if (v) {
                                    toast.success("Anki mining enabled")
                                }
                            }}
                        />
                    </div>
                </div>

                {ankiSettings.enabled && (
                    <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-800">
                        <div className="flex items-end gap-2">
                            <TextInput
                                label="AnkiConnect URL"
                                value={ankiSettings.ankiConnectUrl}
                                onValueChange={(v) => updateSetting("ankiConnectUrl", v)}
                                className="flex-1"
                            />
                            <Button
                                intent={connectionStatus === "success" ? "success" : "gray-outline"}
                                onClick={testConnection}
                                loading={connectionStatus === "testing"}
                            >
                                {connectionStatus === "success" ? "Connected" : "Test Connection"}
                            </Button>
                        </div>

                        {connectionStatus === "failed" && (
                            <Alert
                                intent="alert"
                                description="Could not connect to AnkiConnect. Make sure Anki is running and AnkiConnect addon is installed."
                            />
                        )}

                        {connectionStatus === "success" && (
                            <>
                                <div className="grid grid-cols-2 gap-4">
                                    <Select
                                        label="Deck"
                                        value={ankiSettings.deckName}
                                        onValueChange={(v) => handleDeckChange(v || "")}
                                        options={decks.map(d => ({ value: d, label: d }))}
                                        disabled={loading || decks.length === 0}
                                        help="Note type will be auto-detected"
                                    />
                                    <Select
                                        label="Note Type"
                                        value={ankiSettings.modelName}
                                        onValueChange={(v) => handleModelChange(v || "")}
                                        options={models.map(m => ({ value: m, label: m }))}
                                        disabled={loading || models.length === 0}
                                        help="Manual override available"
                                    />
                                </div>

                                {ankiSettings.modelName && fields.length > 0 && (
                                    <div className="space-y-3">
                                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Field Mappings</p>
                                        <div className="grid grid-cols-3 gap-4">
                                            <Select
                                                label="Sentence Field"
                                                value={ankiSettings.sentenceField || "__none__"}
                                                onValueChange={(v) => updateSetting("sentenceField", v === "__none__" ? "" : (v || ""))}
                                                options={[
                                                    { value: "__none__", label: "(None)" },
                                                    ...fields.map(f => ({ value: f, label: f })),
                                                ]}
                                            />
                                            <Select
                                                label="Audio Field"
                                                value={ankiSettings.audioField || "__none__"}
                                                onValueChange={(v) => updateSetting("audioField", v === "__none__" ? "" : (v || ""))}
                                                options={[
                                                    { value: "__none__", label: "(None)" },
                                                    ...fields.map(f => ({ value: f, label: f })),
                                                ]}
                                            />
                                            <Select
                                                label="Image Field"
                                                value={ankiSettings.imageField || "__none__"}
                                                onValueChange={(v) => updateSetting("imageField", v === "__none__" ? "" : (v || ""))}
                                                options={[
                                                    { value: "__none__", label: "(None)" },
                                                    ...fields.map(f => ({ value: f, label: f })),
                                                ]}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-3">
                                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Audio Padding (seconds)</p>
                                    <div className="grid grid-cols-2 gap-4">
                                        <NumberInput
                                            label="Before subtitle"
                                            value={ankiSettings.audioPaddingBefore}
                                            onValueChange={(v) => updateSetting("audioPaddingBefore", v ?? 0)}
                                            min={0}
                                            max={5}
                                            step={0.1}
                                            formatOptions={{ minimumFractionDigits: 1, maximumFractionDigits: 2 }}
                                        />
                                        <NumberInput
                                            label="After subtitle"
                                            value={ankiSettings.audioPaddingAfter}
                                            onValueChange={(v) => updateSetting("audioPaddingAfter", v ?? 0)}
                                            min={0}
                                            max={5}
                                            step={0.1}
                                            formatOptions={{ minimumFractionDigits: 1, maximumFractionDigits: 2 }}
                                        />
                                    </div>
                                </div>

                                <div className="text-xs text-gray-500 dark:text-gray-400 pt-2 space-y-1">
                                    <p>Keyboard shortcuts in video player:</p>
                                    <ul className="list-disc list-inside">
                                        <li><strong>`</strong> (backtick) - Mine current subtitle to Anki (new card)</li>
                                        <li><strong>\</strong> (backslash) - Update last card with new screenshot/audio</li>
                                    </ul>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </SettingsCard>
    )
}
