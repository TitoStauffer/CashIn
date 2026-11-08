import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FinancialImportError } from "./financial-imports.errors.js";
import { MAX_FINANCIAL_IMPORT_FILE_SIZE, type FinancialImportsService } from "./financial-imports.service.js";
import { FINANCIAL_IMPORT_FORMATS, FINANCIAL_IMPORT_ITEM_TYPES, type CreateCsvMappingInput, type CsvImportConfiguration, type FinancialCategorizationRuleInput, type FinancialImportFormat, type UpdateFinancialImportItemInput } from "./financial-imports.types.js";

interface RouteOptions {
  financialImportsService: FinancialImportsService;
}

interface ImportParams {
  importId: string;
}

interface ImportItemParams extends ImportParams {
  itemId: string;
}

interface ImportUploadHeaders {
  "x-file-name"?: string;
  "x-file-format"?: string;
  "x-csv-mapping"?: string;
  "x-csv-mapping-id"?: string;
  // Credit card statement imports: the card that owns the statement and, for CSV, the purchase sign.
  "x-credit-card-id"?: string;
  "x-card-amount-sign"?: string;
}

interface CsvMappingParams { mappingId: string }

function cardUploadOptions(headers: ImportUploadHeaders): { creditCardId: string; amountSign?: string } | undefined {
  const creditCardId = headers["x-credit-card-id"]?.trim();
  const amountSign = headers["x-card-amount-sign"]?.trim();
  if (!creditCardId) {
    if (amountSign) throw new FinancialImportError("O sinal das compras só se aplica a faturas de cartão.", 400);
    return undefined;
  }
  return amountSign ? { creditCardId, amountSign } : { creditCardId };
}
interface RuleParams { ruleId: string }

const uuidSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
};

const importParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["importId"],
  properties: { importId: uuidSchema },
};

const categorizationRuleBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "description", "categoryId"],
  properties: {
    type: { type: "string", enum: ["income", "expense"] },
    description: { type: "string", minLength: 1, maxLength: 512 },
    categoryId: uuidSchema,
    subcategoryId: { anyOf: [uuidSchema, { type: "null" }] },
    isActive: { type: "boolean" },
  },
};

function sendFinancialImportError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof FinancialImportError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Financial import request failed",
  );
  return reply.code(500).send({ message: "Não foi possível concluir a importação." });
}

function rejectUnexpectedProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.body;
    if (typeof value !== "object" || value === null || Array.isArray(value) || Buffer.isBuffer(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) {
      return reply.code(400).send({ message: "Os dados enviados são inválidos." });
    }
  };
}

function decodeFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeCsvMapping(value: string): CsvImportConfiguration {
  if (Buffer.byteLength(value, "utf8") > 16_384) throw new FinancialImportError("O mapeamento CSV excede o limite permitido.", 400);
  try {
    const decoded = decodeURIComponent(value);
    return JSON.parse(decoded) as CsvImportConfiguration;
  } catch {
    throw new FinancialImportError("O mapeamento CSV informado é inválido.", 400);
  }
}

