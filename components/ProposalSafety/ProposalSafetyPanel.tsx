import { useState } from 'react'
import {
  ExclamationCircleIcon,
  ExclamationIcon,
  InformationCircleIcon,
  ShieldCheckIcon,
} from '@heroicons/react/solid'
import { ChevronDownIcon } from '@heroicons/react/outline'
import type {
  ConfigChange,
  DecodedAction,
  MaxSeverity,
  ProposalSafetyReport,
  SafetyFinding,
} from '@tools/proposalSafety'
import { useProposalSafetyQuery } from './useProposalSafety'

// NOTE: every string rendered here (including the proposal description and memo text,
// which are attacker-controlled) is rendered as a React text node. Never use
// dangerouslySetInnerHTML in this component.

const SEVERITY_STYLES: Record<
  'red' | 'yellow' | 'info',
  { box: string; title: string; body: string; icon: string }
> = {
  red: {
    box: 'bg-red-50 border border-red-200',
    title: 'text-red-800',
    body: 'text-red-700',
    icon: 'text-red-400',
  },
  yellow: {
    box: 'bg-yellow-50 border border-yellow-200',
    title: 'text-yellow-800',
    body: 'text-yellow-700',
    icon: 'text-yellow-400',
  },
  info: {
    box: 'bg-bkg-3 border border-fgd-4',
    title: 'text-fgd-1',
    body: 'text-fgd-2',
    icon: 'text-fgd-3',
  },
}

const SeverityIcon = ({
  severity,
  className,
}: {
  severity: MaxSeverity
  className?: string
}) => {
  if (severity === 'red')
    return <ExclamationCircleIcon className={className} aria-hidden="true" />
  if (severity === 'yellow')
    return <ExclamationIcon className={className} aria-hidden="true" />
  if (severity === 'info')
    return <InformationCircleIcon className={className} aria-hidden="true" />
  return <ShieldCheckIcon className={className} aria-hidden="true" />
}

