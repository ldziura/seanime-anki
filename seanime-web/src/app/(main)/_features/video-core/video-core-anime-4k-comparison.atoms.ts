import { Anime4KOption } from "@/app/(main)/_features/video-core/video-core-anime-4k-manager"
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

// Enable/disable comparison mode (persisted)
export const vc_anime4kComparisonEnabledAtom = atomWithStorage<boolean>(
    "sea-video-core-anime4k-comparison-enabled",
    false,
    undefined,
    { getOnInit: true },
)

// Left side Anime4K mode (persisted)
export const vc_anime4kComparisonLeftAtom = atomWithStorage<Anime4KOption>(
    "sea-video-core-anime4k-comparison-left",
    "off",
    undefined,
    { getOnInit: true },
)

// Right side Anime4K mode (persisted)
export const vc_anime4kComparisonRightAtom = atomWithStorage<Anime4KOption>(
    "sea-video-core-anime4k-comparison-right",
    "mode-a",
    undefined,
    { getOnInit: true },
)

// Divider position (0-100, not persisted - resets to 50 on page load)
export const vc_anime4kComparisonDividerAtom = atom<number>(50)
