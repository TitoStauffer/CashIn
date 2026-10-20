import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FinancialSidebar } from './FinancialSidebar'

const collapsedStorageKey = 'saldocerto.navigation.collapsed'
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>()
let isMobileViewport = false

function createMediaQueryList(query: string): MediaQueryList {
  return {
    matches: isMobileViewport,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      mediaListeners.add(listener as (event: MediaQueryListEvent) => void)
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      mediaListeners.delete(listener as (event: MediaQueryListEvent) => void)
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }
}

function setViewport(isMobile: boolean) {
  isMobileViewport = isMobile
  const event = Object.assign(new Event('change'), { matches: isMobile, media: '(max-width: 760px)' }) as MediaQueryListEvent
  mediaListeners.forEach((listener) => listener(event))
}

function renderSidebar(props: Partial<ComponentProps<typeof FinancialSidebar>> = {}) {
  return render(
    <FinancialSidebar
      activePage="dashboard"
      userEmail="tito@example.com"
      isLoggingOut={false}
      onLogout={vi.fn()}
      {...props}
    />,
  )
}

describe('FinancialSidebar', () => {
  beforeEach(() => {
    isMobileViewport = false
    mediaListeners.clear()
    window.localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn(createMediaQueryList))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    mediaListeners.clear()
  })

  it('shows all sections, marks the active page, and invokes logout', async () => {
    const user = userEvent.setup()
    const onLogout = vi.fn()
    renderSidebar({ activePage: 'expenses', onLogout })

    expect(screen.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Despesas' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: 'Entradas' })).toHaveAttribute('href', '/incomes')
    expect(screen.getByRole('link', { name: 'Metas' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('link', { name: 'Categorias' })).toHaveAttribute('href', '/categories')
    expect(screen.getByText('tito@example.com')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Sair da conta' }))
    expect(onLogout).toHaveBeenCalledOnce()
  })

  it('collapses with the keyboard and restores the saved preference on the next render', async () => {
    const user = userEvent.setup()
    const { container, unmount } = renderSidebar()
    const collapseButton = screen.getByRole('button', { name: 'Recolher menu' })

    await user.tab()
    await user.tab()
    expect(collapseButton).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(container.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
    expect(screen.getByRole('button', { name: 'Expandir menu' })).toHaveAttribute('aria-expanded', 'false')
    expect(window.localStorage.getItem(collapsedStorageKey)).toBe('true')
    expect(screen.getByRole('link', { name: 'Entradas' })).toHaveAttribute('title', 'Entradas')

    unmount()
    renderSidebar()
    expect(document.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
    expect(document.documentElement.style.getPropertyValue('--financial-sidebar-width')).toBe('76px')
  })

  it('opens the mobile menu, closes it after choosing a section, and tracks viewport changes', async () => {
    isMobileViewport = true
    const user = userEvent.setup()
    const { container } = renderSidebar({ activePage: 'incomes' })
    const navigation = container.querySelector('nav')
    expect(navigation).not.toBeNull()
    navigation?.addEventListener('click', (event) => event.preventDefault())
    expect(navigation).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByRole('button', { name: 'Abrir menu' }))
    expect(navigation).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByRole('link', { name: 'Entradas' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('link', { name: 'Metas' }))
    expect(navigation).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.financial-sidebar')).not.toHaveClass('financial-sidebar--mobile-open')

    setViewport(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recolher menu' })).toBeVisible())
    await user.click(screen.getByRole('button', { name: 'Recolher menu' }))
    expect(container.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
  })

  it('shows a disabled logout state while a logout request is running', () => {
    renderSidebar({ isLoggingOut: true })
    expect(screen.getByRole('button', { name: 'Saindo da conta' })).toBeDisabled()
    expect(screen.getByText('Saindo…')).toBeVisible()
  })

  it('keeps the menu usable when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    const user = userEvent.setup()
    const { container } = renderSidebar()

    await user.click(screen.getByRole('button', { name: 'Recolher menu' }))
    expect(container.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
  })
})
