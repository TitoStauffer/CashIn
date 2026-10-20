import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { hashToken } from "../auth/token.js";
import { CategoryConflictError } from "./categories.errors.js";
import type {
  Category,
  CategoryNature,
  CategoryRepository,
  CategorySubcategory,
} from "./categories.types.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_A = "a".repeat(43);
const SESSION_B = "b".repeat(43);

function normalizeName(name: string): string {
  return name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

class MemoryCategoryRepository implements CategoryRepository {
  readonly categories = new Map<string, Category & { userId: string }>();
  readonly subcategories = new Map<string, CategorySubcategory & { userId: string }>();
  readonly usedCategories = new Set<string>();
  readonly usedSubcategories = new Set<string>();
  private nextId = 1;

  private createId(): string {
    const hex = this.nextId.toString(16).padStart(12, "0");
    this.nextId += 1;
    return `00000000-0000-4000-8000-${hex}`;
  }

  private categoryFor(userId: string, categoryId: string) {
    const category = this.categories.get(categoryId);
    return category?.userId === userId ? category : null;
  }

  async listCategories(userId: string, nature?: CategoryNature): Promise<Category[]> {
    return [...this.categories.values()]
      .filter((category) => category.userId === userId && (!nature || category.nature === nature))
      .map(({ userId: _userId, ...category }) => ({
        ...category,
        subcategories: [...this.subcategories.values()]
          .filter((subcategory) => subcategory.categoryId === category.id && subcategory.userId === userId)
          .map(({ userId: _subcategoryUserId, ...subcategory }) => subcategory),
      }));
  }

  async createCategory(userId: string, name: string, nature: CategoryNature): Promise<Category> {
    const duplicate = [...this.categories.values()].some((category) =>
      category.userId === userId
      && category.nature === nature
      && normalizeName(category.name) === normalizeName(name));
    if (duplicate) throw new CategoryConflictError("Já existe uma categoria com esse nome.");

    const category: Category & { userId: string } = {
      id: this.createId(),
      userId,
      name,
      nature,
      subcategories: [],
    };
    this.categories.set(category.id, category);
    const { userId: _userId, ...result } = category;
    return result;
  }

  async updateCategoryName(userId: string, categoryId: string, name: string): Promise<Category | null> {
    const category = this.categoryFor(userId, categoryId);
    if (!category) return null;
    const duplicate = [...this.categories.values()].some((candidate) =>
      candidate.id !== categoryId
      && candidate.userId === userId
      && candidate.nature === category.nature
      && normalizeName(candidate.name) === normalizeName(name));
    if (duplicate) throw new CategoryConflictError("Já existe uma categoria com esse nome.");
    category.name = name;
    return { id: category.id, name: category.name, nature: category.nature, subcategories: [] };
  }

  async deleteCategory(userId: string, categoryId: string): Promise<boolean> {
    const category = this.categoryFor(userId, categoryId);
    if (!category) return false;
    const children = [...this.subcategories.values()].filter((item) => item.categoryId === categoryId);
    if (this.usedCategories.has(categoryId) || children.some((item) => this.usedSubcategories.has(item.id))) {
      throw new CategoryConflictError("O item possui registros vinculados e não pode ser excluído.");
    }
    for (const child of children) this.subcategories.delete(child.id);
    this.categories.delete(categoryId);
    return true;
  }

  async createSubcategory(userId: string, categoryId: string, name: string): Promise<CategorySubcategory | null> {
    if (!this.categoryFor(userId, categoryId)) return null;
    const duplicate = [...this.subcategories.values()].some((subcategory) =>
      subcategory.userId === userId
      && subcategory.categoryId === categoryId
      && normalizeName(subcategory.name) === normalizeName(name));
    if (duplicate) throw new CategoryConflictError("Já existe uma subcategoria com esse nome.");
    const subcategory = { id: this.createId(), userId, name, categoryId };
    this.subcategories.set(subcategory.id, subcategory);
    return { id: subcategory.id, name: subcategory.name, categoryId: subcategory.categoryId };
  }

  async updateSubcategoryName(
    userId: string,
    categoryId: string,
    subcategoryId: string,
    name: string,
  ): Promise<CategorySubcategory | null> {
    const subcategory = this.subcategories.get(subcategoryId);
    if (
      !subcategory
      || subcategory.userId !== userId
      || subcategory.categoryId !== categoryId
      || !this.categoryFor(userId, categoryId)
    ) return null;
    const duplicate = [...this.subcategories.values()].some((candidate) =>
      candidate.id !== subcategoryId
      && candidate.userId === userId
      && candidate.categoryId === categoryId
      && normalizeName(candidate.name) === normalizeName(name));
    if (duplicate) throw new CategoryConflictError("Já existe uma subcategoria com esse nome.");
    subcategory.name = name;
    return { id: subcategory.id, name: subcategory.name, categoryId: subcategory.categoryId };
  }

  async deleteSubcategory(userId: string, categoryId: string, subcategoryId: string): Promise<boolean> {
    const subcategory = this.subcategories.get(subcategoryId);
    if (
      !subcategory
      || subcategory.userId !== userId
      || subcategory.categoryId !== categoryId
      || !this.categoryFor(userId, categoryId)
    ) return false;
    if (this.usedSubcategories.has(subcategoryId)) {
      throw new CategoryConflictError("O item possui registros vinculados e não pode ser excluído.");
    }
    this.subcategories.delete(subcategoryId);
    return true;
  }
}

class SessionAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>([
    [USER_A, { id: USER_A, email: "a@example.com" }],
    [USER_B, { id: USER_B, email: "b@example.com" }],
  ]);
  private readonly sessions = new Map<string, string>([
    [hashToken(SESSION_A), USER_A],
    [hashToken(SESSION_B), USER_B],
  ]);

  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(
    _email: string,
    _passwordHash: string,
    _verificationTokenHash: string,
    _verificationTokenExpiresAt: Date,
  ): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    const userId = this.sessions.get(tokenHash);
    return userId ? this.users.get(userId) ?? null : null;
  }
  async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); }
}

