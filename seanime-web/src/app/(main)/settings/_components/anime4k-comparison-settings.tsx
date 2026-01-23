"use client"

import {
    vc_anime4kComparisonEnabledAtom,
    vc_anime4kComparisonLeftAtom,
    vc_anime4kComparisonRightAtom,
} from "@/app/(main)/_features/video-core/video-core-anime-4k-comparison.atoms"
import { anime4kOptions } from "@/app/(main)/_features/video-core/video-core-anime-4k"
import { Anime4KOption } from "@/app/(main)/_features/video-core/video-core-anime-4k-manager"
import { SettingsCard } from "@/app/(main)/settings/_components/settings-card"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useAtom } from "jotai/react"
import React from "react"

export function Anime4KComparisonSettings() {
    const [enabled, setEnabled] = useAtom(vc_anime4kComparisonEnabledAtom)
    const [leftOption, setLeftOption] = useAtom(vc_anime4kComparisonLeftAtom)
    const [rightOption, setRightOption] = useAtom(vc_anime4kComparisonRightAtom)

    const selectOptions = anime4kOptions.map(opt => ({
        value: opt.value,
        label: opt.label,
    }))

    return (
        <SettingsCard title="Anime4K Comparison Mode">
            <div className="space-y-4">
                <Switch
                    side="right"
                    label="Enable Comparison Mode"
                    help="Split-screen comparison of different Anime4K upscaling modes"
                    value={enabled}
                    onValueChange={setEnabled}
                />

                {enabled && (
                    <>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Left Side</label>
                                <Select
                                    value={leftOption}
                                    onValueChange={(value) => setLeftOption(value as Anime4KOption)}
                                    options={selectOptions}
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Right Side</label>
                                <Select
                                    value={rightOption}
                                    onValueChange={(value) => setRightOption(value as Anime4KOption)}
                                    options={selectOptions}
                                />
                            </div>
                        </div>

                        <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
                            <span className="text-orange-400 text-sm">
                                Running two Anime4K pipelines simultaneously requires significant GPU resources.
                                This mode is intended for comparison testing only.
                            </span>
                        </div>
                    </>
                )}
            </div>
        </SettingsCard>
    )
}
