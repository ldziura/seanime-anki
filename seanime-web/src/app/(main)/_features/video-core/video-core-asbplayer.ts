import React from "react"

/**
 * Hook to handle asbplayer browser extension integration in fullscreen mode.
 *
 * asbplayer injects subtitle overlays relative to the video element's ancestors.
 * When Seanime goes fullscreen, asbplayer's overlay may end up outside the
 * fullscreen element and become invisible.
 *
 * This hook monitors for asbplayer's containers and moves them inside the
 * fullscreen element when needed.
 */
export function useVideoCoreAsbplayerIntegration({
    containerElement,
}: {
    containerElement: HTMLDivElement | null
}) {
    React.useEffect(() => {
        if (!containerElement) return

        // asbplayer container class names to monitor
        const asbplayerContainerClasses = [
            "asbplayer-subtitles-container-bottom",
            "asbplayer-subtitles-container-top",
            "asbplayer-notification-container-bottom",
            "asbplayer-notification-container-top",
            "asbplayer-mobile-video-overlay-container-top",
            "asbplayer-mobile-video-overlay-container-bottom",
        ]

        // Find all asbplayer containers in the document
        const findAsbplayerContainers = (): HTMLElement[] => {
            const containers: HTMLElement[] = []
            for (const className of asbplayerContainerClasses) {
                const elements = document.getElementsByClassName(className)
                for (let i = 0; i < elements.length; i++) {
                    containers.push(elements[i] as HTMLElement)
                }
            }
            return containers
        }

        // Check if element is inside the fullscreen element
        const isInsideFullscreen = (element: HTMLElement): boolean => {
            const fullscreenEl = document.fullscreenElement
            if (!fullscreenEl) return true // Not in fullscreen, no need to move
            return fullscreenEl.contains(element)
        }

        // Move asbplayer containers inside the fullscreen element
        const moveContainersToFullscreen = () => {
            const fullscreenEl = document.fullscreenElement
            if (!fullscreenEl || fullscreenEl !== containerElement) return

            const containers = findAsbplayerContainers()
            for (const container of containers) {
                if (!isInsideFullscreen(container)) {
                    // Store original parent for restoration later
                    const originalParent = container.parentElement
                    if (originalParent) {
                        container.dataset.asbplayerOriginalParent = "true"
                    }

                    // Move to fullscreen container
                    containerElement.appendChild(container)
                }
            }
        }

        // Restore containers to their original position when exiting fullscreen
        const restoreContainers = () => {
            // When exiting fullscreen, asbplayer will handle repositioning
            // We just need to ensure containers aren't stuck in a bad state
            const containers = findAsbplayerContainers()
            for (const container of containers) {
                // Reset any inline styles we might have added
                if (container.dataset.asbplayerOriginalParent) {
                    delete container.dataset.asbplayerOriginalParent
                }
            }
        }

        // Handle fullscreen changes
        const handleFullscreenChange = () => {
            if (document.fullscreenElement === containerElement) {
                // Small delay to let asbplayer do its initial positioning
                setTimeout(moveContainersToFullscreen, 100)
                // Check again after a longer delay in case asbplayer is slow
                setTimeout(moveContainersToFullscreen, 500)
            } else {
                restoreContainers()
            }
        }

        // Monitor for new asbplayer containers being added to the DOM
        const observer = new MutationObserver((mutations) => {
            if (document.fullscreenElement !== containerElement) return

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node instanceof HTMLElement) {
                        const isAsbplayerContainer = asbplayerContainerClasses.some(
                            cls => node.classList.contains(cls)
                        )
                        if (isAsbplayerContainer && !isInsideFullscreen(node)) {
                            containerElement.appendChild(node)
                        }
                    }
                }
            }
        })

        // Start observing
        observer.observe(document.body, {
            childList: true,
            subtree: true,
        })

        // Listen for fullscreen changes
        document.addEventListener("fullscreenchange", handleFullscreenChange)

        // Also poll periodically as a fallback (asbplayer also uses polling)
        const pollInterval = setInterval(() => {
            if (document.fullscreenElement === containerElement) {
                moveContainersToFullscreen()
            }
        }, 1000)

        return () => {
            observer.disconnect()
            document.removeEventListener("fullscreenchange", handleFullscreenChange)
            clearInterval(pollInterval)
        }
    }, [containerElement])
}
