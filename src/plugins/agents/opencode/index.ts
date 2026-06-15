// OpenCode CLI agent adapter
// Uses `opencode run --format json` for programmatic interaction

import type { AgentAdapter, ChatMessage } from '../../../core/types.js'
import { crossSpawn } from '../../../utils/cross-platform.js'

interface OpenCodePart {
  type: string
  text?: string
}

interface OpenCodeEvent {
  type: string
  content?: string
  text?: string
  message?: string
  error?: string
  sessionID?: string
  part?: OpenCodePart
}

interface CallResult {
  text: string
  sessionId: string | null
}

const sessionMap = new Map<string, string>()

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode'
  readonly aliases = ['oc', 'opencodeai']

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = crossSpawn('opencode', ['--version'], { stdio: 'ignore' })
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  async *sendPrompt(sessionId: string, prompt: string, history?: ChatMessage[]): AsyncGenerator<string> {
    console.log(`[OpenCode] sendPrompt called, prompt: ${prompt}, history: ${history?.length || 0} messages`)

    const ocSessionId = sessionMap.get(sessionId)
    const result = await this.callOpenCode(prompt, ocSessionId ?? null)

    if (result.sessionId) {
      sessionMap.set(sessionId, result.sessionId)
    }

    console.log(`[OpenCode] Response length: ${result.text.length}`)

    if (result.text) {
      yield result.text
    }
  }

  private callOpenCode(prompt: string, existingOcSessionId: string | null): Promise<CallResult> {
    return new Promise((resolve, reject) => {
      const args = ['run', '--format', 'json']
      if (existingOcSessionId) {
        args.push('--session', existingOcSessionId)
      }
      args.push(prompt)

      const proc = crossSpawn('opencode', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let fullText = ''
      let errorMessage = ''
      let ocSessionId: string | null = existingOcSessionId ?? null

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
        const lines = stdout.split('\n')
        stdout = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue

          try {
            const event: OpenCodeEvent = JSON.parse(line)
            console.log('[OpenCode] Event:', JSON.stringify(event))

            // Capture the opencode session ID from the first event
            if (!ocSessionId && event.sessionID) {
              ocSessionId = event.sessionID
              console.log('[OpenCode] Captured session ID:', ocSessionId)
            }

            // Capture error message
            if (event.type === 'error') {
              errorMessage = event.error || event.message || 'Unknown error'
            }

            const text = this.extractText(event)
            if (text) {
              fullText += text
            }
          } catch {
            // Skip malformed JSON
          }
        }
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        console.error('[OpenCode stderr]', data.toString())
      })

      proc.on('error', (err) => {
        reject(err)
      })

      proc.on('close', (code) => {
        console.log('[OpenCode] Process closed, code:', code, 'stderr:', stderr)
        // If we got text output, return it even if exit code != 0 (tool errors)
        if (fullText) {
          resolve({ text: fullText, sessionId: ocSessionId })
        } else if (code !== 0) {
          let errorMsg = stderr.trim() || errorMessage || 'OpenCode 执行失败'
          if (errorMsg.length > 200) {
            errorMsg = errorMsg.substring(0, 200) + '...'
          }
          resolve({ text: `❌ OpenCode 错误: ${errorMsg}`, sessionId: ocSessionId })
        } else {
          resolve({ text: fullText, sessionId: ocSessionId })
        }
      })
    })
  }

  private extractText(event: OpenCodeEvent): string {
    // Handle text events with part.text (OpenCode format)
    if (event.type === 'text' && event.part?.text) {
      return event.part.text
    }

    // Handle content events
    if (event.type === 'content' && event.content) {
      return event.content
    }

    // Handle text events with direct text field
    if (event.text) {
      return event.text
    }

    // Handle message field
    if (event.message) {
      return event.message
    }

    return ''
  }
}

// Singleton instance
export const opencodeAdapter = new OpenCodeAdapter()
