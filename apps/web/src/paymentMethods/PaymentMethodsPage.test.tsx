import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'
import { PaymentMethodsPage } from './PaymentMethodsPage'
import { paymentMethodsApi } from './paymentMethodsApi'

const paymentMethod = { id: 'pix', name: 'Pix', nature: 'immediate' as const, isActive: true }
const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }

async function renderPage() {
  render(<WalletProvider userId="user-1"><PaymentMethodsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
}

describe('PaymentMethodsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 760px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [personalWallet] })
    vi.spyOn(paymentMethodsApi, 'list').mockResolvedValue({ items: [paymentMethod] })
    vi.spyOn(paymentMethodsApi, 'create').mockResolvedValue({ ...paymentMethod, id: 'new-method', name: 'Cartão da conta', nature: 'credit_card' })
    vi.spyOn(paymentMethodsApi, 'update').mockResolvedValue(paymentMethod)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('creates a method with a selected nature', async () => {
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Pix' })
    await user.click(screen.getByRole('button', { name: /Nova forma/ }))
    await user.type(screen.getByLabelText('Nome *'), 'Cartão da conta')
    await user.selectOptions(screen.getByLabelText('Natureza *'), 'credit_card')
    await user.click(screen.getByRole('button', { name: 'Salvar forma' }))

    await waitFor(() => expect(paymentMethodsApi.create).toHaveBeenCalledWith({ name: 'Cartão da conta', nature: 'credit_card' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Forma de pagamento cadastrada.')
  })

  it('offers one grouped VA/VR nature and keeps AHO separate', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova forma/ }))
    const nature = screen.getByLabelText('Natureza *')
    expect(nature).toHaveDisplayValue('Imediata (dinheiro, débito ou Pix)')
    expect(nature).toHaveAccessibleDescription(/VA e VR usam um único saldo de benefícios/)
    expect(screen.getByRole('option', { name: 'Cartão de benefícios (VA/VR)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Auxílio home office (AHO)' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Vale-alimentação (VA)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Vale-refeição (VR)' })).not.toBeInTheDocument()
  })

  it('edits a method and can deactivate it without deleting its history', async () => {
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Pix' })
    await user.click(screen.getByRole('button', { name: 'Editar Pix' }))
    await user.clear(screen.getByLabelText('Nome *'))
    await user.type(screen.getByLabelText('Nome *'), 'Pix pessoal')
    await user.click(screen.getByRole('button', { name: 'Salvar forma' }))

    await waitFor(() => expect(paymentMethodsApi.update).toHaveBeenCalledWith('pix', { name: 'Pix pessoal', nature: 'immediate' }))
    await screen.findByRole('status')
    await user.click(screen.getByRole('button', { name: 'Desativar Pix' }))
    await waitFor(() => expect(paymentMethodsApi.update).toHaveBeenCalledWith('pix', { isActive: false }))
  })

  it('shows server validation errors when a duplicate name is rejected', async () => {
    const user = userEvent.setup()
    vi.mocked(paymentMethodsApi.create).mockRejectedValueOnce(Object.assign(new Error('Já existe uma forma de pagamento com esse nome.'), { status: 409 }))
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova forma/ }))
    await user.type(screen.getByLabelText('Nome *'), 'Pix')
    await user.click(screen.getByRole('button', { name: 'Salvar forma' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma forma de pagamento com esse nome.')
  })

  it('shows an empty state and allows canceling a new method', async () => {
    const user = userEvent.setup()
    vi.mocked(paymentMethodsApi.list).mockResolvedValueOnce({ items: [] })
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Cadastrar primeira forma' }))
    expect(screen.getByRole('heading', { name: 'Nova forma de pagamento' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('heading', { name: 'Nova forma de pagamento' })).not.toBeInTheDocument()
  })

  it('shows a retry state when methods cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(paymentMethodsApi.list).mockRejectedValueOnce(new Error('offline'))
    await renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as formas de pagamento.')
    vi.mocked(paymentMethodsApi.list).mockResolvedValueOnce({ items: [paymentMethod] })
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('heading', { name: 'Pix' })).toBeInTheDocument()
  })

  it('can reactivate an inactive method', async () => {
    const user = userEvent.setup()
    vi.mocked(paymentMethodsApi.list).mockResolvedValueOnce({ items: [{ ...paymentMethod, isActive: false }] })
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ativar Pix' }))
    await waitFor(() => expect(paymentMethodsApi.update).toHaveBeenCalledWith('pix', { isActive: true }))
  })

  it('explains the preserved nature when editing a historical VA method', async () => {
    vi.mocked(paymentMethodsApi.list).mockResolvedValueOnce({ items: [{ ...paymentMethod, nature: 'food_benefit' }] })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar Pix' }))
    expect(screen.getByLabelText('Natureza *')).toHaveValue('food_benefit')
    expect(screen.getByLabelText('Natureza *')).toHaveAccessibleDescription(/Esta forma mantém sua natureza histórica/)
  })

  it('shows safe load feedback without exposing a server message', async () => {
    vi.mocked(paymentMethodsApi.list).mockRejectedValueOnce(Object.assign(new Error('server-only-detail'), { status: 500 }))
    await renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as formas de pagamento.')
    expect(screen.queryByText('server-only-detail')).not.toBeInTheDocument()
  })

  it('identifies deactivation while preserving the completed result if refreshing fails', async () => {
    let finish!: (method: typeof paymentMethod) => void
    vi.mocked(paymentMethodsApi.update).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    vi.mocked(paymentMethodsApi.list).mockResolvedValueOnce({ items: [paymentMethod] }).mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Desativar Pix' }))
    expect(screen.getByRole('note')).toHaveTextContent('Desativando a forma de pagamento.')
    finish({ ...paymentMethod, isActive: false })
    expect(await screen.findByText('Forma de pagamento desativada.')).toBeVisible()
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as formas de pagamento.')
  })

  it('hides the previous wallet editor and feedback when another wallet is selected', async () => {
    let finish!: (response: { items: typeof paymentMethod[] }) => void
    vi.mocked(walletApi.list).mockResolvedValueOnce({ items: [personalWallet, { ...personalWallet, id: 'wallet-shared', name: 'Casa', isPersonal: false }] })
    vi.mocked(paymentMethodsApi.list).mockResolvedValueOnce({ items: [paymentMethod] }).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar Pix' }))
    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    expect(screen.getByRole('status')).toHaveTextContent('Carregando formas de pagamento')
    expect(screen.queryByLabelText('Nome *')).not.toBeInTheDocument()
    finish({ items: [] })
    expect(await screen.findByRole('heading', { name: 'Nenhuma forma cadastrada' })).toBeVisible()
    expect(screen.queryByLabelText('Nome *')).not.toBeInTheDocument()
  })
})
