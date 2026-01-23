import {
    vc_anime4kComparisonDividerAtom,
    vc_anime4kComparisonEnabledAtom,
    vc_anime4kComparisonLeftAtom,
    vc_anime4kComparisonRightAtom,
} from "@/app/(main)/_features/video-core/video-core-anime-4k-comparison.atoms"
import { getAnime4KOptionByValue } from "@/app/(main)/_features/video-core/video-core-anime-4k"
import {
    vc_anime4kComparisonManager,
    vc_containerElement,
    vc_miniPlayer,
    vc_pip,
    vc_realVideoSize,
    vc_seeking,
    vc_videoElement,
} from "@/app/(main)/_features/video-core/video-core"
import { cn } from "@/components/ui/core/styling"
import { logger } from "@/lib/helpers/debug"
import { useAtom, useAtomValue } from "jotai/react"
import React from "react"

const log = logger("VIDEO CORE ANIME 4K COMPARISON")

export const VideoCoreAnime4KComparison = () => {
    const comparisonEnabled = useAtomValue(vc_anime4kComparisonEnabledAtom)
    const [leftOption] = useAtom(vc_anime4kComparisonLeftAtom)
    const [rightOption] = useAtom(vc_anime4kComparisonRightAtom)
    const [dividerPosition, setDividerPosition] = useAtom(vc_anime4kComparisonDividerAtom)

    const realVideoSize = useAtomValue(vc_realVideoSize)
    const seeking = useAtomValue(vc_seeking)
    const isMiniPlayer = useAtomValue(vc_miniPlayer)
    const isPip = useAtomValue(vc_pip)
    const video = useAtomValue(vc_videoElement)
    const containerElement = useAtomValue(vc_containerElement)

    const manager = useAtomValue(vc_anime4kComparisonManager)

    // Update manager with real video size
    React.useEffect(() => {
        if (manager && comparisonEnabled) {
            manager.updateCanvasSize({ width: video?.videoWidth || 0, height: video?.videoHeight || 0 })
        }
    }, [manager, video, comparisonEnabled])

    // Handle option changes
    React.useEffect(() => {
        if (video && manager && comparisonEnabled) {
            log.info("Setting comparison options", { left: leftOption, right: rightOption })
            manager.setOptions(leftOption, rightOption, {
                isMiniPlayer,
                isPip,
                seeking,
            })
        }
    }, [video, manager, leftOption, rightOption, isMiniPlayer, isPip, seeking, comparisonEnabled])

    // Handle resize
    React.useLayoutEffect(() => {
        if (manager && comparisonEnabled) {
            manager.resize()
        }
    }, [realVideoSize, comparisonEnabled])

    // Sync divider position with manager
    React.useEffect(() => {
        if (manager && comparisonEnabled) {
            manager.setDividerPosition(dividerPosition)
        }
    }, [manager, dividerPosition, comparisonEnabled])

    if (!comparisonEnabled || isMiniPlayer || isPip) {
        return null
    }

    return (
        <ComparisonDivider
            position={dividerPosition}
            onPositionChange={setDividerPosition}
            leftLabel={getAnime4KOptionByValue(leftOption)?.label || "Off"}
            rightLabel={getAnime4KOptionByValue(rightOption)?.label || "Off"}
            containerElement={containerElement}
        />
    )
}

interface ComparisonDividerProps {
    position: number
    onPositionChange: (position: number) => void
    leftLabel: string
    rightLabel: string
    containerElement: HTMLDivElement | null
}

const ComparisonDivider = ({
    position,
    onPositionChange,
    leftLabel,
    rightLabel,
    containerElement,
}: ComparisonDividerProps) => {
    const [isDragging, setIsDragging] = React.useState(false)
    const dividerRef = React.useRef<HTMLDivElement>(null)

    const handlePointerDown = React.useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(true)
        // Capture pointer to receive events even outside the element
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }, [])

    const handlePointerMove = React.useCallback((e: React.PointerEvent) => {
        if (!isDragging || !containerElement) return

        e.preventDefault()
        e.stopPropagation()

        const rect = containerElement.getBoundingClientRect()
        const x = e.clientX - rect.left
        const newPosition = Math.max(5, Math.min(95, (x / rect.width) * 100))
        onPositionChange(newPosition)
    }, [isDragging, containerElement, onPositionChange])

    const handlePointerUp = React.useCallback((e: React.PointerEvent) => {
        e.preventDefault()
        e.stopPropagation()
        setIsDragging(false)
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    }, [])

    return (
        <div
            ref={dividerRef}
            className={cn(
                "absolute top-0 bottom-0 w-1 bg-white/80 cursor-ew-resize z-[10] select-none touch-none",
                isDragging && "bg-brand-500",
            )}
            style={{
                left: `${position}%`,
                transform: "translateX(-50%)",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        >
            {/* Wider hit area for easier dragging */}
            <div className="absolute top-0 bottom-0 -left-3 -right-3" />

            {/* Mode labels */}
            <div
                className={cn(
                    "absolute top-4 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur-sm px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap",
                    "flex items-center gap-2 pointer-events-none select-none",
                    isDragging && "bg-brand-900/90",
                )}
            >
                <span className="text-white/90">{leftLabel}</span>
                <span className="text-white/50">|</span>
                <span className="text-white/90">{rightLabel}</span>
            </div>

            {/* Drag handle indicator */}
            <div
                className={cn(
                    "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
                    "w-6 h-12 rounded-full bg-white/90 flex items-center justify-center",
                    "shadow-lg pointer-events-none",
                    isDragging && "bg-brand-500 scale-110",
                    "transition-transform duration-150",
                )}
            >
                <div className="flex flex-col gap-0.5">
                    <div className="w-0.5 h-2 bg-gray-500 rounded-full" />
                    <div className="w-0.5 h-2 bg-gray-500 rounded-full" />
                    <div className="w-0.5 h-2 bg-gray-500 rounded-full" />
                </div>
            </div>
        </div>
    )
}
