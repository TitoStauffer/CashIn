import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useWallet } from '../wallets/useWallet'
import './FinancialSidebar.css'

type NavigationItem = {
  href?: string
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

const overviewItem = { href: '/dashboard', label: 'Visão geral', icon: '⌂', key: 'dashboard' } satisfies NavigationItem & { href: string }

const navigationGroups: { id: string; label: string; items: NavigationItem[] }[] = [
  {
    id: 'movements',
    label: 'Registro de movimentações',
    items: [
      { href: '/incomes', label: 'Entradas', icon: '↗', key: 'incomes' },
      { href: '/expenses', label: 'Saídas', icon: '↘', key: 'expenses' },
      { href: '/goals', label: 'Metas e aportes', icon: '◎', key: 'goals' },
    ],
  },
  {
    id: 'registries',
    label: 'Cadastros gerais',
    items: [
      { href: '/categories', label: 'Categorias', icon: '▤', key: 'categories' },
      { href: '/credit-cards', label: 'Cartões e faturas', icon: '▣', key: 'credit-cards' },
      { href: '/payment-methods', label: 'Formas de pagamento', icon: '◉', key: 'payment-methods' },
    ],
  },
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({ movements: true, registries: true })
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
        <SidebarLink item={overviewItem} activePage={activePage} isCollapsed={isCollapsed} onNavigate={() => setIsMobileMenuOpen(false)} />
        {navigationGroups.map((group) => {
          const activeItem = group.items.find((item) => item.key === activePage)
          const expanded = expandedGroups[group.id] ?? true
          return (
            <section className={`financial-sidebar__group${activeItem ? ' financial-sidebar__group--active' : ''}`} key={group.id}>
              <button
                className="financial-sidebar__group-toggle"
                type="button"
                aria-expanded={expanded}
                aria-controls={`financial-navigation-${group.id}`}
                aria-label={activeItem ? `${group.label}, página ativa: ${activeItem.label}` : group.label}
                onClick={() => setExpandedGroups((current) => ({ ...current, [group.id]: !expanded }))}
              >
                <span className="financial-sidebar__group-label">{group.label}</span>
                {activeItem && <span className="financial-sidebar__group-current">{activeItem.label}</span>}
                <span className="financial-sidebar__group-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
              </button>
              <div className="financial-sidebar__group-items" id={`financial-navigation-${group.id}`} hidden={!expanded}>
                {group.items.map((item) => <SidebarLink key={item.key} item={item} activePage={activePage} isCollapsed={isCollapsed} onNavigate={() => setIsMobileMenuOpen(false)} />)}
              </div>
            </section>
          )
        })}
        {activeWallet?.role === 'owner' && !activeWallet.isPersonal && (
          <SidebarLink item={{ href: '/wallet-sharing', label: 'Compartilhamento', icon: '♧', key: 'wallet-sharing' }} activePage={activePage} isCollapsed={isCollapsed} onNavigate={() => setIsMobileMenuOpen(false)} />
        )}
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

function SidebarLink({ item, activePage, isCollapsed, onNavigate }: { item: NavigationItem; activePage: string; isCollapsed: boolean; onNavigate: () => void }) {
  return (
    <a
      className={`financial-sidebar__link${activePage === item.key ? ' financial-sidebar__link--active' : ''}`}
      href={item.href}
      aria-label={item.label}
      aria-current={activePage === item.key ? 'page' : undefined}
      title={isCollapsed ? item.label : undefined}
      onClick={onNavigate}
    >
      <span className="financial-sidebar__icon" aria-hidden="true">{item.icon}</span>
      <span className="financial-sidebar__label">{item.label}</span>
    </a>
  )
}