function createDatabase(): Database {
  const executor: QueryExecutor = {
    query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }),
  };
  return { ...executor, transaction: async (work) => work(executor) };
}

function createTestApp(repository = new MemoryCategoryRepository()) {
  const app = createApp(createDatabase(), {
    authRepository: new SessionAuthRepository(),
    categoryRepository: repository,
  });
  return { app, repository };
}

function authCookie(session = SESSION_A): string {
  return `cashin_session=${session}`;
}

test("category CRUD uses the authenticated owner and returns the agreed nested list envelope", async () => {
  const { app } = createTestApp();
  const unauthenticated = await app.inject({ method: "GET", url: "/categories" });
  assert.equal(unauthenticated.statusCode, 401);

  const create = await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie() },
    payload: { name: "  Salário ", nature: "income" },
  });
  assert.equal(create.statusCode, 201);
  const category = create.json();
  assert.equal(category.name, "Salário");
  assert.equal(category.nature, "income");
  assert.deepEqual(category.subcategories, []);

  const subcategoryCreate = await app.inject({
    method: "POST",
    url: `/categories/${category.id}/subcategories`,
    headers: { cookie: authCookie() },
    payload: { name: "  Salário base  " },
  });
  assert.equal(subcategoryCreate.statusCode, 201);
  assert.deepEqual(subcategoryCreate.json(), {
    id: subcategoryCreate.json().id,
    name: "Salário base",
    categoryId: category.id,
  });

  await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie(SESSION_B) },
    payload: { name: "Salário", nature: "income" },
  });

  const list = await app.inject({ method: "GET", url: "/categories?nature=income", headers: { cookie: authCookie() } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  assert.deepEqual(list.json().items[0], {
    id: category.id,
    name: "Salário",
    nature: "income",
    subcategories: [subcategoryCreate.json()],
  });

  const otherUserList = await app.inject({ method: "GET", url: "/categories", headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(otherUserList.json().items.length, 1);
  assert.notEqual(otherUserList.json().items[0].id, category.id);
  await app.close();
});

test("category uniqueness is scoped to owner and nature, and category nature cannot be edited", async () => {
  const { app } = createTestApp();
  const create = await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie() },
    payload: { name: "Salário", nature: "expense" },
  });
  const categoryId = create.json().id as string;

  const duplicate = await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie() },
    payload: { name: " salario ", nature: "expense" },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(typeof duplicate.json().message, "string");

  const sameNameOtherNature = await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie() },
    payload: { name: "Salario", nature: "income" },
  });
  assert.equal(sameNameOtherNature.statusCode, 201);

  const rename = await app.inject({
    method: "PATCH",
    url: `/categories/${categoryId}`,
    headers: { cookie: authCookie() },
    payload: { name: "Locomoção" },
  });
  assert.equal(rename.statusCode, 200);
  assert.equal(rename.json().name, "Locomoção");
  assert.equal(rename.json().nature, "expense");

  const changeNature = await app.inject({
    method: "PATCH",
    url: `/categories/${categoryId}`,
    headers: { cookie: authCookie() },
    payload: { name: "Locomoção", nature: "income" },
  });
  assert.equal(changeNature.statusCode, 400);
  await app.close();
});

