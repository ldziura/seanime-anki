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

const log = logger("VIDEO CORE ANIME 4K MANAGER")

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

// Convert GPUExternalTexture to regular GPUTexture
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

export type Anime4KManagerCanvasCreatedEvent = CustomEvent<{ canvas: HTMLCanvasElement }>
export type Anime4KManagerOptionChangedEvent = CustomEvent<{ newOption: Anime4KOption }>
export type Anime4KManagerErrorEvent = CustomEvent<{ message: string }>
export type Anime4KManagerCanvasResizedEvent = CustomEvent<{ width: number; height: number }>
export type Anime4KManagerDestroyedEvent = CustomEvent

interface VideoCoreAnime4KManagerEventMap {
    "canvascreated": Anime4KManagerCanvasCreatedEvent
    "optionchanged": Anime4KManagerOptionChangedEvent
    "error": Anime4KManagerErrorEvent
    "canvasresized": Anime4KManagerCanvasResizedEvent
    "destroyed": Anime4KManagerDestroyedEvent
}


export type Anime4KOption =
    "off"
    | "mode-a"
    | "mode-b"
    | "mode-c"
    | "mode-aa"
    | "mode-bb"
    | "mode-ca"
    | "cnn-2x-medium"
    | "cnn-2x-very-large"
    | "denoise-cnn-2x-very-large"
    | "cnn-2x-ultra-large"
    | "gan-3x-large"
    | "gan-4x-ultra-large"

interface FrameDropState {
    enabled: boolean
    frameDropThreshold: number
    frameDropCount: number
    lastFrameTime: number
    targetFrameTime: number
    performanceGracePeriod: number
    initTime: number
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

export class VideoCoreAnime4KManager extends EventTarget {
    canvas: HTMLCanvasElement | null = null
    private readonly videoElement: HTMLVideoElement
    private settings: VideoCoreSettings
    private _currentOption: Anime4KOption = "off"
    private _webgpuResources: { device?: GPUDevice; pipelines?: any[] } | null = null
    private _renderLoopId: number | null = null
    private _abortController: AbortController | null = null
    private _context: GPUCanvasContext | null = null
    private _canvasFormat: GPUTextureFormat | null = null
    private _cachedResources: CachedUpscalerResources | null = null
    private _frameDropState: FrameDropState = {
        enabled: true,
        frameDropThreshold: 5,
        frameDropCount: 0,
        lastFrameTime: 0,
        targetFrameTime: 1000 / 16, // 30fps target
        performanceGracePeriod: 1000,
        initTime: 0,
    }
    private readonly _onFallback?: (message: string) => void
    private readonly _onOptionChanged?: (option: Anime4KOption) => void
    private _boxSize: { width: number; height: number } = { width: 0, height: 0 }
    private _initializationTimeout: NodeJS.Timeout | null = null
    private _initialized = false
    private _onCanvasCreatedCallbacks: Set<(canvas: HTMLCanvasElement) => void> = new Set()
    private _onCanvasCreatedCallbacksOnce: Set<(canvas: HTMLCanvasElement) => void> = new Set()

    constructor({
        videoElement,
        settings,
        onFallback,
        onOptionChanged,
    }: {
        videoElement: HTMLVideoElement
        settings: VideoCoreSettings
        onFallback?: (message: string) => void
        onOptionChanged?: (option: Anime4KOption) => void
    }) {
        super()
        this.videoElement = videoElement
        this.settings = settings
        this._onFallback = onFallback
        this._onOptionChanged = onOptionChanged

        log.info("Anime4K manager initialized")
    }

    getCurrentOption(): Anime4KOption {
        return this._currentOption
    }

