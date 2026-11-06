import type { CsvImportConfiguration, CsvMappingTemplate } from './importsApi'

export function isCsvConfigurationValid(configuration: CsvImportConfiguration | null, columns: Array<{ index: number }>) {
  if (!configuration) return false
  const availableIndexes = new Set(columns.map((column) => column.index))
  const mappedIndexes = Object.values(configuration.columns).filter((index): index is number => index !== null)
  const usesAmount = Number.isInteger(configuration.columns.amount)
  const usesCreditAndDebit = Number.isInteger(configuration.columns.credit) && Number.isInteger(configuration.columns.debit)
  const usesOnlyAmount = usesAmount && configuration.columns.credit === null && configuration.columns.debit === null
  const usesOnlyCreditAndDebit = !usesAmount && usesCreditAndDebit
  return mappedIndexes.every((index) => availableIndexes.has(index))
    && new Set(mappedIndexes).size === mappedIndexes.length
    && Number.isInteger(configuration.columns.date)
    && (usesOnlyAmount || usesOnlyCreditAndDebit)
}

export type CsvConfigurationPanelProps = {
  configuration: CsvImportConfiguration
  columns: Array<{ index: number; label: string }>
  sample: Array<{ lineNumber: number; values: string[] }>
  mappings: CsvMappingTemplate[]
  selectedMappingId: string
  mappingName: string
  mappingDirty: boolean
  disabled: boolean
  inspecting: boolean
  onConfigurationChange: (changes: Partial<CsvImportConfiguration>, preserveColumns: boolean) => void
  onColumnChange: (field: keyof CsvImportConfiguration['columns'], value: string) => void
  onMappingSelect: (mappingId: string) => void
  onMappingNameChange: (name: string) => void
  onSaveMapping: () => void
  onRetryInspection: () => void
}

export function CsvConfigurationPanel({
  configuration,
  columns,
  sample,
  mappings,
  selectedMappingId,
  mappingName,
  mappingDirty,
  disabled,
  inspecting,
  onConfigurationChange,
  onColumnChange,
  onMappingSelect,
  onMappingNameChange,
  onSaveMapping,
  onRetryInspection,
}: CsvConfigurationPanelProps) {
  const isMappingReady = isCsvConfigurationValid(configuration, columns)
  const columnFields: Array<{ key: keyof CsvImportConfiguration['columns']; label: string; required?: boolean }> = [
    { key: 'date', label: 'Data', required: true },
    { key: 'description', label: 'Descrição' },
    { key: 'amount', label: 'Valor único' },
    { key: 'credit', label: 'Crédito' },
    { key: 'debit', label: 'Débito' },
    { key: 'externalId', label: 'Identificador externo' },
  ]

  return (
    <section className="imports-csv-config" aria-labelledby="csv-config-title">
      <div className="imports-csv-config__heading">
        <div>
          <p className="imports-eyebrow">CONFIGURAÇÃO DO CSV</p>
          <h3 id="csv-config-title">Confira como as colunas serão interpretadas</h3>
          <p>A detecção é apenas uma sugestão. Revise a amostra antes de enviar.</p>
        </div>
        <div className="imports-csv-config__actions">
          <label>
            <span>Modelo salvo</span>
            <select value={selectedMappingId} onChange={(event) => onMappingSelect(event.target.value)} disabled={disabled}>
              <option value="">Configuração detectada</option>
              {mappings.map((mapping) => <option key={mapping.id} value={mapping.id}>{mapping.name}</option>)}
            </select>
          </label>
          <button className="imports-secondary-button" type="button" onClick={onRetryInspection} disabled={disabled || inspecting}>
            {inspecting ? 'Analisando…' : 'Analisar novamente'}
          </button>
        </div>
      </div>

      <fieldset className="imports-csv-grid" disabled={disabled}>
        <legend>Formato do arquivo</legend>
        <label><span>Delimitador</span><select value={configuration.delimiter} onChange={(event) => onConfigurationChange({ delimiter: event.target.value as CsvImportConfiguration['delimiter'] }, false)}><option value=",">Vírgula (,)</option><option value=";">Ponto e vírgula (;)</option></select></label>
        <label><span>Codificação</span><select value={configuration.encoding} onChange={(event) => onConfigurationChange({ encoding: event.target.value as CsvImportConfiguration['encoding'] }, false)}><option value="utf-8">UTF-8</option><option value="windows-1252">Windows-1252</option><option value="iso-8859-1">ISO-8859-1</option></select></label>
        <label><span>Formato da data</span><select value={configuration.dateFormat} onChange={(event) => onConfigurationChange({ dateFormat: event.target.value as CsvImportConfiguration['dateFormat'] }, true)}><option value="dd/MM/yyyy">DD/MM/AAAA</option><option value="MM/dd/yyyy">MM/DD/AAAA</option><option value="yyyy-MM-dd">AAAA-MM-DD</option></select></label>
        <label><span>Formato monetário</span><select value={configuration.numberFormat} onChange={(event) => onConfigurationChange({ numberFormat: event.target.value as CsvImportConfiguration['numberFormat'] }, true)}><option value="pt-BR">1.234,56</option><option value="en-US">1,234.56</option></select></label>
        <label className="imports-csv-checkbox"><input type="checkbox" checked={configuration.hasHeader} onChange={(event) => onConfigurationChange({ hasHeader: event.target.checked }, false)} /><span>A primeira linha contém cabeçalhos</span></label>
      </fieldset>

      <fieldset className="imports-csv-grid imports-csv-grid--mapping" disabled={disabled}>
        <legend>Mapeamento de colunas</legend>
        {columnFields.map((field) => (
          <label key={field.key}>
            <span>{field.label}{field.required ? ' *' : ''}</span>
            <select value={configuration.columns[field.key] ?? ''} onChange={(event) => onColumnChange(field.key, event.target.value)}>
              <option value="">Não mapear</option>
              {columns.map((column) => <option key={column.index} value={column.index}>{column.label}</option>)}
            </select>
          </label>
        ))}
        <p className="imports-csv-grid__hint">Mapeie “Valor único” ou use “Crédito” e “Débito” em conjunto.</p>
        {!isMappingReady && <p className="imports-csv-grid__error" role="status">Complete os campos obrigatórios com colunas disponíveis neste arquivo.</p>}
      </fieldset>

      <div className="imports-csv-model">
        <label><span>Nome do modelo</span><input value={mappingName} maxLength={80} placeholder="Ex.: Extrato Banco X" onChange={(event) => onMappingNameChange(event.target.value)} disabled={disabled} /></label>
        <button className="imports-secondary-button" type="button" onClick={onSaveMapping} disabled={disabled || !isMappingReady || !mappingName.trim() || (Boolean(selectedMappingId) && !mappingDirty)}>
          {selectedMappingId ? (mappingDirty ? 'Atualizar modelo' : 'Modelo salvo') : 'Salvar novo modelo'}
        </button>
      </div>

      <div className="imports-csv-sample" tabIndex={0} aria-label="Amostra do arquivo CSV">
        <table>
          <caption>Amostra das primeiras linhas</caption>
          <thead><tr><th scope="col">Linha</th>{columns.map((column) => <th scope="col" key={column.index}>{column.label}</th>)}</tr></thead>
          <tbody>{sample.map((row) => <tr key={row.lineNumber}><th scope="row">{row.lineNumber}</th>{columns.map((column) => <td key={column.index}>{row.values[column.index] || '—'}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  )
}
