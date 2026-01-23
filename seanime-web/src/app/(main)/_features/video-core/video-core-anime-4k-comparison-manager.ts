import { VideoCoreSettings } from "@/app/(main)/_features/video-core/video-core.atoms"
import { logger } from "@/lib/helpers/debug"
import {
    Anime4KPipeline,
    CNNx2M,
    CNNx2UL,
    CNNx2VL,
    DenoiseCNNx2VL,
    Downscale,
    GANx3L,
    GANx4UUL,
    ModeA,
    ModeAA,
    ModeB,
    ModeBB,
    ModeC,
    ModeCA,
} from "anime4k-webgpu"
import { Anime4KOption } from "./video-core-anime-4k-manager"

const log = logger("VIDEO CORE ANIME 4K COMPARISON MANAGER")

// Shader to convert GPUExternalTexture to regular GPUTexture
const EXTERNAL_TO_TEXTURE_SHADER = `
@group(0) @binding(0) var inputTexture: texture_external;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dims = textureDimensions(outputTexture);
    if (global_id.x >= dims.x || global_id.y >= dims.y) {
        return;
    }
    let color = textureLoad(inputTexture, vec2<i32>(global_id.xy));
    textureStore(outputTexture, vec2<i32>(global_id.xy), color);
}
`

// Blit shader to copy any texture to render target (handles format conversion)
const BLIT_SHADER = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Full-screen triangle
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var texCoords = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
    output.texCoord = texCoords[vertexIndex];
    return output;
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