test("category and subcategory identifiers from another account are hidden as not found", async () => {
  const { app, repository } = createTestApp();
  const category = await repository.createCategory(USER_B, "Mercado", "expense");
  const subcategory = await repository.createSubcategory(USER_B, category.id, "Feira");
  assert.ok(subcategory);

  const foreignCategory = await app.inject({
    method: "PATCH",
    url: `/categories/${category.id}`,
    headers: { cookie: authCookie() },
    payload: { name: "Tentativa" },
  });
  assert.equal(foreignCategory.statusCode, 404);

  const foreignSubcategory = await app.inject({
    method: "DELETE",
    url: `/categories/${category.id}/subcategories/${subcategory.id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(foreignSubcategory.statusCode, 404);

  const spoofOwner = await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie() },
    payload: { name: "Falso", nature: "expense", userId: USER_B },
  });
  assert.equal(spoofOwner.statusCode, 400);
  await app.close();
});

test("subcategories can be edited and duplicate names within a category are rejected", async () => {
  const { app } = createTestApp();
  const categoryResponse = await app.inject({
    method: "POST",
    url: "/categories",
    headers: { cookie: authCookie() },
    payload: { name: "Lazer", nature: "expense" },
  });
  const categoryId = categoryResponse.json().id as string;
  const subcategoryResponse = await app.inject({
    method: "POST",
    url: `/categories/${categoryId}/subcategories`,
    headers: { cookie: authCookie() },
    payload: { name: "Férias" },
  });
  const subcategoryId = subcategoryResponse.json().id as string;

  const duplicate = await app.inject({
    method: "POST",
    url: `/categories/${categoryId}/subcategories`,
    headers: { cookie: authCookie() },
    payload: { name: " ferias " },
  });
  assert.equal(duplicate.statusCode, 409);

  const rename = await app.inject({
    method: "PATCH",
    url: `/categories/${categoryId}/subcategories/${subcategoryId}`,
    headers: { cookie: authCookie() },
    payload: { name: "Streaming" },
  });
  assert.equal(rename.statusCode, 200);
  assert.deepEqual(rename.json(), { id: subcategoryId, name: "Streaming", categoryId });
  await app.close();
});

test("deleting a category cascades unreferenced subcategories but returns 409 when one is in use", async () => {
  const { app, repository } = createTestApp();
  const category = await repository.createCategory(USER_A, "Investimentos", "investment_goal");
  const subcategory = await repository.createSubcategory(USER_A, category.id, "Reserva");
  assert.ok(subcategory);
  repository.usedSubcategories.add(subcategory.id);

  const blockedDelete = await app.inject({
    method: "DELETE",
    url: `/categories/${category.id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(blockedDelete.statusCode, 409);
  assert.ok(repository.categories.has(category.id));
  assert.ok(repository.subcategories.has(subcategory.id));

  repository.usedSubcategories.delete(subcategory.id);
  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/categories/${category.id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(deleteResponse.statusCode, 204);
  assert.equal(repository.categories.has(category.id), false);
  assert.equal(repository.subcategories.has(subcategory.id), false);
  await app.close();
});

test("deleting an in-use subcategory returns a conflict and preserves it", async () => {
  const { app, repository } = createTestApp();
  const category = await repository.createCategory(USER_A, "Saúde", "expense");
  const subcategory = await repository.createSubcategory(USER_A, category.id, "Farmácia");
  assert.ok(subcategory);
  repository.usedSubcategories.add(subcategory.id);

  const response = await app.inject({
    method: "DELETE",
    url: `/categories/${category.id}/subcategories/${subcategory.id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(response.statusCode, 409);
  assert.ok(repository.subcategories.has(subcategory.id));
  await app.close();
});