    addEventListener<K extends keyof VideoCoreAnime4KManagerEventMap>(
        type: K,
        listener: (this: VideoCoreAnime4KManager, ev: VideoCoreAnime4KManagerEventMap[K]) => any,
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

    removeEventListener<K extends keyof VideoCoreAnime4KManagerEventMap>(
        type: K,
        listener: (this: VideoCoreAnime4KManager, ev: VideoCoreAnime4KManagerEventMap[K]) => any,
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

    updateCanvasSize(size: { width: number; height: number }) {
        const videoContentSize = this.getRenderedVideoContentSize(this.videoElement)
        this._boxSize = { width: videoContentSize?.displayedWidth || size.width, height: videoContentSize?.displayedHeight || size.height }
        if (this.canvas) {
            this.canvas.width = this._boxSize.width
            this.canvas.height = this._boxSize.height
            log.info("Updating canvas size", { ...this._boxSize })
        }

        const event: Anime4KManagerCanvasResizedEvent = new CustomEvent("canvasresized",
            { detail: { width: this._boxSize.width, height: this._boxSize.height } })
        this.dispatchEvent(event)
    }

    resize() {
        const videoContentSize = this.getRenderedVideoContentSize(this.videoElement)
        this._boxSize = { width: videoContentSize?.displayedWidth || 0, height: videoContentSize?.displayedHeight || 0 }
        if (this.canvas) {
            this.canvas.width = this._boxSize.width
            this.canvas.height = this._boxSize.height
            this.canvas.style.width = this._boxSize.width + "px"
            this.canvas.style.height = this._boxSize.height + "px"
            // log.info("Updating canvas size", { ...this._boxSize })
        }

        const event: Anime4KManagerCanvasResizedEvent = new CustomEvent("canvasresized",
            { detail: { width: this._boxSize.width, height: this._boxSize.height } })
        this.dispatchEvent(event)
    }

    // Adds a function to be called whenever the canvas is created or recreated
    registerOnCanvasCreated(callback: (canvas: HTMLCanvasElement) => void) {
        this._onCanvasCreatedCallbacks.add(callback)
    }

    // Adds a function to be called whenever the canvas is created or recreated
    registerOnCanvasCreatedOnce(callback: (canvas: HTMLCanvasElement) => void) {
        this._onCanvasCreatedCallbacksOnce.add(callback)
    }

    // Select an Anime4K option
    async setOption(option: Anime4KOption, state?: {
        isMiniPlayer: boolean
        isPip: boolean
        seeking: boolean
    }) {

        const previousOption = this._currentOption
        this._currentOption = option

        if (previousOption !== option && option === "off") {
            // log.info("Anime4K turned off")
            this.destroy()
            return
        }

        // Handle change of state
        if (state) {
            // For PIP or mini player, completely destroy the canvas
            if (state.isMiniPlayer || state.isPip) {
                log.info("Destroying canvas due to PIP/mini player mode")
                if (previousOption !== "off") this.destroy()
                return
            }

            // For seeking, just hide the canvas
            if (state.seeking) {
                this._hideCanvas()
                return
            }
        }

        // Skip initialization if size isn't set
        if (this._boxSize.width === 0 || this._boxSize.height === 0) {
            return
        }

        // If canvas exists but is hidden, show it
        if (this.canvas && this._isCanvasHidden()) {
            log.info("Showing previously hidden canvas")
            this._showCanvas()
            return
        }

        // If option changed or no canvas exists, reinitialize
        if (previousOption !== option || !this.canvas) {
            log.info("Change detected, reinitializing canvas")
            if (previousOption !== "off") this.destroy()
            try {
                await this._initialize()
            }
            catch (error) {
                log.error("Failed to initialize Anime4K", error)
                this._handleError(error instanceof Error ? error.message : "Unknown error")
            }
            this._onOptionChanged?.(option)
        }

    }

    // initialize the canvas and start rendering

    // Destroy and cleanup resources
    destroy() {
        // this.videoElement.style.opacity = "1"

        this._initialized = false

        if (this._initializationTimeout) {
            clearTimeout(this._initializationTimeout)
            this._initializationTimeout = null
        }

        if (this._renderLoopId !== null) {
            cancelAnimationFrame(this._renderLoopId)
            this._renderLoopId = null
        }

        // Destroy cached upscaler resources
        if (this._cachedResources) {
            this._cachedResources.inputTexture.destroy()
            this._cachedResources = null
            log.info("Destroyed cached upscaler resources")
        }

        if (this._context) {
            this._context.unconfigure()
            this._context = null
        }

        if (this.canvas) {
            this.canvas.remove()
            this.canvas = null
        }

        if (this._webgpuResources?.device) {
            this._webgpuResources.device.destroy()
            this._webgpuResources = null
        }

        if (this._abortController) {
            this._abortController.abort()
            this._abortController = null
        }

        this._canvasFormat = null
        this._frameDropState.frameDropCount = 0
        this._frameDropState.lastFrameTime = 0

        const event: Anime4KManagerDestroyedEvent = new CustomEvent("destroyed")
        this.dispatchEvent(event)
    }

    // throws if initialization fails
    private async _initialize() {
        if (this._initialized || this._currentOption === "off") {
            return
        }

        log.info("Initializing Anime4K", this._currentOption)

        const event: Anime4KManagerOptionChangedEvent = new CustomEvent("optionchanged", { detail: { newOption: this._currentOption } })
        this.dispatchEvent(event)

        this._abortController = new AbortController()
        this._frameDropState = {
            ...this._frameDropState,
            frameDropCount: 0,
            initTime: performance.now(),
            lastFrameTime: 0,
        }

        // Check WebGPU support, create canvas, and start rendering
        try {
            const gpuInfo = await this.getGPUInfo()
            if (!gpuInfo) {
                throw new Error("WebGPU not supported")
            }

            if (this._abortController.signal.aborted) return

            this._createCanvas()

            if (this._abortController.signal.aborted) return

            await this._startRendering()

            this._initialized = true
            log.info("Anime4K initialized")
        }
        catch (error) {
            if (!this._abortController?.signal.aborted) {
                log.error("Initialization failed", error)
                throw error
            }
        }
    }

    private getRenderedVideoContentSize(video: HTMLVideoElement) {
        const containerWidth = video.clientWidth
        const containerHeight = video.clientHeight

        const videoWidth = video.videoWidth
        const videoHeight = video.videoHeight

        if (!videoWidth || !videoHeight) return null // not ready yet

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
            // object-fit: fill or none or scale-down, fallback
            displayedWidth = containerWidth
            displayedHeight = containerHeight
        }

        return { displayedWidth, displayedHeight }
    }


    // Create and position the canvas
    private _createCanvas() {
        if (this._abortController?.signal.aborted) return

        this.canvas = document.createElement("canvas")

        this.canvas.width = this._boxSize.width
        this.canvas.height = this._boxSize.height
        this.canvas.style.objectFit = "cover"
        this.canvas.style.position = "absolute"
        this.canvas.style.pointerEvents = "none"
        this.canvas.style.zIndex = "2"
        this.canvas.style.objectFit = "contain"
        this.canvas.style.objectPosition = "center"
        this.canvas.style.width = this._boxSize.width + "px"
        this.canvas.style.height = this._boxSize.height + "px"
        this.canvas.style.top = ""
        this.canvas.style.display = "block"
        this.canvas.className = "vc-anime4k-canvas"
        log.info("Creating canvas", { width: this.canvas.width, height: this.canvas.height, top: this.canvas.style.top })

        this.videoElement.parentElement?.appendChild(this.canvas)
        // this.videoElement.style.opacity = "0"
    }

    // WebGPU rendering with custom device creation for higher buffer limits
    private async _startRendering() {
        if (!this.canvas || !this.videoElement || this._currentOption === "off") {
            console.warn("stopped started")
            return
        }

        // 1. Create adapter
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) {
            throw new Error("WebGPU adapter not available")
        }

        // 2. Check adapter limits and log them
        const adapterLimits = adapter.limits
        log.info("Adapter limits:", {
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

        this._webgpuResources = { device }

        log.info("Device limits:", {
            maxBufferSize: device.limits.maxBufferSize,
            maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        })

        // 4. Configure canvas context
        this._context = this.canvas.getContext("webgpu") as GPUCanvasContext
        if (!this._context) {
            throw new Error("Failed to get WebGPU canvas context")
        }

        this._canvasFormat = navigator.gpu.getPreferredCanvasFormat()
        this._context.configure({
            device,
            format: this._canvasFormat,
            alphaMode: "premultiplied",
        })

        log.info("Rendering started with custom device")

        // Notify canvas created callbacks
        setTimeout(() => {
            if (this.canvas) {
                for (const callback of this._onCanvasCreatedCallbacks) {
                    callback(this.canvas)
                }
                for (const callback of this._onCanvasCreatedCallbacksOnce) {
                    callback(this.canvas)
                }
                this._onCanvasCreatedCallbacksOnce.clear()

                const event: Anime4KManagerCanvasCreatedEvent = new CustomEvent("canvascreated", { detail: { canvas: this.canvas } })
                this.dispatchEvent(event)
            }
        }, 100)

        // 5. Start render loop
        this._renderFrame()

        // Start frame drop detection if enabled
        if (this._frameDropState.enabled && this._isOptionSelected(this._currentOption)) {
            this._startFrameDropDetection()
        }
    }

    // Custom render frame loop
    private _renderFrame = () => {
        if (!this._webgpuResources?.device || !this._context || !this.videoElement || !this.canvas || !this._canvasFormat) {
            return
        }

        const device = this._webgpuResources.device

        // Skip if video is not playing or seeking
        if (this.videoElement.paused || this.videoElement.seeking || this.videoElement.readyState < 2) {
            this._renderLoopId = requestAnimationFrame(this._renderFrame)
            return
        }

        // Skip if video dimensions are not valid (can be 0 even when readyState >= 2)
        const videoWidth = this.videoElement.videoWidth
        const videoHeight = this.videoElement.videoHeight
        const canvasWidth = this.canvas.width
        const canvasHeight = this.canvas.height

        if (!videoWidth || !videoHeight || !canvasWidth || !canvasHeight) {
            this._renderLoopId = requestAnimationFrame(this._renderFrame)
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

            // Create command encoder
            const commandEncoder = device.createCommandEncoder()

            let outputTexture: GPUTexture

            if (isRawUpscaler(this._currentOption)) {
                // 7a. For raw upscalers (GAN, CNN), use cached resources
                // Check if we need to (re)create cached resources
                const needsRecreate = !this._cachedResources ||
                    this._cachedResources.nativeWidth !== nativeDimensions.width ||
                    this._cachedResources.nativeHeight !== nativeDimensions.height ||
                    this._cachedResources.targetWidth !== targetDimensions.width ||
                    this._cachedResources.targetHeight !== targetDimensions.height

                if (needsRecreate) {
                    // Destroy old resources
                    if (this._cachedResources) {
                        this._cachedResources.inputTexture.destroy()
                        log.info("Destroyed old cached resources")
                    }

                    // Create new cached resources
                    log.info(`Creating cached resources for ${this._currentOption}`)

                    // Create input texture for raw upscaler
                    const inputTexture = device.createTexture({
                        size: { width: nativeDimensions.width, height: nativeDimensions.height },
                        format: "rgba8unorm",
                        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
                    })

                    // Create upscaler pipeline
                    const upscalerPipeline = this.createRawUpscalerPipeline(device, inputTexture)
                    const upscaledTexture = upscalerPipeline.getOutputTexture()

                    // Create downscale pipeline
                    const downscalePipeline = new Downscale({
                        device,
                        inputTexture: upscaledTexture,
                        targetDimensions,
                    })

                    this._cachedResources = {
                        inputTexture,
                        upscalerPipeline,
                        downscalePipeline,
                        nativeWidth: nativeDimensions.width,
                        nativeHeight: nativeDimensions.height,
                        targetWidth: targetDimensions.width,
                        targetHeight: targetDimensions.height,
                    }

                    log.info("Cached resources created successfully")
                }

                // Fill input texture from video frame
                fillTextureFromExternal(
                    device,
                    commandEncoder,
                    externalTexture,
                    this._cachedResources!.inputTexture
                )

                // Run upscaler pipeline
                this._cachedResources!.upscalerPipeline.pass(commandEncoder)

                // Run downscale pipeline
                this._cachedResources!.downscalePipeline.pass(commandEncoder)
                outputTexture = this._cachedResources!.downscalePipeline.getOutputTexture()
            } else {
                // 7b. For preset pipelines (ModeA, etc.), use external texture directly
                // These handle their own texture management internally
                const pipelineProps = {
                    device,
                    inputTexture: externalTexture,
                    nativeDimensions,
                    targetDimensions,
                }

                const [pipeline] = this.createPipeline(pipelineProps)
                pipeline.pass(commandEncoder)
                outputTexture = pipeline.getOutputTexture()
            }

            // 9. Get canvas texture and blit output to it (handles format conversion)
            const canvasTexture = this._context.getCurrentTexture()

            // Use blit shader to copy and convert format (RGBA16Float -> BGRA8Unorm)
            blitToCanvas(device, commandEncoder, outputTexture, canvasTexture, this._canvasFormat)

            // 10. Submit commands
            device.queue.submit([commandEncoder.finish()])

        }
        catch (error) {
            // Only log errors that aren't expected during normal operation
            const errorMessage = error instanceof Error ? error.message : String(error)
            if (!errorMessage.includes("destroyed") && !errorMessage.includes("lost")) {
                log.error("Render frame error:", error)
            }
        }

        // Continue render loop
        this._renderLoopId = requestAnimationFrame(this._renderFrame)
    }

    // Create pipeline for preset modes (ModeA, ModeB, etc.) that accept GPUExternalTexture
    private createPipeline(commonProps: any): [Anime4KPipeline] {
        switch (this._currentOption) {
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
    private createRawUpscalerPipeline(device: GPUDevice, inputTexture: GPUTexture): Anime4KPipeline {
        const props = { device, inputTexture }
        switch (this._currentOption) {
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
                throw new Error(`Unknown raw upscaler option: ${this._currentOption}`)
        }
    }

    // Start frame drop detection loop
    private _startFrameDropDetection() {
        const frameDetectionLoop = () => {
            if (this._isOptionSelected(this._currentOption) && this._renderLoopId !== null) {
                this._detectFrameDrops()
                this._renderLoopId = requestAnimationFrame(frameDetectionLoop)
            }
        }
        this._renderLoopId = requestAnimationFrame(frameDetectionLoop)
    }

    // Detect frame drops and stop when it gets bad
    private _detectFrameDrops() {
        if (!this._isOptionSelected(this._currentOption)) {
            return
        }

        const now = performance.now()
        const timeSinceInit = now - this._frameDropState.initTime

        // Skip detection during grace period
        if (timeSinceInit < this._frameDropState.performanceGracePeriod) {
            this._frameDropState.lastFrameTime = now
            return
        }

        if (this._frameDropState.lastFrameTime > 0) {
            const frameTime = now - this._frameDropState.lastFrameTime
            const isFrameDrop = frameTime > this._frameDropState.targetFrameTime * 1.5 // 50% tolerance

            if (isFrameDrop) {
                this._frameDropState.frameDropCount++

                if (this._frameDropState.frameDropCount >= this._frameDropState.frameDropThreshold) {
                    log.warning(`Detected ${this._frameDropState.frameDropCount} consecutive frame drops. Falling back to 'off' mode.`)
                    this._handlePerformanceFallback()
                    return
                }
            } else {
                // Reset on successful frame
                this._frameDropState.frameDropCount = 0
            }
        }

        this._frameDropState.lastFrameTime = now
    }

    private _handlePerformanceFallback() {
        this._onFallback?.("Performance degraded. Turning off Anime4K.")
        // Dispatch Fallback Event
        const errorEvent: Anime4KManagerErrorEvent = new CustomEvent("error", { detail: { message: "Performance degraded. Turning off Anime4K." } })
        this.dispatchEvent(errorEvent)

        this.setOption("off")
        this._onOptionChanged?.("off")
    }

    private _handleError(message: string) {
        this._onFallback?.(`Anime4K: ${message}`)
        const errorEvent: Anime4KManagerErrorEvent = new CustomEvent("error", { detail: { message: message } })
        this.dispatchEvent(errorEvent)

        this.setOption("off")
        this._onOptionChanged?.("off")
    }

    // Get GPU information
    private async getGPUInfo() {
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
        }
        catch {
            return null
        }
    }

    private _isOptionSelected(option: Anime4KOption): boolean {
        return option !== "off"
    }

    private _hideCanvas() {
        if (this.canvas) {
            this.canvas.style.display = "none"
            // this.videoElement.style.opacity = "1"
        }
    }

    private _showCanvas() {
        if (this.canvas) {
            this.canvas.style.display = "block"
            // this.videoElement.style.opacity = "0"
        }
    }

    private _isCanvasHidden(): boolean {
        return this.canvas ? this.canvas.style.display === "none" : false
    }
}