@fragment
fn fragmentMain(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(inputTexture, inputSampler, texCoord);
}
`

interface ExternalTextureConverter {
    pipeline: GPUComputePipeline
    bindGroupLayout: GPUBindGroupLayout
}

interface BlitPipeline {
    pipeline: GPURenderPipeline
    bindGroupLayout: GPUBindGroupLayout
    sampler: GPUSampler
}

// Cache for the converter pipeline (created once per device)
const converterCache = new WeakMap<GPUDevice, ExternalTextureConverter>()
const blitCache = new WeakMap<GPUDevice, Map<GPUTextureFormat, BlitPipeline>>()

// Get or create the converter pipeline for a device
function getExternalTextureConverter(device: GPUDevice): ExternalTextureConverter {
    let converter = converterCache.get(device)
    if (!converter) {
        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    externalTexture: {},
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: "write-only",
                        format: "rgba8unorm",
                    },
                },
            ],
        })

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout],
        })

        const shaderModule = device.createShaderModule({
            code: EXTERNAL_TO_TEXTURE_SHADER,
        })

        const pipeline = device.createComputePipeline({
            layout: pipelineLayout,
            compute: {
                module: shaderModule,
                entryPoint: "main",
            },
        })

        converter = { pipeline, bindGroupLayout }
        converterCache.set(device, converter)
    }
    return converter
}

// Convert GPUExternalTexture to regular GPUTexture (creates new texture - use for one-off)
function convertExternalTexture(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    externalTexture: GPUExternalTexture,
    width: number,
    height: number
): GPUTexture {
    const converter = getExternalTextureConverter(device)

    // Create output texture
    const outputTexture = device.createTexture({
        size: { width, height },
        format: "rgba8unorm",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })

    // Create bind group
    const bindGroup = device.createBindGroup({
        layout: converter.bindGroupLayout,
        entries: [
            { binding: 0, resource: externalTexture },
            { binding: 1, resource: outputTexture.createView() },
        ],
    })

    // Run compute pass
    const computePass = encoder.beginComputePass()
    computePass.setPipeline(converter.pipeline)
    computePass.setBindGroup(0, bindGroup)
    computePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
    computePass.end()

    return outputTexture
}

// Fill existing GPUTexture from GPUExternalTexture (reuses texture - use in render loop)
function fillTextureFromExternal(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    externalTexture: GPUExternalTexture,
    outputTexture: GPUTexture
): void {
    const converter = getExternalTextureConverter(device)
    const width = outputTexture.width
    const height = outputTexture.height

    // Create bind group (this is lightweight, OK to create each frame)
    const bindGroup = device.createBindGroup({
        layout: converter.bindGroupLayout,
        entries: [
            { binding: 0, resource: externalTexture },
            { binding: 1, resource: outputTexture.createView() },
        ],
    })

    // Run compute pass
    const computePass = encoder.beginComputePass()
    computePass.setPipeline(converter.pipeline)
    computePass.setBindGroup(0, bindGroup)
    computePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
    computePass.end()
}

// Get or create blit pipeline for format conversion
function getBlitPipeline(device: GPUDevice, targetFormat: GPUTextureFormat): BlitPipeline {
    let formatMap = blitCache.get(device)
    if (!formatMap) {
        formatMap = new Map()
        blitCache.set(device, formatMap)
    }

    let blit = formatMap.get(targetFormat)
    if (!blit) {
        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: "float" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: "filtering" },
                },
            ],
        })

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout],
        })

        const shaderModule = device.createShaderModule({
            code: BLIT_SHADER,
        })

        const pipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: "vertexMain",
            },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [{ format: targetFormat }],
            },
            primitive: {
                topology: "triangle-list",
            },
        })

        const sampler = device.createSampler({
            magFilter: "linear",
            minFilter: "linear",
        })

        blit = { pipeline, bindGroupLayout, sampler }
        formatMap.set(targetFormat, blit)
    }
    return blit
}

// Blit (copy with format conversion) from source texture to render target
function blitToCanvas(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    sourceTexture: GPUTexture,
    targetTexture: GPUTexture,
    targetFormat: GPUTextureFormat
): void {
    const blit = getBlitPipeline(device, targetFormat)

    const bindGroup = device.createBindGroup({
        layout: blit.bindGroupLayout,
        entries: [
            { binding: 0, resource: sourceTexture.createView() },
            { binding: 1, resource: blit.sampler },
        ],
    })

    const renderPass = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: targetTexture.createView(),
                loadOp: "clear",
                storeOp: "store",
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
        ],
    })

    renderPass.setPipeline(blit.pipeline)
    renderPass.setBindGroup(0, bindGroup)
    renderPass.draw(3) // Full-screen triangle
    renderPass.end()
}

// Check if option requires raw upscaler (needs texture conversion)
function isRawUpscaler(option: Anime4KOption): boolean {
    return [
        "cnn-2x-medium",
        "cnn-2x-very-large",
        "denoise-cnn-2x-very-large",
        "cnn-2x-ultra-large",
        "gan-3x-large",
        "gan-4x-ultra-large",
    ].includes(option)
}

export type ComparisonCanvasCreatedEvent = CustomEvent<{ side: "left" | "right", canvas: HTMLCanvasElement }>
export type ComparisonErrorEvent = CustomEvent<{ message: string }>
export type ComparisonDestroyedEvent = CustomEvent

interface VideoCoreAnime4KComparisonManagerEventMap {
    "canvascreated": ComparisonCanvasCreatedEvent
    "error": ComparisonErrorEvent
    "destroyed": ComparisonDestroyedEvent
}

// Cached resources for raw upscaler rendering (prevents VRAM leak)
interface CachedUpscalerResources {
    inputTexture: GPUTexture
    upscalerPipeline: Anime4KPipeline
    downscalePipeline: Anime4KPipeline
    nativeWidth: number
    nativeHeight: number
    targetWidth: number
    targetHeight: number
}

interface ComparisonSide {
    canvas: HTMLCanvasElement | null
    option: Anime4KOption
    webgpuResources: { device?: GPUDevice } | null
    abortController: AbortController | null
    initialized: boolean
    context: GPUCanvasContext | null
    canvasFormat: GPUTextureFormat | null
    renderLoopId: number | null
    // Cached resources for raw upscalers (GAN, CNN)
    cachedResources: CachedUpscalerResources | null
}

export class VideoCoreAnime4KComparisonManager extends EventTarget {
    private readonly videoElement: HTMLVideoElement
    private settings: VideoCoreSettings
    private _boxSize: { width: number; height: number } = { width: 0, height: 0 }
    private _dividerPosition: number = 50
    private readonly _onFallback?: (message: string) => void

    private _left: ComparisonSide = {
        canvas: null,
        option: "off",
        webgpuResources: null,
        abortController: null,
        initialized: false,
        context: null,
        canvasFormat: null,
        renderLoopId: null,
        cachedResources: null,
    }

    private _right: ComparisonSide = {
        canvas: null,
        option: "mode-a",
        webgpuResources: null,
        abortController: null,
        initialized: false,
        context: null,
        canvasFormat: null,
        renderLoopId: null,
        cachedResources: null,
    }

    constructor({
        videoElement,
        settings,
        onFallback,
    }: {
        videoElement: HTMLVideoElement
        settings: VideoCoreSettings
        onFallback?: (message: string) => void
    }) {
        super()
        this.videoElement = videoElement
        this.settings = settings
        this._onFallback = onFallback
        log.info("Anime4K Comparison manager initialized")
    }

    addEventListener<K extends keyof VideoCoreAnime4KComparisonManagerEventMap>(
        type: K,
        listener: (this: VideoCoreAnime4KComparisonManager, ev: VideoCoreAnime4KComparisonManagerEventMap[K]) => any,
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

    getOptions(): { left: Anime4KOption; right: Anime4KOption } {
        return { left: this._left.option, right: this._right.option }
    }

    getDividerPosition(): number {
        return this._dividerPosition
    }

    updateCanvasSize(size: { width: number; height: number }) {
        const videoContentSize = this.getRenderedVideoContentSize(this.videoElement)
        this._boxSize = {
            width: videoContentSize?.displayedWidth || size.width,
            height: videoContentSize?.displayedHeight || size.height,
        }
        this._updateCanvasSizes()
    }

    private _updateCanvasSizes() {
        if (this._left.canvas) {
            this._left.canvas.width = this._boxSize.width
            this._left.canvas.height = this._boxSize.height
            this._left.canvas.style.width = this._boxSize.width + "px"
            this._left.canvas.style.height = this._boxSize.height + "px"
        }
        if (this._right.canvas) {
            this._right.canvas.width = this._boxSize.width
            this._right.canvas.height = this._boxSize.height
            this._right.canvas.style.width = this._boxSize.width + "px"
            this._right.canvas.style.height = this._boxSize.height + "px"
        }
    }

    resize() {
        const videoContentSize = this.getRenderedVideoContentSize(this.videoElement)
        this._boxSize = {
            width: videoContentSize?.displayedWidth || 0,
            height: videoContentSize?.displayedHeight || 0,
        }
        this._updateCanvasSizes()
        this._updateClipPaths()
    }

    setDividerPosition(position: number) {
        this._dividerPosition = Math.max(0, Math.min(100, position))
        this._updateClipPaths()
    }

    private _updateClipPaths() {
        if (this._left.canvas) {
            // Left canvas: show from 0% to dividerPosition%
            this._left.canvas.style.clipPath = `inset(0 ${100 - this._dividerPosition}% 0 0)`
        }
        if (this._right.canvas) {
            // Right canvas: show from dividerPosition% to 100%
            this._right.canvas.style.clipPath = `inset(0 0 0 ${this._dividerPosition}%)`
        }
    }

    async setOptions(left: Anime4KOption, right: Anime4KOption, state?: {
        isMiniPlayer: boolean
        isPip: boolean
        seeking: boolean
    }) {
        // Handle state changes
        if (state) {
            if (state.isMiniPlayer || state.isPip) {
                log.info("Destroying comparison canvases due to PIP/mini player mode")
                this.destroy()
                return
            }

            if (state.seeking) {
                this._hideCanvases()
                return
            }
        }

        // Skip if size isn't set
        if (this._boxSize.width === 0 || this._boxSize.height === 0) {
            return
        }

        // Show canvases if hidden
        if (this._isHidden()) {
            this._showCanvases()
        }

        const leftChanged = left !== this._left.option
        const rightChanged = right !== this._right.option

        // Update left side
        if (leftChanged) {
            await this._updateSide("left", left)
        }

        // Update right side
        if (rightChanged) {
            await this._updateSide("right", right)
        }

        this._updateClipPaths()
    }

    private async _updateSide(side: "left" | "right", option: Anime4KOption) {
        const sideData = side === "left" ? this._left : this._right
        const previousOption = sideData.option
        sideData.option = option

        // Destroy existing canvas if turning off or changing mode
        if (option === "off" || previousOption !== option) {
            this._destroySide(side)
        }

        if (option !== "off") {
            try {
                await this._initializeSide(side, option)
            } catch (error) {
                log.error(`Failed to initialize ${side} side`, error)
                this._handleError(error instanceof Error ? error.message : "Unknown error")
            }
        }
    }

    private async _initializeSide(side: "left" | "right", option: Anime4KOption) {
        const sideData = side === "left" ? this._left : this._right

        if (sideData.initialized || option === "off") {
            return
        }

        log.info(`Initializing ${side} side with option:`, option)

        sideData.abortController = new AbortController()

        try {
            const gpuInfo = await this._getGPUInfo()
            if (!gpuInfo) {
                throw new Error("WebGPU not supported")
            }

            if (sideData.abortController.signal.aborted) return

            this._createCanvas(side)

            if (sideData.abortController.signal.aborted) return

            await this._startRendering(side, option)

            sideData.initialized = true
            log.info(`${side} side initialized`)
        } catch (error) {
            if (!sideData.abortController?.signal.aborted) {
                log.error(`${side} side initialization failed`, error)
                throw error
            }
        }
    }

    private _createCanvas(side: "left" | "right") {
        const sideData = side === "left" ? this._left : this._right

        sideData.canvas = document.createElement("canvas")
        sideData.canvas.width = this._boxSize.width
        sideData.canvas.height = this._boxSize.height
        sideData.canvas.style.objectFit = "contain"
        sideData.canvas.style.position = "absolute"
        sideData.canvas.style.pointerEvents = "none"
        sideData.canvas.style.zIndex = "2"
        sideData.canvas.style.objectPosition = "center"
        sideData.canvas.style.width = this._boxSize.width + "px"
        sideData.canvas.style.height = this._boxSize.height + "px"
        sideData.canvas.style.display = "block"
        sideData.canvas.className = `vc-anime4k-canvas-${side}`

        log.info(`Creating ${side} canvas`, { width: sideData.canvas.width, height: sideData.canvas.height })

        this.videoElement.parentElement?.appendChild(sideData.canvas)

        const event: ComparisonCanvasCreatedEvent = new CustomEvent("canvascreated", {
            detail: { side, canvas: sideData.canvas },
        })
        this.dispatchEvent(event)
    }

    private async _startRendering(side: "left" | "right", option: Anime4KOption) {
        const sideData = side === "left" ? this._left : this._right

        if (!sideData.canvas || !this.videoElement || option === "off") {
            return
        }

        // 1. Create adapter
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) {
            throw new Error("WebGPU adapter not available")
        }

        // 2. Check adapter limits and log them
        const adapterLimits = adapter.limits
        log.info(`Adapter limits for ${side} side:`, {
            maxBufferSize: adapterLimits.maxBufferSize,
            maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
        })

        // 3. Request device with maximum available buffer limits
        const device = await adapter.requestDevice({
            requiredLimits: {
                maxBufferSize: adapterLimits.maxBufferSize,
                maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
            },
        })

        sideData.webgpuResources = { device }

        log.info(`Device limits for ${side} side:`, {
            maxBufferSize: device.limits.maxBufferSize,
            maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        })

        // 4. Configure canvas context
        sideData.context = sideData.canvas.getContext("webgpu") as GPUCanvasContext
        if (!sideData.context) {
            throw new Error("Failed to get WebGPU canvas context")
        }

        sideData.canvasFormat = navigator.gpu.getPreferredCanvasFormat()
        sideData.context.configure({
            device,
            format: sideData.canvasFormat,
            alphaMode: "premultiplied",
        })

        log.info(`Rendering started for ${side} side with custom device`)

        // 5. Start render loop for this side
        this._startRenderLoop(side, option)
    }

    private _startRenderLoop(side: "left" | "right", option: Anime4KOption) {
        const sideData = side === "left" ? this._left : this._right
        let debugFrameCount = 0

        const renderFrame = () => {
            debugFrameCount++
            if (!sideData.webgpuResources?.device || !sideData.context || !this.videoElement || !sideData.canvas || !sideData.canvasFormat) {
                return
            }

            const device = sideData.webgpuResources.device

            // Skip if video is not playing or seeking
            if (this.videoElement.paused || this.videoElement.seeking || this.videoElement.readyState < 2) {
                sideData.renderLoopId = requestAnimationFrame(renderFrame)
                return
            }

            // Skip if video dimensions are not valid (can be 0 even when readyState >= 2)
            const videoWidth = this.videoElement.videoWidth
            const videoHeight = this.videoElement.videoHeight
            const canvasWidth = sideData.canvas.width
            const canvasHeight = sideData.canvas.height

            if (!videoWidth || !videoHeight || !canvasWidth || !canvasHeight) {
                sideData.renderLoopId = requestAnimationFrame(renderFrame)
                return
            }

            try {
                // 6. Import video frame as external texture
                const externalTexture = device.importExternalTexture({
                    source: this.videoElement,
                })

                // Round dimensions to integers and ensure divisibility by 4 for GAN upscalers
                const nativeDimensions = {
                    width: Math.floor(videoWidth / 4) * 4 || 4,
                    height: Math.floor(videoHeight / 4) * 4 || 4,
                }

                const targetDimensions = {
                    width: Math.floor(canvasWidth / 4) * 4 || 4,
                    height: Math.floor(canvasHeight / 4) * 4 || 4,
                }

                // DEBUG: Log dimensions on first frame only
                if (debugFrameCount === 1) {
                    log.info(`[${side}] First frame - native: ${nativeDimensions.width}x${nativeDimensions.height}, target: ${targetDimensions.width}x${targetDimensions.height}, rawUpscaler: ${isRawUpscaler(option)}`)
                }

                // Create command encoder
                const commandEncoder = device.createCommandEncoder()

                let outputTexture: GPUTexture

                if (isRawUpscaler(option)) {
                    // 7a. For raw upscalers (GAN, CNN), use cached resources
                    // Check if we need to (re)create cached resources
                    const needsRecreate = !sideData.cachedResources ||
                        sideData.cachedResources.nativeWidth !== nativeDimensions.width ||
                        sideData.cachedResources.nativeHeight !== nativeDimensions.height ||
                        sideData.cachedResources.targetWidth !== targetDimensions.width ||
                        sideData.cachedResources.targetHeight !== targetDimensions.height

                    if (needsRecreate) {
                        // Destroy old resources
                        if (sideData.cachedResources) {
                            sideData.cachedResources.inputTexture.destroy()
                            log.info(`[${side}] Destroyed old cached resources`)
                        }

                        // Create new cached resources
                        log.info(`[${side}] Creating cached resources for ${option}`)

                        // Create input texture for raw upscaler
                        const inputTexture = device.createTexture({
                            size: { width: nativeDimensions.width, height: nativeDimensions.height },
                            format: "rgba8unorm",
                            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
                        })

                        // Create upscaler pipeline
                        const upscalerPipeline = this._createRawUpscalerPipeline(option, device, inputTexture)
                        const upscaledTexture = upscalerPipeline.getOutputTexture()

                        // Create downscale pipeline
                        const downscalePipeline = new Downscale({
                            device,
                            inputTexture: upscaledTexture,
                            targetDimensions,
                        })

                        sideData.cachedResources = {
                            inputTexture,
                            upscalerPipeline,
                            downscalePipeline,
                            nativeWidth: nativeDimensions.width,
                            nativeHeight: nativeDimensions.height,
                            targetWidth: targetDimensions.width,
                            targetHeight: targetDimensions.height,
                        }

                        log.info(`[${side}] Cached resources created successfully`)
                    }

                    // Fill input texture from video frame
                    fillTextureFromExternal(
                        device,
                        commandEncoder,
                        externalTexture,
                        sideData.cachedResources!.inputTexture
                    )

                    // Run upscaler pipeline
                    sideData.cachedResources!.upscalerPipeline.pass(commandEncoder)

                    // Run downscale pipeline
                    sideData.cachedResources!.downscalePipeline.pass(commandEncoder)
                    outputTexture = sideData.cachedResources!.downscalePipeline.getOutputTexture()
                } else {
                    // 7b. For preset pipelines (ModeA, etc.), use external texture directly
                    // These handle their own texture management internally
                    const pipelineProps = {
                        device,
                        inputTexture: externalTexture,
                        nativeDimensions,
                        targetDimensions,
                    }

                    const [pipeline] = this._createPipeline(option, pipelineProps)
                    pipeline.pass(commandEncoder)
                    outputTexture = pipeline.getOutputTexture()
                }

                // 9. Get canvas texture and blit output to it (handles format conversion)
                const canvasTexture = sideData.context.getCurrentTexture()

                // Use blit shader to copy and convert format (RGBA16Float -> BGRA8Unorm)
                blitToCanvas(device, commandEncoder, outputTexture, canvasTexture, sideData.canvasFormat)

                // 10. Submit commands
                device.queue.submit([commandEncoder.finish()])

            }
            catch (error) {
                // Only log errors that aren't expected during normal operation
                const errorMessage = error instanceof Error ? error.message : String(error)
                if (!errorMessage.includes("destroyed") && !errorMessage.includes("lost")) {
                    log.error(`Render frame error for ${side} side:`, error)
                }
            }

            // Continue render loop
            sideData.renderLoopId = requestAnimationFrame(renderFrame)
        }

        // Start the render loop
        sideData.renderLoopId = requestAnimationFrame(renderFrame)
    }

    // Create pipeline for preset modes (ModeA, ModeB, etc.) that accept GPUExternalTexture
    private _createPipeline(option: Anime4KOption, commonProps: any): [Anime4KPipeline] {
        switch (option) {
            case "mode-a":
                return [new ModeA(commonProps)]
            case "mode-b":
                return [new ModeB(commonProps)]
            case "mode-c":
                return [new ModeC(commonProps)]
            case "mode-aa":
                return [new ModeAA(commonProps)]
            case "mode-bb":
                return [new ModeBB(commonProps)]
            case "mode-ca":
                return [new ModeCA(commonProps)]
            default:
                return [new ModeA(commonProps)]
        }
    }

    // Create pipeline for raw upscalers (GAN, CNN) that require regular GPUTexture
    private _createRawUpscalerPipeline(option: Anime4KOption, device: GPUDevice, inputTexture: GPUTexture): Anime4KPipeline {
        const props = { device, inputTexture }
        switch (option) {
            case "cnn-2x-medium":
                return new CNNx2M(props)
            case "cnn-2x-very-large":
                return new CNNx2VL(props)
            case "denoise-cnn-2x-very-large":
                return new DenoiseCNNx2VL(props)
            case "cnn-2x-ultra-large":
                return new CNNx2UL(props)
            case "gan-3x-large":
                return new GANx3L(props)
            case "gan-4x-ultra-large":
                return new GANx4UUL(props)
            default:
                throw new Error(`Unknown raw upscaler option: ${option}`)
        }
    }

    private _destroySide(side: "left" | "right") {
        const sideData = side === "left" ? this._left : this._right

        sideData.initialized = false

        if (sideData.renderLoopId !== null) {
            cancelAnimationFrame(sideData.renderLoopId)
            sideData.renderLoopId = null
        }

        // Destroy cached upscaler resources
        if (sideData.cachedResources) {
            sideData.cachedResources.inputTexture.destroy()
            sideData.cachedResources = null
            log.info(`[${side}] Destroyed cached upscaler resources`)
        }

        if (sideData.context) {
            sideData.context.unconfigure()
            sideData.context = null
        }

        if (sideData.canvas) {
            sideData.canvas.remove()
            sideData.canvas = null
        }

        if (sideData.webgpuResources?.device) {
            sideData.webgpuResources.device.destroy()
            sideData.webgpuResources = null
        }

        if (sideData.abortController) {
            sideData.abortController.abort()
            sideData.abortController = null
        }

        sideData.canvasFormat = null
    }

    destroy() {
        this._destroySide("left")
        this._destroySide("right")

        const event: ComparisonDestroyedEvent = new CustomEvent("destroyed")
        this.dispatchEvent(event)
    }

    private _hideCanvases() {
        if (this._left.canvas) {
            this._left.canvas.style.display = "none"
        }
        if (this._right.canvas) {
            this._right.canvas.style.display = "none"
        }
    }

    private _showCanvases() {
        if (this._left.canvas) {
            this._left.canvas.style.display = "block"
        }
        if (this._right.canvas) {
            this._right.canvas.style.display = "block"
        }
    }

    private _isHidden(): boolean {
        return (this._left.canvas?.style.display === "none") ||
            (this._right.canvas?.style.display === "none")
    }

    private _handleError(message: string) {
        this._onFallback?.(`Anime4K Comparison: ${message}`)
        const errorEvent: ComparisonErrorEvent = new CustomEvent("error", { detail: { message } })
        this.dispatchEvent(errorEvent)
    }

    private async _getGPUInfo() {
        if (!navigator.gpu) return null

        try {
            const adapter = await navigator.gpu.requestAdapter()
            if (!adapter) return null

            const device = await adapter.requestDevice()
            if (!device) return null

            const info = (adapter as any).info || {}

            return {
                gpu: info.vendor || info.architecture || "Unknown GPU",
                vendor: info.vendor || "Unknown",
                device,
            }
        } catch {
            return null
        }
    }

    private getRenderedVideoContentSize(video: HTMLVideoElement) {
        const containerWidth = video.clientWidth
        const containerHeight = video.clientHeight

        const videoWidth = video.videoWidth
        const videoHeight = video.videoHeight

        if (!videoWidth || !videoHeight) return null

        const containerRatio = containerWidth / containerHeight
        const videoRatio = videoWidth / videoHeight

        let displayedWidth, displayedHeight

        const objectFit = getComputedStyle(video).objectFit || "fill"

        if (objectFit === "cover") {
            if (videoRatio > containerRatio) {
                displayedHeight = containerHeight
                displayedWidth = containerHeight * videoRatio
            } else {
                displayedWidth = containerWidth
                displayedHeight = containerWidth / videoRatio
            }
        } else if (objectFit === "contain") {
            if (videoRatio > containerRatio) {
                displayedWidth = containerWidth
                displayedHeight = containerWidth / videoRatio
            } else {
                displayedHeight = containerHeight
                displayedWidth = containerHeight * videoRatio
            }
        } else {
            displayedWidth = containerWidth
            displayedHeight = containerHeight
        }

        return { displayedWidth, displayedHeight }
    }
}
