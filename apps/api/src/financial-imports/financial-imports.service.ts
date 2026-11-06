import { createHash } from "node:crypto";
import { FinancialImportError } from "./financial-imports.errors.js";
import { createFinancialImportFingerprint } from "./financial-imports.fingerprint.js";
import { FinancialCategorizationRulesService } from "./financial-categorization-rules.service.js";
import { inspectCsv, parseCsvConfiguration, parseCsvInspectionOverrides } from "./financial-imports.csv.js";
import { calculateBillingCycle } from "../credit-cards/billing-cycle.js";
import {
  CARD_AMOUNT_SIGNS,
  FINANCIAL_IMPORT_FORMATS,
  FINANCIAL_IMPORT_ITEM_TYPES,
  type CardAmountSign,
  type FinancialImportFormat,
  type FinancialImportKind,
  type CreateCsvMappingInput,
  type CsvImportConfiguration,
  type CsvInspectionResult,
  type CsvMapping,
  type FinancialImportParser,
  type FinancialImportRepository,
  type FinancialImportSession,
  type ParsedFinancialImportItem,
  type UpdateFinancialImportItemInput,
  type FinancialCategorizationRuleInput,
  type FinancialCategorizationRule,
} from "./financial-imports.types.js";

export const MAX_FINANCIAL_IMPORT_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FINANCIAL_IMPORT_ITEMS = 10_000;
const MAX_FINANCIAL_IMPORT_FILE_NAME_BYTES = 512;
const MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES = 4_000;
const MAX_FINANCIAL_IMPORT_FAILURE_MESSAGE_BYTES = 1_000;
const MAX_FINANCIAL_IMPORT_EXTERNAL_ID_BYTES = 512;
const MAX_FINANCIAL_IMPORT_METADATA_VALUE_BYTES = 512;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_MONEY_PATTERN = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const ZERO_MONEY_PATTERN = /^-?0(?:\.0{1,2})?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const METADATA_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

function validateDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  if (value.startsWith("0000-")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sanitizePostgresText(value: string): string {
  return value.replaceAll("\u0000", "");
}

function normalizeFileName(value: string): string {
  const fileName = value.split(/[\\/]/).at(-1)?.trim() ?? "";
  if (
    !fileName
    || fileName.length > 255
    || Buffer.byteLength(fileName, "utf8") > MAX_FINANCIAL_IMPORT_FILE_NAME_BYTES
    || /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw new FinancialImportError("O nome do arquivo é inválido.", 400);
  }
  return fileName;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let byteLength = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

function normalizeParsedItem(
  item: ParsedFinancialImportItem,
  fallbackSequence: number,
  kind: FinancialImportKind = "bank_statement",
): ParsedFinancialImportItem {
  const sourceLine = typeof item.sourceLine === "number"
    && Number.isSafeInteger(item.sourceLine)
    && item.sourceLine > 0
    ? item.sourceLine
    : null;
  const hasValidSourceSequence = Number.isSafeInteger(item.sequence)
    && item.sequence > 0
    && item.sequence <= MAX_FINANCIAL_IMPORT_ITEMS;
  const hasValidDate = typeof item.date === "string" && validateDate(item.date);
  const hasValidAmount = typeof item.signedAmount === "string"
    && SIGNED_MONEY_PATTERN.test(item.signedAmount)
    && !ZERO_MONEY_PATTERN.test(item.signedAmount);
  const hasValidType = FINANCIAL_IMPORT_ITEM_TYPES.includes(item.type) && isTypeAllowedForKind(item.type, kind);
  const rawDescription = item.description?.trim() || null;
  const hasPostgresSafeDescription = rawDescription === null || !rawDescription.includes("\u0000");
  const hasValidDescriptionLength = rawDescription === null
    || Buffer.byteLength(rawDescription, "utf8") <= MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES;
  const safeDescription = rawDescription === null
    ? null
    : sanitizePostgresText(rawDescription).trim() || null;
  const description = safeDescription === null
    ? null
    : truncateUtf8(safeDescription, MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES);
  const rawCategoryId = item.categoryId ?? null;
  const rawSubcategoryId = item.subcategoryId ?? null;
  const hasValidCategory = rawCategoryId === null || UUID_PATTERN.test(rawCategoryId);
  const hasValidSubcategory = rawSubcategoryId === null || UUID_PATTERN.test(rawSubcategoryId);
  const hasCompatibleReferences = rawSubcategoryId === null
    || (rawCategoryId !== null && hasValidCategory && hasValidSubcategory);
  const rawExternalId = item.externalId?.trim() || null;
  const hasValidExternalId = rawExternalId === null
    || (!rawExternalId.includes("\u0000") && Buffer.byteLength(rawExternalId, "utf8") <= MAX_FINANCIAL_IMPORT_EXTERNAL_ID_BYTES);
  const rawRecordHash = item.recordHash?.trim() || null;
  const hasValidRecordHash = rawRecordHash === null || HASH_PATTERN.test(rawRecordHash);
  const type = hasValidType ? item.type : "transfer";
  const hasNoCategory = type === "transfer" || type === "card_credit";
  const categoryId = hasNoCategory || !hasValidCategory ? null : rawCategoryId;
  const subcategoryId = hasNoCategory
    || categoryId === null
    || !hasValidSubcategory
    || !hasCompatibleReferences
    ? null
    : rawSubcategoryId;
  const invalidReasons: string[] = [];
  const nonRepairableReasons: string[] = [];
  const repairableReasons: string[] = [];
  if (!hasValidSourceSequence) nonRepairableReasons.push("A sequência original da movimentação é inválida.");
  if (!hasValidDate) repairableReasons.push("A data da movimentação é inválida.");
  if (!hasValidAmount) nonRepairableReasons.push("O valor da movimentação deve ser diferente de zero e ter até duas casas decimais.");
  if (!hasValidType) repairableReasons.push("O tipo da movimentação é inválido.");
  if (!hasValidCategory || !hasValidSubcategory || !hasCompatibleReferences) {
    repairableReasons.push("A categoria ou subcategoria da movimentação é inválida.");
  }
  if (!hasPostgresSafeDescription) repairableReasons.push("A descrição da movimentação não pode conter caractere nulo.");
  if (!hasValidDescriptionLength) repairableReasons.push("A descrição da movimentação deve ter no máximo 4.000 bytes.");
  if (!hasValidExternalId) nonRepairableReasons.push("O identificador externo da movimentação é inválido.");
  if (!hasValidRecordHash) nonRepairableReasons.push("A identidade normalizada da movimentação é inválida.");
  invalidReasons.push(...nonRepairableReasons, ...repairableReasons);

  const isDuplicate = item.validationStatus === "duplicate";
  const parserMarkedInvalid = item.validationStatus === "invalid";
  const parserAllowsRepair = !parserMarkedInvalid || item.isRepairable === true;
  let validationStatus = item.validationStatus ?? "valid";
  let errorMessage = item.errorMessage ? sanitizePostgresText(item.errorMessage).trim() || null : null;
  if (isDuplicate) {
    validationStatus = "duplicate";
    if (invalidReasons.length > 0) {
      errorMessage = [errorMessage, ...invalidReasons].filter(Boolean).join(" ");
    }
  } else if (invalidReasons.length > 0) {
    validationStatus = "invalid";
    errorMessage = [errorMessage, ...invalidReasons].filter(Boolean).join(" ");
  } else if (validationStatus === "invalid") {
    errorMessage ??= "A movimentação possui dados inválidos.";
  } else if (validationStatus !== "duplicate") {
    if (type === "transfer") {
      validationStatus = "uncategorized";
      errorMessage ??= kind === "credit_card_statement"
        ? "Pagamento da fatura: ele é conciliado com o extrato bancário e não é importado como estorno."
        : "A transferência precisa ser conciliada antes da importação.";
    } else if (type === "card_credit") {
      validationStatus = "valid";
      errorMessage = null;
    } else if (categoryId === null) {
      validationStatus = "uncategorized";
      errorMessage ??= "Selecione uma categoria para importar a movimentação.";
    } else {
      validationStatus = "valid";
      errorMessage = null;
    }
  }
  if (
    sourceLine !== null
    && errorMessage !== null
    && (validationStatus === "invalid" || validationStatus === "duplicate")
    && !errorMessage.startsWith(`Linha ${sourceLine}:`)
  ) {
    errorMessage = `Linha ${sourceLine}: ${errorMessage}`;
  }

  return {
    sequence: fallbackSequence,
    date: hasValidDate ? item.date : null,
    description,
    signedAmount: hasValidAmount ? item.signedAmount : null,
    type,
    categoryId,
    subcategoryId,
    validationStatus,
    errorMessage,
    isRepairable: !isDuplicate && parserAllowsRepair && validationStatus === "invalid"
      && nonRepairableReasons.length === 0
      && (repairableReasons.length > 0 || parserMarkedInvalid),
    externalId: hasValidExternalId ? rawExternalId : null,
    statementClosingDate: item.statementClosingDate ?? null,
    recordHash: createFinancialImportFingerprint({
      date: hasValidDate ? item.date : null,
      signedAmount: hasValidAmount ? item.signedAmount : null,
      type,
      description,
    }) ?? (hasValidRecordHash ? rawRecordHash : null),
  };
}

// Card statements hold purchases (expense), refunds/chargebacks (card_credit) and invoice payments
// (transfer); bank statements never hold card credits.
function isTypeAllowedForKind(type: ParsedFinancialImportItem["type"], kind: FinancialImportKind): boolean {
  return kind === "credit_card_statement" ? type !== "income" : type !== "card_credit";
}

function normalizeSourceMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  if (!metadata) return {};
  const entries = Object.entries(metadata);
  if (entries.length > 20) throw new FinancialImportError("Os metadados do arquivo são inválidos.", 422);
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const value = rawValue.trim();
    if (
      !METADATA_KEY_PATTERN.test(key)
      || !value
      || value.includes("\u0000")
      || Buffer.byteLength(value, "utf8") > MAX_FINANCIAL_IMPORT_METADATA_VALUE_BYTES
    ) {
      throw new FinancialImportError("Os metadados do arquivo são inválidos.", 422);
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeUpdateInput(input: UpdateFinancialImportItemInput): Required<UpdateFinancialImportItemInput> {
  if (!validateDate(input.date)) {
    throw new FinancialImportError("A data deve ser válida e estar no formato AAAA-MM-DD.", 400);
  }
  if (!FINANCIAL_IMPORT_ITEM_TYPES.includes(input.type)) {
    throw new FinancialImportError("O tipo da movimentação é inválido.", 400);
  }
  const categoryId = input.categoryId ?? null;
  const subcategoryId = input.subcategoryId ?? null;
  if (categoryId !== null && !UUID_PATTERN.test(categoryId)) {
    throw new FinancialImportError("A categoria informada é inválida.", 400);
  }
  if (subcategoryId !== null && !UUID_PATTERN.test(subcategoryId)) {
    throw new FinancialImportError("A subcategoria informada é inválida.", 400);
  }
  if (subcategoryId !== null && categoryId === null) {
    throw new FinancialImportError("Selecione uma categoria para usar a subcategoria.", 400);
  }
  if (input.includeDuplicate !== undefined && typeof input.includeDuplicate !== "boolean") {
    throw new FinancialImportError("A decisão sobre a possível duplicidade é inválida.", 400);
  }
  const statementClosingDate = input.statementClosingDate ?? null;
  if (statementClosingDate !== null && (typeof statementClosingDate !== "string" || !validateDate(statementClosingDate))) {
    throw new FinancialImportError("A data de fechamento da fatura deve ser válida e estar no formato AAAA-MM-DD.", 400);
  }
  const description = input.description?.trim() || null;
  if (description?.includes("\u0000")) {
    throw new FinancialImportError("A descrição da movimentação não pode conter caractere nulo.", 400);
  }
  if (description !== null && Buffer.byteLength(description, "utf8") > MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES) {
    throw new FinancialImportError("A descrição da movimentação deve ter no máximo 4.000 bytes.", 400);
  }
  return {
    date: input.date,
    description,
    type: input.type,
    categoryId,
    subcategoryId,
    includeDuplicate: input.includeDuplicate === true,
    statementClosingDate,
  };
}

export class FinancialImportsService {
  constructor(
    private readonly repository: FinancialImportRepository,
    private readonly parser: FinancialImportParser,
    private readonly categorizationRules?: FinancialCategorizationRulesService,
  ) {}

  async createImport(
    userId: string,
    walletId: string,
    format: FinancialImportFormat,
    rawFileName: string,
    content: Buffer,
    csvOptions?: { configuration?: CsvImportConfiguration; mappingId?: string },
    cardOptions?: { creditCardId: string; amountSign?: string },
  ): Promise<FinancialImportSession> {
    if (!FINANCIAL_IMPORT_FORMATS.includes(format)) {
      throw new FinancialImportError("O formato do arquivo deve ser OFX ou CSV.", 400);
    }
    const kind: FinancialImportKind = cardOptions ? "credit_card_statement" : "bank_statement";
    let cardAmountSign: CardAmountSign | undefined;
    if (cardOptions) {
      if (format === "csv") {
        if (!CARD_AMOUNT_SIGNS.includes(cardOptions.amountSign as CardAmountSign)) {
          throw new FinancialImportError("Informe como o CSV da fatura representa as compras: valores positivos ou negativos.", 400);
        }
        cardAmountSign = cardOptions.amountSign as CardAmountSign;
      } else if (cardOptions.amountSign !== undefined) {
        throw new FinancialImportError("O sinal das compras só se aplica a faturas em CSV; o OFX já informa compras como débitos.", 400);
      }
    }
    if (content.length === 0) throw new FinancialImportError("O arquivo está vazio.", 400);
    if (content.length > MAX_FINANCIAL_IMPORT_FILE_SIZE) {
      throw new FinancialImportError("O arquivo deve ter no máximo 10 MB.", 413);
    }
    const fileName = normalizeFileName(rawFileName);
    const expectedExtension = `.${format}`;
    if (!fileName.toLocaleLowerCase("pt-BR").endsWith(expectedExtension)) {
      throw new FinancialImportError(`O arquivo selecionado deve ter a extensão ${expectedExtension}.`, 400);
    }
    let csvConfiguration: CsvImportConfiguration | undefined;
    if (format === "csv") {
      if (csvOptions?.configuration && csvOptions.mappingId) {
        throw new FinancialImportError("Informe o mapeamento CSV diretamente ou por identificador, não ambos.", 400);
      }
      if (csvOptions?.mappingId) {
        this.validateMappingId(csvOptions.mappingId);
        const mapping = await this.repository.getCsvMapping(userId, walletId, csvOptions.mappingId);
        if (!mapping) throw new FinancialImportError("O modelo CSV não foi encontrado nesta carteira.", 404);
        csvConfiguration = parseCsvConfiguration(mapping.configuration);
      } else if (csvOptions?.configuration) {
        csvConfiguration = parseCsvConfiguration(csvOptions.configuration);
      } else {
        throw new FinancialImportError("Informe o mapeamento das colunas do arquivo CSV.", 400);
      }
    }
    const card = cardOptions ? await this.findImportCreditCard(walletId, cardOptions.creditCardId) : null;
    const fileHash = createHash("sha256").update(content).digest("hex");
    const session = await this.repository.createImport(userId, walletId, {
      format,
      fileName,
      fileSize: content.length,
      fileHash,
      creditCardId: card?.id ?? null,
    });

    try {
      const parserOutput = await this.parser.parse({
        format,
        fileName,
        content,
        csvConfiguration,
        statementKind: kind,
        cardAmountSign,
      });
      const parsed = Array.isArray(parserOutput) ? { items: parserOutput } : parserOutput;
      const parsedItems = parsed.items;
      if (parsedItems.length > MAX_FINANCIAL_IMPORT_ITEMS) {
        throw new FinancialImportError("O arquivo deve ter no máximo 10.000 movimentações.", 413);
      }
      if (parsedItems.length === 0) {
        throw new FinancialImportError("Nenhuma movimentação foi encontrada no arquivo.", 422);
      }
      const sourceSequences = new Set<number>();
      const items = parsedItems.map((item, index) => {
        const parsedItem = normalizeParsedItem(item, index + 1, kind);
        // Each card item is posted to the statement of its purchase date; the user can move it later.
        const normalized = card && parsedItem.date
          ? { ...parsedItem, statementClosingDate: calculateBillingCycle(parsedItem.date, card.closingDay, card.dueDay).closingDate }
          : parsedItem;
        const repeatedSequence = sourceSequences.has(item.sequence);
        if (Number.isSafeInteger(item.sequence)) sourceSequences.add(item.sequence);
        if (repeatedSequence) {
          return {
            ...normalized,
            validationStatus: "invalid" as const,
            errorMessage: [
              normalized.errorMessage,
              "A sequência original da movimentação está duplicada no arquivo.",
            ].filter(Boolean).join(" "),
            isRepairable: false,
          };
        }
        return normalized;
      });
      const categorizedItems = this.categorizationRules
        ? await this.categorizationRules.applyRules(walletId, items)
        : items;
      const preview = await this.repository.savePreview(
        userId,
        walletId,
        session.id,
        categorizedItems,
        normalizeSourceMetadata(parsed.sourceMetadata),
      );
      if (!preview) throw new FinancialImportError("A importação não foi encontrada.", 404);
      return preview;
    } catch (error) {
      const rawFailureMessage = error instanceof FinancialImportError
        ? error.message
        : "Não foi possível processar o arquivo importado.";
      const failureMessage = truncateUtf8(rawFailureMessage.trim(), MAX_FINANCIAL_IMPORT_FAILURE_MESSAGE_BYTES)
        || "Não foi possível processar o arquivo importado.";
      await this.repository.markFailed(userId, walletId, session.id, failureMessage);
      throw error;
    }
  }

  private async findImportCreditCard(walletId: string, creditCardId: string) {
    if (typeof creditCardId !== "string" || !UUID_PATTERN.test(creditCardId)) {
      throw new FinancialImportError("O cartão não foi encontrado nesta carteira.", 404);
    }
    const card = await this.repository.findImportCreditCard(walletId, creditCardId);
    if (!card) throw new FinancialImportError("O cartão não foi encontrado nesta carteira ou está inativo.", 404);
    return card;
  }

  listImports(userId: string, walletId: string): Promise<FinancialImportSession[]> {
    return this.repository.listImports(userId, walletId);
  }

  listCategorizationRules(walletId: string): Promise<FinancialCategorizationRule[]> {
    return this.requireCategorizationRules().listRules(walletId);
  }

  createCategorizationRule(userId: string, walletId: string, input: FinancialCategorizationRuleInput): Promise<FinancialCategorizationRule> {
    return this.requireCategorizationRules().createRule(userId, walletId, input);
  }

  updateCategorizationRule(walletId: string, ruleId: string, input: FinancialCategorizationRuleInput): Promise<FinancialCategorizationRule> {
    return this.requireCategorizationRules().updateRule(walletId, ruleId, input);
  }

  deleteCategorizationRule(walletId: string, ruleId: string): Promise<void> {
    return this.requireCategorizationRules().deleteRule(walletId, ruleId);
  }

  inspectCsv(content: Buffer, configuration?: unknown): CsvInspectionResult {
    if (content.length > MAX_FINANCIAL_IMPORT_FILE_SIZE) throw new FinancialImportError("O arquivo deve ter no máximo 10 MB.", 413);
    return inspectCsv(content, configuration ? parseCsvInspectionOverrides(configuration) : undefined);
  }

  listCsvMappings(userId: string, walletId: string): Promise<CsvMapping[]> {
    return this.repository.listCsvMappings(userId, walletId);
  }

  createCsvMapping(userId: string, walletId: string, input: CreateCsvMappingInput): Promise<CsvMapping> {
    return this.repository.createCsvMapping(userId, walletId, this.normalizeCsvMappingInput(input));
  }

  async updateCsvMapping(userId: string, walletId: string, mappingId: string, input: CreateCsvMappingInput): Promise<CsvMapping> {
    this.validateMappingId(mappingId);
    const mapping = await this.repository.updateCsvMapping(userId, walletId, mappingId, this.normalizeCsvMappingInput(input));
    if (!mapping) throw new FinancialImportError("O modelo CSV não foi encontrado nesta carteira.", 404);
    return mapping;
  }

  async getImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession> {
    this.validateImportId(importId);
    const session = await this.repository.getImport(userId, walletId, importId);
    if (!session) throw new FinancialImportError("A importação não foi encontrada.", 404);
    return session;
  }

  async updateItem(
    userId: string,
    walletId: string,
    importId: string,
    itemId: string,
    input: UpdateFinancialImportItemInput,
  ) {
    this.validateImportId(importId);
    this.validateItemId(itemId);
    const item = await this.repository.updateItem(
      userId,
      walletId,
      importId,
      itemId,
      normalizeUpdateInput(input),
    );
    if (!item) throw new FinancialImportError("A movimentação da importação não foi encontrada ou não pode mais ser alterada.", 409);
    return item;
  }

  async confirmImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession> {
    this.validateImportId(importId);
    const session = await this.repository.confirmImport(userId, walletId, importId);
    if (!session) throw new FinancialImportError("A importação não foi encontrada ou não pode ser confirmada.", 409);
    return session;
  }

  async undoImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession> {
    this.validateImportId(importId);
    const session = await this.repository.undoImport(userId, walletId, importId);
    if (!session) {
      throw new FinancialImportError(
        "A importação não pode ser desfeita porque seus lançamentos foram alterados ou ela não está concluída.",
        409,
      );
    }
    return session;
  }

  async discardImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession> {
    this.validateImportId(importId);
    const session = await this.repository.discardImport(userId, walletId, importId);
    if (!session) {
      throw new FinancialImportError("A prévia da importação não foi encontrada ou não pode mais ser descartada.", 409);
    }
    return session;
  }

  private validateImportId(importId: string): void {
    if (!UUID_PATTERN.test(importId)) throw new FinancialImportError("A importação não foi encontrada.", 404);
  }

  private requireCategorizationRules(): FinancialCategorizationRulesService {
    if (!this.categorizationRules) throw new FinancialImportError("As regras de categorização não estão disponíveis.", 503);
    return this.categorizationRules;
  }

  private validateItemId(itemId: string): void {
    if (!UUID_PATTERN.test(itemId)) throw new FinancialImportError("A movimentação da importação não foi encontrada.", 404);
  }

  private validateMappingId(mappingId: string): void {
    if (!UUID_PATTERN.test(mappingId)) throw new FinancialImportError("O modelo CSV não foi encontrado.", 404);
  }

  private normalizeCsvMappingInput(input: CreateCsvMappingInput): CreateCsvMappingInput {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 100 || Buffer.byteLength(name, "utf8") > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new FinancialImportError("O nome do modelo CSV deve ter entre 1 e 100 caracteres.", 400);
    }
    return { name, configuration: parseCsvConfiguration(input.configuration) };
  }
}
