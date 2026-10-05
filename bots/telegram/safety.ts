/**
 * Adapter to the proposal safety engine (tools/proposalSafety, owned by another module).
 * The engine is loaded lazily with a dynamic require so the bot keeps working
 * (with "no findings") before the engine lands or if it fails to load.
 *
 * Engine API (CLAUDE.md):
 *   loadProposalSafetyInput(connection, proposalPk, { programId }) -> Promise<ProposalSafetyInput>
 *   analyzeProposal(input) -> { actions, findings: SafetyFinding[], maxSeverity }
 */
import * as fs from 'fs'
import * as path from 'path'
import { Connection, PublicKey } from '@solana/web3.js'

export interface SafetyFinding {
  id: string
  severity: 'red' | 'yellow' | 'info'
  title: string
  explanation: string
  instructionIndex?: number
}

export interface SafetyResult {
  /** false when the engine is not installed / failed to load */
  available: boolean
  findings: SafetyFinding[]
}

export interface SafetyChecker {
  check(proposalPk: string, programId: string): Promise<SafetyResult>
}

interface EngineModule {
  analyzeProposal: (input: any) => { findings: SafetyFinding[] }
  loadProposalSafetyInput: (
    connection: Connection,
    proposalPk: PublicKey,
    opts?: { programId?: PublicKey },
  ) => Promise<any>
}

export const ENGINE_DIR = path.resolve(__dirname, '../../tools/proposalSafety')

let cached: EngineModule | null | undefined

export function loadEngine(
  dir = ENGINE_DIR,
  log: (m: string) => void = console.warn,
): EngineModule | null {
  if (cached !== undefined && dir === ENGINE_DIR) return cached
  let mod: EngineModule | null = null
  const exists = ['index.ts', 'index.js'].some((f) => fs.existsSync(path.join(dir, f)))
  if (exists) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require(dir)
      if (
        typeof m?.analyzeProposal === 'function' &&
        typeof m?.loadProposalSafetyInput === 'function'
      ) {
        mod = m
      } else {
        log('[safety] tools/proposalSafety found but does not export the expected API; skipping')
      }
    } catch (e: any) {
      log(`[safety] failed to load tools/proposalSafety: ${e?.message ?? e}; skipping`)
    }
  } else {
    log('[safety] tools/proposalSafety not present; danger alerts disabled')
  }
  if (dir === ENGINE_DIR) cached = mod
  return mod
}

export function onlyRed(findings: SafetyFinding[] | undefined) {
  return (findings ?? []).filter((f) => f && f.severity === 'red')
}

export function makeSafetyChecker(
  connection: Connection,
  engine: EngineModule | null = loadEngine(),
): SafetyChecker {
  return {
    async check(proposalPk, programId) {
      if (!engine) return { available: false, findings: [] }
      const input = await engine.loadProposalSafetyInput(
        connection,
        new PublicKey(proposalPk),
        { programId: new PublicKey(programId) },
      )
      const report = engine.analyzeProposal(input)
      return { available: true, findings: Array.isArray(report?.findings) ? report.findings : [] }
    },
  }
}

/** Stable key for "this exact danger was already alerted". */
export function dangerKey(txSig: string | undefined, red: SafetyFinding[]) {
  const ids = red.map((f) => `${f.id}@${f.instructionIndex ?? ''}`).sort()
  return `${txSig ?? ''}|${ids.join(',')}`
}
