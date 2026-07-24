import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, post: postMock }, formatFCFA: (n: number) => `${n} FCFA` }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks/useSpeech', () => ({ useSpeech: () => ({ supported: false, listening: false, speak: vi.fn(), startListening: vi.fn(), stopSpeaking: vi.fn() }) }))
vi.mock('@/lib/apec', () => ({ apecMetaPairs: () => [] }))

import MesOffresInternes from './MesOffresInternes'
import { useAuthStore } from '@/stores/authStore'

const JOB = { id: 'job-1', title: 'Développeur', department_name: 'IT', location: 'Abidjan', contract_type: 'cdi', salary_min: null, salary_max: null, description: 'desc', requirements: null, visibility: 'internal', target_min_seniority_months: null, created_at: '2026-01-01', already_applied: 0 }

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MesOffresInternes /></QueryClientProvider>)
}

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset()
  // Module interview_sim ACTIVÉ par défaut dans ces tests : seule la
  // description « garde module » ci-dessous exerce le cas désactivé.
  useAuthStore.setState({ tenantConfig: { primaryColor: '#000', secondaryColor: '#000', logoUrl: null, name: 'SOTRA', slug: 'sotra', enabledModules: { interview_sim: true } } })
})
afterEach(() => { cleanup(); useAuthStore.getState().logout() })

describe('MesOffresInternes — entretien par offre', () => {
  it('la modale de détail affiche le bouton « s’entraîner »', async () => {
    getMock.mockImplementation((url: string) => url === '/recruitment/internal-jobs'
      ? Promise.resolve({ data: { data: [JOB] } })
      : Promise.resolve({ data: { data: {} } }))
    renderPage()
    fireEvent.click(await screen.findByText('offers.viewOffer'))
    expect(await screen.findByText('offers.trainInterview')).toBeTruthy()
  })

  it('clic « s’entraîner » → bascule en entretien (start appelé)', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/recruitment/internal-jobs') return Promise.resolve({ data: { data: [JOB] } })
      if (url === '/interview-sim/internal-jobs/job-1/start') return Promise.resolve({ data: { data: { jobId: 'job-1', jobTitle: 'Développeur', langue: 'fr', roleKey: 'dev', nbQuestions: 1, questions: ['Q1'], categories: ['Java'] } } })
      return Promise.resolve({ data: { data: {} } })
    })
    renderPage()
    fireEvent.click(await screen.findByText('offers.viewOffer'))
    fireEvent.click(await screen.findByText('offers.trainInterview'))
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/interview-sim/internal-jobs/job-1/start'))
    expect(await screen.findByText('Q1')).toBeTruthy()
  })
})

describe('MesOffresInternes — garde module interview_sim (opt-in)', () => {
  it('module DÉSACTIVÉ (défaut) : le bouton « s’entraîner » n’est pas affiché', async () => {
    useAuthStore.setState({ tenantConfig: { primaryColor: '#000', secondaryColor: '#000', logoUrl: null, name: 'SOTRA', slug: 'sotra', enabledModules: { interview_sim: false } } })
    getMock.mockImplementation((url: string) => url === '/recruitment/internal-jobs'
      ? Promise.resolve({ data: { data: [JOB] } })
      : Promise.resolve({ data: { data: {} } }))
    renderPage()
    fireEvent.click(await screen.findByText('offers.viewOffer'))
    await screen.findByText('offers.jobDescription')
    expect(screen.queryByText('offers.trainInterview')).toBeNull()
  })

  it('module ACTIVÉ : le bouton « s’entraîner » est affiché', async () => {
    useAuthStore.setState({ tenantConfig: { primaryColor: '#000', secondaryColor: '#000', logoUrl: null, name: 'SOTRA', slug: 'sotra', enabledModules: { interview_sim: true } } })
    getMock.mockImplementation((url: string) => url === '/recruitment/internal-jobs'
      ? Promise.resolve({ data: { data: [JOB] } })
      : Promise.resolve({ data: { data: {} } }))
    renderPage()
    fireEvent.click(await screen.findByText('offers.viewOffer'))
    expect(await screen.findByText('offers.trainInterview')).toBeTruthy()
  })
})
