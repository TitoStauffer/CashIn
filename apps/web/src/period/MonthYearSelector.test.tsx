import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MonthYearSelector } from './MonthYearSelector'
import { formatMonth, getCurrentMonth, getMonthRange, isValidMonth, shiftMonth } from './month'

describe('MonthYearSelector', () => {
  it('selects a month and year directly and shows the formatted period', () => {
    const onMonthChange = vi.fn()
    render(<MonthYearSelector month="2024-03" onMonthChange={onMonthChange} />)

    expect(screen.getByLabelText('Selecionar mês e ano')).toHaveValue('2024-03')
    expect(screen.getByText('Março de 2024')).toBeVisible()
    const monthInput = screen.getByLabelText('Selecionar mês e ano')
    fireEvent.change(monthInput, { target: { value: '2022-11' } })
    expect(onMonthChange).toHaveBeenCalledWith('2022-11')
    fireEvent.change(monthInput, { target: { value: '2024-13' } })
    expect(onMonthChange).toHaveBeenCalledOnce()
  })

  it('keeps previous and next month navigation and offers a shortcut to the current month', async () => {
    const user = userEvent.setup()
    const onMonthChange = vi.fn()
    render(<MonthYearSelector month="2024-01" onMonthChange={onMonthChange} />)

    await user.click(screen.getByRole('button', { name: 'Mês anterior' }))
    expect(onMonthChange).toHaveBeenLastCalledWith('2023-12')
    await user.click(screen.getByRole('button', { name: 'Próximo mês' }))
    expect(onMonthChange).toHaveBeenLastCalledWith('2024-02')
    await user.click(screen.getByRole('button', { name: 'Ir para o mês atual' }))
    expect(onMonthChange).toHaveBeenLastCalledWith(getCurrentMonth())
  })

  it('disables the current month shortcut when the selected month is already current', () => {
    render(<MonthYearSelector month={getCurrentMonth()} onMonthChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Ir para o mês atual' })).toBeDisabled()
  })
})

describe('month utilities', () => {
  it('formats periods, validates direct input, and shifts across years', () => {
    expect(formatMonth('2024-03')).toBe('Março de 2024')
    expect(isValidMonth('2024-03')).toBe(true)
    expect(isValidMonth('2024-00')).toBe(false)
    expect(isValidMonth('2024-13')).toBe(false)
    expect(isValidMonth('2024-3')).toBe(false)
    expect(shiftMonth('2024-01', -1)).toBe('2023-12')
    expect(shiftMonth('2024-12', 1)).toBe('2025-01')
    expect(getMonthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(getMonthRange('2023-02')).toEqual({ from: '2023-02-01', to: '2023-02-28' })
  })
})
