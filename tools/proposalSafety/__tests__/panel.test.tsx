/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 */
import * as fs from 'fs'
import * as path from 'path'
import { render, screen } from '@testing-library/react'
import { ProposalSafetyReportView } from '../../../components/ProposalSafety/ProposalSafetyPanel'
import { analyzeProposal } from '../analyze'
import { ProposalSafetyInput } from '../types'

jest.mock('../../../components/ProposalSafety/useProposalSafety', () => ({
  useProposalSafetyQuery: () => ({ data: undefined, isLoading: true }),
}))

const DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'marinade')
const load = (pk: string): ProposalSafetyInput =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${pk}.json`), 'utf8'))

describe('ProposalSafetyReportView', () => {
  it('renders MIP-24 findings, actions and the description box', () => {
    const report = analyzeProposal(load('EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9'))
    render(<ProposalSafetyReportView report={report} />)
    expect(screen.getAllByText(/This DAO has never paid this address before/).length).toBeGreaterThan(0)
    expect(screen.getByText('Description vs. what it actually does')).toBeInTheDocument()
    expect(screen.getByText('Instructions in plain language')).toBeInTheDocument()
  })

  it('renders an attacker-controlled description as text, never as HTML', () => {
    const input = load('7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj')
    input.proposal.descriptionText = 'No parameter changes. <img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    const report = analyzeProposal(input)
    const { container } = render(<ProposalSafetyReportView report={report} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect((window as any).__pwned).toBeUndefined()
    expect(container.textContent).toContain('No parameter changes.')
  })
})