export function registerFinancialImportRoutes(app: FastifyInstance, options: RouteOptions): void {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.post<{ Headers: ImportUploadHeaders; Body: Buffer }>(
    "/financial-imports",
    {
      // Authorization runs in `onRequest`, before the body is read: Fastify parses the payload only
      // after this hook, so a request without a session or without access to the wallet is refused
      // without the API ever buffering the file it was sending.
      onRequest: [app.authenticate, app.resolveWalletContext],
      bodyLimit: MAX_FINANCIAL_IMPORT_FILE_SIZE,
    },
    async (request, reply) => {
      try {
        const rawFileName = request.headers["x-file-name"];
        const rawFormat = request.headers["x-file-format"]?.toLowerCase();
        if (!rawFileName) throw new FinancialImportError("Informe o nome do arquivo.", 400);
        if (!rawFormat || !FINANCIAL_IMPORT_FORMATS.includes(rawFormat as FinancialImportFormat)) {
          throw new FinancialImportError("O formato do arquivo deve ser OFX ou CSV.", 400);
        }
        if (!Buffer.isBuffer(request.body)) {
          throw new FinancialImportError("Envie o arquivo como application/octet-stream.", 415);
        }
        const session = await options.financialImportsService.createImport(
          request.currentUser!.id,
          request.currentWalletId!,
          rawFormat as FinancialImportFormat,
          decodeFileName(rawFileName),
          request.body,
          rawFormat === "csv" ? {
            configuration: request.headers["x-csv-mapping"] ? decodeCsvMapping(request.headers["x-csv-mapping"]!) : undefined,
            mappingId: request.headers["x-csv-mapping-id"],
          } : undefined,
          cardUploadOptions(request.headers),
        );
        return reply.code(201).send(session);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.post<{ Headers: ImportUploadHeaders; Body: Buffer }>(
    "/financial-imports/csv/inspect",
    // Same reason as the upload above: the file is only read once the request is authorized.
    { onRequest: [app.authenticate, app.resolveWalletContext], bodyLimit: MAX_FINANCIAL_IMPORT_FILE_SIZE },
    async (request, reply) => {
      try {
        if (!Buffer.isBuffer(request.body)) throw new FinancialImportError("Envie o arquivo como application/octet-stream.", 415);
        const rawMapping = request.headers["x-csv-mapping"];
        return reply.code(200).send(options.financialImportsService.inspectCsv(
          request.body,
          rawMapping ? decodeCsvMapping(rawMapping) : undefined,
        ));
      } catch (error) { return sendFinancialImportError(error, request, reply); }
    },
  );

  app.get(
    "/financial-imports/csv-mappings",
    { preHandler: [app.authenticate, app.resolveWalletContext] },
    async (request, reply) => {
      try {
        const items = await options.financialImportsService.listCsvMappings(request.currentUser!.id, request.currentWalletId!);
        return reply.code(200).send({ items });
      } catch (error) { return sendFinancialImportError(error, request, reply); }
    },
  );

  app.post<{ Body: CreateCsvMappingInput }>(
    "/financial-imports/csv-mappings",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["name", "configuration"]),
      schema: { body: { type: "object", additionalProperties: false, required: ["name", "configuration"], properties: { name: { type: "string", minLength: 1, maxLength: 100 }, configuration: { type: "object" } } } },
    },
    async (request, reply) => {
      try {
        const mapping = await options.financialImportsService.createCsvMapping(request.currentUser!.id, request.currentWalletId!, request.body);
        return reply.code(201).send(mapping);
      } catch (error) { return sendFinancialImportError(error, request, reply); }
    },
  );

  app.patch<{ Params: CsvMappingParams; Body: CreateCsvMappingInput }>(
    "/financial-imports/csv-mappings/:mappingId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["name", "configuration"]),
      schema: { params: { type: "object", additionalProperties: false, required: ["mappingId"], properties: { mappingId: uuidSchema } }, body: { type: "object", additionalProperties: false, required: ["name", "configuration"], properties: { name: { type: "string", minLength: 1, maxLength: 100 }, configuration: { type: "object" } } } },
    },
    async (request, reply) => {
      try {
        const mapping = await options.financialImportsService.updateCsvMapping(request.currentUser!.id, request.currentWalletId!, request.params.mappingId, request.body);
        return reply.code(200).send(mapping);
      } catch (error) { return sendFinancialImportError(error, request, reply); }
    },
  );

  app.get(
    "/financial-imports/rules",
    { preHandler: [app.authenticate, app.resolveWalletContext] },
    async (request, reply) => {
      try {
        const items = await options.financialImportsService.listCategorizationRules(request.currentWalletId!);
        return reply.code(200).send({ items });
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.post<{ Body: FinancialCategorizationRuleInput }>(
    "/financial-imports/rules",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["type", "description", "categoryId", "subcategoryId", "isActive"]),
      schema: { body: categorizationRuleBodySchema },
    },
    async (request, reply) => {
      try {
        const item = await options.financialImportsService.createCategorizationRule(
          request.currentUser!.id,
          request.currentWalletId!,
          request.body,
        );
        return reply.code(201).send(item);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.patch<{ Params: RuleParams; Body: FinancialCategorizationRuleInput }>(
    "/financial-imports/rules/:ruleId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["type", "description", "categoryId", "subcategoryId", "isActive"]),
      schema: {
        params: { type: "object", additionalProperties: false, required: ["ruleId"], properties: { ruleId: uuidSchema } },
        body: categorizationRuleBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await options.financialImportsService.updateCategorizationRule(
          request.currentWalletId!,
          request.params.ruleId,
          request.body,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.delete<{ Params: RuleParams }>(
    "/financial-imports/rules/:ruleId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: { params: { type: "object", additionalProperties: false, required: ["ruleId"], properties: { ruleId: uuidSchema } } },
    },
    async (request, reply) => {
      try {
        await options.financialImportsService.deleteCategorizationRule(request.currentWalletId!, request.params.ruleId);
        return reply.code(204).send();
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.get(
    "/financial-imports",
    { preHandler: [app.authenticate, app.resolveWalletContext] },
    async (request, reply) => {
      try {
        const items = await options.financialImportsService.listImports(
          request.currentUser!.id,
          request.currentWalletId!,
        );
        return reply.code(200).send({ items });
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ImportParams }>(
    "/financial-imports/:importId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: { params: importParamsSchema },
    },
    async (request, reply) => {
      try {
        const session = await options.financialImportsService.getImport(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.importId,
        );
        return reply.code(200).send(session);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.patch<{ Params: ImportItemParams; Body: UpdateFinancialImportItemInput }>(
    "/financial-imports/:importId/items/:itemId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["date", "description", "type", "categoryId", "subcategoryId", "includeDuplicate", "statementClosingDate", "creditCardStatementId", "transferCounterpartWalletId", "walletTransferId"]),
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["importId", "itemId"],
          properties: { importId: uuidSchema, itemId: uuidSchema },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["date", "type"],
          properties: {
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            description: { anyOf: [{ type: "string" }, { type: "null" }] },
            type: { type: "string", enum: [...FINANCIAL_IMPORT_ITEM_TYPES] },
            categoryId: { anyOf: [uuidSchema, { type: "null" }] },
            subcategoryId: { anyOf: [uuidSchema, { type: "null" }] },
            includeDuplicate: { type: "boolean" },
            statementClosingDate: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
            creditCardStatementId: { anyOf: [uuidSchema, { type: "null" }] },
            transferCounterpartWalletId: { anyOf: [uuidSchema, { type: "null" }] },
            walletTransferId: { anyOf: [uuidSchema, { type: "null" }] },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await options.financialImportsService.updateItem(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.importId,
          request.params.itemId,
          request.body,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.post<{ Params: ImportParams }>(
    "/financial-imports/:importId/confirm",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: { params: importParamsSchema },
    },
    async (request, reply) => {
      try {
        const session = await options.financialImportsService.confirmImport(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.importId,
        );
        return reply.code(200).send(session);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.post<{ Params: ImportParams }>(
    "/financial-imports/:importId/undo",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: { params: importParamsSchema },
    },
    async (request, reply) => {
      try {
        const session = await options.financialImportsService.undoImport(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.importId,
        );
        return reply.code(200).send(session);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );

  app.delete<{ Params: ImportParams }>(
    "/financial-imports/:importId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: { params: importParamsSchema },
    },
    async (request, reply) => {
      try {
        const session = await options.financialImportsService.discardImport(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.importId,
        );
        return reply.code(200).send(session);
      } catch (error) {
        return sendFinancialImportError(error, request, reply);
      }
    },
  );
}
