import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { get: getMock, put: putMock } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { InterviewFocusPanel } from './InterviewFocusPanel'

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <InterviewFocusPanel endpoint="/recruitment/jobs/job-1/interview-focus" queryKeyId="job-1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => { getMock.mockReset(); putMock.mockReset() })
afterEach(() => cleanup())

describe('InterviewFocusPanel', () => {
  it('replié par défaut : ne charge rien tant que non ouvert', () => {
    renderPanel()
    expect(getMock).not.toHaveBeenCalled()
  })

  it('ouverture → charge le profil et permet d\'ajouter une technologie', async () => {
    getMock.mockResolvedValue({
      data: { data: { focus: { technologies: [], tools: [], methodologies: [], languages: [] } } },
    })
    renderPanel()
    fireEvent.click(screen.getByText('panel.configure'))
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/recruitment/jobs/job-1/interview-focus'))
    fireEvent.click(await screen.findByText('technologies.add'))
    expect(await screen.findAllByPlaceholderText('technologies.namePlaceholder')).toHaveLength(1)
  })

  it('enregistrement : appelle PUT avec le profil courant', async () => {
    getMock.mockResolvedValue({
      data: { data: { focus: { technologies: [], tools: [], methodologies: [], languages: [] } } },
    })
    putMock.mockResolvedValue({ data: { data: { focus: {} } } })
    renderPanel()
    fireEvent.click(screen.getByText('panel.configure'))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    fireEvent.click(await screen.findByText('panel.saveButton'))
    await waitFor(() => expect(putMock).toHaveBeenCalledWith(
      '/recruitment/jobs/job-1/interview-focus',
      { focus: { technologies: [], tools: [], methodologies: [], languages: [] } },
    ))
  })
})
