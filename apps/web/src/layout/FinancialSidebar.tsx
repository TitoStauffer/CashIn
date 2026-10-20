import { useEffect, useState } from 'react'
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
  const [isCollapsed, setIsCollapsed] = useState(readCollapsedPreference)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia('(max-width: 760px)').matches)

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

      <nav
        className="financial-sidebar__nav"
        id="financial-navigation"
        aria-label="Navegação principal"
        aria-hidden={isMobileViewport && !isMobileMenuOpen}
      >
        {navigationItems.map((item) => (
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
