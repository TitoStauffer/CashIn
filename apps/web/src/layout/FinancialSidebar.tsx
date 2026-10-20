import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useWallet } from '../wallets/useWallet'
import './FinancialSidebar.css'

type NavigationItem = {
  href: string
  label: string
  icon: string
  key: string
}

type FinancialSidebarProps = {
  activePage: string
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

const navigationItems: NavigationItem[] = [
  { href: '/dashboard', label: 'Home', icon: '⌂', key: 'dashboard' },
  { href: '/incomes', label: 'Entradas', icon: '↗', key: 'incomes' },
  { href: '/expenses', label: 'Despesas', icon: '↘', key: 'expenses' },
  { href: '/goals', label: 'Metas', icon: '◎', key: 'goals' },
  { href: '/categories', label: 'Categorias', icon: '▤', key: 'categories' },
  { href: '/wallet-sharing', label: 'Compartilhamento', icon: '♧', key: 'wallet-sharing' },
]

const collapsedStorageKey = 'saldocerto.navigation.collapsed'

function readCollapsedPreference() {
  try {
    return window.localStorage.getItem(collapsedStorageKey) === 'true'
  } catch {
    return false
  }
}

export function FinancialSidebar({ activePage, userEmail, isLoggingOut, onLogout }: FinancialSidebarProps) {
  const { wallets, activeWalletId, activeWallet, selectWallet, createWallet, isCreating } = useWallet()
  const [isCollapsed, setIsCollapsed] = useState(readCollapsedPreference)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  const [isWalletFormOpen, setIsWalletFormOpen] = useState(false)
  const [walletName, setWalletName] = useState('')
  const [walletError, setWalletError] = useState('')

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 760px)')
    const updateViewport = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches)
      setIsMobileMenuOpen(false)
    }
    mediaQuery.addEventListener('change', updateViewport)
    return () => mediaQuery.removeEventListener('change', updateViewport)
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--financial-sidebar-width', isCollapsed ? '76px' : '248px')
    try {
      window.localStorage.setItem(collapsedStorageKey, String(isCollapsed))
    } catch {
      // Keep the navigation usable when browser storage is unavailable.
    }
    return () => {
      document.documentElement.style.removeProperty('--financial-sidebar-width')
    }
  }, [isCollapsed])

  function toggleCollapsed() {
    setIsCollapsed((collapsed) => !collapsed)
  }

  async function handleCreateWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = walletName.trim()
    if (!name) {
      setWalletError('Informe um nome para a carteira.')
      return
    }
    setWalletError('')
    try {
      await createWallet(name)
      setWalletName('')
      setIsWalletFormOpen(false)
    } catch (error) {
      setWalletError(error instanceof Error && error.message.trim()
        ? error.message
        : 'Não foi possível criar a carteira. Tente novamente.')
    }
  }

  return (
    <aside className={`financial-sidebar${isCollapsed ? ' financial-sidebar--collapsed' : ''}${isMobileMenuOpen ? ' financial-sidebar--mobile-open' : ''}`}>
      <div className="financial-sidebar__header">
        <a className="financial-sidebar__brand" href="/dashboard" aria-label="Saldo Certo, Home">
          <span className="financial-sidebar__brand-mark" aria-hidden="true">SC</span>
          <span className="financial-sidebar__brand-name">saldo<span>certo</span></span>
        </a>
        <button
          className="financial-sidebar__toggle"
          type="button"
          onClick={() => {
            if (isMobileViewport) {
              setIsMobileMenuOpen((open) => !open)
            } else {
              toggleCollapsed()
            }
          }}
          aria-label={isMobileViewport
            ? isMobileMenuOpen ? 'Fechar menu' : 'Abrir menu'
            : isCollapsed ? 'Expandir menu' : 'Recolher menu'}
          aria-expanded={isMobileViewport ? isMobileMenuOpen : !isCollapsed}
          aria-controls="financial-navigation"
        >
          <span aria-hidden="true">{isMobileMenuOpen ? '×' : isCollapsed ? '☰' : '‹'}</span>
        </button>
      </div>

      <section className="financial-sidebar__wallet" aria-label="Carteira ativa">
        <label className="financial-sidebar__wallet-label" htmlFor="active-wallet">Carteira ativa</label>
        <select
          id="active-wallet"
          value={activeWalletId ?? ''}
          onChange={(event) => selectWallet(event.target.value)}
          aria-label={`Carteira ativa: ${activeWallet?.name ?? 'nenhuma selecionada'}`}
          title={activeWallet?.name}
        >
          {wallets.map((wallet) => (
            <option key={wallet.id} value={wallet.id}>{wallet.name}{wallet.isPersonal ? ' (pessoal)' : ''}</option>
          ))}
        </select>
        <button
          type="button"
          className="financial-sidebar__wallet-create"
          onClick={() => { setWalletError(''); setIsWalletFormOpen((open) => !open) }}
          aria-expanded={isWalletFormOpen}
          aria-controls="create-wallet-form"
        >
          <span aria-hidden="true">＋</span>
          <span className="financial-sidebar__label">Nova carteira</span>
        </button>
        {isWalletFormOpen && (
          <form className="financial-sidebar__wallet-form" id="create-wallet-form" onSubmit={handleCreateWallet}>
            <label htmlFor="new-wallet-name">Nome da carteira</label>
            <input
              id="new-wallet-name"
              value={walletName}
              onChange={(event) => setWalletName(event.target.value)}
              maxLength={80}
              required
              autoFocus
            />
            {walletError && <p className="financial-sidebar__wallet-error" role="alert">{walletError}</p>}
            <button type="submit" disabled={isCreating}>{isCreating ? 'Criando…' : 'Criar carteira'}</button>
          </form>
        )}
      </section>

      <nav
        className="financial-sidebar__nav"
        id="financial-navigation"
        aria-label="Navegação principal"
        aria-hidden={isMobileViewport && !isMobileMenuOpen}
      >
        {navigationItems.filter((item) => item.key !== 'wallet-sharing' || (activeWallet?.role === 'owner' && !activeWallet.isPersonal)).map((item) => (
          <a
            className={`financial-sidebar__link${activePage === item.key ? ' financial-sidebar__link--active' : ''}`}
            href={item.href}
            key={item.key}
            aria-label={item.label}
            aria-current={activePage === item.key ? 'page' : undefined}
            title={isCollapsed ? item.label : undefined}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <span className="financial-sidebar__icon" aria-hidden="true">{item.icon}</span>
            <span className="financial-sidebar__label">{item.label}</span>
          </a>
        ))}
      </nav>

      <div className="financial-sidebar__account">
        <span className="financial-sidebar__email" title={userEmail}>{userEmail}</span>
        <button type="button" className="financial-sidebar__logout" onClick={onLogout} disabled={isLoggingOut} aria-label={isLoggingOut ? 'Saindo da conta' : 'Sair da conta'}>
          <span aria-hidden="true">↪</span>
          <span className="financial-sidebar__label">{isLoggingOut ? 'Saindo…' : 'Sair da conta'}</span>
        </button>
      </div>
    </aside>
  )
}
