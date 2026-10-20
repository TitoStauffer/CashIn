import { formatMonth, getCurrentMonth, isValidMonth, shiftMonth } from './month'
import './MonthYearSelector.css'

type MonthYearSelectorProps = {
  month: string
  onMonthChange: (month: string) => void
}

export function MonthYearSelector({ month, onMonthChange }: MonthYearSelectorProps) {
  const currentMonth = getCurrentMonth()

  function handleMonthChange(value: string) {
    if (isValidMonth(value)) onMonthChange(value)
  }

  return (
    <div className="month-year-selector" aria-label="Navegação por mês e ano">
      <button
        type="button"
        className="month-year-selector__arrow"
        onClick={() => onMonthChange(shiftMonth(month, -1))}
        aria-label="Mês anterior"
      >
        ‹
      </button>
      <label className="month-year-selector__picker">
        <span className="month-year-selector__sr-only">Selecionar mês e ano</span>
        <input
          type="month"
          value={month}
          onChange={(event) => handleMonthChange(event.target.value)}
          aria-label="Selecionar mês e ano"
        />
      </label>
      <span className="month-year-selector__formatted" aria-live="polite">{formatMonth(month)}</span>
      <button
        type="button"
        className="month-year-selector__arrow"
        onClick={() => onMonthChange(shiftMonth(month, 1))}
        aria-label="Próximo mês"
      >
        ›
      </button>
      <button
        type="button"
        className="month-year-selector__today"
        onClick={() => handleMonthChange(currentMonth)}
        disabled={month === currentMonth}
        aria-label="Ir para o mês atual"
      >
        Mês atual
      </button>
    </div>
  )
}
