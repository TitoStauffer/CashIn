import { createHash } from "node:crypto";
import { FinancialImportError } from "./financial-imports.errors.js";
import {
  FINANCIAL_IMPORT_FORMATS,
  FINANCIAL_IMPORT_ITEM_TYPES,
  type FinancialImportFormat,
  type FinancialImportParser,
  type FinancialImportRepository,
  type FinancialImportSession,
  type ParsedFinancialImportItem,
  type UpdateFinancialImportItemInput,
} from "./financial-imports.types.js";

export const MAX_FINANCIAL_IMPORT_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FINANCIAL_IMPORT_ITEMS = 10_000;
const MAX_FINANCIAL_IMPORT_FILE_NAME_BYTES = 512;
const MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES = 4_000;
const MAX_FINANCIAL_IMPORT_FAILURE_MESSAGE_BYTES = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_MONEY_PATTERN = /^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const ZERO_MONEY_PATTERN = /^-?0(?:\.0{1,2})?$/;

function validateDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

function normalizeParsedItem(item: ParsedFinancialImportItem, fallbackSequence: number): ParsedFinancialImportItem {
  const hasValidSourceSequence = Number.isSafeInteger(item.sequence)
    && item.sequence > 0
    && item.sequence <= MAX_FINANCIAL_IMPORT_ITEMS;
  const hasValidDate = typeof item.date === "string" && validateDate(item.date);
  const hasValidAmount = typeof item.signedAmount === "string"
    && SIGNED_MONEY_PATTERN.test(item.signedAmount)
    && !ZERO_MONEY_PATTERN.test(item.signedAmount);
  const hasValidType = FINANCIAL_IMPORT_ITEM_TYPES.includes(item.type);
  const rawDescription = item.description?.trim() || null;
  const hasValidDescription = rawDescription === null
    || Buffer.byteLength(rawDescription, "utf8") <= MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES;
  const description = rawDescription === null
    ? null
    : truncateUtf8(rawDescription, MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES);
  const rawCategoryId = item.categoryId ?? null;
  const rawSubcategoryId = item.subcategoryId ?? null;
  const hasValidCategory = rawCategoryId === null || UUID_PATTERN.test(rawCategoryId);
  const hasValidSubcategory = rawSubcategoryId === null || UUID_PATTERN.test(rawSubcategoryId);
  const hasCompatibleReferences = rawSubcategoryId === null
    || (rawCategoryId !== null && hasValidCategory && hasValidSubcategory);
  const type = hasValidType ? item.type : "transfer";
  const categoryId = type === "transfer" || !hasValidCategory ? null : rawCategoryId;
  const subcategoryId = type === "transfer"
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
  if (!hasValidDescription) repairableReasons.push("A descrição da movimentação deve ter no máximo 4.000 bytes.");
  invalidReasons.push(...nonRepairableReasons, ...repairableReasons);

  const isDuplicate = item.validationStatus === "duplicate";
  const parserMarkedInvalid = item.validationStatus === "invalid";
  const parserAllowsRepair = !parserMarkedInvalid || item.isRepairable === true;
  let validationStatus = item.validationStatus ?? "valid";
  let errorMessage = item.errorMessage?.trim() || null;
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
      errorMessage ??= "A transferência precisa ser conciliada antes da importação.";
    } else if (categoryId === null) {
      validationStatus = "uncategorized";
      errorMessage ??= "Selecione uma categoria para importar a movimentação.";
    } else {
      validationStatus = "valid";
      errorMessage = null;
    }
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
  };
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
  const description = input.description?.trim() || null;
  if (description !== null && Buffer.byteLength(description, "utf8") > MAX_FINANCIAL_IMPORT_DESCRIPTION_BYTES) {
    throw new FinancialImportError("A descrição da movimentação deve ter no máximo 4.000 bytes.", 400);
  }
  return {
    date: input.date,
    description,
    type: input.type,
    categoryId,
    subcategoryId,
  };
}

export class FinancialImportsService {
  constructor(
    private readonly repository: FinancialImportRepository,
    private readonly parser: FinancialImportParser,
  ) {}

  async createImport(
    userId: string,
    walletId: string,
    format: FinancialImportFormat,
    rawFileName: string,
    content: Buffer,
  ): Promise<FinancialImportSession> {
    if (!FINANCIAL_IMPORT_FORMATS.includes(format)) {
      throw new FinancialImportError("O formato do arquivo deve ser OFX ou CSV.", 400);
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
    const fileHash = createHash("sha256").update(content).digest("hex");
    const session = await this.repository.createImport(userId, walletId, {
      format,
      fileName,
      fileSize: content.length,
      fileHash,
    });

    try {
      const parsedItems = await this.parser.parse({ format, fileName, content });
      if (parsedItems.length > MAX_FINANCIAL_IMPORT_ITEMS) {
        throw new FinancialImportError("O arquivo deve ter no máximo 10.000 movimentações.", 413);
      }
      if (parsedItems.length === 0) {
        throw new FinancialImportError("Nenhuma movimentação foi encontrada no arquivo.", 422);
      }
      const sourceSequences = new Set<number>();
      const items = parsedItems.map((item, index) => {
        const normalized = normalizeParsedItem(item, index + 1);
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
      const preview = await this.repository.savePreview(userId, walletId, session.id, items);
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

  listImports(userId: string, walletId: string): Promise<FinancialImportSession[]> {
    return this.repository.listImports(userId, walletId);
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

  private validateItemId(itemId: string): void {
    if (!UUID_PATTERN.test(itemId)) throw new FinancialImportError("A movimentação da importação não foi encontrada.", 404);
  }
}
