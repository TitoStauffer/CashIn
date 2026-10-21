import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FinancialSidebar } from './FinancialSidebar'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'

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

async function renderSidebar(props: Partial<ComponentProps<typeof FinancialSidebar>> = {}) {
  const result = render(
    <WalletProvider userId="user-1">
      <FinancialSidebar
        activePage="dashboard"
        userEmail="tito@example.com"
        isLoggingOut={false}
        onLogout={vi.fn()}
        {...props}
      />
    </WalletProvider>,
  )
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}

describe('FinancialSidebar', () => {
  beforeEach(() => {
    isMobileViewport = false
    mediaListeners.clear()
    window.localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn(createMediaQueryList))
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [
      { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' },
      { id: 'wallet-shared', name: 'Família', isPersonal: false, role: 'member' },
    ] })
    vi.spyOn(walletApi, 'create').mockResolvedValue({ id: 'wallet-new', name: 'Viagem', isPersonal: false, role: 'owner' })
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
    await renderSidebar({ activePage: 'expenses', onLogout })

    expect(screen.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Saídas' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: 'Entradas' })).toHaveAttribute('href', '/incomes')
    expect(screen.getByRole('link', { name: 'Metas e aportes' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('link', { name: 'Categorias' })).toHaveAttribute('href', '/categories')
    expect(screen.getByText('tito@example.com')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Sair da conta' }))
    expect(onLogout).toHaveBeenCalledOnce()
  })

  it('groups movement and registry links including credit cards and invoices', async () => {
    await renderSidebar()

    expect(screen.getByRole('button', { name: 'Registro de movimentações' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Entradas' })).toHaveAttribute('href', '/incomes')
    expect(screen.getByRole('link', { name: 'Saídas' })).toHaveAttribute('href', '/expenses')
    expect(screen.getByRole('link', { name: 'Metas e aportes' })).toHaveAttribute('href', '/goals')
    expect(screen.getByRole('button', { name: 'Cadastros gerais' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Categorias' })).toHaveAttribute('href', '/categories')
    expect(screen.getByRole('link', { name: 'Formas de pagamento' })).toHaveAttribute('href', '/payment-methods')
    expect(screen.getByRole('link', { name: 'Cartões e faturas' })).toHaveAttribute('href', '/credit-cards')
  })

  it('collapses a group accessibly and reports its active page', async () => {
    const user = userEvent.setup()
    await renderSidebar({ activePage: 'incomes' })
    const toggle = screen.getByRole('button', { name: 'Registro de movimentações, página ativa: Entradas' })

    toggle.focus()
    await user.keyboard('{Enter}')

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('link', { name: 'Entradas', hidden: true })).not.toBeVisible()
    expect(toggle).toHaveAccessibleName('Registro de movimentações, página ativa: Entradas')
  })

  it('keeps the selected wallet for this account and creates a new wallet as active', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    const selector = await screen.findByRole('combobox', { name: 'Carteira ativa: Pessoal' })
    await user.selectOptions(selector, 'wallet-shared')
    expect(window.localStorage.getItem('saldocerto.active-wallet.user-1')).toBe('wallet-shared')

    await user.click(screen.getByRole('button', { name: /Nova carteira/ }))
    await user.type(screen.getByLabelText('Nome da carteira'), 'Viagem')
    await user.click(screen.getByRole('button', { name: 'Criar carteira' }))

    await waitFor(() => expect(walletApi.create).toHaveBeenCalledWith('Viagem'))
    expect(await screen.findByRole('combobox', { name: 'Carteira ativa: Viagem' })).toHaveValue('wallet-new')
    expect(window.localStorage.getItem('saldocerto.active-wallet.user-1')).toBe('wallet-new')
  })

  it('shows wallet sharing only to owners of shared wallets', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.list).mockResolvedValueOnce({ items: [
      { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' },
      { id: 'wallet-shared-owner', name: 'Casa', isPersonal: false, role: 'owner' },
      { id: 'wallet-shared-member', name: 'Família', isPersonal: false, role: 'member' },
    ] })
    await renderSidebar()

    expect(screen.queryByRole('link', { name: 'Compartilhamento' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared-owner')
    expect(screen.getByRole('link', { name: 'Compartilhamento' })).toHaveAttribute('href', '/wallet-sharing')

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared-member')
    expect(screen.queryByRole('link', { name: 'Compartilhamento' })).not.toBeInTheDocument()
  })

  it('restores the saved wallet when it still belongs to the account', async () => {
    window.localStorage.setItem('saldocerto.active-wallet.user-1', 'wallet-shared')
    renderSidebar()

    expect(await screen.findByRole('combobox', { name: 'Carteira ativa: Família' })).toHaveValue('wallet-shared')
  })

  it('falls back to the personal wallet when the saved selection is no longer available', async () => {
    window.localStorage.setItem('saldocerto.active-wallet.user-1', 'wallet-removed')
    renderSidebar()

    expect(await screen.findByRole('combobox', { name: 'Carteira ativa: Pessoal' })).toHaveValue('wallet-personal')
    expect(window.localStorage.getItem('saldocerto.active-wallet.user-1')).toBe('wallet-personal')
  })

  it('shows a retry action when the wallet list cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.list)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [{ id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' }] })
    render(
      <WalletProvider userId="user-1">
        <FinancialSidebar activePage="dashboard" userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />
      </WalletProvider>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('combobox', { name: 'Carteira ativa: Pessoal' })).toBeVisible()
    expect(walletApi.list).toHaveBeenCalledTimes(2)
  })

  it('shows an empty-state retry when no wallets are returned', async () => {
    vi.mocked(walletApi.list).mockResolvedValueOnce({ items: [] })
    render(
      <WalletProvider userId="user-1">
        <FinancialSidebar activePage="dashboard" userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />
      </WalletProvider>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Nenhuma carteira está disponível')
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeEnabled()
  })

  it('keeps the active wallet and reports an error when creation fails', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.create).mockRejectedValueOnce(new Error('Falha de criação'))
    await renderSidebar()

    await user.click(screen.getByRole('button', { name: /Nova carteira/ }))
    await user.type(screen.getByLabelText('Nome da carteira'), 'Viagem')
    await user.click(screen.getByRole('button', { name: 'Criar carteira' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Falha de criação')
    expect(screen.getByRole('combobox', { name: 'Carteira ativa: Pessoal' })).toHaveValue('wallet-personal')
  })

  it('collapses with the keyboard and restores the saved preference on the next render', async () => {
    const user = userEvent.setup()
    const { container, unmount } = await renderSidebar()
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
    await renderSidebar()
    expect(document.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--financial-sidebar-width')).toBe('76px'))
  })

  it('opens the mobile menu, closes it after choosing a section, and tracks viewport changes', async () => {
    isMobileViewport = true
    const user = userEvent.setup()
    const { container } = await renderSidebar({ activePage: 'incomes' })
    const navigation = container.querySelector('nav')
    expect(navigation).not.toBeNull()
    navigation?.addEventListener('click', (event) => event.preventDefault())
    expect(navigation).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByRole('button', { name: 'Abrir menu' }))
    expect(navigation).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByRole('link', { name: 'Entradas' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('link', { name: 'Metas e aportes' }))
    expect(navigation).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.financial-sidebar')).not.toHaveClass('financial-sidebar--mobile-open')

    setViewport(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recolher menu' })).toBeVisible())
    await user.click(screen.getByRole('button', { name: 'Recolher menu' }))
    expect(container.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
  })

  it('shows a disabled logout state while a logout request is running', async () => {
    await renderSidebar({ isLoggingOut: true })
    expect(screen.getByRole('button', { name: 'Saindo da conta' })).toBeDisabled()
    expect(screen.getByText('Saindo…')).toBeVisible()
  })

  it('keeps the menu usable when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    const user = userEvent.setup()
    const { container } = await renderSidebar()

    await user.click(screen.getByRole('button', { name: 'Recolher menu' }))
    expect(container.querySelector('.financial-sidebar')).toHaveClass('financial-sidebar--collapsed')
  })
})
