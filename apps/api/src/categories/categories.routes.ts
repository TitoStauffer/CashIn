import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CategoryError } from "./categories.errors.js";
import type { CategoriesService } from "./categories.service.js";
import { CATEGORY_NATURES, type CategoryNature } from "./categories.types.js";

interface RouteOptions {
  categoriesService: CategoriesService;
}

interface CategoryParams {
  categoryId: string;
}

interface SubcategoryParams extends CategoryParams {
  subcategoryId: string;
}

interface CategoryQuery {
  nature?: CategoryNature;
}

interface CreateCategoryBody {
  name: string;
  nature: CategoryNature;
}

interface UpdateNameBody {
  name: string;
}

const uuidSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
};

const nameSchema = { type: "string", minLength: 1, maxLength: 100 };

function sendCategoryError(error: unknown, reply: FastifyReply) {
  if (error instanceof CategoryError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
}

function rejectUnexpectedProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.body;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) {
      return reply.code(400).send({ message: "Os dados enviados são inválidos." });
    }
  };
}

function rejectUnexpectedQueryProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.query;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) {
      return reply.code(400).send({ message: "Os parâmetros enviados são inválidos." });
    }
  };
}

export function registerCategoryRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get<{ Querystring: CategoryQuery }>(
    "/categories",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedQueryProperties(["nature"]),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { nature: { type: "string", enum: [...CATEGORY_NATURES] } },
        },
      },
    },
    async (request, reply) => {
      try {
        const items = await options.categoriesService.listCategories(
          request.currentUser!.id,
          request.query.nature,
        );
        return reply.code(200).send({ items });
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );

  app.post<{ Body: CreateCategoryBody }>(
    "/categories",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedProperties(["name", "nature"]),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "nature"],
          properties: {
            name: nameSchema,
            nature: { type: "string", enum: [...CATEGORY_NATURES] },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await options.categoriesService.createCategory(
          request.currentUser!.id,
          request.body.name,
          request.body.nature,
        );
        return reply.code(201).send(item);
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );

  app.patch<{ Params: CategoryParams; Body: UpdateNameBody }>(
    "/categories/:categoryId",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedProperties(["name"]),
      schema: {
        params: { type: "object", required: ["categoryId"], properties: { categoryId: uuidSchema } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: nameSchema },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await options.categoriesService.updateCategoryName(
          request.currentUser!.id,
          request.params.categoryId,
          request.body.name,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );

  app.delete<{ Params: CategoryParams }>(
    "/categories/:categoryId",
    {
      preHandler: app.authenticate,
      schema: { params: { type: "object", required: ["categoryId"], properties: { categoryId: uuidSchema } } },
    },
    async (request, reply) => {
      try {
        await options.categoriesService.deleteCategory(request.currentUser!.id, request.params.categoryId);
        return reply.code(204).send();
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );

  app.post<{ Params: CategoryParams; Body: UpdateNameBody }>(
    "/categories/:categoryId/subcategories",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedProperties(["name"]),
      schema: {
        params: { type: "object", required: ["categoryId"], properties: { categoryId: uuidSchema } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: nameSchema },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await options.categoriesService.createSubcategory(
          request.currentUser!.id,
          request.params.categoryId,
          request.body.name,
        );
        return reply.code(201).send(item);
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );

  app.patch<{ Params: SubcategoryParams; Body: UpdateNameBody }>(
    "/categories/:categoryId/subcategories/:subcategoryId",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedProperties(["name"]),
      schema: {
        params: {
          type: "object",
          required: ["categoryId", "subcategoryId"],
          properties: { categoryId: uuidSchema, subcategoryId: uuidSchema },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: nameSchema },
        },
      },
    },
    async (request, reply) => {
      try {
        const item = await options.categoriesService.updateSubcategoryName(
          request.currentUser!.id,
          request.params.categoryId,
          request.params.subcategoryId,
          request.body.name,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );

  app.delete<{ Params: SubcategoryParams }>(
    "/categories/:categoryId/subcategories/:subcategoryId",
    {
      preHandler: app.authenticate,
      schema: {
        params: {
          type: "object",
          required: ["categoryId", "subcategoryId"],
          properties: { categoryId: uuidSchema, subcategoryId: uuidSchema },
        },
      },
    },
    async (request, reply) => {
      try {
        await options.categoriesService.deleteSubcategory(
          request.currentUser!.id,
          request.params.categoryId,
          request.params.subcategoryId,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendCategoryError(error, reply);
      }
    },
  );
}
