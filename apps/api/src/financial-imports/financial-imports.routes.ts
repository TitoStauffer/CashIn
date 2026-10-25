import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FinancialImportError } from "./financial-imports.errors.js";
import { MAX_FINANCIAL_IMPORT_FILE_SIZE, type FinancialImportsService } from "./financial-imports.service.js";
import { FINANCIAL_IMPORT_FORMATS, FINANCIAL_IMPORT_ITEM_TYPES, type FinancialImportFormat, type UpdateFinancialImportItemInput } from "./financial-imports.types.js";

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
}

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

export function registerFinancialImportRoutes(app: FastifyInstance, options: RouteOptions): void {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.post<{ Headers: ImportUploadHeaders; Body: Buffer }>(
    "/financial-imports",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
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
        );
        return reply.code(201).send(session);
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
      preValidation: rejectUnexpectedProperties(["date", "description", "type", "categoryId", "subcategoryId"]),
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
