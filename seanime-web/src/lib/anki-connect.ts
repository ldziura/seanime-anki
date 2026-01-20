/**
 * AnkiConnect API client for creating Anki flashcards from Seanime
 * Requires AnkiConnect addon (code: 2055492159) installed in Anki
 */

import { logger } from "@/lib/helpers/debug"

const log = logger("ANKI CONNECT")

export interface AnkiMedia {
    data: string // base64 encoded data
    filename: string
    fields: string[] // fields to add this media to
}

export interface AnkiNote {
    deckName: string
    modelName: string
    fields: Record<string, string>
    audio?: AnkiMedia[]
    picture?: AnkiMedia[]
    tags?: string[]
}

export interface AnkiConnectResponse<T = unknown> {
    result: T
    error: string | null
}

export interface NoteInfo {
    noteId: number
    modelName: string
    tags: string[]
    fields: Record<string, { value: string; order: number }>
}

export class AnkiConnectService {
    private url: string
    private lastNoteId: number | null = null

    constructor(url: string = "http://127.0.0.1:8765") {
        this.url = url
    }

    setUrl(url: string) {
        this.url = url
    }

    async invoke<T = unknown>(action: string, params?: object): Promise<T> {
        const requestBody = {
            action,
            version: 6,
            params,
        }

        log.info(`Request to ${this.url}`, { action, params: params ? Object.keys(params) : [] })

        let response: Response
        try {
            response = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
            })
        } catch (fetchError) {
            log.error("Fetch failed", {
                url: this.url,
                error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                errorType: fetchError instanceof TypeError ? "TypeError (likely CORS or network)" : "Unknown",
            })
            throw fetchError
        }

        log.info("Response received", { status: response.status, statusText: response.statusText })

        if (!response.ok) {
            log.error("Response not OK", { status: response.status, statusText: response.statusText })
            throw new Error(`AnkiConnect request failed: ${response.status} ${response.statusText}`)
        }

        let result: AnkiConnectResponse<T>
        try {
            result = await response.json() as AnkiConnectResponse<T>
            log.info("Response parsed", { hasError: !!result.error, hasResult: result.result !== null })
        } catch (parseError) {
            log.error("Failed to parse response JSON", parseError)
            throw parseError
        }

        if (result.error) {
            log.error("AnkiConnect returned error", { error: result.error })
            throw new Error(`AnkiConnect error: ${result.error}`)
        }

        return result.result
    }

    /**
     * Test connection to AnkiConnect
     */
    async testConnection(): Promise<boolean> {
        log.info("Testing connection", { url: this.url })
        try {
            const version = await this.invoke<number>("version")
            log.info("Connection successful", { version })
            return version >= 6
        } catch (error) {
            log.error("Connection test failed", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            })
            return false
        }
    }

    /**
     * Get list of deck names
     */
    async getDecks(): Promise<string[]> {
        return this.invoke<string[]>("deckNames")
    }

    /**
     * Get list of model (note type) names
     */
    async getModels(): Promise<string[]> {
        return this.invoke<string[]>("modelNames")
    }

    /**
     * Get field names for a specific model
     */
    async getModelFields(modelName: string): Promise<string[]> {
        return this.invoke<string[]>("modelFieldNames", { modelName })
    }

    /**
     * Add a new note to Anki
     */
    async addNote(note: AnkiNote): Promise<number> {
        const noteId = await this.invoke<number>("addNote", {
            note: {
                deckName: note.deckName,
                modelName: note.modelName,
                fields: note.fields,
                audio: note.audio,
                picture: note.picture,
                tags: note.tags || [],
                options: {
                    allowDuplicate: true,
                    duplicateScope: "deck",
                },
            },
        })
        this.lastNoteId = noteId
        return noteId
    }

    /**
     * Update fields of an existing note
     */
    async updateNoteFields(
        noteId: number,
        fields: Record<string, string>,
        audio?: AnkiMedia[],
        picture?: AnkiMedia[],
    ): Promise<void> {
        await this.invoke("updateNoteFields", {
            note: {
                id: noteId,
                fields,
                audio,
                picture,
            },
        })
    }

    /**
     * Get the last created note ID
     */
    getLastNoteId(): number | null {
        return this.lastNoteId
    }

    /**
     * Clear the last note ID
     */
    clearLastNoteId(): void {
        this.lastNoteId = null
    }

    /**
     * Sync Anki database (trigger save)
     */
    async sync(): Promise<void> {
        await this.invoke("sync")
    }

    /**
     * Find notes by query
     * Returns array of note IDs
     */
    async findNotes(query: string): Promise<number[]> {
        return this.invoke<number[]>("findNotes", { query })
    }

    /**
     * Get detailed information about notes including their field values
     * @param noteIds - Array of note IDs to get info for
     */
    async notesInfo(noteIds: number[]): Promise<NoteInfo[]> {
        return this.invoke<NoteInfo[]>("notesInfo", { notes: noteIds })
    }

    /**
     * Detect the most common note type (model) used in a deck
     * @param deckName - The deck to analyze
     * @returns The most common model name, or null if deck is empty
     */
    async detectDeckNoteType(deckName: string): Promise<string | null> {
        try {
            // Query notes specifically from this deck
            const query = `deck:"${deckName}"`
            log.info("Detecting note type for deck", { deckName, query })

            const noteIds = await this.findNotes(query)
            if (!noteIds || noteIds.length === 0) {
                log.info("No notes found in deck for type detection", { deckName })
                return null
            }

            log.info("Found notes in deck", { deckName, totalNotes: noteIds.length })

            // Sample up to 20 most recent notes from this deck (highest IDs = most recent)
            const sampleIds = noteIds
                .sort((a, b) => b - a)
                .slice(0, 20)

            log.info("Sampling recent notes from deck", { deckName, sampleIds })

            const notesInfo = await this.notesInfo(sampleIds)
            if (!notesInfo || notesInfo.length === 0) {
                return null
            }

            // Count model occurrences
            const modelCounts: Record<string, number> = {}
            for (const note of notesInfo) {
                modelCounts[note.modelName] = (modelCounts[note.modelName] || 0) + 1
            }

            // Find most common model
            let mostCommonModel: string | null = null
            let maxCount = 0
            for (const [model, count] of Object.entries(modelCounts)) {
                if (count > maxCount) {
                    maxCount = count
                    mostCommonModel = model
                }
            }

            log.info("Detected deck note type", { deckName, modelName: mostCommonModel, sampleSize: sampleIds.length })
            return mostCommonModel
        } catch (error) {
            log.error("Failed to detect deck note type", { deckName, error })
            return null
        }
    }

    /**
     * Get the most recently created note ID from a specific deck
     * Note IDs in Anki are timestamps, so the highest ID is the most recent
     */
    async getLatestNoteIdFromDeck(deckName: string): Promise<number | null> {
        try {
            // Find all notes in the deck
            const noteIds = await this.findNotes(`deck:"${deckName}"`)
            if (!noteIds || noteIds.length === 0) {
                log.info("No notes found in deck", { deckName })
                return null
            }
            // Note IDs are timestamps, so the highest is the most recent
            const latestId = Math.max(...noteIds)
            log.info("Found latest note", { deckName, latestId, totalNotes: noteIds.length })
            return latestId
        } catch (error) {
            log.error("Failed to get latest note ID", { deckName, error })
            return null
        }
    }

    /**
     * Get the last note ID - either locally tracked or fetch from Anki
     * @param deckName - The deck to search in if not locally tracked
     * @param forceRefresh - Always fetch from Anki, ignoring cached value
     */
    async getOrFetchLastNoteId(deckName?: string, forceRefresh: boolean = false): Promise<number | null> {
        // If forceRefresh, always fetch from Anki
        if (forceRefresh && deckName) {
            const latestId = await this.getLatestNoteIdFromDeck(deckName)
            if (latestId) {
                this.lastNoteId = latestId
                return latestId
            }
            return null
        }

        // First check if we have a locally tracked note ID
        if (this.lastNoteId) {
            return this.lastNoteId
        }
        // If no local ID and deck name provided, fetch from Anki
        if (deckName) {
            const latestId = await this.getLatestNoteIdFromDeck(deckName)
            if (latestId) {
                this.lastNoteId = latestId
                return latestId
            }
        }
        return null
    }
}

// Singleton instance
export const ankiConnect = new AnkiConnectService()
