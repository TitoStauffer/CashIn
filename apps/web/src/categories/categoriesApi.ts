export type CategoryNature = 'income' | 'expense' | 'investment' | 'investment_goal'

export type Subcategory = {
  id: string
  name: string
  categoryId: string
}

export type Category = {
  id: string
  name: string
  nature: CategoryNature
  subcategories: Subcategory[]
}

type CategoryListResponse = {
  items: Category[]
}

type ErrorResponse = {
  message?: string
}

export class CategoryApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'CategoryApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new CategoryApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function categoryPath(categoryId: string) {
  return `/categories/${encodeURIComponent(categoryId)}`
}

export const categoriesApi = {
  list(nature: CategoryNature, signal?: AbortSignal) {
    const query = new URLSearchParams({ nature })
    return request<CategoryListResponse>(`/categories?${query.toString()}`, { signal })
  },

  create(name: string, nature: CategoryNature) {
    return request<unknown>('/categories', {
      method: 'POST',
      body: JSON.stringify({ name, nature }),
    })
  },

  update(categoryId: string, name: string) {
    return request<unknown>(categoryPath(categoryId), {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
  },

  remove(categoryId: string) {
    return request<void>(categoryPath(categoryId), { method: 'DELETE' })
  },

  createSubcategory(categoryId: string, name: string) {
    return request<unknown>(`${categoryPath(categoryId)}/subcategories`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },

  updateSubcategory(categoryId: string, subcategoryId: string, name: string) {
    return request<unknown>(
      `${categoryPath(categoryId)}/subcategories/${encodeURIComponent(subcategoryId)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    )
  },

  removeSubcategory(categoryId: string, subcategoryId: string) {
    return request<void>(
      `${categoryPath(categoryId)}/subcategories/${encodeURIComponent(subcategoryId)}`,
      { method: 'DELETE' },
    )
  },
}