const Verdict = ({ severity }: { severity: MaxSeverity }) => {
  const label =
    severity === 'red'
      ? 'Danger — read the red findings before voting'
      : severity === 'yellow'
      ? 'Review carefully'
      : 'No issues found by the rules'
  const cls =
    severity === 'red'
      ? 'bg-red-600 text-white'
      : severity === 'yellow'
      ? 'bg-yellow-400 text-black'
      : 'bg-green text-bkg-1'
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${cls}`}
    >
      {label}
    </span>
  )
}

const FindingCard = ({ finding }: { finding: SafetyFinding }) => {
  const s = SEVERITY_STYLES[finding.severity]
  return (
    <div className={`rounded-md p-4 ${s.box}`}>
      <div className="flex">
        <div className="flex-shrink-0">
          <SeverityIcon
            severity={finding.severity}
            className={`h-5 w-5 ${s.icon}`}
          />
        </div>
        <div className="ml-3 min-w-0">
          <h3 className={`text-sm font-medium ${s.title}`}>
            {finding.title}
            {finding.instructionIndex !== undefined && (
              <span className="ml-2 text-xs font-normal opacity-75">
                instruction #{finding.instructionIndex + 1}
              </span>
            )}
          </h3>
          <p className={`mt-1 text-sm break-words ${s.body}`}>
            {finding.explanation}
          </p>
        </div>
      </div>
    </div>
  )
}

const ActionRow = ({ action }: { action: DecodedAction }) => {
  const [open, setOpen] = useState(false)
  const dot =
    action.severity === 'red'
      ? 'bg-red-500'
      : action.severity === 'yellow'
      ? 'bg-yellow-400'
      : 'bg-fgd-4'
  return (
    <li className="border-b border-fgd-4 last:border-b-0 py-2">
      <button
        type="button"
        className="flex w-full items-start text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span
          className={`mt-1.5 mr-2 h-2.5 w-2.5 flex-shrink-0 rounded-full ${dot}`}
        />
        <span className="flex-1 min-w-0 text-sm text-fgd-1 break-words">
          <span className="text-fgd-3 mr-1">#{action.index + 1}</span>
          {action.summary}
          {!action.known && (
            <span className="ml-2 text-xs text-yellow-500">
              (not decoded)
            </span>
          )}
        </span>
        <ChevronDownIcon
          className={`ml-2 h-4 w-4 flex-shrink-0 text-fgd-3 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && (
        <dl className="mt-2 ml-5 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
          <dt className="text-fgd-3">Program</dt>
          <dd className="sm:col-span-2 text-fgd-2 break-all">
            {action.programName} ({action.programId})
          </dd>
          <dt className="text-fgd-3">Hold-up time</dt>
          <dd className="sm:col-span-2 text-fgd-2">
            {action.holdUpTime
              ? `${action.holdUpTime} s`
              : '0 — executes immediately'}
            {action.executed ? ' (already executed)' : ''}
          </dd>
          {action.details.map((d, i) => (
            <div key={i} className="contents">
              <dt className="text-fgd-3">{d.label}</dt>
              <dd className="sm:col-span-2 text-fgd-2 break-all">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

const ChangesTable = ({ changes }: { changes: ConfigChange[] }) => {
  const [showAll, setShowAll] = useState(false)
  const changed = changes.filter((c) => c.changed)
  const rows = showAll ? changes : changed
  if (!changes.length) return null
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-bold text-fgd-1">What changes</h4>
        {changed.length !== changes.length && (
          <button
            type="button"
            className="text-xs text-primary-light"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? 'Only show changes' : 'Show unchanged settings too'}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-fgd-3">
          No effective changes compared with the current on-chain values.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-fgd-3">
                <th className="py-1 pr-2 font-normal">Setting</th>
                <th className="py-1 pr-2 font-normal">Now</th>
                <th className="py-1 pr-2 font-normal">After this proposal</th>
                <th className="py-1 font-normal">Ix</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={`${c.key}-${i}`} className="border-t border-fgd-4">
                  <td className="py-1 pr-2 text-fgd-2">{c.label}</td>
                  <td className="py-1 pr-2 text-fgd-2 break-all">{c.old}</td>
                  <td
                    className={`py-1 pr-2 break-all ${
                      c.changed ? 'text-fgd-1 font-bold' : 'text-fgd-3'
                    }`}
                  >
                    {c.new}
                  </td>
                  <td className="py-1 text-fgd-3">#{c.instructionIndex + 1}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const DescriptionBox = ({ report }: { report: ProposalSafetyReport }) => {
  const d = report.description
  if (!d.actually.length && !d.claims.length) return null
  return (
    <div
      className={`rounded-md p-3 ${
        d.mismatch ? 'border border-red-300' : 'border border-fgd-4'
      }`}
    >
      <h4 className="text-sm font-bold text-fgd-1 mb-2">
        Description vs. what it actually does
      </h4>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <p className="text-xs text-fgd-3 mb-1">
            The description says{d.unresolvedLink ? ' (link not loaded)' : ''}:
          </p>
          {/* untrusted text: rendered as a plain text node */}
          <blockquote className="text-xs text-fgd-2 border-l-2 border-fgd-4 pl-2 whitespace-pre-wrap break-words">
            {d.claims.length ? d.claims.join(' … ') : d.text || '(empty)'}
          </blockquote>
        </div>
        <div>
          <p className="text-xs text-fgd-3 mb-1">The instructions actually:</p>
          <ul className="list-disc pl-4 text-xs text-fgd-1 space-y-1">
            {d.actually.map((a, i) => (
              <li key={i} className="break-words">
                {a}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export const ProposalSafetyReportView = ({
  report,
}: {
  report: ProposalSafetyReport
}) => {
  const [showInfo, setShowInfo] = useState(false)
  const serious = report.findings.filter((f) => f.severity !== 'info')
  const info = report.findings.filter((f) => f.severity === 'info')
  return (
    <div className="space-y-4">
      {serious.length > 0 && (
        <div className="space-y-2">
          {serious.map((f, i) => (
            <FindingCard key={`${f.id}-${i}`} finding={f} />
          ))}
        </div>
      )}
      {info.length > 0 && (
        <div>
          <button
            type="button"
            className="text-xs text-primary-light"
            onClick={() => setShowInfo(!showInfo)}
          >
            {showInfo ? 'Hide' : 'Show'} {info.length} informational note
            {info.length > 1 ? 's' : ''}
          </button>
          {showInfo && (
            <div className="mt-2 space-y-2">
              {info.map((f, i) => (
                <FindingCard key={`${f.id}-${i}`} finding={f} />
              ))}
            </div>
          )}
        </div>
      )}
      <DescriptionBox report={report} />
      <div>
        <h4 className="text-sm font-bold text-fgd-1 mb-1">
          Instructions in plain language
        </h4>
        {report.actions.length === 0 ? (
          <p className="text-xs text-fgd-3">
            This proposal has no instructions (signaling vote only).
          </p>
        ) : (
          <ul>
            {report.actions.map((a) => (
              <ActionRow key={a.index} action={a} />
            ))}
          </ul>
        )}
      </div>
      <ChangesTable changes={report.changes} />
      {report.notes.length > 0 && (
        <ul className="text-xs text-fgd-3 list-disc pl-4">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

const ProposalSafetyPanel = () => {
  const { data, isLoading, error } = useProposalSafetyQuery()
  const report = data?.report
  const accent =
    report?.maxSeverity === 'red'
      ? 'border-l-red-500'
      : report?.maxSeverity === 'yellow'
      ? 'border-l-yellow-400'
      : 'border-l-primary-light'
  return (
    <div
      className={`rounded-lg border border-bkg-4 border-l-4 ${accent} bg-bkg-2 p-4 space-y-4 shadow-lg`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="mb-0 flex items-center">
          <span className="mr-3 rounded border border-primary-light px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-primary-light">
            Safety check
          </span>
          <SeverityIcon
            severity={report?.maxSeverity ?? 'none'}
            className={`h-5 w-5 mr-2 ${
              report?.maxSeverity === 'red'
                ? 'text-red-500'
                : report?.maxSeverity === 'yellow'
                ? 'text-yellow-400'
                : 'text-fgd-3'
            }`}
          />
          What this proposal really does
        </h3>
        {report && <Verdict severity={report.maxSeverity} />}
      </div>
      <p className="text-[11px] text-fgd-3">
        Unaudited, evaluation-grade. Automatic rule-based reading of the
        on-chain instructions — it can miss things; always check the
        instructions below.
      </p>
      {isLoading && (
        <div className="space-y-2">
          <div className="animate-pulse bg-bkg-3 h-10 rounded-md" />
          <div className="animate-pulse bg-bkg-3 h-24 rounded-md" />
          <p className="text-xs text-fgd-3">
            Reading the instructions, treasury and payment history…
          </p>
        </div>
      )}
      {error && !report && (
        <p className="text-sm text-yellow-600">
          Could not run the safety check ({String((error as Error)?.message ?? error).slice(0, 200)}). Review the instructions manually.
        </p>
      )}
      {report && <ProposalSafetyReportView report={report} />}
    </div>
  )
}

export default ProposalSafetyPanel
